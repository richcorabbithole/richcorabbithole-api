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

const { GetCommand, PutCommand } = require("@aws-sdk/lib-dynamodb");
const { PutObjectCommand } = require("@aws-sdk/client-s3");
const { createHash } = require("crypto");
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

    // Treat any post-research status as already done — guards against SQS at-least-once
    // delivery re-running the full pipeline (including the masterclass fan-out) on retry.
    // "failed" is intentionally excluded: failed tasks should be retried by SQS for recovery.
    const ALREADY_DONE_STATUSES = ["researched", "series_researched", "publishing", "published"];
    if (existing.Item && ALREADY_DONE_STATUSES.includes(existing.Item.status)) {
      console.log(`Task ${taskId} already processed (status: ${existing.Item.status}), skipping`);
      return { taskId, status: "already_processed" };
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

    // Defensively validate even caller-supplied types: the worker is an SQS consumer
    // and must not trust any field unconditionally (guards against replayed/crafted messages).
    let resolvedArticleType = null;
    let articleTypeInferred = false;

    if (providedArticleType) {
      if (VALID_ARTICLE_TYPES.includes(providedArticleType)) {
        resolvedArticleType = providedArticleType;
        console.log(`Task ${taskId} article type provided: ${resolvedArticleType}`);
      } else {
        console.warn(`Task ${taskId} provided articleType "${providedArticleType}" is invalid, falling back to inference`);
        // resolvedArticleType stays null — falls through to inference below
      }
    }

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
        .filter(c => c.slug !== "other")
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

    // --- Masterclass series fan-out ---
    // For masterclass articles, generate a series outline and create child tasks (one per part).
    // The parent task tracks the series; each child flows through the normal write→edit→SEO pipeline.
    // The publishWorker collects all children when they're all ready and creates one PR.
    if (resolvedArticleType === "masterclass") {
      // Reuse a previously stored outline if this is a retry after a mid-loop crash.
      // The outline is persisted to DynamoDB before the fan-out loop starts, so a crash
      // inside the loop leaves the parent record with a stable `seriesOutline` JSON string.
      // On retry we parse it instead of calling Claude again — this prevents LLM
      // non-determinism from producing a different outline and leaving orphaned children.
      let parts, seriesTitle, seriesSlug;
      const SERIES_SLUG_RE = /^[a-z][a-z0-9-]{0,29}$/;

      if (existing.Item && existing.Item.seriesOutline) {
        console.log(`Task ${taskId} reusing stored series outline (retry path)`);
        try {
          const stored = JSON.parse(existing.Item.seriesOutline);
          if (
            stored &&
            typeof stored.seriesTitle === "string" &&
            typeof stored.seriesSlug === "string" &&
            SERIES_SLUG_RE.test(stored.seriesSlug) &&
            Array.isArray(stored.parts) &&
            stored.parts.length >= 1 &&
            stored.parts.length <= 6
          ) {
            parts = stored.parts;
            seriesTitle = stored.seriesTitle;
            seriesSlug = stored.seriesSlug;
          }
        } catch {
          console.warn(`Task ${taskId} stored seriesOutline JSON parse failed, re-generating`);
        }
      }

      if (!parts) {
        // Generate series outline: seriesTitle, seriesSlug, parts array
        const outlineMessage = await anthropicInstance.messages.create({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1024,
          system: `You are a curriculum designer for a technical blog. Given research on a topic, produce a series outline for a masterclass learning series.

Rules:
- 3–6 parts total. Choose the count that best fits the topic's natural scope — don't pad or compress.
- Each part should be a focused, standalone 800–1500 word post that builds on previous parts.
- Parts must form a logical learning arc: foundations first, then intermediate, then advanced/synthesis.
- seriesSlug: lowercase, hyphenated, max 30 chars (e.g. "rust-ownership", "docker-networking")
- partScope: 2–4 sentences describing what THIS part covers and what the reader will understand after reading it. Be specific — the writer will use this as their brief.
- Respond with ONLY valid JSON — no markdown, no explanation.`,
          messages: [{
            role: "user",
            content: `Topic: ${topic}\n\nResearch summary:\n${researchContent.slice(0, 4000)}\n\nRespond with ONLY:\n{\n  "seriesTitle": "...",\n  "seriesSlug": "...",\n  "parts": [\n    { "part": 1, "partTitle": "...", "partScope": "..." },\n    ...\n  ]\n}`
          }]
        });

        const outlineTextBlock = outlineMessage.content.find(b => b.type === "text");
        let outline = null;
        if (outlineTextBlock) {
          try {
            outline = JSON.parse(outlineTextBlock.text.trim());
          } catch {
            console.warn(`Task ${taskId} series outline JSON parse failed, falling back to single-part`);
          }
        }

        // Validate outline shape — fall back to a single-part series if malformed
        const isValidOutline = outline &&
          typeof outline.seriesTitle === "string" &&
          typeof outline.seriesSlug === "string" &&
          SERIES_SLUG_RE.test(outline.seriesSlug) &&
          Array.isArray(outline.parts) &&
          outline.parts.length >= 1 &&
          outline.parts.length <= 6;

        parts = isValidOutline ? outline.parts : [{ part: 1, partTitle: topic, partScope: "" }];
        seriesTitle = isValidOutline ? outline.seriesTitle : topic;
        seriesSlug = isValidOutline ? outline.seriesSlug : `masterclass-${taskId.slice(0, 8)}`;

        // Persist the outline on the parent task BEFORE starting the fan-out loop.
        // If a crash occurs mid-loop, the retry re-enters here, finds seriesOutline,
        // and reuses it — preventing a different LLM response from generating orphaned children.
        await updateTaskStatus(taskId, existing.Item ? existing.Item.status : "researching", {
          seriesOutline: JSON.stringify({ seriesTitle, seriesSlug, parts })
        });
      }

      const totalParts = parts.length;

      console.log(`Task ${taskId} masterclass series: "${seriesTitle}" — ${totalParts} parts (slug: ${seriesSlug})`);

      // Create child tasks and enqueue write jobs BEFORE updating parent status.
      // If the loop fails mid-way, the parent stays in its current status and SQS retries
      // will re-enter here. Deterministic child IDs make re-creation idempotent.
      const docClient = getDocClient();
      const now = new Date().toISOString();
      const childTaskIds = [];

      for (const partDef of parts) {
        // Deterministic child ID: stable across retries for the same parent+part,
        // so a mid-loop crash followed by an SQS retry writes the same S3 key and
        // DynamoDB item (idempotent overwrite) rather than creating duplicate children.
        const childTaskId = createHash("sha256")
          .update(`${taskId}:part:${partDef.part}`)
          .digest("hex")
          .slice(0, 36);
        childTaskIds.push(childTaskId);

        // Save per-part research to S3: shared research + part scope injected at top
        const partResearchContent = partDef.partScope
          ? `## Part ${partDef.part} Scope\n\n${partDef.partScope}\n\n---\n\n${researchContent}`
          : researchContent;
        const partS3Key = `research/${childTaskId}.md`;
        await s3Client.send(
          new PutObjectCommand({
            Bucket: process.env.BUCKET_NAME,
            Key: partS3Key,
            Body: partResearchContent,
            ContentType: "text/markdown"
          })
        );

        // Create child task record
        await docClient.send(
          new PutCommand({
            TableName: process.env.TABLE_NAME,
            Item: {
              taskId: childTaskId,
              parentTaskId: taskId,
              status: "researched",
              topic,
              part: partDef.part,
              partTitle: partDef.partTitle || `Part ${partDef.part}`,
              partScope: partDef.partScope || "",
              seriesTitle,
              seriesSlug,
              totalParts,
              articleType: "masterclass",
              articleTypeInferred: false,
              category: resolvedCategory,
              isNewCategory: partDef.part === 1 ? isNewCategory : false, // only first part triggers new-category site files
              ...(partDef.part === 1 && newCategoryColor ? { newCategoryColor } : {}),
              ...(partDef.part === 1 && resolvedCategoryDescription ? { categoryDescription: resolvedCategoryDescription } : {}),
              s3Key: partS3Key,
              createdAt: now,
              updatedAt: now,
            }
          })
        );

        // Enqueue write job for this part
        try {
          if (!process.env.WRITE_QUEUE_URL) {
            console.error(`WRITE_QUEUE_URL not set — skipping write enqueue for child task ${childTaskId}`);
          } else {
            await sendSqsMessage(process.env.WRITE_QUEUE_URL, {
              taskId: childTaskId,
              category: resolvedCategory,
              articleType: "masterclass"
            });
            console.log(`Enqueued write job for part ${partDef.part}/${totalParts}: ${childTaskId}`);
          }
        } catch (enqueueErr) {
          console.error(`Research saved but failed to enqueue write job for child ${childTaskId}:`, enqueueErr);
        }
      }

      // Update parent task to series_researched only after ALL child tasks are created.
      // This is the correct placement: a retry that sees series_researched knows the fan-out
      // is genuinely complete and can skip safely.
      const parentFields = {
        s3Key,
        researchedAt: new Date().toISOString(),
        category: resolvedCategory,
        isNewCategory,
        articleType: resolvedArticleType,
        articleTypeInferred,
        seriesTitle,
        seriesSlug,
        totalParts,
      };
      if (newCategoryColor) parentFields.newCategoryColor = newCategoryColor;
      if (resolvedCategoryDescription) parentFields.categoryDescription = resolvedCategoryDescription;
      await updateTaskStatus(taskId, "series_researched", parentFields);

      return { taskId, s3Key, status: "series_researched", seriesSlug, totalParts, childTaskIds };
    }

    // --- Standard single-post flow ---

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
