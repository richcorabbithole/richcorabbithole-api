/**
 * Shared mock setup for AWS SDK and Anthropic SDK.
 *
 * Uses require.cache manipulation to intercept module-scoped AWS clients.
 * Each call to a setup function:
 *   1. Deletes the handler module from cache (forces fresh require)
 *   2. Replaces SDK modules with fakes whose .send() calls the provided mockSend
 *   3. Returns a cleanup function for afterEach
 *
 * This lets tests control what every AWS/Anthropic call returns without
 * changing production code or adding mocking libraries.
 */

const path = require("path");

// Paths to handler modules (used for cache invalidation)
const RESEARCH_PATH = path.resolve(__dirname, "../research.js");
const WORKER_PATH = path.resolve(__dirname, "../researchWorker.js");

/**
 * Build a fake module cache entry.
 * Node's require.cache expects { id, loaded, exports }.
 */
function fakeCacheEntry(modulePath, exports) {
  return {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports
  };
}

/**
 * Set up mocks for the research accept handler (src/research.js).
 *
 * @param {Function} mockSend - A mock.fn() that all .send() calls route through
 * @returns {{ handler: Function, cleanup: Function }}
 */
function setupResearchMocks(mockSend) {
  // Clear handler from cache so it re-evaluates with our fakes
  delete require.cache[RESEARCH_PATH];

  // Fake DynamoDB client
  const dynamoPath = require.resolve("@aws-sdk/client-dynamodb");
  require.cache[dynamoPath] = fakeCacheEntry(dynamoPath, {
    DynamoDBClient: class {
      send(cmd) { return mockSend(cmd); }
    }
  });

  // Fake DynamoDB Document Client + commands
  const libDynamoPath = require.resolve("@aws-sdk/lib-dynamodb");
  require.cache[libDynamoPath] = fakeCacheEntry(libDynamoPath, {
    DynamoDBDocumentClient: {
      from: () => ({ send: (cmd) => mockSend(cmd) })
    },
    PutCommand: class PutCommand {
      constructor(params) { this.params = params; this.name = "PutCommand"; }
    },
    UpdateCommand: class UpdateCommand {
      constructor(params) { this.params = params; this.name = "UpdateCommand"; }
    },
    GetCommand: class GetCommand {
      constructor(params) { this.params = params; this.name = "GetCommand"; }
    }
  });

  // Fake SQS client + command
  const sqsPath = require.resolve("@aws-sdk/client-sqs");
  require.cache[sqsPath] = fakeCacheEntry(sqsPath, {
    SQSClient: class {
      send(cmd) { return mockSend(cmd); }
    },
    SendMessageCommand: class SendMessageCommand {
      constructor(params) { this.params = params; this.name = "SendMessageCommand"; }
    }
  });

  // Fake crypto.randomUUID for deterministic taskIds
  const cryptoPath = require.resolve("crypto");
  const realCrypto = require("crypto");
  require.cache[cryptoPath] = fakeCacheEntry(cryptoPath, {
    ...realCrypto,
    randomUUID: () => "test-task-id-1234"
  });

  // Set required environment variables
  process.env.TABLE_NAME = "test-tasks-table";
  process.env.RESEARCH_QUEUE_URL = "https://sqs.us-east-1.amazonaws.com/123456789/test-queue";
  process.env.STAGE = "test";

  // Load handler with faked dependencies
  const handler = require(RESEARCH_PATH).handler;

  const cleanup = () => {
    delete require.cache[RESEARCH_PATH];
    delete require.cache[dynamoPath];
    delete require.cache[libDynamoPath];
    delete require.cache[sqsPath];
    delete require.cache[cryptoPath];
    delete process.env.TABLE_NAME;
    delete process.env.RESEARCH_QUEUE_URL;
    delete process.env.STAGE;
  };

  return { handler, cleanup };
}

/**
 * Set up mocks for the research worker (src/researchWorker.js).
 *
 * @param {Function} mockSend - A mock.fn() that all AWS .send() calls route through
 * @param {Function} mockCreate - A mock.fn() for Anthropic messages.create()
 * @returns {{ handler: Function, cleanup: Function }}
 */
function setupWorkerMocks(mockSend, mockCreate) {
  // Clear handler from cache
  delete require.cache[WORKER_PATH];

  // Fake DynamoDB client
  const dynamoPath = require.resolve("@aws-sdk/client-dynamodb");
  require.cache[dynamoPath] = fakeCacheEntry(dynamoPath, {
    DynamoDBClient: class {
      send(cmd) { return mockSend(cmd); }
    }
  });

  // Fake DynamoDB Document Client + commands
  const libDynamoPath = require.resolve("@aws-sdk/lib-dynamodb");
  require.cache[libDynamoPath] = fakeCacheEntry(libDynamoPath, {
    DynamoDBDocumentClient: {
      from: () => ({ send: (cmd) => mockSend(cmd) })
    },
    UpdateCommand: class UpdateCommand {
      constructor(params) { this.params = params; this.name = "UpdateCommand"; }
    },
    GetCommand: class GetCommand {
      constructor(params) { this.params = params; this.name = "GetCommand"; }
    }
  });

  // Fake S3 client + command
  const s3Path = require.resolve("@aws-sdk/client-s3");
  require.cache[s3Path] = fakeCacheEntry(s3Path, {
    S3Client: class {
      send(cmd) { return mockSend(cmd); }
    },
    PutObjectCommand: class PutObjectCommand {
      constructor(params) { this.params = params; this.name = "PutObjectCommand"; }
    }
  });

  // Fake Secrets Manager client + command
  const secretsPath = require.resolve("@aws-sdk/client-secrets-manager");
  require.cache[secretsPath] = fakeCacheEntry(secretsPath, {
    SecretsManagerClient: class {
      send(cmd) { return mockSend(cmd); }
    },
    GetSecretValueCommand: class GetSecretValueCommand {
      constructor(params) { this.params = params; this.name = "GetSecretValueCommand"; }
    }
  });

  // Fake Anthropic SDK
  const anthropicPath = require.resolve("@anthropic-ai/sdk");
  const FakeAnthropic = class {
    constructor() {
      this.messages = { create: mockCreate };
    }
  };
  require.cache[anthropicPath] = fakeCacheEntry(anthropicPath, FakeAnthropic);

  // Set required environment variables
  process.env.TABLE_NAME = "test-tasks-table";
  process.env.BUCKET_NAME = "test-research-bucket";
  process.env.SECRET_ID = "test/anthropic-api-key";
  process.env.STAGE = "test";

  // Load handler with faked dependencies
  const handler = require(WORKER_PATH).handler;

  const cleanup = () => {
    delete require.cache[WORKER_PATH];
    delete require.cache[dynamoPath];
    delete require.cache[libDynamoPath];
    delete require.cache[s3Path];
    delete require.cache[secretsPath];
    delete require.cache[anthropicPath];
    delete process.env.TABLE_NAME;
    delete process.env.BUCKET_NAME;
    delete process.env.SECRET_ID;
    delete process.env.STAGE;
  };

  return { handler, cleanup };
}

module.exports = { setupResearchMocks, setupWorkerMocks };
