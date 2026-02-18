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
  const { topic, category: providedCategory } = body;

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

    // --- Category resolution ---
    let resolvedCategory;
    let isNewCategory = false;
    let newCategoryColor = null;

    if (providedCategory) {
      // User explicitly specified a category via CLI — use it directly.
      resolvedCategory = providedCategory;
    } else {
      // Fetch the current known categories from DynamoDB (stays in sync as new ones are added).
      const knownCategories = await getKnownCategories();

      // Ask Claude to pick the best-fit category or invent a new one.
      // System prompt enforces strict classifier behaviour — role framing here is persistent
      // and not overridable by the creative reasoning the model applies to user-turn text.
      const categorySystemPrompt = `You are a strict category classifier for the richcorabbithole blog. Your only job is to assign one category slug.

Rules:
- STRONGLY prefer an existing category. Only create a new one when no existing category is even a loose fit.
- The existing categories cover a very wide range intentionally: a topic involving computers, software, AI, or electronics is "tech"; biology, physics, chemistry, astronomy, or medicine is "science"; anything you build or DIY is "maker". When in doubt, prefer a broad existing category over a narrow new one.
- Niche vocabulary does NOT justify a new category. A post about CRISPR is "science", not "genomics". A post about mechanical keyboards is "maker", not "hardware".
- A new category is justified ONLY when the topic's primary domain is genuinely not covered by any existing category (e.g. a cooking topic → "food"; a sports topic → "sports"; a personal finance topic → "finance").
- You must respond with ONLY valid JSON — no markdown, no explanation, no extra text.`;

      const categoryPrompt = `Existing categories: ${knownCategories.join(", ")}

Assign a category to this blog post. Use an existing category unless the topic clearly does not belong to any of them. Do not create a new category just because the topic is specific or uses niche vocabulary.

Only set "isNew": true if you are inventing a slug that does not appear in the existing list above.

Respond with ONLY this JSON shape:
{"category":"<slug>","isNew":<true|false>,"color":"<muted hex if isNew, else null>"}

If isNew is true, pick a muted hex color fitting a retro-future / Pip-Boy vault aesthetic (e.g. #5a9a8a, #8a7aaa, #aa8a5a, #5a8a6a, #aa5a5a, #7a7a7a).

Research excerpt:
${researchContent.slice(0, 3000)}`;

      const catMessage = await anthropicInstance.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 256,
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
        catResult = { category: "other", isNew: false, color: null };
      }

      resolvedCategory = catResult.category || "other";
      isNewCategory = catResult.isNew === true && !knownCategories.includes(resolvedCategory);
      newCategoryColor = isNewCategory ? (catResult.color || "#7a7a7a") : null;
    }

    console.log(`Task ${taskId} category resolved: ${resolvedCategory} (isNew: ${isNewCategory})`);

    // Update task record to researched, persisting category metadata
    const researchedFields = {
      s3Key,
      researchedAt: new Date().toISOString(),
      category: resolvedCategory,
      isNewCategory,
    };
    if (newCategoryColor) researchedFields.newCategoryColor = newCategoryColor;
    await updateTaskStatus(taskId, "researched", researchedFields);

    // Enqueue write job — non-fatal since research is already persisted.
    // If this fails, the task stays "researched" and can be re-triggered via cli.js draft.
    try {
      if (!process.env.WRITE_QUEUE_URL) {
        console.error(`WRITE_QUEUE_URL not set — skipping write enqueue for task ${taskId}`);
      } else {
        await sendSqsMessage(process.env.WRITE_QUEUE_URL, { taskId, category: resolvedCategory });
        console.log(`Research complete for task ${taskId}: ${s3Key} — write job enqueued (category: ${resolvedCategory})`);
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
