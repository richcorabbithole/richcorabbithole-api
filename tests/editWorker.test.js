const { describe, it, mock, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const { setupWorkerMocks, EDIT_WORKER_PATH } = require("./test-helpers/mock-aws.js");
const {
  sqsEvent,
  runSqsValidationTests,
  runClaudeResponseTests,
  runErrorHandlingTests
} = require("./test-helpers/worker-test-utils.js");

const SAMPLE_EDITED = `---
title: "Test Post"
description: "A test post about testing"
publishDate: "2026-02-16"
hyperfixation: "tech"
researchDepth: 3
tags: ["testing", "automation", "tech"]
draft: true
sources:
  - "https://example.com"
---

# Test Post

This is an improved test blog post with better flow and clarity.`;

describe("editWorker handler", () => {
  let handler;
  let mockSend;
  let mockCreate;
  let cleanup;

  const defaultMockSend = (cmd) => {
    if (cmd.name === "GetCommand") {
      return {
        Item: {
          taskId: "t1",
          status: "drafted",
          s3Key: "research/t1.md",
          draftS3Key: "drafts/t1.md"
        }
      };
    }
    if (cmd.name === "GetSecretValueCommand") {
      return { SecretString: "sk-ant-test-key" };
    }
    if (cmd.name === "GetObjectCommand") {
      return {
        Body: { transformToString: async () => "# Draft\n\nSome draft content" }
      };
    }
    return {};
  };

  beforeEach(() => {
    mockSend = mock.fn(async (cmd) => defaultMockSend(cmd));

    mockCreate = mock.fn(async () => ({
      content: [{ type: "text", text: SAMPLE_EDITED }]
    }));

    const setup = setupWorkerMocks(mockSend, mockCreate, {
      handlerPath: EDIT_WORKER_PATH
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

    it("throws when task has no draftS3Key", async () => {
      mockSend.mock.mockImplementation(async (cmd) => {
        if (cmd.name === "GetCommand") {
          return { Item: { taskId: "t1", status: "drafted" } };
        }
        return {};
      });

      await assert.rejects(
        () => handler(sqsEvent({ taskId: "t1" })),
        { message: "Task t1 has no draft draftS3Key" }
      );
    });

    it("marks task failed and returns on unexpected status", async () => {
      mockSend.mock.mockImplementation(async (cmd) => {
        if (cmd.name === "GetCommand") {
          return {
            Item: { taskId: "t1", status: "pending", draftS3Key: "drafts/t1.md" }
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
    it("skips already-edited tasks", async () => {
      mockSend.mock.mockImplementation(async (cmd) => {
        if (cmd.name === "GetCommand") {
          return {
            Item: { taskId: "t1", status: "edited", draftS3Key: "drafts/t1.md" }
          };
        }
        return {};
      });

      const result = await handler(sqsEvent({ taskId: "t1" }));
      assert.strictEqual(result.status, "already_processed");
      assert.strictEqual(mockCreate.mock.calls.length, 0);
    });

    it("skips tasks that have progressed to optimizing", async () => {
      mockSend.mock.mockImplementation(async (cmd) => {
        if (cmd.name === "GetCommand") {
          return {
            Item: { taskId: "t1", status: "optimizing", draftS3Key: "drafts/t1.md" }
          };
        }
        return {};
      });

      const result = await handler(sqsEvent({ taskId: "t1" }));
      assert.strictEqual(result.status, "already_processed");
      assert.strictEqual(mockCreate.mock.calls.length, 0);
    });

    it("skips tasks that have progressed to ready", async () => {
      mockSend.mock.mockImplementation(async (cmd) => {
        if (cmd.name === "GetCommand") {
          return {
            Item: { taskId: "t1", status: "ready", draftS3Key: "drafts/t1.md" }
          };
        }
        return {};
      });

      const result = await handler(sqsEvent({ taskId: "t1" }));
      assert.strictEqual(result.status, "already_processed");
      assert.strictEqual(mockCreate.mock.calls.length, 0);
    });

    it("allows retry when status is editing (SQS retry after crash)", async () => {
      mockSend.mock.mockImplementation(async (cmd) => {
        if (cmd.name === "GetCommand") {
          return {
            Item: { taskId: "t1", status: "editing", draftS3Key: "drafts/t1.md" }
          };
        }
        return defaultMockSend(cmd);
      });

      const result = await handler(sqsEvent({ taskId: "t1" }));

      // Should complete successfully, not mark as failed
      assert.strictEqual(result.status, "edited");
      assert.strictEqual(mockCreate.mock.calls.length, 1);
    });
  });

  // --- Happy path ---

  describe("happy path", () => {
    it("executes full pipeline in correct order", async () => {
      await handler(sqsEvent({ taskId: "t1" }));

      const callNames = mockSend.mock.calls.map(c => c.arguments[0].name);

      // Expected order: GetCommand (lookup), UpdateCommand (editing),
      // GetObjectCommand (fetch draft), GetSecretValueCommand,
      // PutObjectCommand (save edited), UpdateCommand (edited),
      // SendMessageCommand (enqueue SEO)
      assert.strictEqual(callNames[0], "GetCommand");
      assert.strictEqual(callNames[1], "UpdateCommand");
      assert.strictEqual(callNames[2], "GetObjectCommand");
      assert.strictEqual(callNames[3], "GetSecretValueCommand");
      assert.strictEqual(callNames[4], "PutObjectCommand");
      assert.strictEqual(callNames[5], "UpdateCommand");
      assert.strictEqual(callNames[6], "SendMessageCommand");
    });

    it("reads draft from correct S3 key", async () => {
      await handler(sqsEvent({ taskId: "t1" }));

      const getCall = mockSend.mock.calls.find(
        c => c.arguments[0].name === "GetObjectCommand"
      );
      assert.strictEqual(getCall.arguments[0].params.Key, "drafts/t1.md");
      assert.strictEqual(getCall.arguments[0].params.Bucket, "test-research-bucket");
    });

    it("writes edited content to correct S3 key", async () => {
      await handler(sqsEvent({ taskId: "t1" }));

      const putCall = mockSend.mock.calls.find(
        c => c.arguments[0].name === "PutObjectCommand"
      );
      assert.strictEqual(putCall.arguments[0].params.Key, "edited/t1.md");
      assert.strictEqual(putCall.arguments[0].params.Bucket, "test-research-bucket");
      assert.strictEqual(putCall.arguments[0].params.ContentType, "text/markdown");
      assert.strictEqual(putCall.arguments[0].params.Body, SAMPLE_EDITED);
    });

    it("returns taskId, editedS3Key, and edited status", async () => {
      const result = await handler(sqsEvent({ taskId: "t1" }));

      assert.strictEqual(result.taskId, "t1");
      assert.strictEqual(result.editedS3Key, "edited/t1.md");
      assert.strictEqual(result.status, "edited");
    });

    it("sends draft content to Claude in user message", async () => {
      await handler(sqsEvent({ taskId: "t1" }));

      assert.strictEqual(mockCreate.mock.calls.length, 1);
      const callArgs = mockCreate.mock.calls[0].arguments[0];
      assert.ok(callArgs.messages[0].content.includes("Some draft content"));
    });

    it("updates DynamoDB with edited status and editedS3Key", async () => {
      await handler(sqsEvent({ taskId: "t1" }));

      const updateCalls = mockSend.mock.calls.filter(
        c => c.arguments[0].name === "UpdateCommand"
      );
      // Last UpdateCommand should be the "edited" status
      const editedUpdate = updateCalls[updateCalls.length - 1];
      assert.strictEqual(
        editedUpdate.arguments[0].params.ExpressionAttributeValues[":status"],
        "edited"
      );
      assert.strictEqual(
        editedUpdate.arguments[0].params.ExpressionAttributeValues[":editedS3Key"],
        "edited/t1.md"
      );
    });

    it("enqueues SEO job to SeoQueue after editing", async () => {
      await handler(sqsEvent({ taskId: "t1" }));

      const sendCall = mockSend.mock.calls.find(
        c => c.arguments[0].name === "SendMessageCommand"
      );
      assert.ok(sendCall, "Expected a SendMessageCommand call");
      assert.strictEqual(
        sendCall.arguments[0].params.QueueUrl,
        "https://sqs.us-east-1.amazonaws.com/123456789/test-seo-queue"
      );
      const msgBody = JSON.parse(sendCall.arguments[0].params.MessageBody);
      assert.strictEqual(msgBody.taskId, "t1");
    });

    it("returns successfully when SEO queue enqueue fails", async () => {
      let callCount = 0;
      mockSend.mock.mockImplementation(async (cmd) => {
        if (cmd.name === "SendMessageCommand") {
          throw new Error("SQS send failed");
        }
        return defaultMockSend(cmd);
      });

      const result = await handler(sqsEvent({ taskId: "t1" }));
      assert.strictEqual(result.status, "edited");
    });
  });

  // --- Shared Claude response handling ---

  runClaudeResponseTests(
    () => handler,
    () => sqsEvent({ taskId: "t1" }),
    "edited",
    () => mockCreate,
    () => mockSend,
    SAMPLE_EDITED
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
            Item: { taskId: "t1", status: "drafted", draftS3Key: "drafts/t1.md" }
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
            Item: { taskId: "t1", status: "drafted", draftS3Key: "drafts/t1.md" }
          };
        }
        if (cmd.name === "GetSecretValueCommand") {
          return { SecretString: "sk-ant-test-key" };
        }
        if (cmd.name === "GetObjectCommand") {
          return {
            Body: { transformToString: async () => "# Draft content" }
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
