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

const { GetCommand } = require("@aws-sdk/lib-dynamodb");
const { getDocClient, getS3Object, getGitHubToken, githubApiRequest, updateTaskStatus, parseSqsMessage } = require("./lib/shared-utils");

const GITHUB_OWNER = "richcorabbithole";
const GITHUB_REPO = "richcorabbithole-site";
const BASE_BRANCH = "development";
const BLOG_PATH_PREFIX = "blog/src/content/blog";

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
    const slug = slugify(title);
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

    // Step 4: Create the PR
    const prBody = buildPrBody(frontmatter, wordCount, taskId);
    const pr = await githubApiRequest(
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
