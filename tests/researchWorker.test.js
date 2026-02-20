const { describe, it, mock, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const { setupWorkerMocks } = require("./test-helpers/mock-aws.js");
const {
  sqsEvent,
  runSqsValidationTests,
  runClaudeResponseTests,
  runErrorHandlingTests
} = require("./test-helpers/worker-test-utils.js");

describe("researchWorker handler", () => {
  let handler;
  let mockSend;
  let mockCreate;
  let cleanup;

  beforeEach(() => {
    // Default: all AWS calls succeed, Claude returns text
    mockSend = mock.fn(async (cmd) => {
      if (cmd.name === "GetCommand") {
        return { Item: { taskId: "t1", status: "pending" } };
      }
      if (cmd.name === "GetSecretValueCommand") {
        return { SecretString: "sk-ant-test-key" };
      }
      return {};
    });

    mockCreate = mock.fn(async () => ({
      content: [{ type: "text", text: "# Research Results\n\nTest research content" }]
    }));

    const setup = setupWorkerMocks(mockSend, mockCreate);
    handler = setup.handler;
    cleanup = setup.cleanup;
  });

  afterEach(() => {
    cleanup();
    mock.restoreAll();
  });

  // --- Shared SQS validation tests ---

  runSqsValidationTests(() => handler);

  // --- Domain-specific: topic validation ---

  describe("topic validation", () => {
    it("marks task failed and returns when topic is missing", async () => {
      const result = await handler(sqsEvent({ taskId: "t1" }));

      // Should not throw (message is deleted)
      assert.strictEqual(result, undefined);

      // Should have called updateTaskStatus with "failed"
      const updateCall = mockSend.mock.calls.find(
        c => c.arguments[0].name === "UpdateCommand"
      );
      assert.ok(updateCall, "Expected an UpdateCommand call");
      assert.match(
        updateCall.arguments[0].params.ExpressionAttributeValues[":status"],
        /failed/
      );
    });
  });

  // --- Idempotency ---

  describe("idempotency", () => {
    for (const doneStatus of ["researched", "series_researched", "publishing", "published"]) {
      it(`skips tasks with status "${doneStatus}"`, async () => {
        mockSend.mock.mockImplementation(async (cmd) => {
          if (cmd.name === "GetCommand") {
            return { Item: { taskId: "t1", status: doneStatus } };
          }
          return {};
        });

        const result = await handler(sqsEvent({ taskId: "t1", topic: "test" }));

        assert.strictEqual(result.status, "already_processed");
        // Claude should NOT have been called
        assert.strictEqual(mockCreate.mock.calls.length, 0);
      });
    }

    it("re-runs failed tasks (not in done-statuses list)", async () => {
      // "failed" is intentionally excluded so SQS retries can attempt recovery
      mockSend.mock.mockImplementation(async (cmd) => {
        if (cmd.name === "GetCommand") {
          return { Item: { taskId: "t1", status: "failed" } };
        }
        if (cmd.name === "GetSecretValueCommand") {
          return { SecretString: "sk-ant-test-key" };
        }
        return {};
      });

      const result = await handler(sqsEvent({ taskId: "t1", topic: "test" }));

      // Should re-run the pipeline and produce a normal result
      assert.strictEqual(result.status, "researched");
      assert.ok(mockCreate.mock.calls.length > 0, "Claude should have been called for recovery");
    });

    it("processes pending task normally", async () => {
      const result = await handler(sqsEvent({ taskId: "t1", topic: "test" }));

      assert.strictEqual(result.status, "researched");
      // Three Claude calls: type inference (index 0) + research (index 1) + categorization (index 2)
      assert.strictEqual(mockCreate.mock.calls.length, 3);
    });

    it("skips type inference when articleType is provided", async () => {
      const result = await handler(sqsEvent({ taskId: "t1", topic: "test", articleType: "how-to" }));

      assert.strictEqual(result.status, "researched");
      // Two Claude calls: research (index 0) + categorization (index 1) — no inference needed
      assert.strictEqual(mockCreate.mock.calls.length, 2);
    });

    it("falls back to inference when provided articleType is invalid", async () => {
      const result = await handler(sqsEvent({ taskId: "t1", topic: "test", articleType: "essay" }));

      assert.strictEqual(result.status, "researched");
      // Three Claude calls — invalid type treated as absent, inference runs
      assert.strictEqual(mockCreate.mock.calls.length, 3);
    });

    it("does not persist invalid articleType to DynamoDB", async () => {
      await handler(sqsEvent({ taskId: "t1", topic: "test", articleType: "badtype" }));

      const updateCalls = mockSend.mock.calls.filter(c => c.arguments[0].name === "UpdateCommand");
      const researchedUpdate = updateCalls[updateCalls.length - 1];
      const persistedType = researchedUpdate.arguments[0].params.ExpressionAttributeValues[":articleType"];
      // Must be a valid type (inferred fallback), never the invalid input
      assert.ok(["knowledge", "best-of", "how-to", "masterclass"].includes(persistedType),
        `Expected valid articleType, got "${persistedType}"`);
    });
  });

  // --- Happy path ---

  describe("happy path", () => {
    it("executes full pipeline in correct order", async () => {
      await handler(sqsEvent({ taskId: "t1", topic: "test topic" }));

      const callNames = mockSend.mock.calls.map(c => c.arguments[0].name);

      // Expected order: GetCommand (idempotency), UpdateCommand (researching),
      // GetSecretValueCommand (API key — cached thereafter), PutObjectCommand (S3 write),
      // GetCommand (getKnownCategories), UpdateCommand (researched),
      // SendMessageCommand (enqueue write job)
      // Note: type inference and categorization Claude calls fire between GetSecretValueCommand
      // and PutObjectCommand / GetCommand respectively, but add no AWS SDK calls of their own.
      // cachedApiKey is reused for all three Claude calls — only one GetSecretValueCommand fires.
      assert.strictEqual(callNames[0], "GetCommand");
      assert.strictEqual(callNames[1], "UpdateCommand");
      assert.strictEqual(callNames[2], "GetSecretValueCommand");
      assert.strictEqual(callNames[3], "PutObjectCommand");
      assert.strictEqual(callNames[4], "GetCommand");
      assert.strictEqual(callNames[5], "UpdateCommand");
      assert.strictEqual(callNames[6], "SendMessageCommand");
    });

    it("writes S3 object with correct key pattern", async () => {
      await handler(sqsEvent({ taskId: "t1", topic: "test" }));

      const s3Call = mockSend.mock.calls.find(
        c => c.arguments[0].name === "PutObjectCommand"
      );
      assert.strictEqual(s3Call.arguments[0].params.Key, "research/t1.md");
      assert.strictEqual(s3Call.arguments[0].params.Bucket, "test-research-bucket");
      assert.strictEqual(s3Call.arguments[0].params.ContentType, "text/markdown");
    });

    it("enqueues write job to WriteQueue after research", async () => {
      await handler(sqsEvent({ taskId: "t1", topic: "test topic" }));

      const sqsCall = mockSend.mock.calls.find(
        c => c.arguments[0].name === "SendMessageCommand"
      );
      assert.ok(sqsCall, "Expected a SendMessageCommand call");
      assert.strictEqual(sqsCall.arguments[0].params.QueueUrl, process.env.WRITE_QUEUE_URL);
      const messageBody = JSON.parse(sqsCall.arguments[0].params.MessageBody);
      assert.strictEqual(messageBody.taskId, "t1");
    });

    it("returns successfully when write queue enqueue fails", async () => {
      mockSend.mock.mockImplementation(async (cmd) => {
        if (cmd.name === "GetCommand") {
          return { Item: { taskId: "t1", status: "pending" } };
        }
        if (cmd.name === "GetSecretValueCommand") {
          return { SecretString: "sk-ant-test-key" };
        }
        if (cmd.name === "SendMessageCommand") {
          throw new Error("SQS write queue unavailable");
        }
        return {};
      });

      const result = await handler(sqsEvent({ taskId: "t1", topic: "test" }));

      // Should still return researched — enqueue failure is non-fatal
      assert.strictEqual(result.status, "researched");
      assert.strictEqual(result.taskId, "t1");
    });

    it("returns taskId, s3Key, and researched status", async () => {
      const result = await handler(sqsEvent({ taskId: "t1", topic: "test" }));

      assert.strictEqual(result.taskId, "t1");
      assert.strictEqual(result.s3Key, "research/t1.md");
      assert.strictEqual(result.status, "researched");
    });
  });

  // --- Shared Claude response handling ---

  runClaudeResponseTests(
    () => handler,
    () => sqsEvent({ taskId: "t1", topic: "test" }),
    "researched",
    () => mockCreate,
    () => mockSend,
    "The actual research"
  );

  // --- Shared + domain-specific error handling ---

  runErrorHandlingTests(
    () => handler,
    () => sqsEvent({ taskId: "t1", topic: "test" }),
    () => mockCreate,
    () => mockSend,
    (cmd) => {
      if (cmd.name === "GetCommand") {
        return { Item: { taskId: "t1", status: "pending" } };
      }
      if (cmd.name === "GetSecretValueCommand") {
        return { SecretString: "sk-ant-test-key" };
      }
      return {};
    }
  );

  describe("domain-specific errors", () => {
    it("marks task failed and re-throws on S3 failure", async () => {
      mockSend.mock.mockImplementation(async (cmd) => {
        if (cmd.name === "GetCommand") {
          return { Item: { taskId: "t1", status: "pending" } };
        }
        if (cmd.name === "GetSecretValueCommand") {
          return { SecretString: "sk-ant-test-key" };
        }
        if (cmd.name === "PutObjectCommand") {
          throw new Error("S3 bucket not found");
        }
        return {};
      });

      await assert.rejects(
        () => handler(sqsEvent({ taskId: "t1", topic: "test" })),
        { message: "S3 bucket not found" }
      );
    });
  });

  // --- Masterclass series fan-out ---

  describe("masterclass series fan-out", () => {
    const SERIES_OUTLINE = JSON.stringify({
      seriesTitle: "The Complete Guide to Rust Ownership",
      seriesSlug: "rust-ownership",
      parts: [
        { part: 1, partTitle: "What is Ownership?", partScope: "Foundations of ownership." },
        { part: 2, partTitle: "Borrowing and Lifetimes", partScope: "Borrow checker basics." },
        { part: 3, partTitle: "Advanced Patterns", partScope: "Advanced usage." }
      ]
    });

    beforeEach(() => {
      // Tests pass articleType: "masterclass" directly, so type inference is skipped.
      // Call order: 1=research, 2=category, 3=series outline (3 total, not 4)
      let claudeCallCount = 0;
      mockCreate.mock.mockImplementation(async () => {
        claudeCallCount++;
        if (claudeCallCount === 1) {
          // research call
          return { content: [{ type: "text", text: "# Research\n\nRust ownership is fundamental." }] };
        }
        if (claudeCallCount === 2) {
          // category call
          return { content: [{ type: "text", text: JSON.stringify({ scores: { tech: 0.9 }, proposed: null }) }] };
        }
        if (claudeCallCount === 3) {
          // series outline
          return { content: [{ type: "text", text: SERIES_OUTLINE }] };
        }
        return { content: [{ type: "text", text: "" }] };
      });
    });

    it("returns series_researched status for masterclass articleType", async () => {
      const result = await handler(sqsEvent({ taskId: "t1", topic: "rust ownership", articleType: "masterclass" }));
      assert.strictEqual(result.status, "series_researched");
      assert.strictEqual(result.seriesSlug, "rust-ownership");
      assert.strictEqual(result.totalParts, 3);
    });

    it("creates one child task per part in DynamoDB", async () => {
      await handler(sqsEvent({ taskId: "t1", topic: "rust ownership", articleType: "masterclass" }));

      const putCalls = mockSend.mock.calls.filter(c => c.arguments[0].name === "PutCommand");
      assert.strictEqual(putCalls.length, 3, "Expected one PutCommand per series part");

      const firstPut = putCalls[0].arguments[0].params.Item;
      assert.strictEqual(firstPut.parentTaskId, "t1");
      assert.strictEqual(firstPut.part, 1);
      assert.strictEqual(firstPut.seriesSlug, "rust-ownership");
      assert.strictEqual(firstPut.articleType, "masterclass");
      assert.strictEqual(firstPut.status, "researched");
    });

    it("enqueues one write job per part to the WriteQueue", async () => {
      await handler(sqsEvent({ taskId: "t1", topic: "rust ownership", articleType: "masterclass" }));

      const sqsCalls = mockSend.mock.calls.filter(c => c.arguments[0].name === "SendMessageCommand");
      assert.strictEqual(sqsCalls.length, 3, "Expected one SQS message per series part");

      for (const call of sqsCalls) {
        const body = JSON.parse(call.arguments[0].params.MessageBody);
        assert.ok(body.taskId, "Each write job should have a taskId");
        assert.strictEqual(body.articleType, "masterclass");
      }
    });

    it("saves per-part research to S3 with part scope prepended", async () => {
      await handler(sqsEvent({ taskId: "t1", topic: "rust ownership", articleType: "masterclass" }));

      const s3Puts = mockSend.mock.calls.filter(c => c.arguments[0].name === "PutObjectCommand");
      // First PutObjectCommand is the shared research; subsequent ones are per-part
      assert.ok(s3Puts.length >= 4, "Expected 1 shared + 3 per-part S3 writes");

      const partPut = s3Puts[1]; // first child part
      assert.ok(partPut.arguments[0].params.Body.includes("Part 1 Scope"), "Per-part research should include scope header");
    });

    it("updates parent task to series_researched with series metadata", async () => {
      await handler(sqsEvent({ taskId: "t1", topic: "rust ownership", articleType: "masterclass" }));

      const updateCalls = mockSend.mock.calls.filter(c => c.arguments[0].name === "UpdateCommand");
      const seriesUpdate = updateCalls.find(c =>
        c.arguments[0].params.ExpressionAttributeValues[":status"] === "series_researched"
      );
      assert.ok(seriesUpdate, "Expected series_researched status update");

      const vals = seriesUpdate.arguments[0].params.ExpressionAttributeValues;
      assert.strictEqual(vals[":seriesSlug"], "rust-ownership");
      assert.strictEqual(vals[":totalParts"], 3);
    });

    it("falls back to single-part series when outline JSON is invalid", async () => {
      // articleType: "masterclass" is provided → no type inference → 3 Claude calls
      let claudeCallCount = 0;
      mockCreate.mock.mockImplementation(async () => {
        claudeCallCount++;
        if (claudeCallCount === 1) return { content: [{ type: "text", text: "# Research\n\nContent." }] };
        if (claudeCallCount === 2) return { content: [{ type: "text", text: JSON.stringify({ scores: { tech: 0.9 }, proposed: null }) }] };
        // outline call returns invalid JSON → triggers fallback
        return { content: [{ type: "text", text: "not valid json" }] };
      });

      const result = await handler(sqsEvent({ taskId: "t1", topic: "rust", articleType: "masterclass" }));
      assert.strictEqual(result.status, "series_researched");
      assert.strictEqual(result.totalParts, 1);
    });

    it("generates deterministic child task IDs (stable across retries)", async () => {
      const { createHash } = require("crypto");
      await handler(sqsEvent({ taskId: "t1", topic: "rust ownership", articleType: "masterclass" }));

      const putCalls = mockSend.mock.calls.filter(c => c.arguments[0].name === "PutCommand");
      assert.strictEqual(putCalls.length, 3);

      // Each child ID must equal sha256("t1:part:<N>").slice(0, 36)
      for (let i = 0; i < 3; i++) {
        const expectedId = createHash("sha256")
          .update(`t1:part:${i + 1}`)
          .digest("hex")
          .slice(0, 36);
        const actualId = putCalls[i].arguments[0].params.Item.taskId;
        assert.strictEqual(actualId, expectedId, `Part ${i + 1} child ID should be deterministic`);

        // S3 key must use the same deterministic ID
        const s3Puts = mockSend.mock.calls.filter(c => c.arguments[0].name === "PutObjectCommand");
        const partS3Put = s3Puts[i + 1]; // index 0 is the shared research; parts start at index 1
        assert.strictEqual(partS3Put.arguments[0].params.Key, `research/${expectedId}.md`);
      }
    });
  });
});
