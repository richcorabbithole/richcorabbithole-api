/**
 * Shared test behaviors for SQS-triggered Lambda workers.
 *
 * Provides reusable test suites that every worker shares:
 *   - SQS event validation (empty Records, missing Records, malformed JSON, missing taskId)
 *   - Claude response handling (empty content, mixed content types)
 *   - Error handling (marks failed + re-throws, re-throws when status update also fails)
 *
 * All callbacks use the getX() pattern (called at test-execution time, not
 * registration time) so they access the correct mock instances from beforeEach.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert");

/**
 * Build an SQS Lambda event from a body object or raw string.
 */
function sqsEvent(body) {
  return {
    Records: [{
      body: typeof body === "string" ? body : JSON.stringify(body)
    }]
  };
}

/**
 * Register shared SQS event validation tests.
 *
 * @param {() => Function} getHandler - Returns the handler function
 */
function runSqsValidationTests(getHandler) {
  describe("SQS event validation", () => {
    it("returns undefined on empty Records array", async () => {
      const result = await getHandler()({ Records: [] });
      assert.strictEqual(result, undefined);
    });

    it("returns undefined on missing Records", async () => {
      const result = await getHandler()({});
      assert.strictEqual(result, undefined);
    });

    it("throws on malformed JSON body for DLQ", async () => {
      await assert.rejects(
        () => getHandler()({ Records: [{ body: "not json" }] }),
        { message: "Malformed SQS message body" }
      );
    });

    it("throws on missing taskId for DLQ", async () => {
      await assert.rejects(
        () => getHandler()(sqsEvent({})),
        { message: "Missing taskId in SQS message" }
      );
    });
  });
}

/**
 * Register shared Claude response handling tests.
 *
 * @param {() => Function} getHandler - Returns the handler function
 * @param {() => object} makeEvent - Returns an SQS event that reaches the Claude call
 * @param {string} expectedStatus - The status value on successful return (e.g. "researched", "drafted")
 * @param {() => object} getMockCreate - Returns the mockCreate mock.fn()
 * @param {() => object} getMockSend - Returns the mockSend mock.fn()
 * @param {string} expectedBody - The text body expected in the PutObjectCommand on success
 */
function runClaudeResponseTests(getHandler, makeEvent, expectedStatus, getMockCreate, getMockSend, expectedBody) {
  describe("Claude response handling", () => {
    it("throws when Claude returns empty content array", async () => {
      getMockCreate().mock.mockImplementation(async () => ({
        content: []
      }));

      await assert.rejects(
        () => getHandler()(makeEvent()),
        { message: "Claude returned no text content" }
      );
    });

    it("finds text block among mixed content types", async () => {
      getMockCreate().mock.mockImplementation(async () => ({
        content: [
          { type: "tool_use", id: "123", name: "test" },
          { type: "text", text: expectedBody }
        ]
      }));

      const result = await getHandler()(makeEvent());
      assert.strictEqual(result.status, expectedStatus);

      const putCall = getMockSend().mock.calls.find(
        c => c.arguments[0].name === "PutObjectCommand"
      );
      assert.strictEqual(putCall.arguments[0].params.Body, expectedBody);
    });
  });
}

/**
 * Register shared error handling tests.
 *
 * @param {() => Function} getHandler - Returns the handler function
 * @param {() => object} makeEvent - Returns an SQS event that reaches the Claude call
 * @param {() => object} getMockCreate - Returns the mockCreate mock.fn()
 * @param {() => object} getMockSend - Returns the mockSend mock.fn()
 * @param {(cmd: object) => any} buildDefaultMockSend - Default mockSend implementation for the specific worker
 */
function runErrorHandlingTests(getHandler, makeEvent, getMockCreate, getMockSend, buildDefaultMockSend) {
  describe("error handling", () => {
    it("marks task failed and re-throws on Claude API failure", async () => {
      getMockCreate().mock.mockImplementation(async () => {
        throw new Error("API rate limited");
      });

      await assert.rejects(
        () => getHandler()(makeEvent()),
        { message: "API rate limited" }
      );

      const updateCalls = getMockSend().mock.calls.filter(
        c => c.arguments[0].name === "UpdateCommand"
      );
      const failedUpdate = updateCalls.find(
        c => c.arguments[0].params.ExpressionAttributeValues[":status"] === "failed"
      );
      assert.ok(failedUpdate, "Expected task to be marked as failed");
    });

    it("re-throws original error even when status update fails", async () => {
      let updateCallCount = 0;
      getMockSend().mock.mockImplementation(async (cmd) => {
        if (cmd.name === "UpdateCommand") {
          updateCallCount++;
          if (updateCallCount >= 2) {
            throw new Error("DynamoDB down too");
          }
          return {};
        }
        return buildDefaultMockSend(cmd);
      });

      getMockCreate().mock.mockImplementation(async () => {
        throw new Error("Original Claude error");
      });

      await assert.rejects(
        () => getHandler()(makeEvent()),
        { message: "Original Claude error" }
      );
    });
  });
}

module.exports = {
  sqsEvent,
  runSqsValidationTests,
  runClaudeResponseTests,
  runErrorHandlingTests
};
