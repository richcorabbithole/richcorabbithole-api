/**
 * Shared utilities for SQS-triggered Lambda workers.
 *
 * Provides AWS client singletons, common helpers (API key retrieval,
 * task status updates, S3 reads), and SQS message parsing.
 *
 * Each worker imports what it needs; module-scoped clients are created
 * once per Lambda cold start and reused across invocations.
 */

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, UpdateCommand } = require("@aws-sdk/lib-dynamodb");
const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const { SecretsManagerClient, GetSecretValueCommand } = require("@aws-sdk/client-secrets-manager");

// Module-scoped singletons (one per Lambda container)
const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const s3Client = new S3Client({});
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

module.exports = {
  getDocClient: () => docClient,
  getS3Client: () => s3Client,
  getAnthropicApiKey,
  updateTaskStatus,
  getS3Object,
  parseSqsMessage
};
