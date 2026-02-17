/**
 * Edit Worker Handler
 *
 * Triggered by SQS when an editing task is queued. Reads the draft from S3,
 * runs it through Claude for editorial improvements, saves the edited version
 * to S3, and updates DynamoDB.
 *
 * Flow: SQS → this function → S3 (read draft) → Claude API → S3 (write edited) + DynamoDB
 *
 * Error contract with SQS:
 *   - Return successfully → SQS deletes the message (done)
 *   - Throw an error → SQS retries (up to maxReceiveCount=2), then DLQ
 */

const { GetCommand } = require("@aws-sdk/lib-dynamodb");
const { PutObjectCommand } = require("@aws-sdk/client-s3");
const { getDocClient, getS3Client, getS3Object, getAnthropicApiKey, updateTaskStatus, parseSqsMessage, sendSqsMessage } = require("./lib/shared-utils");

const EDIT_SYSTEM_PROMPT = `You are a senior editor for richcorabbithole — a blog about going deep on random topics (hyperfixations).

Your job is to take a draft blog post and improve it for publication. You act as a copy editor, not a rewriter — preserve the author's voice and structure while polishing the content.

Review and improve the draft for:
- **Clarity**: Ensure every paragraph communicates its point clearly. Remove ambiguity.
- **Logical flow**: Sections should build on each other naturally. Add transitions where needed.
- **Factual accuracy**: Flag or remove unsupported claims. If a statement needs a source, note it.
- **Tone consistency**: The blog has a conversational, curious tone — like explaining something fascinating to a friend. Smooth out any sections that feel too formal or too casual.
- **Grammar & punctuation**: Fix errors without over-editing.
- **Readability**: Break up long paragraphs, improve sentence variety, ensure headings are descriptive.
- **Frontmatter**: Preserve the existing YAML frontmatter exactly as-is. Do not change the frontmatter fields or their values unless fixing an obvious error (e.g., malformed YAML).

Do NOT add new sections or significantly expand the content. Focus on making what's there better.
Do NOT include any text before the opening --- or after the post content.
Output ONLY the complete improved markdown file with frontmatter.`;

module.exports.handler = async (event) => {
  const msg = parseSqsMessage(event);
  if (!msg) return;

  const { taskId } = msg;

  try {
    // Look up the task to get its current status and draft location
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

    // Idempotency: if already edited or further along, skip
    const completedStatuses = ["edited", "optimizing", "ready"];
    if (completedStatuses.includes(task.status)) {
      console.log(`Task ${taskId} already processed (status: ${task.status}), skipping`);
      return { taskId, status: "already_processed" };
    }

    // Only process tasks in expected status
    if (task.status !== "drafted") {
      console.error(`Task ${taskId} has unexpected status: ${task.status}`);
      await updateTaskStatus(taskId, "failed", {
        error: `Cannot edit from status: ${task.status}`
      });
      return;
    }

    // Verify draft exists
    if (!task.draftS3Key) {
      throw new Error(`Task ${taskId} has no draft draftS3Key`);
    }

    // Update status to editing
    await updateTaskStatus(taskId, "editing");

    // Fetch the draft from S3
    const draftContent = await getS3Object(task.draftS3Key);

    const apiKey = await getAnthropicApiKey();

    const anthropicSDK = require("@anthropic-ai/sdk");
    const anthropicInstance = new anthropicSDK({ apiKey });

    const message = await anthropicInstance.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 8192,
      system: EDIT_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `Edit and improve this blog post draft:\n\n${draftContent}`
        }
      ]
    });

    const textBlock = message.content.find(block => block.type === "text");
    if (!textBlock) {
      throw new Error("Claude returned no text content");
    }
    const editedContent = textBlock.text;

    // Save the edited version to S3
    const editedS3Key = `edited/${taskId}.md`;
    const s3Client = getS3Client();
    await s3Client.send(
      new PutObjectCommand({
        Bucket: process.env.BUCKET_NAME,
        Key: editedS3Key,
        Body: editedContent,
        ContentType: "text/markdown"
      })
    );

    // Update task record
    await updateTaskStatus(taskId, "edited", { editedS3Key });

    // Enqueue SEO job — non-fatal since edited content is already persisted.
    // If this fails, the task stays "edited" and can be re-triggered manually.
    try {
      if (!process.env.SEO_QUEUE_URL) {
        console.error(`SEO_QUEUE_URL not set — skipping SEO enqueue for task ${taskId}`);
      } else {
        await sendSqsMessage(process.env.SEO_QUEUE_URL, { taskId });
        console.log(`Edit complete for task ${taskId}: ${editedS3Key} — SEO job enqueued`);
      }
    } catch (enqueueErr) {
      console.error(`Edit saved but failed to enqueue SEO job for ${taskId}:`, enqueueErr);
    }

    return { taskId, editedS3Key, status: "edited" };
  } catch (error) {
    console.error(`Editing failed for task ${taskId}:`, error);

    try {
      await updateTaskStatus(taskId, "failed", { error: error.message });
    } catch (updateError) {
      console.error("Failed to update task status:", updateError);
    }

    // Re-throw so SQS retries the message
    throw error;
  }
};
