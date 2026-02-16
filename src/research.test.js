const { describe, it, mock, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const { setupResearchMocks } = require("./test-helpers/mock-aws.js");

describe("research accept handler", () => {
  let handler;
  let mockSend;
  let cleanup;

  beforeEach(() => {
    mockSend = mock.fn(async () => ({}));
    const setup = setupResearchMocks(mockSend);
    handler = setup.handler;
    cleanup = setup.cleanup;
  });

  afterEach(() => {
    cleanup();
    mock.restoreAll();
  });

  // --- Input validation ---

  describe("input validation", () => {
    it("rejects malformed JSON body", async () => {
      const result = await handler({ body: "not json" });

      assert.strictEqual(result.statusCode, 400);
      const body = JSON.parse(result.body);
      assert.match(body.error, /Invalid JSON/);
    });

    it("rejects missing body", async () => {
      const result = await handler({});

      assert.strictEqual(result.statusCode, 400);
      const body = JSON.parse(result.body);
      assert.match(body.error, /topic/);
    });

    it("rejects empty object with no topic", async () => {
      const result = await handler({ body: JSON.stringify({}) });

      assert.strictEqual(result.statusCode, 400);
      const body = JSON.parse(result.body);
      assert.match(body.error, /topic/);
    });

    it("rejects non-string topic", async () => {
      const result = await handler({ body: JSON.stringify({ topic: 123 }) });

      assert.strictEqual(result.statusCode, 400);
      const body = JSON.parse(result.body);
      assert.match(body.error, /string/);
    });

    it("rejects topic over 500 characters", async () => {
      const result = await handler({
        body: JSON.stringify({ topic: "a".repeat(501) })
      });

      assert.strictEqual(result.statusCode, 400);
      const body = JSON.parse(result.body);
      assert.match(body.error, /500/);
    });

    it("accepts topic at exactly 500 characters", async () => {
      const result = await handler({
        body: JSON.stringify({ topic: "a".repeat(500) })
      });

      assert.strictEqual(result.statusCode, 202);
    });
  });

  // --- Happy path ---

  describe("happy path", () => {
    it("returns 202 with taskId and pending status", async () => {
      const result = await handler({
        body: JSON.stringify({ topic: "test topic" })
      });

      assert.strictEqual(result.statusCode, 202);
      const body = JSON.parse(result.body);
      assert.strictEqual(body.taskId, "test-task-id-1234");
      assert.strictEqual(body.status, "pending");
      assert.ok(body.message);
    });

    it("creates DynamoDB record with correct fields", async () => {
      await handler({ body: JSON.stringify({ topic: "test topic" }) });

      // First send call is PutCommand (DynamoDB)
      const putCall = mockSend.mock.calls[0];
      const params = putCall.arguments[0].params;
      assert.strictEqual(params.TableName, "test-tasks-table");
      assert.strictEqual(params.Item.taskId, "test-task-id-1234");
      assert.strictEqual(params.Item.status, "pending");
      assert.strictEqual(params.Item.topic, "test topic");
      assert.ok(params.Item.createdAt);
      assert.ok(params.Item.updatedAt);
    });

    it("sends SQS message with taskId and topic", async () => {
      await handler({ body: JSON.stringify({ topic: "test topic" }) });

      // Second send call is SendMessageCommand (SQS)
      const sqsCall = mockSend.mock.calls[1];
      const params = sqsCall.arguments[0].params;
      assert.strictEqual(params.QueueUrl, process.env.RESEARCH_QUEUE_URL);
      const messageBody = JSON.parse(params.MessageBody);
      assert.strictEqual(messageBody.taskId, "test-task-id-1234");
      assert.strictEqual(messageBody.topic, "test topic");
    });
  });

  // --- Error handling ---

  describe("error handling", () => {
    it("returns 500 when DynamoDB PutCommand fails", async () => {
      mockSend.mock.mockImplementation(async () => {
        throw new Error("DynamoDB unavailable");
      });

      const result = await handler({
        body: JSON.stringify({ topic: "test topic" })
      });

      assert.strictEqual(result.statusCode, 500);
      const body = JSON.parse(result.body);
      assert.match(body.error, /Failed to create task record/);
    });

    it("marks task as failed when SQS send fails", async () => {
      let callIndex = 0;
      mockSend.mock.mockImplementation(async () => {
        callIndex++;
        if (callIndex === 2) {
          throw new Error("SQS unavailable");
        }
        return {};
      });

      const result = await handler({
        body: JSON.stringify({ topic: "test topic" })
      });

      assert.strictEqual(result.statusCode, 500);

      // Third call should be UpdateCommand marking task as failed
      assert.strictEqual(mockSend.mock.calls.length, 3);
      const updateCall = mockSend.mock.calls[2];
      assert.strictEqual(updateCall.arguments[0].name, "UpdateCommand");
      assert.match(
        updateCall.arguments[0].params.ExpressionAttributeValues[":status"],
        /failed/
      );
    });

    it("returns 500 even when DynamoDB update also fails after SQS failure", async () => {
      let callIndex = 0;
      mockSend.mock.mockImplementation(async () => {
        callIndex++;
        if (callIndex >= 2) {
          throw new Error("Everything is broken");
        }
        return {};
      });

      const result = await handler({
        body: JSON.stringify({ topic: "test topic" })
      });

      // Should not crash — returns 500 gracefully
      assert.strictEqual(result.statusCode, 500);
    });
  });
});
