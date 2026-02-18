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

function buildFirstDraftPrompt(category) {
  const today = new Date().toISOString().slice(0, 10);
  return `You are a blog writer for richcorabbithole — a blog about going deep on random topics (hyperfixations).

Your job is to transform research notes into a blog post that satisfies intellectual curiosity. This is not marketing content or persuasive writing — it's exploration and discovery shared with curious readers.

The post MUST start with valid YAML frontmatter fenced by --- lines. The frontmatter MUST contain exactly these fields:
- title: An accurate, descriptive title that reflects what you actually learned (string, in quotes)
- description: A 1-2 sentence summary of what the post explores (string, in quotes)
- publishDate: "${today}" (string, in quotes — use this exact date, do not change it)
- hyperfixation: "${category}" (string, in quotes — do not change this value)
- slug: A short 2-4 word URL slug derived from the title (lowercase, hyphenated, max 30 chars, e.g. "roman-aqueducts", "quantum-sleep", "deep-sea-vents"). More memorable than the full title — omit filler words.
- researchDepth: How deep the research goes, 1-5 integer
- tags: Array of 3-6 relevant tags (array of strings)
- sources: Array of source URLs from the research (array of strings)

After the frontmatter, write the blog post in markdown with:
- **Conversational but substantive**: Like telling a friend about something interesting you learned over coffee. Natural, engaged, but not breathless or clinical.
- **Grounded in research**: Everything you write should come from the research notes. Do NOT invent scenarios, anecdotes, or personal experiences. If you want to frame something, use the actual research as the hook.
- **Personal voice for reactions, not stories**: Use "I" for genuine reactions to the research ("This surprised me", "I wasn't expecting this"), but never invent fictional situations ("my friend told me", "I once knew someone").
- **Show your thinking**: Include the process of discovery, not just polished conclusions. Dead ends, uncertainties, and questions are valuable.
- **Specific over generic**: Actual examples, real numbers, concrete details from the research. Avoid vague gestures like "research shows" without saying which research.
- **Natural section headings** (## level) that describe what they contain, not marketing formulas
- **Balanced tone**: Curious and interested, but not overselling. If something is genuinely surprising, say so. If it's incremental, say that too.
- **Opening**: Start with the topic itself, not "rabbit hole" metaphors or origin stories. Get to the interesting part immediately.
- A natural conclusion that reflects on what you learned or what questions remain
- 800-1500 words of body content

CRITICAL: Only write about what's actually in the research. No fictional anecdotes, invented friends, or made-up scenarios. The blog name is "richcorabbithole" but you don't need to say "rabbit hole" in every post.

Think: engaged curiosity, not academic distance or marketing hype. Trust your reader to find the material interesting without overselling it.

Do NOT include any text before the opening --- or after the post content.
Output ONLY the complete markdown file with frontmatter.`;
}

function buildRevisionPrompt(category) {
  return `You are a blog writer for richcorabbithole — a blog about going deep on random topics (hyperfixations).

You are revising an existing draft based on editorial feedback. You will receive:
1. The original research notes
2. The current draft
3. Revision notes explaining what needs to change

Apply the feedback while maintaining the blog's conversational but substantive tone. Aim for engaged curiosity, not academic distance or marketing hype. Keep the same frontmatter schema but update fields if the feedback requires it (e.g., more accurate title, better tags).

The post MUST start with valid YAML frontmatter fenced by --- lines. The frontmatter MUST contain exactly these fields:
- title: An accurate, descriptive title (string, in quotes)
- description: A 1-2 sentence summary of what the post explores (string, in quotes)
- publishDate: The original publish date (string, in quotes, YYYY-MM-DD format)
- hyperfixation: "${category}" (string, in quotes — do not change this value)
- slug: A short 2-4 word URL slug derived from the title (lowercase, hyphenated, max 30 chars, e.g. "roman-aqueducts", "quantum-sleep", "deep-sea-vents"). Keep from existing draft unless the title changed significantly.
- researchDepth: How deep the research goes, 1-5 integer
- tags: Array of 3-6 relevant tags (array of strings)
- sources: Array of source URLs from the research (array of strings)

Keep personal framing ("I"), show your thinking process, use specific details. Trust your reader's intelligence.

Do NOT include any text before the opening --- or after the post content.
Output ONLY the complete revised markdown file with frontmatter.`;
}

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

    // Resolve the category — set by researchWorker after categorization, falls back to "other"
    const resolvedCategory = task.category || "other";

    // Build the Claude prompt based on flow
    let systemPrompt;
    let userMessage;
    const s3Client = getS3Client();

    if (isRevision) {
      systemPrompt = buildRevisionPrompt(resolvedCategory);

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
      systemPrompt = buildFirstDraftPrompt(resolvedCategory);
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
      revisionCount,
      draftedAt: new Date().toISOString()
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
