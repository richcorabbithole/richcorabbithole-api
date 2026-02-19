/**
 * Tests for CLI approval commands (approve / reject).
 *
 * The CLI is a script that auto-calls main() on require, so we stub process.argv
 * to give it a no-op command and stub process.exit to prevent early termination.
 * After requiring, we call the exported setApprovalCommand directly with mocked
 * AWS SDK clients injected via require.cache.
 */

const { describe, it, mock, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const path = require("path");

const CLI_PATH = path.resolve(__dirname, "../scripts/cli.js");
const DYNAMO_PATH = require.resolve("@aws-sdk/client-dynamodb");
const LIB_DYNAMO_PATH = require.resolve("@aws-sdk/lib-dynamodb");

function fakeCacheEntry(modulePath, exports) {
  return { id: modulePath, filename: modulePath, loaded: true, exports };
}

describe("CLI approval commands", () => {
  let mockSend;
  let originalArgv;
  let originalExit;
  let exitCode;
  let setApprovalCommand;

  beforeEach(() => {
    // Stub process.argv so main() sees no command and exits cleanly
    originalArgv = process.argv;
    process.argv = ["node", "cli.js"];

    // Stub process.exit so the "no command" path doesn't kill the test runner
    originalExit = process.exit;
    process.exit = (code) => { exitCode = code; };
    exitCode = undefined;

    mockSend = mock.fn(async (cmd) => {
      if (cmd.name === "GetCommand") {
        return {
          Item: {
            taskId: "task-abc",
            topic: "quantum computing",
            status: "published",
            prUrl: "https://github.com/richcorabbithole/richcorabbithole-site/pull/42"
          }
        };
      }
      return {};
    });

    // Fake DynamoDB clients
    require.cache[DYNAMO_PATH] = fakeCacheEntry(DYNAMO_PATH, {
      DynamoDBClient: class {
        send(cmd) { return mockSend(cmd); }
      }
    });
    require.cache[LIB_DYNAMO_PATH] = fakeCacheEntry(LIB_DYNAMO_PATH, {
      DynamoDBDocumentClient: {
        from: () => ({ send: (cmd) => mockSend(cmd) })
      },
      GetCommand: class GetCommand {
        constructor(params) { this.params = params; this.name = "GetCommand"; }
      },
      UpdateCommand: class UpdateCommand {
        constructor(params) { this.params = params; this.name = "UpdateCommand"; }
      }
    });

    // Stub other SDK modules the CLI imports at module scope
    const sqsPath = require.resolve("@aws-sdk/client-sqs");
    require.cache[sqsPath] = fakeCacheEntry(sqsPath, {
      SQSClient: class { send() {} },
      SendMessageCommand: class { constructor(p) { this.params = p; } },
      GetQueueUrlCommand: class { constructor(p) { this.params = p; } }
    });
    const s3Path = require.resolve("@aws-sdk/client-s3");
    require.cache[s3Path] = fakeCacheEntry(s3Path, {
      S3Client: class { send() {} },
      GetObjectCommand: class { constructor(p) { this.params = p; } }
    });

    // TABLE_NAME is read at module scope from process.env
    process.env.TABLE_NAME = "test-tasks-table";

    // Load CLI with fakes in place; main() runs but exits silently on missing command
    delete require.cache[CLI_PATH];
    ({ setApprovalCommand } = require(CLI_PATH));
  });

  afterEach(() => {
    process.argv = originalArgv;
    process.exit = originalExit;

    delete require.cache[CLI_PATH];
    delete require.cache[DYNAMO_PATH];
    delete require.cache[LIB_DYNAMO_PATH];

    const sqsPath = require.resolve("@aws-sdk/client-sqs");
    const s3Path = require.resolve("@aws-sdk/client-s3");
    delete require.cache[sqsPath];
    delete require.cache[s3Path];

    delete process.env.TABLE_NAME;

    mock.restoreAll();
  });

  describe("approve", () => {
    it("issues GetCommand then UpdateCommand with approval=approved", async () => {
      await setApprovalCommand("task-abc", "approved");

      const calls = mockSend.mock.calls.map(c => c.arguments[0]);
      assert.strictEqual(calls[0].name, "GetCommand");
      assert.deepStrictEqual(calls[0].params.Key, { taskId: "task-abc" });

      const update = calls.find(c => c.name === "UpdateCommand");
      assert.ok(update, "Expected an UpdateCommand");
      assert.deepStrictEqual(update.params.Key, { taskId: "task-abc" });
      assert.strictEqual(update.params.ExpressionAttributeValues[":decision"], "approved");
      assert.ok(
        update.params.ExpressionAttributeNames["#ts"] === "approvedAt",
        "Timestamp field should be approvedAt"
      );
      assert.ok(
        update.params.ExpressionAttributeValues[":now"],
        "Expected a timestamp value for :now"
      );
    });

    it("exits with code 1 when task is not found", async () => {
      mockSend = mock.fn(async () => ({ Item: null }));
      // Re-inject updated mockSend
      require.cache[DYNAMO_PATH] = fakeCacheEntry(DYNAMO_PATH, {
        DynamoDBClient: class { send(cmd) { return mockSend(cmd); } }
      });
      require.cache[LIB_DYNAMO_PATH] = fakeCacheEntry(LIB_DYNAMO_PATH, {
        DynamoDBDocumentClient: { from: () => ({ send: (cmd) => mockSend(cmd) }) },
        GetCommand: class GetCommand { constructor(p) { this.params = p; this.name = "GetCommand"; } },
        UpdateCommand: class UpdateCommand { constructor(p) { this.params = p; this.name = "UpdateCommand"; } }
      });

      delete require.cache[CLI_PATH];
      ({ setApprovalCommand } = require(CLI_PATH));

      await setApprovalCommand("missing-task", "approved");
      assert.strictEqual(exitCode, 1);
    });
  });

  describe("reject", () => {
    it("issues GetCommand then UpdateCommand with approval=rejected", async () => {
      await setApprovalCommand("task-abc", "rejected");

      const calls = mockSend.mock.calls.map(c => c.arguments[0]);
      assert.strictEqual(calls[0].name, "GetCommand");

      const update = calls.find(c => c.name === "UpdateCommand");
      assert.ok(update, "Expected an UpdateCommand");
      assert.strictEqual(update.params.ExpressionAttributeValues[":decision"], "rejected");
      assert.ok(
        update.params.ExpressionAttributeNames["#ts"] === "rejectedAt",
        "Timestamp field should be rejectedAt"
      );
    });

    it("exits with code 1 when task is not found", async () => {
      mockSend = mock.fn(async () => ({ Item: null }));
      require.cache[DYNAMO_PATH] = fakeCacheEntry(DYNAMO_PATH, {
        DynamoDBClient: class { send(cmd) { return mockSend(cmd); } }
      });
      require.cache[LIB_DYNAMO_PATH] = fakeCacheEntry(LIB_DYNAMO_PATH, {
        DynamoDBDocumentClient: { from: () => ({ send: (cmd) => mockSend(cmd) }) },
        GetCommand: class GetCommand { constructor(p) { this.params = p; this.name = "GetCommand"; } },
        UpdateCommand: class UpdateCommand { constructor(p) { this.params = p; this.name = "UpdateCommand"; } }
      });

      delete require.cache[CLI_PATH];
      ({ setApprovalCommand } = require(CLI_PATH));

      await setApprovalCommand("missing-task", "rejected");
      assert.strictEqual(exitCode, 1);
    });
  });
});
