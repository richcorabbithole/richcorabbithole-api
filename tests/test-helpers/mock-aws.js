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
const RESEARCH_PATH = path.resolve(__dirname, "../../src/research.js");
const WORKER_PATH = path.resolve(__dirname, "../../src/researchWorker.js");
const WRITE_WORKER_PATH = path.resolve(__dirname, "../../src/writeWorker.js");
const EDIT_WORKER_PATH = path.resolve(__dirname, "../../src/editWorker.js");
const SEO_WORKER_PATH = path.resolve(__dirname, "../../src/seoWorker.js");
const PUBLISH_WORKER_PATH = path.resolve(__dirname, "../../src/publishWorker.js");
const SHARED_UTILS_PATH = path.resolve(__dirname, "../../src/lib/shared-utils.js");

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
  // Clear handler and shared lib from cache so they re-evaluate with our fakes
  delete require.cache[RESEARCH_PATH];
  delete require.cache[SHARED_UTILS_PATH];

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

  // Fake S3 + Secrets Manager (shared-utils creates these singletons at module scope)
  const s3Path = require.resolve("@aws-sdk/client-s3");
  require.cache[s3Path] = fakeCacheEntry(s3Path, {
    S3Client: class { send(cmd) { return mockSend(cmd); } },
    GetObjectCommand: class GetObjectCommand {
      constructor(params) { this.params = params; this.name = "GetObjectCommand"; }
    }
  });

  const secretsPath = require.resolve("@aws-sdk/client-secrets-manager");
  require.cache[secretsPath] = fakeCacheEntry(secretsPath, {
    SecretsManagerClient: class { send(cmd) { return mockSend(cmd); } },
    GetSecretValueCommand: class GetSecretValueCommand {
      constructor(params) { this.params = params; this.name = "GetSecretValueCommand"; }
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
    delete require.cache[SHARED_UTILS_PATH];
    delete require.cache[dynamoPath];
    delete require.cache[libDynamoPath];
    delete require.cache[sqsPath];
    delete require.cache[s3Path];
    delete require.cache[secretsPath];
    delete require.cache[cryptoPath];
    delete process.env.TABLE_NAME;
    delete process.env.RESEARCH_QUEUE_URL;
    delete process.env.STAGE;
  };

  return { handler, cleanup };
}

/**
 * Set up mocks for an SQS-triggered worker (researchWorker, writeWorker, etc.).
 *
 * Base S3 fake always includes PutObjectCommand + GetObjectCommand.
 * Pass additional S3 command classes via options.extraS3Commands.
 *
 * @param {Function} mockSend - A mock.fn() that all AWS .send() calls route through
 * @param {Function} mockCreate - A mock.fn() for Anthropic messages.create()
 * @param {object} [options]
 * @param {string} options.handlerPath - Absolute path to the worker module
 * @param {object} [options.extraS3Commands] - Extra S3 command classes to include, e.g. { CopyObjectCommand: class { ... } }
 * @returns {{ handler: Function, cleanup: Function }}
 */
function setupWorkerMocks(mockSend, mockCreate, options = {}) {
  const handlerPath = options.handlerPath || WORKER_PATH;

  // Clear handler and shared lib from cache
  delete require.cache[handlerPath];
  delete require.cache[SHARED_UTILS_PATH];

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

  // Fake S3 client + commands (base: PutObject + GetObject, plus extras)
  const s3Path = require.resolve("@aws-sdk/client-s3");
  const s3Exports = {
    S3Client: class {
      send(cmd) { return mockSend(cmd); }
    },
    PutObjectCommand: class PutObjectCommand {
      constructor(params) { this.params = params; this.name = "PutObjectCommand"; }
    },
    GetObjectCommand: class GetObjectCommand {
      constructor(params) { this.params = params; this.name = "GetObjectCommand"; }
    },
    ...(options.extraS3Commands || {})
  };
  require.cache[s3Path] = fakeCacheEntry(s3Path, s3Exports);

  // Fake SQS client + command (shared-utils initialises an SQS singleton)
  const sqsPath = require.resolve("@aws-sdk/client-sqs");
  require.cache[sqsPath] = fakeCacheEntry(sqsPath, {
    SQSClient: class {
      send(cmd) { return mockSend(cmd); }
    },
    SendMessageCommand: class SendMessageCommand {
      constructor(params) { this.params = params; this.name = "SendMessageCommand"; }
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
  process.env.WRITE_QUEUE_URL = "https://sqs.us-east-1.amazonaws.com/123456789/test-write-queue";
  process.env.EDIT_QUEUE_URL = "https://sqs.us-east-1.amazonaws.com/123456789/test-edit-queue";
  process.env.SEO_QUEUE_URL = "https://sqs.us-east-1.amazonaws.com/123456789/test-seo-queue";

  // Load handler with faked dependencies
  const handler = require(handlerPath).handler;

  const cleanup = () => {
    delete require.cache[handlerPath];
    delete require.cache[SHARED_UTILS_PATH];
    delete require.cache[dynamoPath];
    delete require.cache[libDynamoPath];
    delete require.cache[s3Path];
    delete require.cache[sqsPath];
    delete require.cache[secretsPath];
    delete require.cache[anthropicPath];
    delete process.env.TABLE_NAME;
    delete process.env.BUCKET_NAME;
    delete process.env.SECRET_ID;
    delete process.env.STAGE;
    delete process.env.WRITE_QUEUE_URL;
    delete process.env.EDIT_QUEUE_URL;
    delete process.env.SEO_QUEUE_URL;
  };

  return { handler, cleanup };
}

/**
 * Set up mocks for the publishWorker (src/publishWorker.js).
 *
 * Like setupWorkerMocks but replaces the Anthropic SDK mock with a fake `https`
 * module, since publishWorker uses githubApiRequest (raw https) instead of Claude.
 *
 * @param {Function} mockSend - A mock.fn() that all AWS .send() calls route through
 * @param {Function} mockHttpsRequest - A mock.fn(options, callback) for https.request
 * @returns {{ handler: Function, cleanup: Function }}
 */
function setupPublishWorkerMocks(mockSend, mockHttpsRequest) {
  // Clear handler and shared lib from cache
  delete require.cache[PUBLISH_WORKER_PATH];
  delete require.cache[SHARED_UTILS_PATH];

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

  // Fake S3 client + commands
  const s3Path = require.resolve("@aws-sdk/client-s3");
  require.cache[s3Path] = fakeCacheEntry(s3Path, {
    S3Client: class {
      send(cmd) { return mockSend(cmd); }
    },
    PutObjectCommand: class PutObjectCommand {
      constructor(params) { this.params = params; this.name = "PutObjectCommand"; }
    },
    GetObjectCommand: class GetObjectCommand {
      constructor(params) { this.params = params; this.name = "GetObjectCommand"; }
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

  // Fake https module — shared-utils uses https.request for GitHub API calls.
  // The mockHttpsRequest function receives (options, callback) and must return a
  // fake request object with write() and end() methods.
  const httpsPath = require.resolve("https");
  const realHttps = require("https");
  require.cache[httpsPath] = fakeCacheEntry(httpsPath, {
    ...realHttps,
    request: mockHttpsRequest
  });

  // Fake crypto — shared-utils uses crypto.sign for JWT creation with an RSA
  // private key. In tests we use a fake key, so we stub crypto.sign to return
  // a deterministic fake signature instead of actually doing RSA signing.
  const cryptoPath = require.resolve("crypto");
  const realCrypto = require("crypto");
  require.cache[cryptoPath] = fakeCacheEntry(cryptoPath, {
    ...realCrypto,
    sign: () => Buffer.from("fake-jwt-signature")
  });

  // Set required environment variables
  process.env.TABLE_NAME = "test-tasks-table";
  process.env.BUCKET_NAME = "test-research-bucket";
  process.env.STAGE = "test";

  // Load handler with faked dependencies
  const handler = require(PUBLISH_WORKER_PATH).handler;

  const cleanup = () => {
    delete require.cache[PUBLISH_WORKER_PATH];
    delete require.cache[SHARED_UTILS_PATH];
    delete require.cache[dynamoPath];
    delete require.cache[libDynamoPath];
    delete require.cache[s3Path];
    delete require.cache[sqsPath];
    delete require.cache[secretsPath];
    delete require.cache[httpsPath];
    delete require.cache[cryptoPath];
    delete process.env.TABLE_NAME;
    delete process.env.BUCKET_NAME;
    delete process.env.STAGE;
  };

  return { handler, cleanup };
}

module.exports = { setupResearchMocks, setupWorkerMocks, setupPublishWorkerMocks, WORKER_PATH, WRITE_WORKER_PATH, EDIT_WORKER_PATH, SEO_WORKER_PATH, PUBLISH_WORKER_PATH };
