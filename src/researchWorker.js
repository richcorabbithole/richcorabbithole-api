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
const { getDocClient, getS3Client, getAnthropicApiKey, updateTaskStatus, parseSqsMessage, sendSqsMessage, getKnownCategories } = require("./lib/shared-utils");

module.exports.handler = async (event) => {
  const msg = parseSqsMessage(event);
  if (!msg) return;

  const { taskId, body } = msg;
  const { topic, category: providedCategory, articleType: providedArticleType } = body;

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

    // --- Article type resolution ---
    // If not supplied by the caller, infer it from the topic with a cheap classification call.
    const VALID_ARTICLE_TYPES = ["knowledge", "best-of", "how-to", "masterclass"];
    let resolvedArticleType = providedArticleType;
    let articleTypeInferred = false;

    if (!resolvedArticleType) {
      const typeMessage = await anthropicInstance.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 64,
        system: `You classify blog topic requests into one of four article types. Respond with ONLY valid JSON — no markdown, no explanation.

Types:
- "knowledge": Reader wants to understand a concept (what is X, how does X work, why does X matter)
- "best-of": Reader wants curation to choose from a crowded space (best tools, top options, what to use)
- "how-to": Reader wants to accomplish a specific goal (how to do X, steps to achieve Y)
- "masterclass": Reader wants deep, comprehensive ownership of a topic (complete guide, everything about X)`,
        messages: [{ role: "user", content: `Classify this topic: ${topic}\n\nRespond with ONLY: { "articleType": "<type>" }` }]
      });

      const typeTextBlock = typeMessage.content.find(b => b.type === "text");
      if (typeTextBlock) {
        try {
          const parsed = JSON.parse(typeTextBlock.text.trim());
          if (VALID_ARTICLE_TYPES.includes(parsed.articleType)) {
            resolvedArticleType = parsed.articleType;
            articleTypeInferred = true;
          }
        } catch {
          // ignore — falls back to "knowledge" below
        }
      }

      if (!resolvedArticleType) {
        console.warn(`Task ${taskId} article type inference failed, falling back to "knowledge"`);
        resolvedArticleType = "knowledge";
        articleTypeInferred = true;
      }

      console.log(`Task ${taskId} article type inferred: ${resolvedArticleType}`);
    } else {
      console.log(`Task ${taskId} article type provided: ${resolvedArticleType}`);
    }

    // Research focus addendum — adapts the research prompt to gather the right raw material
    // for each article type before the writer ever sees it.
    const RESEARCH_FOCUS = {
      "knowledge": "",
      "best-of": "\n\nFocus specifically on: identifying the major options in this space, the criteria for evaluating them, their relative tradeoffs, and which options are best suited for different use cases.",
      "how-to": "\n\nFocus specifically on: the step-by-step process required, prerequisites, common failure points and how to avoid them, and what success concretely looks like.",
      "masterclass": "\n\nThis will become a comprehensive deep-dive. Cover foundational concepts, intermediate nuance, advanced edge cases, open questions in the field, and practical application. Go deeper than a surface overview — the goal is for the reader to genuinely own this topic after reading."
    };

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
          content: `Research the following topic thoroughly: ${topic}${RESEARCH_FOCUS[resolvedArticleType]}`
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

    // --- Category resolution ---
    let resolvedCategory;
    let resolvedCategoryDescription = null;
    let isNewCategory = false;
    let newCategoryColor = null;

    // Shared slug validation — enforced for both user-supplied and model-output categories.
    const SLUG_RE = /^[a-z][a-z0-9-]*$/;

    // How much better a proposed new category must score over the best existing
    // category before we create it. Kept intentionally low (0.05) so that genuinely
    // distinct topics aren't forced into a broad bucket, while still biasing toward
    // reuse when the fit is roughly equal.
    const NEW_CATEGORY_THRESHOLD = 0.05;

    if (providedCategory) {
      // Defensively validate even user-supplied categories: the worker is an SQS consumer
      // and must not trust any field unconditionally (guards against replayed/crafted messages).
      if (SLUG_RE.test(providedCategory) && providedCategory.length <= 32) {
        resolvedCategory = providedCategory;
        // Still check whether this is a new category so publishWorker updates
        // config.ts, categoryConfig.ts, global.css, and DynamoDB appropriately.
        const knownCategories = await getKnownCategories();
        const existing = knownCategories.find(c => c.slug === resolvedCategory);
        if (!existing) {
          isNewCategory = true;
          newCategoryColor = "#7a7a7a"; // default muted color for user-supplied new categories
          resolvedCategoryDescription = `topics related to ${resolvedCategory}`;
        }
      } else {
        console.warn(`Provided category "${providedCategory}" failed validation, falling back to auto-categorization`);
        // resolvedCategory stays unset — falls through to the Claude categorization block below
      }
    }

    if (!resolvedCategory) {
      // Fetch the current known categories from DynamoDB (stays in sync as new ones are added).
      // Each entry is { slug, description } — descriptions travel with slugs so the classifier
      // always has accurate, up-to-date guidance even as categories evolve over time.
      const knownCategories = await getKnownCategories();

      const categoryListText = knownCategories
        .map(c => `- ${c.slug}: ${c.description}`)
        .join("\n");

      // Scoring-based classifier: ask Claude to score fit (0.0–1.0) for each existing
      // category AND optionally propose one new category with its own score.
      // A new category wins only when its score exceeds the best existing score by at
      // least NEW_CATEGORY_THRESHOLD (0.05), preventing broad categories from absorbing
      // everything simply because they are loosely applicable.
      const categorySystemPrompt = `You are a category classifier for the richcorabbithole blog. Score how well this blog post fits each category.

Rules:
- Score each existing category from 0.0 (no fit) to 1.0 (perfect fit) based on the post's PRIMARY domain.
- The primary domain is what the post is fundamentally about, not incidental themes. A post about a fictional character is "pop-culture" even if that character uses technology.
- Optionally propose ONE new category if the topic's primary domain is genuinely not covered by any existing category. Only propose a new category if it would score materially higher than all existing ones.
- You must respond with ONLY valid JSON — no markdown, no explanation, no extra text.`;

      const categoryPrompt = `Existing categories:
${categoryListText}

Score each category for this blog post, then optionally propose a new one.

Respond with ONLY this JSON shape:
{
  "scores": { "<existing-slug>": <0.0-1.0>, ... },
  "proposed": { "slug": "<new-slug>", "score": <0.0-1.0>, "description": "<short phrase describing what belongs here>", "color": "<muted hex>" } | null
}

For "color" if proposing a new category, pick a muted hex fitting a retro-future / Pip-Boy vault aesthetic (e.g. #5a9a8a, #8a7aaa, #aa8a5a, #5a8a6a, #aa5a5a, #7a7a7a, #9a7a5a).

Research excerpt:
${researchContent.slice(0, 3000)}`;

      const catMessage = await anthropicInstance.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 512,
        system: categorySystemPrompt,
        messages: [{ role: "user", content: categoryPrompt }]
      });

      const catTextBlock = catMessage.content.find(b => b.type === "text");
      if (!catTextBlock) throw new Error("Claude returned no text for category decision");

      let catResult;
      try {
        catResult = JSON.parse(catTextBlock.text.trim());
      } catch {
        console.warn("Failed to parse category JSON, falling back to 'other':", catTextBlock.text);
        catResult = { scores: {}, proposed: null };
      }

      // Find the best-scoring existing category
      const scores = catResult.scores && typeof catResult.scores === "object" ? catResult.scores : {};
      let bestSlug = "other";
      let bestScore = 0;
      for (const { slug } of knownCategories) {
        const score = typeof scores[slug] === "number" ? scores[slug] : 0;
        if (score > bestScore) {
          bestScore = score;
          bestSlug = slug;
        }
      }

      // Evaluate proposed new category — only accept if it clears the threshold AND has a valid slug
      const proposed = catResult.proposed && typeof catResult.proposed === "object" ? catResult.proposed : null;
      const rawProposedSlug = typeof proposed?.slug === "string" ? proposed.slug.trim() : "";
      const proposedScore = typeof proposed?.score === "number" ? proposed.score : 0;
      const isValidProposedSlug = SLUG_RE.test(rawProposedSlug) && rawProposedSlug.length <= 32;
      const proposedBeatsExisting = proposedScore - bestScore >= NEW_CATEGORY_THRESHOLD;
      const proposedIsNew = isValidProposedSlug && !knownCategories.find(c => c.slug === rawProposedSlug);

      if (proposed && isValidProposedSlug && proposedBeatsExisting && proposedIsNew) {
        resolvedCategory = rawProposedSlug;
        isNewCategory = true;
        resolvedCategoryDescription = typeof proposed.description === "string"
          ? proposed.description.slice(0, 200)
          : `topics related to ${rawProposedSlug}`;
        const rawColor = typeof proposed.color === "string" ? proposed.color.trim() : null;
        const isValidColor = rawColor && /^#[0-9a-fA-F]{3,8}$/.test(rawColor);
        newCategoryColor = isValidColor ? rawColor : "#7a7a7a";
        console.log(`Task ${taskId} new category "${resolvedCategory}" proposed (score ${proposedScore}) beats best existing "${bestSlug}" (score ${bestScore})`);
      } else {
        resolvedCategory = bestSlug;
        isNewCategory = false;
        newCategoryColor = null;
        if (proposed && isValidProposedSlug && !proposedBeatsExisting) {
          console.log(`Task ${taskId} proposed category "${rawProposedSlug}" (score ${proposedScore}) did not beat existing "${bestSlug}" (score ${bestScore}) by threshold ${NEW_CATEGORY_THRESHOLD} — using existing`);
        }
      }
    }

    console.log(`Task ${taskId} category resolved: ${resolvedCategory} (isNew: ${isNewCategory})`);

    // Update task record to researched, persisting category and article type metadata
    const researchedFields = {
      s3Key,
      researchedAt: new Date().toISOString(),
      category: resolvedCategory,
      isNewCategory,
      articleType: resolvedArticleType,
      articleTypeInferred,
    };
    if (newCategoryColor) researchedFields.newCategoryColor = newCategoryColor;
    if (resolvedCategoryDescription) researchedFields.categoryDescription = resolvedCategoryDescription;
    await updateTaskStatus(taskId, "researched", researchedFields);

    // Enqueue write job — non-fatal since research is already persisted.
    // If this fails, the task stays "researched" and can be re-triggered via cli.js draft.
    try {
      if (!process.env.WRITE_QUEUE_URL) {
        console.error(`WRITE_QUEUE_URL not set — skipping write enqueue for task ${taskId}`);
      } else {
        await sendSqsMessage(process.env.WRITE_QUEUE_URL, { taskId, category: resolvedCategory, articleType: resolvedArticleType });
        console.log(`Research complete for task ${taskId}: ${s3Key} — write job enqueued (category: ${resolvedCategory}, articleType: ${resolvedArticleType})`);
      }
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
