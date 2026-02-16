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

const { GetCommand } = require("@aws-sdk/lib-dynamodb");
const { PutObjectCommand } = require("@aws-sdk/client-s3");
const { getDocClient, getS3Client, getAnthropicApiKey, updateTaskStatus, parseSqsMessage, sendSqsMessage } = require("./lib/shared-utils");

module.exports.handler = async (event) => {
  const msg = parseSqsMessage(event);
  if (!msg) return;

  const { taskId, body } = msg;
  const { topic } = body;

  if (!topic) {
    // Has taskId but no topic — mark the existing DynamoDB record as failed, then delete message
    console.error("Missing topic in SQS message:", JSON.stringify(body));
    try {
      await updateTaskStatus(taskId, "failed", { error: "Missing topic in SQS message" });
    } catch (updateErr) {
      console.error("Failed to mark task as failed:", updateErr);
    }
    return;
  }

  try {
    // Check if already processed (idempotency guard for at-least-once delivery)
    const docClient = getDocClient();
    const existing = await docClient.send(
      new GetCommand({
        TableName: process.env.TABLE_NAME,
        Key: { taskId }
      })
    );

    if (existing.Item && existing.Item.status === "researched") {
      console.log(`Task ${taskId} already researched, skipping`);
      return { taskId, status: "already_researched" };
    }

    // Update the task record to researching
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
- A list of recommended sources/references with full URLs
- Suggested angles for a blog post

Be thorough but concise. Focus on accuracy and include URLs for all cited sources where possible. URLs may come from training data and should be verified by the reader.`,
      messages: [
        {
          role: "user",
          content: `Research the following topic thoroughly: ${topic}`
        }
      ]
    });

    const textBlock = message.content.find(block => block.type === "text");
    if (!textBlock) {
      throw new Error("Claude returned no text content");
    }
    const researchContent = textBlock.text;

    // Store the research
    const s3Key = `research/${taskId}.md`;
    const s3Client = getS3Client();

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

    // Enqueue write job — non-fatal since research is already persisted.
    // If this fails, the task stays "researched" and can be re-triggered via cli.js draft.
    try {
      await sendSqsMessage(process.env.WRITE_QUEUE_URL, { taskId });
      console.log(`Research complete for task ${taskId}: ${s3Key} — write job enqueued`);
    } catch (enqueueErr) {
      console.error(`Research saved but failed to enqueue write job for ${taskId}:`, enqueueErr);
    }

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
