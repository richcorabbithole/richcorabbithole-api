/**
 * Publish Worker Handler
 *
 * Triggered by SQS when the SEO stage completes. Takes the final blog post
 * from S3 and creates a PR on richcorabbithole-site via the GitHub API.
 *
 * Flow: SQS → this function → S3 (read final post) → GitHub API (branch, commit, PR) → DynamoDB
 *
 * GitHub API sequence:
 *   1. Get development branch SHA
 *   2. Create branch: post/{slug}
 *   3. Commit the markdown file to blog/src/content/blog/{slug}.md
 *   4. Open PR from post/{slug} → development
 *
 * Error contract with SQS:
 *   - Return successfully → SQS deletes the message (done)
 *   - Throw an error → SQS retries (up to maxReceiveCount=2), then DLQ
 */

const { GetCommand, QueryCommand, UpdateCommand } = require("@aws-sdk/lib-dynamodb");
const { getDocClient, getS3Object, getGitHubToken, githubApiRequest, updateTaskStatus, parseSqsMessage, addKnownCategory } = require("./lib/shared-utils");

const GITHUB_OWNER = "richcorabbithole";
const GITHUB_REPO = "richcorabbithole-site";
const BASE_BRANCH = "development";
const BLOG_PATH_PREFIX = "blog/src/content/blog";

const SITE_CONFIG_PATH     = "blog/src/content/config.ts";
const SITE_CAT_CONFIG_PATH = "blog/src/lib/categoryConfig.ts";
const SITE_CSS_PATH        = "blog/src/styles/global.css";

/**
 * Convert a title string into a URL-safe slug.
 * Example: "The Science of Sleep" → "the-science-of-sleep"
 */
function slugify(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

/**
 * Parse YAML frontmatter from a markdown string.
 * Returns an object with extracted fields and the body content.
 */
function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: content };

  const raw = match[1];
  const body = match[2];

  // Simple YAML parsing for known fields
  const get = (key) => {
    const m = raw.match(new RegExp(`^${key}:\\s*["']?(.+?)["']?\\s*$`, "m"));
    return m ? m[1] : null;
  };

  // Parse array fields (tags, sources)
  const getArray = (key) => {
    const arrayMatch = raw.match(new RegExp(`^${key}:\\s*\\n((?:\\s+-\\s+.+\\n?)*)`, "m"));
    if (arrayMatch) {
      return arrayMatch[1]
        .split("\n")
        .map(line => line.replace(/^\s*-\s*["']?(.+?)["']?\s*$/, "$1"))
        .filter(Boolean);
    }
    // Also handle inline array format: [item1, item2]
    const inlineMatch = raw.match(new RegExp(`^${key}:\\s*\\[(.+?)\\]`, "m"));
    if (inlineMatch) {
      return inlineMatch[1]
        .split(",")
        .map(s => s.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
    }
    return [];
  };

  return {
    frontmatter: {
      title: get("title"),
      description: get("description"),
      hyperfixation: get("hyperfixation"),
      slug: get("slug"),
      researchDepth: get("researchDepth"),
      tags: getArray("tags"),
      sources: getArray("sources")
    },
    body
  };
}

/**
 * Count words in a string.
 */
function countWords(text) {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

/**
 * Build the PR description body from post metadata.
 */
function buildPrBody(frontmatter, wordCount, taskId) {
  const lines = [
    "## New Blog Post",
    "",
    `**Title:** ${frontmatter.title || "Untitled"}`,
  ];

  if (frontmatter.hyperfixation) {
    lines.push(`**Category:** ${frontmatter.hyperfixation}`);
  }
  lines.push(`**Word count:** ${wordCount}`);
  if (frontmatter.researchDepth) {
    lines.push(`**Research depth:** ${frontmatter.researchDepth}/5`);
  }

  if (frontmatter.sources && frontmatter.sources.length > 0) {
    lines.push("", "### Sources");
    for (const source of frontmatter.sources) {
      lines.push(`- ${source}`);
    }
  }

  lines.push(
    "",
    "---",
    `*Automated by the richcorabbithole pipeline — Task ID: \`${taskId}\`*`
  );

  return lines.join("\n");
}

/**
 * Build the PR description for a masterclass series.
 */
function buildSeriesPrBody(seriesTitle, seriesSlug, parts, parentTaskId) {
  const lines = [
    "## New Masterclass Series",
    "",
    `**Series:** ${seriesTitle}`,
    `**Parts:** ${parts.length}`,
    "",
    "### Parts",
  ];
  for (const p of parts) {
    lines.push(`- **Part ${p.part}:** ${p.title}`);
  }
  lines.push(
    "",
    "---",
    `*Automated by the richcorabbithole pipeline — Series task ID: \`${parentTaskId}\`*`
  );
  return lines.join("\n");
}

/**
 * Query all child tasks for a given parentTaskId via the GSI.
 * Returns array of DynamoDB items.
 */
async function getChildTasks(docClient, tableName, parentTaskId) {
  const result = await docClient.send(
    new QueryCommand({
      TableName: tableName,
      IndexName: "parentTaskId-index",
      KeyConditionExpression: "parentTaskId = :pid",
      ExpressionAttributeValues: { ":pid": parentTaskId },
    })
  );
  return result.Items || [];
}

/**
 * Fetch a file from the repo on a given branch.
 * Returns { content: string, sha: string }.
 */
async function getRepoFile(repoPath, filePath, branchName, token) {
  const result = await githubApiRequest(
    "GET",
    `${repoPath}/contents/${filePath}?ref=${branchName}`,
    token
  );
  const content = Buffer.from(result.content.replace(/\n/g, ""), "base64").toString("utf-8");
  return { content, sha: result.sha };
}

/**
 * Commit a single file update to an existing branch.
 */
async function commitRepoFile(repoPath, filePath, branchName, token, newContent, sha, message) {
  await githubApiRequest("PUT", `${repoPath}/contents/${filePath}`, token, {
    message,
    content: Buffer.from(newContent).toString("base64"),
    branch: branchName,
    sha
  });
}

/**
 * Add a new category to the three site files that define it:
 *   1. blog/src/content/config.ts  — Zod enum
 *   2. blog/src/lib/categoryConfig.ts — label + color record
 *   3. blog/src/styles/global.css  — CSS custom property
 *
 * All changes are committed directly to branchName.
 */
async function commitNewCategorySiteFiles(repoPath, branchName, token, category, color) {
  const label = category.toUpperCase().replace(/-/g, " ");
  const cssVar = `--color-cat-${category}`;

  // 1. config.ts — add to z.enum([...]) array
  const { content: configContent, sha: configSha } = await getRepoFile(repoPath, SITE_CONFIG_PATH, branchName, token);
  const alreadyInConfig = configContent.includes(`'${category}'`) || configContent.includes(`"${category}"`);
  let updatedConfig = configContent;
  if (!alreadyInConfig) {
    updatedConfig = configContent.replace(
      /(hyperfixation:\s*z\.enum\(\[)([\s\S]*?)(\]\))/,
      (_, open, inner, close) => `${open}${inner.trimEnd()}, '${category}'${close}`
    );
    if (updatedConfig === configContent) {
      throw new Error(`commitNewCategorySiteFiles: enum pattern not found in config.ts — file may have been refactored`);
    }
  }
  await commitRepoFile(repoPath, SITE_CONFIG_PATH, branchName, token, updatedConfig, configSha, `Add category: ${category}`);

  // 2. categoryConfig.ts — add to Category type union and add record entry
  // Quote the key so hyphenated slugs (e.g. "true-crime") produce valid TS object literals.
  const { content: catConfigContent, sha: catConfigSha } = await getRepoFile(repoPath, SITE_CAT_CONFIG_PATH, branchName, token);
  const newEntry = `  '${category}': { label: '${label}', color: 'var(${cssVar})' },`;
  // Use quoted-key checks only — avoid the bare-word regex which falsely matches
  // unquoted object keys (e.g. `lifestyle:`) before the entry is actually present.
  const alreadyInCatConfig = catConfigContent.includes(`'${category}'`) || catConfigContent.includes(`"${category}"`);
  let updatedCatConfig = catConfigContent;
  if (!alreadyInCatConfig) {
    // 2a. Add to the `export type Category = ...` union on the first line.
    updatedCatConfig = updatedCatConfig.replace(
      /(export type Category\s*=\s*)([\s\S]*?)(;)/,
      (_, open, inner, close) => `${open}${inner.trimEnd()} | '${category}'${close}`
    );
    if (updatedCatConfig === catConfigContent) {
      throw new Error(`commitNewCategorySiteFiles: Category type pattern not found in categoryConfig.ts — file may have been refactored`);
    }
    // 2b. Add the record entry.
    updatedCatConfig = updatedCatConfig.replace(
      /(export const categoryConfig[^{]*\{)([\s\S]*?)(\};)/,
      (_, open, inner, close) => `${open}${inner}${newEntry}\n${close}`
    );
    if (updatedCatConfig === catConfigContent) {
      throw new Error(`commitNewCategorySiteFiles: categoryConfig pattern not found in categoryConfig.ts — file may have been refactored`);
    }
  }
  await commitRepoFile(repoPath, SITE_CAT_CONFIG_PATH, branchName, token, updatedCatConfig, catConfigSha, `Add category: ${category}`);

  // 3. global.css — add CSS variable in @theme block after last --color-cat-* line
  const { content: cssContent, sha: cssSha } = await getRepoFile(repoPath, SITE_CSS_PATH, branchName, token);
  const cssLine = `  ${cssVar}: ${color};`;
  const alreadyInCss = cssContent.includes(cssVar);
  let updatedCss = cssContent;
  if (!alreadyInCss) {
    updatedCss = cssContent.replace(
      /(--color-cat-[a-z-]+:\s*#[0-9a-fA-F]+;)(?![\s\S]*--color-cat-)/,
      (match) => `${match}\n${cssLine}`
    );
    if (updatedCss === cssContent) {
      throw new Error(`commitNewCategorySiteFiles: --color-cat-* pattern not found in global.css — file may have been refactored`);
    }
  }
  await commitRepoFile(repoPath, SITE_CSS_PATH, branchName, token, updatedCss, cssSha, `Add category: ${category}`);

  console.log(`Committed site file changes for new category: ${category}`);
}

module.exports.handler = async (event) => {
  const msg = parseSqsMessage(event);
  if (!msg) return;

  const { taskId } = msg;

  try {
    // Look up the task to verify status and get final post location
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

    // Idempotency: if already published, skip
    if (task.status === "published") {
      console.log(`Task ${taskId} already published, skipping`);
      return { taskId, status: "already_published" };
    }

    // --- Series child task path ---
    // If this task is a child of a masterclass series, check whether all siblings are ready
    // before proceeding. The last sibling to reach "ready" will find all siblings ready and
    // proceed to create the PR; earlier arrivals exit cleanly (message is consumed, not retried).
    if (task.parentTaskId) {
      const siblings = await getChildTasks(docClient, process.env.TABLE_NAME, task.parentTaskId);
      const allReady = siblings.length > 0 && siblings.every(s => s.status === "ready" || s.status === "published");

      if (!allReady) {
        const readyCount = siblings.filter(s => s.status === "ready" || s.status === "published").length;
        console.log(`Series task ${taskId}: ${readyCount}/${siblings.length} parts ready — waiting for remaining parts`);
        // Return without error — SQS deletes the message. The finalS3Key is already saved.
        // The last sibling to arrive will trigger the PR creation.
        return { taskId, status: "waiting_for_siblings" };
      }

      // All siblings ready — check if PR already created (idempotency)
      const parentResult = await docClient.send(
        new GetCommand({ TableName: process.env.TABLE_NAME, Key: { taskId: task.parentTaskId } })
      );
      const parentTask = parentResult.Item;
      if (parentTask && parentTask.status === "published") {
        console.log(`Series parent ${task.parentTaskId} already published, marking child ${taskId} published`);
        await updateTaskStatus(taskId, "published", { publishedAt: new Date().toISOString(), prUrl: parentTask.prUrl, prNumber: parentTask.prNumber, branchName: parentTask.branchName });
        return { taskId, status: "already_published" };
      }

      // Mark parent as publishing to claim PR creation (first sibling to get here wins)
      try {
        await docClient.send(
          new UpdateCommand({
            TableName: process.env.TABLE_NAME,
            Key: { taskId: task.parentTaskId },
            UpdateExpression: "SET #status = :publishing, updatedAt = :now",
            ConditionExpression: "#status <> :publishing AND #status <> :published",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: {
              ":publishing": "publishing",
              ":published": "published",
              ":now": new Date().toISOString(),
            },
          })
        );
      } catch (condErr) {
        if (condErr.name === "ConditionalCheckFailedException") {
          // Re-fetch parent to distinguish two cases:
          // 1. Parent is "published" → another sibling completed the PR, we're done.
          // 2. Parent is "publishing" → a previous attempt claimed the lock but failed
          //    mid-way (GitHub error, S3 read error, etc.). Treat the existing lock as
          //    ours and fall through to the GitHub operations — they're all idempotent.
          const recheck = await docClient.send(
            new GetCommand({ TableName: process.env.TABLE_NAME, Key: { taskId: task.parentTaskId } })
          );
          const recheckParent = recheck.Item;
          if (recheckParent && recheckParent.status === "published") {
            console.log(`Series parent ${task.parentTaskId} already published — marking child ${taskId} published`);
            await updateTaskStatus(taskId, "published", { publishedAt: new Date().toISOString(), prUrl: recheckParent.prUrl, prNumber: recheckParent.prNumber, branchName: recheckParent.branchName });
            return { taskId, status: "already_published" };
          }
          if (recheckParent && recheckParent.status === "publishing") {
            console.log(`Series parent ${task.parentTaskId} is stalled in publishing — resuming`);
            // Fall through to the GitHub operations below
          } else {
            console.log(`Series parent ${task.parentTaskId} already being published by another sibling — skipping`);
            return { taskId, status: "waiting_for_siblings" };
          }
        } else {
          throw condErr;
        }
      }

      // Sort siblings by part number, collect their final posts
      const sortedSiblings = [...siblings].sort((a, b) => (a.part || 0) - (b.part || 0));
      const token = await getGitHubToken();
      const repoPath = `/repos/${GITHUB_OWNER}/${GITHUB_REPO}`;

      // Get base branch SHA
      const devRef = await githubApiRequest("GET", `${repoPath}/git/ref/heads/${BASE_BRANCH}`, token);
      const baseSha = devRef.object.sha;

      const seriesSlug = task.seriesSlug;
      const seriesTitle = task.seriesTitle;
      const branchName = `series/${seriesSlug}`;

      // Create series branch
      try {
        await githubApiRequest("POST", `${repoPath}/git/refs`, token, {
          ref: `refs/heads/${branchName}`,
          sha: baseSha,
        });
      } catch (err) {
        if (!(err.statusCode === 422 && err.response?.message?.includes("Reference already exists"))) {
          throw err;
        }
        console.log(`Branch ${branchName} already exists — continuing`);
      }

      // Commit new-category site files from the first part (if applicable)
      const firstPart = sortedSiblings[0];
      if (firstPart.isNewCategory && firstPart.category && firstPart.newCategoryColor) {
        await commitNewCategorySiteFiles(repoPath, branchName, token, firstPart.category, firstPart.newCategoryColor);
      }

      // Commit each part's markdown file
      const partSummaries = [];
      for (const sibling of sortedSiblings) {
        const postContent = await getS3Object(sibling.finalS3Key);
        const { frontmatter } = parseFrontmatter(postContent);
        const title = frontmatter.title || `Part ${sibling.part}`;
        const SLUG_RE = /^[a-z][a-z0-9-]{0,49}$/;
        const rawSlug = typeof frontmatter.slug === "string" ? frontmatter.slug.trim() : "";
        const slug = (SLUG_RE.test(rawSlug) ? rawSlug : null) || slugify(title) || `${seriesSlug}-part-${sibling.part}`;
        const filePath = `${BLOG_PATH_PREFIX}/${slug}.md`;
        const encodedContent = Buffer.from(postContent).toString("base64");

        let skipCommit = false;
        let existingFileSha = null;
        try {
          const existing = await githubApiRequest("GET", `${repoPath}/contents/${filePath}?ref=${branchName}`, token);
          if (existing.content?.replace(/\n/g, "") === encodedContent) {
            skipCommit = true;
          } else {
            existingFileSha = existing.sha;
          }
        } catch (err) {
          if (err.statusCode !== 404) throw err;
        }

        if (!skipCommit) {
          const commitPayload = {
            message: `Add series part ${sibling.part}: ${title}`,
            content: encodedContent,
            branch: branchName,
          };
          if (existingFileSha) commitPayload.sha = existingFileSha;
          await githubApiRequest("PUT", `${repoPath}/contents/${filePath}`, token, commitPayload);
        }

        partSummaries.push({ part: sibling.part, title, slug });
      }

      // Create the series PR
      const prBody = buildSeriesPrBody(seriesTitle, seriesSlug, partSummaries, task.parentTaskId);
      let pr;
      try {
        pr = await githubApiRequest("POST", `${repoPath}/pulls`, token, {
          title: `New series: ${seriesTitle}`,
          body: prBody,
          head: branchName,
          base: BASE_BRANCH,
        });
      } catch (err) {
        if (err.statusCode === 422) {
          const prs = await githubApiRequest("GET", `${repoPath}/pulls?head=${GITHUB_OWNER}:${branchName}&base=${BASE_BRANCH}&state=open`, token);
          if (prs.length > 0) {
            pr = prs[0];
          } else {
            throw err;
          }
        } else {
          throw err;
        }
      }

      // Persist new category to DynamoDB (non-fatal)
      if (firstPart.isNewCategory && firstPart.category) {
        try {
          const description = firstPart.categoryDescription || `topics related to ${firstPart.category}`;
          await addKnownCategory(firstPart.category, description);
        } catch (catErr) {
          console.error(`Failed to persist new category (non-fatal):`, catErr);
        }
      }

      // Mark parent task published
      const publishedAt = new Date().toISOString();
      await updateTaskStatus(task.parentTaskId, "published", {
        publishedAt,
        prUrl: pr.html_url,
        prNumber: pr.number,
        branchName,
      });

      // Mark all child tasks published
      for (const sibling of sortedSiblings) {
        await updateTaskStatus(sibling.taskId, "published", { publishedAt, prUrl: pr.html_url, prNumber: pr.number, branchName });
      }

      console.log(`Published series "${seriesTitle}" (${sortedSiblings.length} parts): PR #${pr.number} at ${pr.html_url}`);
      return { taskId, parentTaskId: task.parentTaskId, prUrl: pr.html_url, prNumber: pr.number, status: "published" };
    }

    // --- Standard single-post path ---

    // Allow retries for in-progress publishing or expected ready status
    const isExpected = task.status === "ready";
    const isRetry = task.status === "publishing";

    if (!isExpected && !isRetry) {
      console.error(`Task ${taskId} has unexpected status: ${task.status}`);
      await updateTaskStatus(taskId, "failed", {
        error: `Cannot publish from status: ${task.status}`
      });
      return;
    }

    // Verify final post exists
    if (!task.finalS3Key) {
      throw new Error(`Task ${taskId} has no final finalS3Key`);
    }

    // Update status to publishing
    if (task.status !== "publishing") {
      await updateTaskStatus(taskId, "publishing");
    }

    // Fetch the final post from S3
    const postContent = await getS3Object(task.finalS3Key);

    // Parse frontmatter for metadata
    const { frontmatter, body } = parseFrontmatter(postContent);
    const title = frontmatter.title || `post-${taskId.slice(0, 8)}`;
    // Validate the Claude-generated frontmatter slug before using it in git refs and file paths.
    // Must be a clean lowercase slug (no /, .., spaces, or other invalid ref characters).
    // Falls back to slugify(title) so a malformed model output can't produce unexpected paths.
    const SLUG_RE = /^[a-z][a-z0-9-]{0,49}$/;
    const rawSlug = typeof frontmatter.slug === "string" ? frontmatter.slug.trim() : "";
    const slug = (SLUG_RE.test(rawSlug) ? rawSlug : null)
      || slugify(title)
      || `post-${taskId.slice(0, 8)}`;
    const wordCount = countWords(body);

    // Get GitHub token
    const token = await getGitHubToken();

    const repoPath = `/repos/${GITHUB_OWNER}/${GITHUB_REPO}`;

    // Step 1: Get the development branch SHA
    const devRef = await githubApiRequest(
      "GET",
      `${repoPath}/git/ref/heads/${BASE_BRANCH}`,
      token
    );
    const baseSha = devRef.object.sha;

    // Step 2: Create branch post/{slug}
    const branchName = `post/${slug}`;
    try {
      await githubApiRequest(
        "POST",
        `${repoPath}/git/refs`,
        token,
        {
          ref: `refs/heads/${branchName}`,
          sha: baseSha
        }
      );
    } catch (err) {
      // 422 means ref already exists — check if we should treat as idempotent
      if (err.statusCode === 422 && err.response?.message?.includes("Reference already exists")) {
        console.log(`Branch ${branchName} already exists — checking for existing PR`);
        const prs = await githubApiRequest(
          "GET",
          `${repoPath}/pulls?head=${GITHUB_OWNER}:${branchName}&base=${BASE_BRANCH}&state=open`,
          token
        );
        if (prs.length > 0) {
          const pr = prs[0];
          console.log(`PR already exists: ${pr.html_url}`);
          await updateTaskStatus(taskId, "published", {
            publishedAt: new Date().toISOString(),
            prUrl: pr.html_url,
            prNumber: pr.number,
            branchName
          });
          return { taskId, prUrl: pr.html_url, status: "published" };
        }
        // Branch exists but no PR — continue to commit and create PR
      } else {
        throw err;
      }
    }

    // Step 3: Commit the file to the branch
    const filePath = `${BLOG_PATH_PREFIX}/${slug}.md`;
    const encodedContent = Buffer.from(postContent).toString("base64");

    // Check if file already exists on branch (handles retry after partial success).
    // The prior attempt may have committed the file but failed before creating the PR.
    let skipCommit = false;
    let existingFileSha = null;
    try {
      const existing = await githubApiRequest(
        "GET",
        `${repoPath}/contents/${filePath}?ref=${branchName}`,
        token
      );
      if (existing.content?.replace(/\n/g, "") === encodedContent) {
        console.log(`File already committed with matching content, skipping PUT`);
        skipCommit = true;
      } else {
        existingFileSha = existing.sha;
        console.log(`File exists with different content, will update (sha: ${existingFileSha})`);
      }
    } catch (err) {
      if (err.statusCode === 404) {
        // File doesn't exist yet — normal first-attempt path
      } else {
        throw err;
      }
    }

    if (!skipCommit) {
      const commitPayload = {
        message: `Add blog post: ${title}`,
        content: encodedContent,
        branch: branchName
      };
      if (existingFileSha) {
        commitPayload.sha = existingFileSha;
      }
      await githubApiRequest("PUT", `${repoPath}/contents/${filePath}`, token, commitPayload);
    }

    // Step 3b: If this post introduces a new category, commit site file changes first.
    // Use task.category (validated and stored by researchWorker) rather than frontmatter.hyperfixation
    // (model-generated content from the post body) to prevent crafted frontmatter from writing
    // unexpected keys into repo TS/CSS files.
    if (task.isNewCategory && task.category && task.newCategoryColor) {
      await commitNewCategorySiteFiles(
        repoPath,
        branchName,
        token,
        task.category,
        task.newCategoryColor
      );
    }

    // Step 4: Create the PR
    const prBody = buildPrBody(frontmatter, wordCount, taskId);
    let pr;
    try {
      pr = await githubApiRequest(
        "POST",
        `${repoPath}/pulls`,
        token,
        {
          title: `New post: ${title}`,
          body: prBody,
          head: branchName,
          base: BASE_BRANCH
        }
      );
    } catch (err) {
      // 422 means a PR already exists for this head/base — treat as idempotent
      if (err.statusCode === 422) {
        console.log(`PR creation returned 422 — checking for existing PR on ${branchName}`);
        const prs = await githubApiRequest(
          "GET",
          `${repoPath}/pulls?head=${GITHUB_OWNER}:${branchName}&base=${BASE_BRANCH}&state=open`,
          token
        );
        if (prs.length > 0) {
          pr = prs[0];
          console.log(`Existing PR found: ${pr.html_url}`);
        } else {
          throw err;
        }
      } else {
        throw err;
      }
    }

    // If this post introduced a new category, persist it to DynamoDB so future
    // research runs see it immediately. Use task.category (the validated value from DynamoDB)
    // rather than frontmatter.hyperfixation (model-generated, unvalidated at this point).
    if (task.isNewCategory && task.category) {
      try {
        const description = task.categoryDescription || `topics related to ${task.category}`;
        await addKnownCategory(task.category, description);
        console.log(`Added new category to DynamoDB: ${task.category} — "${description}"`);
      } catch (catErr) {
        // Non-fatal — the PR is already open; category will be missing from DynamoDB
        // but the site schema was already committed as part of the PR.
        console.error(`Failed to persist new category to DynamoDB (non-fatal):`, catErr);
      }
    }

    // Update task record
    await updateTaskStatus(taskId, "published", {
      publishedAt: new Date().toISOString(),
      prUrl: pr.html_url,
      prNumber: pr.number,
      branchName
    });

    console.log(`Published task ${taskId}: PR #${pr.number} at ${pr.html_url}`);

    return { taskId, prUrl: pr.html_url, prNumber: pr.number, status: "published" };
  } catch (error) {
    console.error(`Publishing failed for task ${taskId}:`, error);

    try {
      await updateTaskStatus(taskId, "failed", { error: error.message });
    } catch (updateError) {
      console.error("Failed to update task status:", updateError);
    }

    // Re-throw so SQS retries the message
    throw error;
  }
};
