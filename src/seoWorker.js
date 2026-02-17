/**
 * SEO Worker Handler
 *
 * Triggered by SQS when an SEO optimization task is queued. Reads the edited post from S3,
 * generates SEO-optimized metadata (description, tags, social previews), updates the frontmatter,
 * saves the final version to S3, and updates DynamoDB.
 *
 * Flow: SQS → this function → S3 (read edited) → Claude API → S3 (write final) + DynamoDB
 *
 * Error contract with SQS:
 *   - Return successfully → SQS deletes the message (done)
 *   - Throw an error → SQS retries (up to maxReceiveCount=2), then DLQ
 */

const { GetCommand } = require("@aws-sdk/lib-dynamodb");
const { PutObjectCommand } = require("@aws-sdk/client-s3");
const { getDocClient, getS3Client, getS3Object, getAnthropicApiKey, updateTaskStatus, parseSqsMessage } = require("./lib/shared-utils");

const SEO_SYSTEM_PROMPT = `You are an SEO specialist for richcorabbithole — a blog about going deep on random topics (hyperfixations).

Your job is to optimize the blog post's metadata for search engines and social media without changing the content itself.

Review the post and generate:
- **Meta description** (150-160 characters): Compelling summary that includes the main topic and entices clicks. Should accurately represent the content.
- **Social media title** (50-60 characters): Punchy, attention-grabbing version of the title optimized for Twitter/LinkedIn previews.
- **Tags** (3-5 tags): Relevant keywords/topics for categorization and discoverability. Use lowercase, hyphen-separated format (e.g., "machine-learning", "web-security").
- **SEO keywords**: 5-7 primary keywords/phrases that best represent the content for search optimization.

CRITICAL: You must preserve the entire post content exactly as-is. ONLY update the frontmatter fields listed above.
Do NOT include any text before the opening --- or after the post content.
Output ONLY the complete markdown file with updated frontmatter.`;

module.exports.handler = async (event) => {
  const msg = parseSqsMessage(event);
  if (!msg) return;

  const { taskId } = msg;

  try {
    // Look up the task to get its current status and edited content location
    const docClient = getDocClient();
    const existing = await docClient.send(
      new GetCommand({
        TableName: process.env.TABLE_NAME,
        Key: { taskId }
      })
    );

    if (!existing.Item) {
      throw new Error(`Task ${taskId} not found`);
    }

    const task = existing.Item;

    // Idempotency: if already optimized, skip
    if (task.status === "ready") {
      console.log(`Task ${taskId} already SEO-optimized, skipping`);
      return { taskId, status: "already_ready" };
    }

    // Only process tasks in expected status
    if (task.status !== "edited") {
      console.error(`Task ${taskId} has unexpected status: ${task.status}`);
      await updateTaskStatus(taskId, "failed", {
        error: `Cannot optimize SEO from status: ${task.status}`
      });
      return;
    }

    // Verify edited content exists
    if (!task.editedS3Key) {
      throw new Error(`Task ${taskId} has no edited editedS3Key`);
    }

    // Update status to optimizing
    await updateTaskStatus(taskId, "optimizing");

    // Fetch the edited content from S3
    const editedContent = await getS3Object(task.editedS3Key);

    const apiKey = await getAnthropicApiKey();

    const anthropicSDK = require("@anthropic-ai/sdk");
    const anthropicInstance = new anthropicSDK({ apiKey });

    const message = await anthropicInstance.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 8192,
      system: SEO_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `Optimize the SEO metadata for this blog post:\n\n${editedContent}`
        }
      ]
    });

    const textBlock = message.content.find(block => block.type === "text");
    if (!textBlock) {
      throw new Error("Claude returned no text content");
    }
    const optimizedContent = textBlock.text;

    // Save the SEO-optimized version to S3
    const finalS3Key = `final/${taskId}.md`;
    const s3Client = getS3Client();
    await s3Client.send(
      new PutObjectCommand({
        Bucket: process.env.BUCKET_NAME,
        Key: finalS3Key,
        Body: optimizedContent,
        ContentType: "text/markdown"
      })
    );

    // Update task record - status "ready" means ready for publication
    await updateTaskStatus(taskId, "ready", { finalS3Key });

    console.log(`SEO optimization complete for task ${taskId}: ${finalS3Key} - ready for publication`);

    return { taskId, finalS3Key, status: "ready" };
  } catch (error) {
    console.error(`SEO optimization failed for task ${taskId}:`, error);

    try {
      await updateTaskStatus(taskId, "failed", { error: error.message });
    } catch (updateError) {
      console.error("Failed to update task status:", updateError);
    }

    // Re-throw so SQS retries the message
    throw error;
  }
};
