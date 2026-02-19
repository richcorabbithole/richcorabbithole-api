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
const { DynamoDBDocumentClient, UpdateCommand, GetCommand } = require("@aws-sdk/lib-dynamodb");
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

/**
 * Retrieve the Anthropic API key from AWS Secrets Manager.
 * Result is cached for the lifetime of the Lambda container.
 *
 * @returns {Promise<string>} The Anthropic API key string.
 */
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

  let secretString = response.SecretString;
  // AWS Secrets Manager sometimes stores PEM private keys with literal newlines,
  // which makes JSON.parse fail with "Bad control character". Escape them first,
  // then restore real newlines in the key value after parsing.
  let parsed;
  try {
    parsed = JSON.parse(secretString);
  } catch {
    // Escape literal newlines only within JSON string values by replacing bare newlines
    // that fall inside a quoted context. Simple heuristic: escape all \n and \r, then
    // restore structural whitespace by re-parsing with relaxed logic isn't straightforward,
    // so instead we use a targeted regex to escape newlines inside the privateKey field value.
    secretString = secretString.replace(
      /("privateKey"\s*:\s*")([\s\S]*?)(")/,
      (_, prefix, key, suffix) => prefix + key.replace(/\n/g, "\\n").replace(/\r/g, "\\r") + suffix
    );
    parsed = JSON.parse(secretString);
  }
  // Ensure the private key has real newlines for crypto.sign (in case it was stored with \n literals)
  if (parsed.privateKey) {
    parsed.privateKey = parsed.privateKey.replace(/\\n/g, "\n");
  }
  cachedGitHubApp = parsed;
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

/**
 * Update a pipeline task's status and optional metadata fields in DynamoDB.
 *
 * @param {string} taskId - The UUID of the task to update.
 * @param {string} status - New status value (e.g. "researching", "published").
 * @param {object} [extraFields={}] - Additional attributes to set on the item.
 * @returns {Promise<void>}
 */
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

/**
 * Fetch an object from the pipeline S3 bucket and return its body as a string.
 *
 * @param {string} key - The S3 object key (e.g. "research/uuid.md").
 * @returns {Promise<string>} The object body decoded as UTF-8 text.
 */
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
/**
 * Parse and validate the first record from an SQS Lambda event.
 * Returns null for empty events (message silently consumed).
 * Throws on malformed JSON or missing taskId (triggers SQS retry).
 *
 * @param {object} event - The Lambda SQS event object.
 * @returns {{ taskId: string, body: object } | null}
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

/**
 * Send a JSON message to an SQS queue.
 *
 * @param {string} queueUrl - The full SQS queue URL.
 * @param {object} body - JSON-serializable message payload.
 * @returns {Promise<void>}
 */
async function sendSqsMessage(queueUrl, body) {
  await sqsClient.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(body)
    })
  );
}

// Config item key for the known categories stored in DynamoDB.
// The item lives in the same table as tasks, keyed on taskId = "config:categories".
// Schema: { taskId: "config:categories", status: "config", categories: { <slug>: <description> } }
// The `categories` attribute is a DynamoDB Map (M) — slug → description string.
const CATEGORIES_CONFIG_KEY = "config:categories";

// Seed data — used as fallback if the config item is missing or empty.
// Each entry: { slug, description }
const DEFAULT_CATEGORIES = [
  { slug: "tech",        description: "computers, software, AI, electronics, and the internet" },
  { slug: "science",     description: "biology, physics, chemistry, astronomy, medicine, and natural phenomena" },
  { slug: "history",     description: "historical events, figures, eras, and cultural history" },
  { slug: "gaming",      description: "video games, tabletop games, game design, and gaming culture" },
  { slug: "maker",       description: "DIY projects, hardware, crafts, woodworking, electronics builds, and hands-on making" },
  { slug: "pop-culture", description: "fictional characters, movies, TV shows, comics, anime, music artists, and media franchises" },
  { slug: "other",       description: "topics that don't fit any other category" },
];

/**
 * Fetch the known hyperfixation categories from DynamoDB.
 * Returns an array of { slug, description } objects.
 * Falls back to DEFAULT_CATEGORIES if the config item is missing.
 *
 * @returns {Promise<Array<{slug: string, description: string}>>}
 */
async function getKnownCategories() {
  const result = await docClient.send(
    new GetCommand({
      TableName: process.env.TABLE_NAME,
      Key: { taskId: CATEGORIES_CONFIG_KEY }
    })
  );
  if (result.Item) {
    // New schema: categories Map (M) — slug → description string.
    if (result.Item.categories && typeof result.Item.categories === "object") {
      const entries = Object.entries(result.Item.categories);
      if (entries.length > 0) {
        return entries.map(([slug, description]) => ({ slug, description }));
      }
    }

    // Legacy schema: values String Set (SS) or List (L) — slug only, no descriptions.
    // Preserved for backward compatibility until the seed script is run on existing deployments.
    // Descriptions are synthesised from DEFAULT_CATEGORIES where known, falling back to a
    // generic phrase so the classifier still gets useful context.
    if (result.Item.values) {
      const vals = result.Item.values;
      const arr = vals instanceof Set ? [...vals] : Array.isArray(vals) ? vals : null;
      if (arr && arr.length > 0) {
        const defaultMap = new Map(DEFAULT_CATEGORIES.map(c => [c.slug, c.description]));
        return arr.map(slug => ({
          slug,
          description: defaultMap.get(slug) ?? `topics related to ${slug}`,
        }));
      }
    }
  }
  return [...DEFAULT_CATEGORIES];
}

/**
 * Add a new category to the known categories map in DynamoDB.
 *
 * Uses SET with if_not_exists to write the slug → description entry idempotently.
 * Concurrent calls for the same slug are safe — if_not_exists is a no-op when the
 * key already exists, so the first description written wins.
 *
 * @param {string} slug - lowercase slug to add (e.g. "food", "true-crime")
 * @param {string} description - short phrase describing what belongs in this category
 * @returns {Promise<void>}
 */
async function addKnownCategory(slug, description) {
  // SET #categories.#slug = if_not_exists(#categories.#slug, :desc)
  // DynamoDB requires expression attribute names for map key paths when the key
  // could be a reserved word or contain special characters (hyphens, etc.).
  await docClient.send(
    new UpdateCommand({
      TableName: process.env.TABLE_NAME,
      Key: { taskId: CATEGORIES_CONFIG_KEY },
      UpdateExpression: "SET #status = :status, #cats.#slug = if_not_exists(#cats.#slug, :desc)",
      ExpressionAttributeNames: {
        "#status": "status",
        "#cats": "categories",
        "#slug": slug,
      },
      ExpressionAttributeValues: {
        ":status": "config",
        ":desc": description,
      },
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
  sendSqsMessage,
  getKnownCategories,
  addKnownCategory
};
