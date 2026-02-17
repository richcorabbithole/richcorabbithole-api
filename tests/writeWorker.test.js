const { describe, it, mock, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const { setupWorkerMocks, WRITE_WORKER_PATH } = require("./test-helpers/mock-aws.js");
const {
  sqsEvent,
  runSqsValidationTests,
  runClaudeResponseTests,
  runErrorHandlingTests
} = require("./test-helpers/worker-test-utils.js");

const SAMPLE_DRAFT = `---
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

This is a test blog post.`;

describe("writeWorker handler", () => {
  let handler;
  let mockSend;
  let mockCreate;
  let cleanup;

  const defaultMockSend = (cmd) => {
    if (cmd.name === "GetCommand") {
      return {
        Item: {
          taskId: "t1",
          status: "researched",
          s3Key: "research/t1.md"
        }
      };
    }
    if (cmd.name === "GetSecretValueCommand") {
      return { SecretString: "sk-ant-test-key" };
    }
    if (cmd.name === "GetObjectCommand") {
      return {
        Body: { transformToString: async () => "# Research\n\nSome research content" }
      };
    }
    return {};
  };

  beforeEach(() => {
    mockSend = mock.fn(async (cmd) => defaultMockSend(cmd));

    mockCreate = mock.fn(async () => ({
      content: [{ type: "text", text: SAMPLE_DRAFT }]
    }));

    const setup = setupWorkerMocks(mockSend, mockCreate, {
      handlerPath: WRITE_WORKER_PATH,
      extraS3Commands: {
        CopyObjectCommand: class CopyObjectCommand {
          constructor(params) { this.params = params; this.name = "CopyObjectCommand"; }
        }
      }
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

    it("throws when task has no research s3Key", async () => {
      mockSend.mock.mockImplementation(async (cmd) => {
        if (cmd.name === "GetCommand") {
          return { Item: { taskId: "t1", status: "researched" } };
        }
        return {};
      });

      await assert.rejects(
        () => handler(sqsEvent({ taskId: "t1" })),
        { message: "Task t1 has no research s3Key" }
      );
    });

    it("marks task failed and returns on unexpected status", async () => {
      mockSend.mock.mockImplementation(async (cmd) => {
        if (cmd.name === "GetCommand") {
          return {
            Item: { taskId: "t1", status: "pending", s3Key: "research/t1.md" }
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
    it("skips already-drafted tasks", async () => {
      mockSend.mock.mockImplementation(async (cmd) => {
        if (cmd.name === "GetCommand") {
          return {
            Item: { taskId: "t1", status: "drafted", s3Key: "research/t1.md" }
          };
        }
        return {};
      });

      const result = await handler(sqsEvent({ taskId: "t1" }));
      assert.strictEqual(result.status, "already_processed");
      assert.strictEqual(mockCreate.mock.calls.length, 0);
    });

    it("skips tasks that have progressed to editing", async () => {
      mockSend.mock.mockImplementation(async (cmd) => {
        if (cmd.name === "GetCommand") {
          return {
            Item: { taskId: "t1", status: "editing", s3Key: "research/t1.md" }
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
            Item: { taskId: "t1", status: "ready", s3Key: "research/t1.md" }
          };
        }
        return {};
      });

      const result = await handler(sqsEvent({ taskId: "t1" }));
      assert.strictEqual(result.status, "already_processed");
      assert.strictEqual(mockCreate.mock.calls.length, 0);
    });

    it("allows retry when status is writing (SQS retry after crash)", async () => {
      mockSend.mock.mockImplementation(async (cmd) => {
        if (cmd.name === "GetCommand") {
          return {
            Item: { taskId: "t1", status: "writing", s3Key: "research/t1.md" }
          };
        }
        return defaultMockSend(cmd);
      });

      const result = await handler(sqsEvent({ taskId: "t1" }));

      // Should complete successfully, not mark as failed
      assert.strictEqual(result.status, "drafted");
      assert.strictEqual(mockCreate.mock.calls.length, 1);
    });
  });

  // --- First draft happy path ---

  describe("first draft happy path", () => {
    it("executes full pipeline in correct order", async () => {
      await handler(sqsEvent({ taskId: "t1" }));

      const callNames = mockSend.mock.calls.map(c => c.arguments[0].name);

      // Expected order: GetCommand (lookup), UpdateCommand (writing),
      // GetObjectCommand (fetch research), GetSecretValueCommand,
      // PutObjectCommand (save draft), UpdateCommand (drafted),
      // SendMessageCommand (enqueue edit)
      assert.strictEqual(callNames[0], "GetCommand");
      assert.strictEqual(callNames[1], "UpdateCommand");
      assert.strictEqual(callNames[2], "GetObjectCommand");
      assert.strictEqual(callNames[3], "GetSecretValueCommand");
      assert.strictEqual(callNames[4], "PutObjectCommand");
      assert.strictEqual(callNames[5], "UpdateCommand");
      assert.strictEqual(callNames[6], "SendMessageCommand");
    });

    it("reads research from correct S3 key", async () => {
      await handler(sqsEvent({ taskId: "t1" }));

      const getCall = mockSend.mock.calls.find(
        c => c.arguments[0].name === "GetObjectCommand"
      );
      assert.strictEqual(getCall.arguments[0].params.Key, "research/t1.md");
      assert.strictEqual(getCall.arguments[0].params.Bucket, "test-research-bucket");
    });

    it("writes draft to correct S3 key", async () => {
      await handler(sqsEvent({ taskId: "t1" }));

      const putCall = mockSend.mock.calls.find(
        c => c.arguments[0].name === "PutObjectCommand"
      );
      assert.strictEqual(putCall.arguments[0].params.Key, "drafts/t1.md");
      assert.strictEqual(putCall.arguments[0].params.Bucket, "test-research-bucket");
      assert.strictEqual(putCall.arguments[0].params.ContentType, "text/markdown");
      assert.strictEqual(putCall.arguments[0].params.Body, SAMPLE_DRAFT);
    });

    it("returns taskId, draftS3Key, drafted status, and revisionCount 0", async () => {
      const result = await handler(sqsEvent({ taskId: "t1" }));

      assert.strictEqual(result.taskId, "t1");
      assert.strictEqual(result.draftS3Key, "drafts/t1.md");
      assert.strictEqual(result.status, "drafted");
      assert.strictEqual(result.revisionCount, 0);
    });

    it("sends research content to Claude in user message", async () => {
      await handler(sqsEvent({ taskId: "t1" }));

      assert.strictEqual(mockCreate.mock.calls.length, 1);
      const callArgs = mockCreate.mock.calls[0].arguments[0];
      assert.ok(callArgs.messages[0].content.includes("Some research content"));
    });

    it("updates DynamoDB with drafted status and draftS3Key", async () => {
      await handler(sqsEvent({ taskId: "t1" }));

      const updateCalls = mockSend.mock.calls.filter(
        c => c.arguments[0].name === "UpdateCommand"
      );
      // Last UpdateCommand should be the "drafted" status
      const draftedUpdate = updateCalls[updateCalls.length - 1];
      assert.strictEqual(
        draftedUpdate.arguments[0].params.ExpressionAttributeValues[":status"],
        "drafted"
      );
      assert.strictEqual(
        draftedUpdate.arguments[0].params.ExpressionAttributeValues[":draftS3Key"],
        "drafts/t1.md"
      );
    });

    it("enqueues edit job to EditQueue after drafting", async () => {
      await handler(sqsEvent({ taskId: "t1" }));

      const sendCall = mockSend.mock.calls.find(
        c => c.arguments[0].name === "SendMessageCommand"
      );
      assert.ok(sendCall, "Expected a SendMessageCommand call");
      assert.strictEqual(
        sendCall.arguments[0].params.QueueUrl,
        "https://sqs.us-east-1.amazonaws.com/123456789/test-edit-queue"
      );
      const msgBody = JSON.parse(sendCall.arguments[0].params.MessageBody);
      assert.strictEqual(msgBody.taskId, "t1");
    });

    it("returns successfully when edit queue enqueue fails", async () => {
      mockSend.mock.mockImplementation(async (cmd) => {
        if (cmd.name === "SendMessageCommand") {
          throw new Error("SQS send failed");
        }
        return defaultMockSend(cmd);
      });

      const result = await handler(sqsEvent({ taskId: "t1" }));
      assert.strictEqual(result.status, "drafted");
    });
  });

  // --- Revision flow ---

  describe("revision flow", () => {
    beforeEach(() => {
      mockSend.mock.mockImplementation(async (cmd) => {
        if (cmd.name === "GetCommand") {
          return {
            Item: {
              taskId: "t1",
              status: "revision_requested",
              s3Key: "research/t1.md",
              draftS3Key: "drafts/t1.md",
              revisionNotes: "Make it more opinionated",
              revisionCount: 1
            }
          };
        }
        if (cmd.name === "GetSecretValueCommand") {
          return { SecretString: "sk-ant-test-key" };
        }
        if (cmd.name === "GetObjectCommand") {
          return {
            Body: { transformToString: async () => "# Existing content" }
          };
        }
        return {};
      });
    });

    it("archives previous draft before overwriting", async () => {
      await handler(sqsEvent({ taskId: "t1" }));

      const copyCall = mockSend.mock.calls.find(
        c => c.arguments[0].name === "CopyObjectCommand"
      );
      assert.ok(copyCall, "Expected a CopyObjectCommand call");
      assert.strictEqual(copyCall.arguments[0].params.Key, "drafts/t1.rev1.md");
      assert.strictEqual(
        copyCall.arguments[0].params.CopySource,
        "test-research-bucket/drafts/t1.md"
      );
    });

    it("sends research, current draft, and revision notes to Claude", async () => {
      await handler(sqsEvent({ taskId: "t1" }));

      const callArgs = mockCreate.mock.calls[0].arguments[0];
      const userContent = callArgs.messages[0].content;
      assert.ok(userContent.includes("Original Research"));
      assert.ok(userContent.includes("Current Draft"));
      assert.ok(userContent.includes("Revision Notes"));
      assert.ok(userContent.includes("Make it more opinionated"));
    });

    it("increments revisionCount", async () => {
      const result = await handler(sqsEvent({ taskId: "t1" }));

      assert.strictEqual(result.revisionCount, 2);
    });

    it("uses default revision notes when none provided", async () => {
      mockSend.mock.mockImplementation(async (cmd) => {
        if (cmd.name === "GetCommand") {
          return {
            Item: {
              taskId: "t1",
              status: "revision_requested",
              s3Key: "research/t1.md",
              draftS3Key: "drafts/t1.md",
              revisionCount: 0
            }
          };
        }
        if (cmd.name === "GetSecretValueCommand") {
          return { SecretString: "sk-ant-test-key" };
        }
        if (cmd.name === "GetObjectCommand") {
          return {
            Body: { transformToString: async () => "# Content" }
          };
        }
        return {};
      });

      await handler(sqsEvent({ taskId: "t1" }));

      const callArgs = mockCreate.mock.calls[0].arguments[0];
      assert.ok(callArgs.messages[0].content.includes("No specific notes provided"));
    });
  });

  // --- Shared Claude response handling ---

  runClaudeResponseTests(
    () => handler,
    () => sqsEvent({ taskId: "t1" }),
    "drafted",
    () => mockCreate,
    () => mockSend,
    SAMPLE_DRAFT
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
            Item: { taskId: "t1", status: "researched", s3Key: "research/t1.md" }
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
            Item: { taskId: "t1", status: "researched", s3Key: "research/t1.md" }
          };
        }
        if (cmd.name === "GetSecretValueCommand") {
          return { SecretString: "sk-ant-test-key" };
        }
        if (cmd.name === "GetObjectCommand") {
          return {
            Body: { transformToString: async () => "# Research content" }
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
