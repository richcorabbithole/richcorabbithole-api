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
    it("skips already-researched tasks", async () => {
      mockSend.mock.mockImplementation(async (cmd) => {
        if (cmd.name === "GetCommand") {
          return { Item: { taskId: "t1", status: "researched" } };
        }
        return {};
      });

      const result = await handler(sqsEvent({ taskId: "t1", topic: "test" }));

      assert.strictEqual(result.status, "already_researched");
      // Claude should NOT have been called
      assert.strictEqual(mockCreate.mock.calls.length, 0);
    });

    it("processes pending task normally", async () => {
      const result = await handler(sqsEvent({ taskId: "t1", topic: "test" }));

      assert.strictEqual(result.status, "researched");
      assert.strictEqual(mockCreate.mock.calls.length, 1);
    });
  });

  // --- Happy path ---

  describe("happy path", () => {
    it("executes full pipeline in correct order", async () => {
      await handler(sqsEvent({ taskId: "t1", topic: "test topic" }));

      const callNames = mockSend.mock.calls.map(c => c.arguments[0].name);

      // Expected order: GetCommand (idempotency), UpdateCommand (researching),
      // GetSecretValueCommand, PutObjectCommand (S3), UpdateCommand (researched)
      assert.strictEqual(callNames[0], "GetCommand");
      assert.strictEqual(callNames[1], "UpdateCommand");
      assert.strictEqual(callNames[2], "GetSecretValueCommand");
      assert.strictEqual(callNames[3], "PutObjectCommand");
      assert.strictEqual(callNames[4], "UpdateCommand");
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
});
