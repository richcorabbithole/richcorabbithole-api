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

const ARTICLE_TYPE_STRUCTURE = {
  "knowledge": `- **Structure**: Conceptual sections that build understanding naturally — foundational concepts first, then nuance, then implications. Use ## headings that describe what each section explains, not marketing formulas.
- **Opening**: Start with the concept itself. Get to the interesting part immediately.
- **Conclusion**: Reflect on what you learned and what questions remain open.
- **Length**: 800–1500 words of body content.`,

  "best-of": `- **Structure**: (1) Brief intro establishing why choice is hard or the space is crowded, (2) The criteria you'd use to evaluate options, (3) Each notable option with honest tradeoffs — what it's good at, where it falls short, who it's for, (4) A clear recommendation with reasoning. Don't hedge — make the call.
- **Opening**: Establish the choice problem immediately. Don't summarize what you're about to do — just start evaluating.
- **Tone**: Opinionated but fair. Honest about tradeoffs. No option is perfect; say so.
- **Length**: 1000–1800 words of body content.`,

  "how-to": `- **Structure**: (1) What you'll accomplish and any prerequisites, (2) Numbered steps — specific, actionable, in order, (3) What can go wrong and how to handle it, (4) How to know it worked.
- **Opening**: State what the reader will be able to do after following this. Get to step 1 quickly.
- **Steps**: Be concrete. Include actual commands, values, or decisions where relevant. Don't skip steps that seem obvious.
- **Tone**: Direct and practical. Save the exploration for the knowledge posts — here the reader wants to get something done.
- **Length**: 800–1500 words of body content.`,

  "masterclass": `- **Structure**: Build from foundations up. Start with what someone needs to know first, then intermediate concepts, then advanced nuance and edge cases. Use named ## sections that could stand alone as reference points. Include a "further reading" or "where to go next" section at the end.
- **Opening**: Frame the scope — what this covers and why it matters to go deep on it.
- **Depth**: Go further than a knowledge post. Cover the mechanisms, the history, the controversies, the open questions, and the practical implications. This is a reference, not a scan.
- **Tone**: Still conversational, but willing to slow down and be precise. The reader is investing time — reward that.
- **Length**: 2000–4000 words of body content.`,

  "masterclass-part": `- **Structure**: This is ONE part of a multi-part series — stay tightly focused on this part's scope. Open by briefly orienting the reader within the series arc (one sentence is enough). Cover this part's topic thoroughly with named ## sections. End with a natural hand-off that sets up the next part (if there is one).
- **Opening**: Get to this part's topic immediately. One sentence of series context, then dive in.
- **Depth**: Go deep on this specific scope — don't try to cover the whole series topic. Precision and depth within the scope beats breadth.
- **Tone**: Conversational but precise. The reader is committed to the series — reward that with substance, not padding.
- **Length**: 800–1500 words of body content.`
};

function buildFirstDraftPrompt(category, articleType = "knowledge", seriesContext = null) {
  const today = new Date().toISOString().slice(0, 10);

  // Series parts use a focused per-part structure, not the standalone masterclass structure
  const effectiveStructureKey = seriesContext ? "masterclass-part" : articleType;
  const structure = ARTICLE_TYPE_STRUCTURE[effectiveStructureKey] || ARTICLE_TYPE_STRUCTURE["knowledge"];

  // Series-specific frontmatter fields injected when this post is part of a series
  const seriesFrontmatter = seriesContext ? `- seriesSlug: "${seriesContext.seriesSlug}" (string, in quotes — do not change this value)
- seriesTitle: "${seriesContext.seriesTitle}" (string, in quotes — do not change this value)
- part: ${seriesContext.part} (integer — do not change this value)
- totalParts: ${seriesContext.totalParts} (integer — do not change this value)` : "";

  const seriesNote = seriesContext
    ? `\nThis post is **Part ${seriesContext.part} of ${seriesContext.totalParts}** in the "${seriesContext.seriesTitle}" series. The research notes include a "Part ${seriesContext.part} Scope" section at the top — use that as your brief for what this specific part should cover.\n`
    : "";

  return `You are a blog writer for richcorabbithole — a blog about going deep on random topics (hyperfixations).

Your job is to transform research notes into a blog post that satisfies intellectual curiosity. This is not marketing content or persuasive writing — it's exploration and discovery shared with curious readers.

The post MUST start with valid YAML frontmatter fenced by --- lines. The frontmatter MUST contain exactly these fields:
- title: An accurate, descriptive title that reflects what you actually learned (string, in quotes)
- description: A 1-2 sentence summary of what the post explores (string, in quotes)
- publishDate: "${today}" (string, in quotes — use this exact date, do not change it)
- hyperfixation: "${category}" (string, in quotes — do not change this value)
- articleType: "${articleType}" (string, in quotes — do not change this value)
- slug: A short 2-4 word URL slug derived from the title (lowercase, hyphenated, max 30 chars, e.g. "roman-aqueducts", "quantum-sleep", "deep-sea-vents"). More memorable than the full title — omit filler words.
- researchDepth: How deep the research goes, 1-5 integer
- tags: Array of 3-6 relevant tags (array of strings)
- sources: Array of source URLs from the research (array of strings)${seriesFrontmatter ? `\n${seriesFrontmatter}` : ""}
${seriesNote}
This post is a **${articleType}** article. Structure and write it accordingly:
${structure}

Across all article types:
- **Conversational but substantive**: Like telling a friend about something interesting you learned. Natural, engaged, but not breathless or clinical.
- **Grounded in research**: Everything you write should come from the research notes. Do NOT invent scenarios, anecdotes, or personal experiences.
- **Personal voice for reactions, not stories**: Use "I" for genuine reactions to the research ("This surprised me", "I wasn't expecting this"), but never invent fictional situations.
- **Show your thinking**: Include the process of discovery, not just polished conclusions. Dead ends, uncertainties, and questions are valuable.
- **Specific over generic**: Actual examples, real numbers, concrete details from the research.
- **Balanced tone**: Curious and interested, not overselling.

CRITICAL: Only write about what's actually in the research. No fictional anecdotes, invented friends, or made-up scenarios.

Do NOT include any text before the opening --- or after the post content.
Output ONLY the complete markdown file with frontmatter.`;
}

function buildRevisionPrompt(category, articleType = "knowledge", seriesContext = null) {
  const effectiveStructureKey = seriesContext ? "masterclass-part" : articleType;
  const structure = ARTICLE_TYPE_STRUCTURE[effectiveStructureKey] || ARTICLE_TYPE_STRUCTURE["knowledge"];

  const seriesFrontmatter = seriesContext ? `- seriesSlug: "${seriesContext.seriesSlug}" (string, in quotes — do not change this value)
- seriesTitle: "${seriesContext.seriesTitle}" (string, in quotes — do not change this value)
- part: ${seriesContext.part} (integer — do not change this value)
- totalParts: ${seriesContext.totalParts} (integer — do not change this value)` : "";

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
- articleType: "${articleType}" (string, in quotes — do not change this value)
- slug: A short 2-4 word URL slug derived from the title (lowercase, hyphenated, max 30 chars, e.g. "roman-aqueducts", "quantum-sleep", "deep-sea-vents"). Keep from existing draft unless the title changed significantly.
- researchDepth: How deep the research goes, 1-5 integer
- tags: Array of 3-6 relevant tags (array of strings)
- sources: Array of source URLs from the research (array of strings)${seriesFrontmatter ? `\n${seriesFrontmatter}` : ""}

This post is a **${articleType}** article — maintain its structural conventions during revision:
${structure}

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

    // Resolve the category and article type — both set by researchWorker, fall back to safe defaults
    const resolvedCategory = task.category || "other";
    const resolvedArticleType = task.articleType || "knowledge";

    // Build series context if this is a child task (part of a masterclass series)
    const seriesContext = task.parentTaskId && task.seriesSlug ? {
      seriesSlug: task.seriesSlug,
      seriesTitle: task.seriesTitle,
      part: task.part,
      totalParts: task.totalParts,
    } : null;

    // Build the Claude prompt based on flow
    let systemPrompt;
    let userMessage;
    const s3Client = getS3Client();

    if (isRevision) {
      systemPrompt = buildRevisionPrompt(resolvedCategory, resolvedArticleType, seriesContext);

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
      systemPrompt = buildFirstDraftPrompt(resolvedCategory, resolvedArticleType, seriesContext);
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
