/**
 * Shared AWS utilities for Lambda handlers and workers.
 *
 * Provides AWS client singletons, common helpers (API key retrieval,
 * task status updates, S3 reads, SQS sends), and SQS message parsing.
 *
 * Each handler/worker imports what it needs; module-scoped clients are
 * created once per Lambda cold start and reused across invocations.
 */

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, UpdateCommand } = require("@aws-sdk/lib-dynamodb");
const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const { SQSClient, SendMessageCommand } = require("@aws-sdk/client-sqs");
const { SecretsManagerClient, GetSecretValueCommand } = require("@aws-sdk/client-secrets-manager");
const crypto = require("crypto");
const https = require("https");

// Module-scoped singletons (one per Lambda container)
const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const s3Client = new S3Client({});
const sqsClient = new SQSClient({});
const secretsClient = new SecretsManagerClient({});

let cachedApiKey = null;

async function getAnthropicApiKey() {
  if (cachedApiKey) return cachedApiKey;

  const response = await secretsClient.send(
    new GetSecretValueCommand({
      SecretId: process.env.SECRET_ID
    })
  );

  cachedApiKey = response.SecretString;
  return cachedApiKey;
}

// --- GitHub App authentication ---
// Generates short-lived installation tokens for the richcorabbithole GitHub App.
// The App is owned by richcompton1705 and installed on the richcorabbithole org
// with Contents (R/W) and Pull Requests (R/W) scoped to richcorabbithole-site.

let cachedGitHubApp = null;    // { appId, installationId, privateKey }
let cachedInstallToken = null; // { token, expiresAt }

async function getGitHubAppCredentials() {
  if (cachedGitHubApp) return cachedGitHubApp;

  const response = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: "richcorabbithole/github-app" })
  );

  cachedGitHubApp = JSON.parse(response.SecretString);
  return cachedGitHubApp;
}

function createGitHubJWT(appId, privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iat: now - 60,        // 60s in the past for clock skew
    exp: now + (10 * 60), // 10-minute expiry (GitHub max)
    iss: String(appId)
  })).toString("base64url");

  const signature = crypto
    .sign("sha256", Buffer.from(`${header}.${payload}`), privateKey)
    .toString("base64url");

  return `${header}.${payload}.${signature}`;
}

/**
 * Get a short-lived GitHub installation access token for the richcorabbithole org.
 *
 * Flow:
 *   1. Read App credentials from Secrets Manager (cached per cold start)
 *   2. Sign a JWT with the App's private key
 *   3. Exchange the JWT for an installation token (POST /app/installations/{id}/access_tokens)
 *   4. Cache the token until 5 minutes before expiry (tokens last 1 hour)
 *
 * @returns {Promise<string>} A `ghs_` prefixed installation access token
 */
async function getGitHubToken() {
  // Return cached token if still valid (5-min buffer before expiry)
  if (cachedInstallToken) {
    const expiresAt = new Date(cachedInstallToken.expiresAt).getTime();
    const bufferMs = 5 * 60 * 1000;
    if (expiresAt > Date.now() + bufferMs) {
      return cachedInstallToken.token;
    }
  }

  const { appId, installationId, privateKey } = await getGitHubAppCredentials();
  const jwt = createGitHubJWT(appId, privateKey);

  // Exchange JWT for installation access token
  const result = await new Promise((resolve, reject) => {
    const postData = JSON.stringify({});
    const req = https.request({
      hostname: "api.github.com",
      path: `/app/installations/${installationId}/access_tokens`,
      method: "POST",
      headers: {
        "Authorization": `Bearer ${jwt}`,
        "Accept": "application/vnd.github+json",
        "User-Agent": "richcorabbithole-pipeline",
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(postData)
      }
    }, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        if (res.statusCode !== 201) {
          reject(new Error(`GitHub token exchange failed (${res.statusCode}): ${data}`));
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Failed to parse GitHub token response: ${data}`));
        }
      });
    });

    req.on("error", reject);
    req.write(postData);
    req.end();
  });

  cachedInstallToken = { token: result.token, expiresAt: result.expires_at };
  return cachedInstallToken.token;
}

/**
 * Make an authenticated GitHub REST API request.
 *
 * @param {string} method - HTTP method (GET, POST, PUT, etc.)
 * @param {string} path - API path (e.g., "/repos/owner/repo/pulls")
 * @param {string} token - GitHub installation access token
 * @param {object|null} body - Request body (JSON-serializable), or null for GET
 * @returns {Promise<object>} Parsed JSON response
 * @throws {Error} On non-2xx responses with status code and body
 */
async function githubApiRequest(method, path, token, body = null) {
  return new Promise((resolve, reject) => {
    const postData = body ? JSON.stringify(body) : null;
    const headers = {
      "Authorization": `token ${token}`,
      "Accept": "application/vnd.github+json",
      "User-Agent": "richcorabbithole-pipeline"
    };
    if (postData) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = String(Buffer.byteLength(postData));
    }

    const req = https.request({
      hostname: "api.github.com",
      path,
      method,
      headers
    }, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        let parsed;
        try {
          parsed = data ? JSON.parse(data) : {};
        } catch (e) {
          reject(new Error(`Failed to parse GitHub API response for ${method} ${path}: ${data}`));
          return;
        }
        if (res.statusCode >= 400) {
          const err = new Error(`GitHub API ${method} ${path} failed (${res.statusCode}): ${data}`);
          err.statusCode = res.statusCode;
          err.response = parsed;
          reject(err);
        } else {
          resolve(parsed);
        }
      });
    });

    req.on("error", reject);
    if (postData) req.write(postData);
    req.end();
  });
}

async function updateTaskStatus(taskId, status, extraFields = {}) {
  const expressionParts = ["#status = :status", "updatedAt = :now"];
  const attributeNames = { "#status": "status" };
  const attributeValues = {
    ":status": status,
    ":now": new Date().toISOString()
  };

  for (const [key, value] of Object.entries(extraFields)) {
    const attrKey = `#${key}`;
    const valKey = `:${key}`;
    expressionParts.push(`${attrKey} = ${valKey}`);
    attributeNames[attrKey] = key;
    attributeValues[valKey] = value;
  }

  await docClient.send(
    new UpdateCommand({
      TableName: process.env.TABLE_NAME,
      Key: { taskId },
      UpdateExpression: `SET ${expressionParts.join(", ")}`,
      ExpressionAttributeNames: attributeNames,
      ExpressionAttributeValues: attributeValues
    })
  );
}

async function getS3Object(key) {
  const response = await s3Client.send(
    new GetObjectCommand({
      Bucket: process.env.BUCKET_NAME,
      Key: key
    })
  );
  return response.Body.transformToString();
}

/**
 * Parse and validate an SQS event's first record.
 *
 * @param {object} event - The Lambda SQS event
 * @returns {{ taskId: string, body: object } | null}
 *   Returns null if Records is empty/missing (silently consumed).
 *   Throws on malformed JSON or missing taskId (retried then DLQ'd).
 */
function parseSqsMessage(event) {
  if (!event.Records || event.Records.length === 0) {
    console.error("No records in SQS event");
    return null;
  }

  const record = event.Records[0];
  let parsed;
  try {
    parsed = JSON.parse(record.body);
  } catch (parseErr) {
    console.error("Malformed SQS message body:", record.body);
    throw new Error("Malformed SQS message body");
  }

  if (!parsed.taskId) {
    console.error("Missing taskId in SQS message:", record.body);
    throw new Error("Missing taskId in SQS message");
  }

  return { taskId: parsed.taskId, body: parsed };
}

async function sendSqsMessage(queueUrl, body) {
  await sqsClient.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(body)
    })
  );
}

module.exports = {
  getDocClient: () => docClient,
  getS3Client: () => s3Client,
  getSqsClient: () => sqsClient,
  getAnthropicApiKey,
  getGitHubToken,
  githubApiRequest,
  updateTaskStatus,
  getS3Object,
  parseSqsMessage,
  sendSqsMessage
};
