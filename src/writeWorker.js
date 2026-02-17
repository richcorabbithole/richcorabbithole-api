/**
 * Write Worker Handler
 *
 * Triggered by SQS when a writing task is queued. Reads research from S3,
 * generates a blog post draft via Claude, saves the draft to S3, and
 * updates DynamoDB.
 *
 * Handles two flows:
 *   - First draft: task status is "researched" — writes from research alone
 *   - Revision: task status is "revision_requested" — revises the existing
 *     draft using editorial/human feedback notes
 *
 * Flow: SQS → this function → S3 (read research) → Claude API → S3 (write draft) + DynamoDB
 *
 * Error contract with SQS:
 *   - Return successfully → SQS deletes the message (done)
 *   - Throw an error → SQS retries (up to maxReceiveCount=2), then DLQ
 */

const { GetCommand } = require("@aws-sdk/lib-dynamodb");
const { PutObjectCommand, CopyObjectCommand } = require("@aws-sdk/client-s3");
const { getDocClient, getS3Client, getS3Object, getAnthropicApiKey, updateTaskStatus, parseSqsMessage, sendSqsMessage } = require("./lib/shared-utils");

const FIRST_DRAFT_SYSTEM_PROMPT = `You are a blog writer for richcorabbithole — a blog about going deep on random topics (hyperfixations).

Your job is to transform research notes into a blog post that satisfies intellectual curiosity. This is not marketing content or persuasive writing — it's exploration and discovery shared with curious readers.

The post MUST start with valid YAML frontmatter fenced by --- lines. The frontmatter MUST contain exactly these fields:
- title: An accurate, descriptive title that reflects what you actually learned (string, in quotes)
- description: A 1-2 sentence summary of what the post explores (string, in quotes)
- publishDate: Today's date in YYYY-MM-DD format (string, in quotes)
- hyperfixation: One of: tech, science, history, gaming, maker, other (string, in quotes)
- researchDepth: How deep the research goes, 1-5 integer
- tags: Array of 3-6 relevant tags (array of strings)
- draft: true (boolean, the post starts as a draft)
- sources: Array of source URLs from the research (array of strings)

After the frontmatter, write the blog post in markdown with:
- A conversational tone — like sharing something interesting you learned with a friend over coffee
- Natural section headings (## level) that emerge from the content, not marketing formulas
- Honest exploration: uncertainties, caveats, "I'm not sure about X", "This surprised me"
- No hype language: avoid "fascinating", "incredible", "game-changing", "revolutionary"
- No superlatives unless genuinely warranted by the facts
- Specific details and examples rather than vague claims
- A natural conclusion that reflects on what you learned, not a call-to-action
- 800-1500 words of body content

Trust your reader's intelligence. You're satisfying curiosity, not selling ideas.

Do NOT include any text before the opening --- or after the post content.
Output ONLY the complete markdown file with frontmatter.`;

const REVISION_SYSTEM_PROMPT = `You are a blog writer for richcorabbithole — a blog about going deep on random topics (hyperfixations).

You are revising an existing draft based on editorial feedback. You will receive:
1. The original research notes
2. The current draft
3. Revision notes explaining what needs to change

Apply the feedback while maintaining the blog's honest, exploratory tone. This is about satisfying curiosity, not marketing or persuasion. Keep the same frontmatter schema but update fields if the feedback requires it (e.g., more accurate title, better tags).

The post MUST start with valid YAML frontmatter fenced by --- lines. The frontmatter MUST contain exactly these fields:
- title: An accurate, descriptive title (string, in quotes)
- description: A 1-2 sentence summary of what the post explores (string, in quotes)
- publishDate: The original publish date (string, in quotes, YYYY-MM-DD format)
- hyperfixation: One of: tech, science, history, gaming, maker, other (string, in quotes)
- researchDepth: How deep the research goes, 1-5 integer
- tags: Array of 3-6 relevant tags (array of strings)
- draft: true (boolean)
- sources: Array of source URLs from the research (array of strings)

Avoid hype, superlatives, and marketing language. Trust your reader's intelligence.

Do NOT include any text before the opening --- or after the post content.
Output ONLY the complete revised markdown file with frontmatter.`;

module.exports.handler = async (event) => {
  const msg = parseSqsMessage(event);
  if (!msg) return;

  const { taskId } = msg;

  try {
    // Look up the task to get its current status and research location
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

    // Idempotency: if already completed (drafted or beyond), skip
    const completedStatuses = ["drafted", "editing", "edited", "optimizing", "ready"];
    if (completedStatuses.includes(task.status)) {
      console.log(`Task ${taskId} already processed (status: ${task.status}), skipping`);
      return { taskId, status: "already_processed" };
    }

    // Allow retries for in-progress writing
    const isRevision = task.status === "revision_requested";
    const isFirstDraft = task.status === "researched";
    const isRetry = task.status === "writing";

    if (!isFirstDraft && !isRevision && !isRetry) {
      console.error(`Task ${taskId} has unexpected status: ${task.status}`);
      await updateTaskStatus(taskId, "failed", {
        error: `Cannot write from status: ${task.status}`
      });
      return;
    }

    // Verify research exists
    if (!task.s3Key) {
      throw new Error(`Task ${taskId} has no research s3Key`);
    }

    // Update status to writing (idempotent if already writing)
    if (task.status !== "writing") {
      await updateTaskStatus(taskId, "writing");
    }

    // Fetch the research from S3
    const researchContent = await getS3Object(task.s3Key);

    // Build the Claude prompt based on flow
    let systemPrompt;
    let userMessage;
    const s3Client = getS3Client();

    if (isRevision) {
      systemPrompt = REVISION_SYSTEM_PROMPT;

      // Fetch current draft
      const draftKey = task.draftS3Key || `drafts/${taskId}.md`;
      const currentDraft = await getS3Object(draftKey);

      const revisionNotes = task.revisionNotes || "No specific notes provided.";

      userMessage = `## Original Research\n\n${researchContent}\n\n## Current Draft\n\n${currentDraft}\n\n## Revision Notes\n\n${revisionNotes}`;

      // Preserve previous draft before overwriting
      const revisionCount = (task.revisionCount || 0);
      const archiveKey = `drafts/${taskId}.rev${revisionCount}.md`;
      await s3Client.send(
        new CopyObjectCommand({
          Bucket: process.env.BUCKET_NAME,
          CopySource: `${process.env.BUCKET_NAME}/${draftKey}`,
          Key: archiveKey
        })
      );
    } else {
      systemPrompt = FIRST_DRAFT_SYSTEM_PROMPT;
      userMessage = `Write a blog post based on this research:\n\n${researchContent}`;
    }

    const apiKey = await getAnthropicApiKey();

    const anthropicSDK = require("@anthropic-ai/sdk");
    const anthropicInstance = new anthropicSDK({ apiKey });

    const message = await anthropicInstance.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 8192,
      system: systemPrompt,
      messages: [
        {
          role: "user",
          content: userMessage
        }
      ]
    });

    const textBlock = message.content.find(block => block.type === "text");
    if (!textBlock) {
      throw new Error("Claude returned no text content");
    }
    const draftContent = textBlock.text;

    // Save the draft to S3
    const draftS3Key = `drafts/${taskId}.md`;
    await s3Client.send(
      new PutObjectCommand({
        Bucket: process.env.BUCKET_NAME,
        Key: draftS3Key,
        Body: draftContent,
        ContentType: "text/markdown"
      })
    );

    // Update task record
    const revisionCount = isRevision ? (task.revisionCount || 0) + 1 : 0;
    await updateTaskStatus(taskId, "drafted", {
      draftS3Key,
      revisionCount
    });

    // Enqueue edit job — non-fatal since draft is already persisted.
    // If this fails, the task stays "drafted" and can be re-triggered via cli.js draft.
    try {
      if (!process.env.EDIT_QUEUE_URL) {
        console.error(`EDIT_QUEUE_URL not set — skipping edit enqueue for task ${taskId}`);
      } else {
        await sendSqsMessage(process.env.EDIT_QUEUE_URL, { taskId });
        console.log(`Draft ${isRevision ? "revised" : "created"} for task ${taskId}: ${draftS3Key} — edit job enqueued`);
      }
    } catch (enqueueErr) {
      console.error(`Draft saved but failed to enqueue edit job for ${taskId}:`, enqueueErr);
    }

    return { taskId, draftS3Key, status: "drafted", revisionCount };
  } catch (error) {
    console.error(`Writing failed for task ${taskId}:`, error);

    try {
      await updateTaskStatus(taskId, "failed", { error: error.message });
    } catch (updateError) {
      console.error("Failed to update task status:", updateError);
    }

    throw error;
  }
};
