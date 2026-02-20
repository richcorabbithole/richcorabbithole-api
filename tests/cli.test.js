/**
 * Tests for CLI commands (approve / reject / delete).
 *
 * The CLI is a script that auto-calls main() on require, so we stub process.argv
 * to give it a no-op command and stub process.exit to prevent early termination.
 * After requiring, we call the exported command functions directly with mocked
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

// ─── delete command ───────────────────────────────────────────────────────────

describe("CLI delete command", () => {
  let mockSend;
  let originalArgv;
  let originalExit;
  let exitCode;
  let deleteTaskCommand;

  // Full task record with all four S3 keys present
  const FULL_TASK = {
    taskId: "task-del",
    topic: "coffee brewing",
    status: "published",
    s3Key: "research/task-del.md",
    draftS3Key: "drafts/task-del.md",
    editedS3Key: "edited/task-del.md",
    finalS3Key: "final/task-del.md"
  };

  function setupFakes(taskItem) {
    mockSend = mock.fn(async (cmd) => {
      if (cmd.name === "GetCommand") return { Item: taskItem };
      return {};
    });

    require.cache[DYNAMO_PATH] = fakeCacheEntry(DYNAMO_PATH, {
      DynamoDBClient: class { send(cmd) { return mockSend(cmd); } }
    });
    require.cache[LIB_DYNAMO_PATH] = fakeCacheEntry(LIB_DYNAMO_PATH, {
      DynamoDBDocumentClient: { from: () => ({ send: (cmd) => mockSend(cmd) }) },
      GetCommand:    class GetCommand    { constructor(p) { this.params = p; this.name = "GetCommand"; } },
      UpdateCommand: class UpdateCommand { constructor(p) { this.params = p; this.name = "UpdateCommand"; } },
      DeleteCommand: class DeleteCommand { constructor(p) { this.params = p; this.name = "DeleteCommand"; } }
    });

    const sqsPath = require.resolve("@aws-sdk/client-sqs");
    require.cache[sqsPath] = fakeCacheEntry(sqsPath, {
      SQSClient: class { send() {} },
      SendMessageCommand: class { constructor(p) { this.params = p; } },
      GetQueueUrlCommand: class { constructor(p) { this.params = p; } }
    });

    const s3Path = require.resolve("@aws-sdk/client-s3");
    require.cache[s3Path] = fakeCacheEntry(s3Path, {
      S3Client: class { send(cmd) { return mockSend(cmd); } },
      GetObjectCommand:    class { constructor(p) { this.params = p; this.name = "GetObjectCommand"; } },
      DeleteObjectCommand: class { constructor(p) { this.params = p; this.name = "DeleteObjectCommand"; } }
    });

    process.env.TABLE_NAME = "test-tasks-table";

    delete require.cache[CLI_PATH];
    ({ deleteTaskCommand } = require(CLI_PATH));
  }

  beforeEach(() => {
    originalArgv = process.argv;
    process.argv = ["node", "cli.js"];
    originalExit = process.exit;
    process.exit = (code) => { exitCode = code; };
    exitCode = undefined;

    setupFakes(FULL_TASK);
  });

  afterEach(() => {
    process.argv = originalArgv;
    process.exit = originalExit;

    delete require.cache[CLI_PATH];
    delete require.cache[DYNAMO_PATH];
    delete require.cache[LIB_DYNAMO_PATH];
    delete require.cache[require.resolve("@aws-sdk/client-sqs")];
    delete require.cache[require.resolve("@aws-sdk/client-s3")];

    delete process.env.TABLE_NAME;

    mock.restoreAll();
  });

  it("fetches the task then deletes all four S3 objects and the DynamoDB item", async () => {
    await deleteTaskCommand("task-del");

    const calls = mockSend.mock.calls.map(c => c.arguments[0]);

    // First call must be GetCommand to look up the task
    assert.strictEqual(calls[0].name, "GetCommand");
    assert.deepStrictEqual(calls[0].params.Key, { taskId: "task-del" });

    // Four DeleteObjectCommands — one per S3 key
    const s3Deletes = calls.filter(c => c.name === "DeleteObjectCommand");
    assert.strictEqual(s3Deletes.length, 4, "Expected four S3 delete calls");

    const deletedKeys = s3Deletes.map(c => c.params.Key);
    assert.ok(deletedKeys.includes("research/task-del.md"),  "Expected research key deleted");
    assert.ok(deletedKeys.includes("drafts/task-del.md"),    "Expected draft key deleted");
    assert.ok(deletedKeys.includes("edited/task-del.md"),    "Expected edited key deleted");
    assert.ok(deletedKeys.includes("final/task-del.md"),     "Expected final key deleted");

    // All S3 deletes use the same bucket (BUCKET_NAME is derived from stage at module scope)
    const bucket = s3Deletes[0].params.Bucket;
    assert.ok(bucket, "Expected a Bucket value");
    for (const c of s3Deletes) {
      assert.strictEqual(c.params.Bucket, bucket, "All S3 deletes should use the same bucket");
    }

    // Last call must be DeleteCommand to remove the DynamoDB item
    const last = calls[calls.length - 1];
    assert.strictEqual(last.name, "DeleteCommand");
    assert.deepStrictEqual(last.params.Key, { taskId: "task-del" });
  });

  it("only deletes S3 keys that are present on the task record", async () => {
    // Task only has research + draft — no edited or final yet
    setupFakes({
      taskId: "task-partial",
      topic: "partial task",
      status: "drafted",
      s3Key: "research/task-partial.md",
      draftS3Key: "drafts/task-partial.md"
    });

    await deleteTaskCommand("task-partial");

    const calls = mockSend.mock.calls.map(c => c.arguments[0]);
    const s3Deletes = calls.filter(c => c.name === "DeleteObjectCommand");
    assert.strictEqual(s3Deletes.length, 2, "Expected two S3 delete calls for partial task");

    const deletedKeys = s3Deletes.map(c => c.params.Key);
    assert.ok(deletedKeys.includes("research/task-partial.md"));
    assert.ok(deletedKeys.includes("drafts/task-partial.md"));
  });

  it("skips all S3 deletes when task has no S3 keys", async () => {
    setupFakes({
      taskId: "task-empty",
      topic: "empty task",
      status: "pending"
    });

    await deleteTaskCommand("task-empty");

    const calls = mockSend.mock.calls.map(c => c.arguments[0]);
    const s3Deletes = calls.filter(c => c.name === "DeleteObjectCommand");
    assert.strictEqual(s3Deletes.length, 0, "Expected no S3 delete calls");

    // DynamoDB item still deleted
    const dbDelete = calls.find(c => c.name === "DeleteCommand");
    assert.ok(dbDelete, "Expected DeleteCommand even with no S3 keys");
  });

  it("DynamoDB delete happens after all S3 deletes", async () => {
    await deleteTaskCommand("task-del");

    const calls = mockSend.mock.calls.map(c => c.arguments[0]);
    const lastIdx = calls.length - 1;
    assert.strictEqual(calls[lastIdx].name, "DeleteCommand", "DeleteCommand should be last");

    // All preceding calls (after GetCommand) should be S3 deletes
    const middleCalls = calls.slice(1, lastIdx);
    for (const c of middleCalls) {
      assert.strictEqual(c.name, "DeleteObjectCommand");
    }
  });

  it("exits with code 1 and does not delete anything when task is not found", async () => {
    setupFakes(null); // GetCommand returns { Item: null }

    await deleteTaskCommand("task-missing");
    assert.strictEqual(exitCode, 1);

    const calls = mockSend.mock.calls.map(c => c.arguments[0]);
    const deleteCalls = calls.filter(c =>
      c.name === "DeleteObjectCommand" || c.name === "DeleteCommand"
    );
    assert.strictEqual(deleteCalls.length, 0, "Should not delete anything for missing task");
  });

  it("exits with code 1 when no taskId is provided", async () => {
    await deleteTaskCommand(undefined);
    assert.strictEqual(exitCode, 1);
  });
});

// ─── series-status command ─────────────────────────────────────────────────────

describe("CLI series-status command", () => {
  let mockSend;
  let originalArgv;
  let originalExit;
  let exitCode;
  let seriesStatusCommand;

  const PARENT_TASK = {
    taskId: "parent-uuid",
    status: "series_researched",
    seriesSlug: "rust-ownership",
    seriesTitle: "The Complete Guide to Rust Ownership",
    totalParts: 2,
  };

  const CHILD_TASKS = [
    { taskId: "child-1", parentTaskId: "parent-uuid", part: 1, partTitle: "What is Ownership?", status: "ready", finalS3Key: "final/child-1.md" },
    { taskId: "child-2", parentTaskId: "parent-uuid", part: 2, partTitle: "Borrowing and Lifetimes", status: "editing" },
  ];

  function setupFakes(parentItem, children) {
    mockSend = mock.fn(async (cmd) => {
      if (cmd.name === "GetCommand") {
        const key = cmd.params?.Key?.taskId;
        if (key === "parent-uuid") return { Item: parentItem };
        if (key === "child-1") return { Item: CHILD_TASKS[0] }; // when given child taskId
        return { Item: null };
      }
      if (cmd.name === "QueryCommand") {
        return { Items: children };
      }
      return {};
    });

    require.cache[DYNAMO_PATH] = fakeCacheEntry(DYNAMO_PATH, {
      DynamoDBClient: class { send(cmd) { return mockSend(cmd); } }
    });
    require.cache[LIB_DYNAMO_PATH] = fakeCacheEntry(LIB_DYNAMO_PATH, {
      DynamoDBDocumentClient: { from: () => ({ send: (cmd) => mockSend(cmd) }) },
      GetCommand: class GetCommand { constructor(p) { this.params = p; this.name = "GetCommand"; } },
      UpdateCommand: class UpdateCommand { constructor(p) { this.params = p; this.name = "UpdateCommand"; } },
      DeleteCommand: class DeleteCommand { constructor(p) { this.params = p; this.name = "DeleteCommand"; } },
      QueryCommand: class QueryCommand { constructor(p) { this.params = p; this.name = "QueryCommand"; } }
    });

    const sqsPath = require.resolve("@aws-sdk/client-sqs");
    require.cache[sqsPath] = fakeCacheEntry(sqsPath, {
      SQSClient: class { send() {} },
      SendMessageCommand: class { constructor(p) { this.params = p; } },
      GetQueueUrlCommand: class { constructor(p) { this.params = p; } }
    });

    const s3Path = require.resolve("@aws-sdk/client-s3");
    require.cache[s3Path] = fakeCacheEntry(s3Path, {
      S3Client: class { send() {} },
      GetObjectCommand: class { constructor(p) { this.params = p; } },
      DeleteObjectCommand: class { constructor(p) { this.params = p; } }
    });

    process.env.TABLE_NAME = "test-tasks-table";
    delete require.cache[CLI_PATH];
    ({ seriesStatusCommand } = require(CLI_PATH));
  }

  beforeEach(() => {
    originalArgv = process.argv;
    process.argv = ["node", "cli.js"];
    originalExit = process.exit;
    process.exit = (code) => { exitCode = code; };
    exitCode = undefined;
    setupFakes(PARENT_TASK, CHILD_TASKS);
  });

  afterEach(() => {
    process.argv = originalArgv;
    process.exit = originalExit;
    delete require.cache[CLI_PATH];
    delete require.cache[DYNAMO_PATH];
    delete require.cache[LIB_DYNAMO_PATH];
    delete require.cache[require.resolve("@aws-sdk/client-sqs")];
    delete require.cache[require.resolve("@aws-sdk/client-s3")];
    delete process.env.TABLE_NAME;
    mock.restoreAll();
  });

  it("queries DynamoDB for parent task and child tasks", async () => {
    await seriesStatusCommand("parent-uuid");

    const getCalls = mockSend.mock.calls.filter(c => c.arguments[0].name === "GetCommand");
    assert.ok(getCalls.length >= 1, "Expected at least one GetCommand call");

    const queryCalls = mockSend.mock.calls.filter(c => c.arguments[0].name === "QueryCommand");
    assert.strictEqual(queryCalls.length, 1, "Expected exactly one QueryCommand for children");

    const queryParams = queryCalls[0].arguments[0].params;
    assert.strictEqual(queryParams.IndexName, "parentTaskId-index");
    assert.ok(queryParams.ExpressionAttributeValues[":pid"] === "parent-uuid", "Should query by parentTaskId");
  });

  it("exits with code 1 when task is not found", async () => {
    setupFakes(null, []);
    await seriesStatusCommand("nonexistent");
    assert.strictEqual(exitCode, 1);
  });

  it("exits with code 1 when no taskId is provided", async () => {
    await seriesStatusCommand(undefined);
    assert.strictEqual(exitCode, 1);
  });
});
