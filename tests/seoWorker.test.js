const { describe, it, mock, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const { setupWorkerMocks, SEO_WORKER_PATH } = require("./test-helpers/mock-aws.js");
const {
  sqsEvent,
  runSqsValidationTests,
  runClaudeResponseTests,
  runErrorHandlingTests
} = require("./test-helpers/worker-test-utils.js");

const SAMPLE_OPTIMIZED = `---
title: "Test Post"
description: "Discover how automation and testing revolutionize modern development workflows in this deep dive."
socialTitle: "Testing & Automation: A Deep Dive"
publishDate: "2026-02-16"
hyperfixation: "tech"
researchDepth: 3
tags: ["testing", "automation", "tech", "ci-cd", "quality-assurance"]
seoKeywords: ["automated testing", "continuous integration", "software quality", "test automation tools", "modern development", "CI/CD pipelines"]
draft: true
sources:
  - "https://example.com"
---

# Test Post

This is an SEO-optimized test blog post with enhanced metadata.`;

describe("seoWorker handler", () => {
  let handler;
  let mockSend;
  let mockCreate;
  let cleanup;

  const defaultMockSend = (cmd) => {
    if (cmd.name === "GetCommand") {
      return {
        Item: {
          taskId: "t1",
          status: "edited",
          s3Key: "research/t1.md",
          draftS3Key: "drafts/t1.md",
          editedS3Key: "edited/t1.md"
        }
      };
    }
    if (cmd.name === "GetSecretValueCommand") {
      return { SecretString: "sk-ant-test-key" };
    }
    if (cmd.name === "GetObjectCommand") {
      return {
        Body: { transformToString: async () => "# Edited Post\n\nSome edited content" }
      };
    }
    return {};
  };

  beforeEach(() => {
    mockSend = mock.fn(async (cmd) => defaultMockSend(cmd));

    mockCreate = mock.fn(async () => ({
      content: [{ type: "text", text: SAMPLE_OPTIMIZED }]
    }));

    const setup = setupWorkerMocks(mockSend, mockCreate, {
      handlerPath: SEO_WORKER_PATH
    });
    handler = setup.handler;
    cleanup = setup.cleanup;
  });

  afterEach(() => {
    cleanup();
    mock.restoreAll();
  });

  // --- Shared SQS validation tests ---

  runSqsValidationTests(() => handler);

  // --- Task lookup ---

  describe("task lookup", () => {
    it("throws when task is not found in DynamoDB", async () => {
      mockSend.mock.mockImplementation(async (cmd) => {
        if (cmd.name === "GetCommand") return {};
        return {};
      });

      await assert.rejects(
        () => handler(sqsEvent({ taskId: "t1" })),
        { message: "Task t1 not found" }
      );
    });

    it("throws when task has no editedS3Key", async () => {
      mockSend.mock.mockImplementation(async (cmd) => {
        if (cmd.name === "GetCommand") {
          return { Item: { taskId: "t1", status: "edited" } };
        }
        return {};
      });

      await assert.rejects(
        () => handler(sqsEvent({ taskId: "t1" })),
        { message: "Task t1 has no edited editedS3Key" }
      );
    });

    it("marks task failed and returns on unexpected status", async () => {
      mockSend.mock.mockImplementation(async (cmd) => {
        if (cmd.name === "GetCommand") {
          return {
            Item: { taskId: "t1", status: "pending", editedS3Key: "edited/t1.md" }
          };
        }
        return {};
      });

      const result = await handler(sqsEvent({ taskId: "t1" }));
      assert.strictEqual(result, undefined);

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
    it("skips already-optimized tasks", async () => {
      mockSend.mock.mockImplementation(async (cmd) => {
        if (cmd.name === "GetCommand") {
          return {
            Item: { taskId: "t1", status: "ready", editedS3Key: "edited/t1.md" }
          };
        }
        return {};
      });

      const result = await handler(sqsEvent({ taskId: "t1" }));
      assert.strictEqual(result.status, "already_ready");
      assert.strictEqual(mockCreate.mock.calls.length, 0);
    });
  });

  // --- Happy path ---

  describe("happy path", () => {
    it("executes full pipeline in correct order", async () => {
      await handler(sqsEvent({ taskId: "t1" }));

      const callNames = mockSend.mock.calls.map(c => c.arguments[0].name);

      // Expected order: GetCommand (lookup), UpdateCommand (optimizing),
      // GetObjectCommand (fetch edited), GetSecretValueCommand,
      // PutObjectCommand (save final), UpdateCommand (ready)
      assert.strictEqual(callNames[0], "GetCommand");
      assert.strictEqual(callNames[1], "UpdateCommand");
      assert.strictEqual(callNames[2], "GetObjectCommand");
      assert.strictEqual(callNames[3], "GetSecretValueCommand");
      assert.strictEqual(callNames[4], "PutObjectCommand");
      assert.strictEqual(callNames[5], "UpdateCommand");
    });

    it("reads edited content from correct S3 key", async () => {
      await handler(sqsEvent({ taskId: "t1" }));

      const getCall = mockSend.mock.calls.find(
        c => c.arguments[0].name === "GetObjectCommand"
      );
      assert.strictEqual(getCall.arguments[0].params.Key, "edited/t1.md");
      assert.strictEqual(getCall.arguments[0].params.Bucket, "test-research-bucket");
    });

    it("writes final content to correct S3 key", async () => {
      await handler(sqsEvent({ taskId: "t1" }));

      const putCall = mockSend.mock.calls.find(
        c => c.arguments[0].name === "PutObjectCommand"
      );
      assert.strictEqual(putCall.arguments[0].params.Key, "final/t1.md");
      assert.strictEqual(putCall.arguments[0].params.Bucket, "test-research-bucket");
      assert.strictEqual(putCall.arguments[0].params.ContentType, "text/markdown");
      assert.strictEqual(putCall.arguments[0].params.Body, SAMPLE_OPTIMIZED);
    });

    it("returns taskId, finalS3Key, and ready status", async () => {
      const result = await handler(sqsEvent({ taskId: "t1" }));

      assert.strictEqual(result.taskId, "t1");
      assert.strictEqual(result.finalS3Key, "final/t1.md");
      assert.strictEqual(result.status, "ready");
    });

    it("sends edited content to Claude in user message", async () => {
      await handler(sqsEvent({ taskId: "t1" }));

      assert.strictEqual(mockCreate.mock.calls.length, 1);
      const callArgs = mockCreate.mock.calls[0].arguments[0];
      assert.ok(callArgs.messages[0].content.includes("Some edited content"));
    });

    it("updates DynamoDB with ready status and finalS3Key", async () => {
      await handler(sqsEvent({ taskId: "t1" }));

      const updateCalls = mockSend.mock.calls.filter(
        c => c.arguments[0].name === "UpdateCommand"
      );
      // Last UpdateCommand should be the "ready" status
      const readyUpdate = updateCalls[updateCalls.length - 1];
      assert.strictEqual(
        readyUpdate.arguments[0].params.ExpressionAttributeValues[":status"],
        "ready"
      );
      assert.strictEqual(
        readyUpdate.arguments[0].params.ExpressionAttributeValues[":finalS3Key"],
        "final/t1.md"
      );
    });
  });

  // --- Shared Claude response handling ---

  runClaudeResponseTests(
    () => handler,
    () => sqsEvent({ taskId: "t1" }),
    "ready",
    () => mockCreate,
    () => mockSend,
    SAMPLE_OPTIMIZED
  );

  // --- Shared + domain-specific error handling ---

  runErrorHandlingTests(
    () => handler,
    () => sqsEvent({ taskId: "t1" }),
    () => mockCreate,
    () => mockSend,
    defaultMockSend
  );

  describe("domain-specific errors", () => {
    it("marks task failed and re-throws on S3 read failure", async () => {
      mockSend.mock.mockImplementation(async (cmd) => {
        if (cmd.name === "GetCommand") {
          return {
            Item: { taskId: "t1", status: "edited", editedS3Key: "edited/t1.md" }
          };
        }
        if (cmd.name === "GetObjectCommand") {
          throw new Error("S3 bucket not found");
        }
        return {};
      });

      await assert.rejects(
        () => handler(sqsEvent({ taskId: "t1" })),
        { message: "S3 bucket not found" }
      );
    });

    it("marks task failed and re-throws on S3 write failure", async () => {
      mockSend.mock.mockImplementation(async (cmd) => {
        if (cmd.name === "GetCommand") {
          return {
            Item: { taskId: "t1", status: "edited", editedS3Key: "edited/t1.md" }
          };
        }
        if (cmd.name === "GetSecretValueCommand") {
          return { SecretString: "sk-ant-test-key" };
        }
        if (cmd.name === "GetObjectCommand") {
          return {
            Body: { transformToString: async () => "# Edited content" }
          };
        }
        if (cmd.name === "PutObjectCommand") {
          throw new Error("S3 write failed");
        }
        return {};
      });

      await assert.rejects(
        () => handler(sqsEvent({ taskId: "t1" })),
        { message: "S3 write failed" }
      );
    });
  });
});
