/**
 * Research Worker Handler
 *
 * Triggered by SQS when a research task is queued. Performs the actual
 * Claude API research, saves output to S3, and updates DynamoDB.
 *
 * Flow: SQS → this function → Claude API → S3 + DynamoDB
 *
 * Error contract with SQS:
 *   - Return successfully → SQS deletes the message (done)
 *   - Throw an error → SQS retries (up to maxReceiveCount=2), then DLQ
 *
 * This means we MUST throw on failure, not swallow errors. If we catch
 * an error and return normally, SQS thinks it succeeded and deletes
 * the message — losing the task forever.
 */

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, UpdateCommand } = require("@aws-sdk/lib-dynamodb");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { SecretsManagerClient, GetSecretValueCommand } = require("@aws-sdk/client-secrets-manager");

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

// Module scoped helper to update the task in Dynamo
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

module.exports.handler = async (event) => {
  // Parse the SQS message — batchSize is 1 but guard defensively
  if (!event.Records || event.Records.length === 0) {
    console.error("No records in SQS event");
    return;
  }

  const record = event.Records[0];
  const { taskId, topic } = JSON.parse(record.body);

  try {
    // Update the task record to reserarching
    await updateTaskStatus(taskId, "researching");

    const apiKey = await getAnthropicApiKey();

    // Lazy loading Anthropic in case validation fails
    const anthropicSDK = require("@anthropic-ai/sdk");
    const anthropicInstance = new anthropicSDK({ apiKey });

    const message = await anthropicInstance.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4096,
      system: `You are a research assistant for a technical blog called richcorabbithole.
Your job is to produce comprehensive, well-sourced research on a given topic.

Structure your research as markdown with:
- An executive summary (2-3 sentences)
- Key findings organized by theme
- Important data points, statistics, or quotes
- A list of recommended sources/references
- Suggested angles for a blog post

Be thorough but concise. Focus on accuracy and cite specific sources where possible.`,
      messages: [
        {
          role: "user",
          content: `Research the following topic thoroughly: ${topic}`
        }
      ]
    });

    const researchContent = message.content[0].text;

    // Store the research
    const s3Key = `research/${taskId}.md`;

    await s3Client.send(
      new PutObjectCommand({
        Bucket: process.env.BUCKET_NAME,
        Key: s3Key,
        Body: researchContent,
        ContentType: "text/markdown"
      })
    );

    // Update task record to researched
    await updateTaskStatus(taskId, "researched", { s3Key });

    // TODO: Assemble the rest of the agent pipeline, this return is a placeholder 
    console.log(`Research complete for task ${taskId}: ${s3Key}`);
    return { taskId, s3Key, status: "researched" };
  } catch (error) {
    console.error(`Research failed for task ${taskId}:`, error);

    try {
      await updateTaskStatus(taskId, "failed", { error: error.message });
    } catch (updateError) {
      // If even the status update fails (DynamoDB down?), log it
      // but don't swallow the original error.
      console.error("Failed to update task status:", updateError);
    }

    // Re-throw so SQS retries the message
    throw error;
  }
};
