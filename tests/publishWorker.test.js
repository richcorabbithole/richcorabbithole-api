const { describe, it, mock, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const { setupPublishWorkerMocks, PUBLISH_WORKER_PATH } = require("./test-helpers/mock-aws.js");
const { sqsEvent, runSqsValidationTests } = require("./test-helpers/worker-test-utils.js");
const { EventEmitter } = require("events");

// --- Sample post content (markdown with frontmatter) ---

const SAMPLE_POST = `---
title: "Test Post Title"
description: "A test description"
publishDate: "2026-02-17"
hyperfixation: "tech"
researchDepth: 3
tags:
  - testing
  - automation
draft: true
sources:
  - "https://example.com/source1"
  - "https://example.com/source2"
---

# Test Post Title

This is test blog post content with enough words to count.`;

const SAMPLE_POST_BASE64 = Buffer.from(SAMPLE_POST).toString("base64");

// GitHub returns base64 with embedded newlines every 60 chars
function toGitHubBase64(content) {
  const raw = Buffer.from(content).toString("base64");
  return raw.replace(/(.{60})/g, "$1\n");
}

// --- Fake https response builder ---

/**
 * Create a fake https.request that routes responses based on method+path.
 *
 * @param {Function} routeFn - (method, path, body) => { statusCode, body }
 * @returns {Function} A function matching the https.request(options, cb) signature
 */
function createMockHttps(routeFn) {
  return (options, callback) => {
    const fakeReq = new EventEmitter();
    let requestBody = "";
    fakeReq.write = (data) => { requestBody += data; };
    fakeReq.end = () => {
      const { statusCode, body } = routeFn(options.method, options.path, requestBody);
      const fakeRes = new EventEmitter();
      fakeRes.statusCode = statusCode;
      callback(fakeRes);
      fakeRes.emit("data", typeof body === "string" ? body : JSON.stringify(body));
      fakeRes.emit("end");
    };
    return fakeReq;
  };
}

// --- Default GitHub API route handler ---

function defaultGitHubRoutes(method, path, _requestBody) {
  // Token exchange (getGitHubToken)
  if (method === "POST" && path.includes("/access_tokens")) {
    return {
      statusCode: 201,
      body: { token: "ghs_test_token_123", expires_at: "2099-01-01T00:00:00Z" }
    };
  }
  // Get development branch SHA
  if (method === "GET" && path.includes("/git/ref/heads/development")) {
    return {
      statusCode: 200,
      body: { object: { sha: "abc123devsha" } }
    };
  }
  // Create branch
  if (method === "POST" && path.includes("/git/refs")) {
    return { statusCode: 201, body: { ref: "refs/heads/post/test-post-title" } };
  }
  // Check file existence (GET /contents/)
  if (method === "GET" && path.includes("/contents/")) {
    const err = { message: "Not Found" };
    return { statusCode: 404, body: err };
  }
  // Commit file (PUT /contents/)
  if (method === "PUT" && path.includes("/contents/")) {
    return { statusCode: 201, body: { content: { sha: "newfilesha" } } };
  }
  // Create PR
  if (method === "POST" && path.includes("/pulls")) {
    return {
      statusCode: 201,
      body: { html_url: "https://github.com/richcorabbithole/richcorabbithole-site/pull/42", number: 42 }
    };
  }
  // List PRs (for branch-exists check)
  if (method === "GET" && path.includes("/pulls")) {
    return { statusCode: 200, body: [] };
  }
  return { statusCode: 404, body: { message: "Unmatched route" } };
}

// --- Default AWS mockSend ---

function defaultMockSend(cmd) {
  if (cmd.name === "GetCommand") {
    return {
      Item: {
        taskId: "t1",
        status: "ready",
        finalS3Key: "final/t1.md"
      }
    };
  }
  if (cmd.name === "GetSecretValueCommand") {
    return {
      SecretString: JSON.stringify({
        appId: "12345",
        installationId: "67890",
        privateKey: "-----BEGIN RSA PRIVATE KEY-----\nfake-key\n-----END RSA PRIVATE KEY-----"
      })
    };
  }
  if (cmd.name === "GetObjectCommand") {
    return {
      Body: { transformToString: async () => SAMPLE_POST }
    };
  }
  return {};
}

// ======================================================================
// Tests
// ======================================================================

describe("publishWorker handler", () => {
  let handler;
  let mockSend;
  let mockHttpsRequest;
  let githubRoutes;
  let cleanup;

  beforeEach(() => {
    githubRoutes = defaultGitHubRoutes;
    mockSend = mock.fn(async (cmd) => defaultMockSend(cmd));
    mockHttpsRequest = mock.fn((options, callback) => {
      return createMockHttps(githubRoutes)(options, callback);
    });

    const setup = setupPublishWorkerMocks(mockSend, mockHttpsRequest);
    handler = setup.handler;
    cleanup = setup.cleanup;
  });

  afterEach(() => {
    cleanup();
    mock.restoreAll();
  });

  // --- Shared SQS validation ---

  runSqsValidationTests(() => handler);

  // --- Task lookup ---

  describe("task lookup", () => {
    it("throws when task is not found in DynamoDB", async () => {
      mockSend.mock.mockImplementation(async (cmd) => {
        if (cmd.name === "GetCommand") return {};
        return {};
      });

      await assert.rejects(
        () => handler(sqsEvent({ taskId: "t1" })),
        { message: "Task t1 not found" }
      );
    });

    it("throws when task has no finalS3Key", async () => {
      mockSend.mock.mockImplementation(async (cmd) => {
        if (cmd.name === "GetCommand") {
          return { Item: { taskId: "t1", status: "ready" } };
        }
        return {};
      });

      await assert.rejects(
        () => handler(sqsEvent({ taskId: "t1" })),
        { message: "Task t1 has no final finalS3Key" }
      );
    });

    it("marks task failed and returns on unexpected status", async () => {
      mockSend.mock.mockImplementation(async (cmd) => {
        if (cmd.name === "GetCommand") {
          return {
            Item: { taskId: "t1", status: "pending", finalS3Key: "final/t1.md" }
          };
        }
        return {};
      });

      const result = await handler(sqsEvent({ taskId: "t1" }));
      assert.strictEqual(result, undefined);

      const updateCalls = mockSend.mock.calls.filter(
        c => c.arguments[0].name === "UpdateCommand"
      );
      const failedUpdate = updateCalls.find(
        c => c.arguments[0].params.ExpressionAttributeValues[":status"] === "failed"
      );
      assert.ok(failedUpdate, "Expected task to be marked as failed");
    });
  });

  // --- Idempotency ---

  describe("idempotency", () => {
    it("skips already-published tasks", async () => {
      mockSend.mock.mockImplementation(async (cmd) => {
        if (cmd.name === "GetCommand") {
          return {
            Item: { taskId: "t1", status: "published", finalS3Key: "final/t1.md" }
          };
        }
        return {};
      });

      const result = await handler(sqsEvent({ taskId: "t1" }));
      assert.strictEqual(result.status, "already_published");

      // No GitHub calls should have been made
      assert.strictEqual(mockHttpsRequest.mock.callCount(), 0);
    });

    it("allows retry when status is publishing (SQS retry after crash)", async () => {
      mockSend.mock.mockImplementation(async (cmd) => {
        if (cmd.name === "GetCommand") {
          return {
            Item: { taskId: "t1", status: "publishing", finalS3Key: "final/t1.md" }
          };
        }
        if (cmd.name === "GetSecretValueCommand") {
          return defaultMockSend(cmd);
        }
        if (cmd.name === "GetObjectCommand") {
          return defaultMockSend(cmd);
        }
        return {};
      });

      const result = await handler(sqsEvent({ taskId: "t1" }));
      assert.strictEqual(result.status, "published");
    });
  });

  // --- Happy path ---

  describe("happy path (file does not exist)", () => {
    it("executes full flow: branch → check file → commit → PR → published", async () => {
      const result = await handler(sqsEvent({ taskId: "t1" }));

      assert.strictEqual(result.status, "published");
      assert.strictEqual(result.prUrl, "https://github.com/richcorabbithole/richcorabbithole-site/pull/42");
      assert.strictEqual(result.prNumber, 42);
    });

    it("updates DynamoDB with published status, prUrl, prNumber, and branchName", async () => {
      await handler(sqsEvent({ taskId: "t1" }));

      const updateCalls = mockSend.mock.calls.filter(
        c => c.arguments[0].name === "UpdateCommand"
      );
      const publishedUpdate = updateCalls.find(
        c => c.arguments[0].params.ExpressionAttributeValues[":status"] === "published"
      );
      assert.ok(publishedUpdate, "Expected published status update");

      const values = publishedUpdate.arguments[0].params.ExpressionAttributeValues;
      assert.ok(values[":prUrl"], "Expected prUrl in update");
      assert.ok(values[":branchName"], "Expected branchName in update");
    });

    it("sends PUT /contents without sha when file is new", async () => {
      const httpsCalls = [];
      githubRoutes = (method, path, requestBody) => {
        httpsCalls.push({ method, path, requestBody });
        return defaultGitHubRoutes(method, path, requestBody);
      };

      await handler(sqsEvent({ taskId: "t1" }));

      // Find the PUT /contents call
      const putCall = httpsCalls.find(c => c.method === "PUT" && c.path.includes("/contents/"));
      assert.ok(putCall, "Expected a PUT /contents call");

      const putBody = JSON.parse(putCall.requestBody);
      assert.strictEqual(putBody.sha, undefined, "PUT should not include sha for new file");
      assert.ok(putBody.content, "PUT should include base64 content");
      assert.ok(putBody.branch.startsWith("post/"), "PUT should target the feature branch");
    });

    it("creates PR with correct title and base branch", async () => {
      const httpsCalls = [];
      githubRoutes = (method, path, requestBody) => {
        httpsCalls.push({ method, path, requestBody });
        return defaultGitHubRoutes(method, path, requestBody);
      };

      await handler(sqsEvent({ taskId: "t1" }));

      const prCall = httpsCalls.find(c => c.method === "POST" && c.path.includes("/pulls"));
      assert.ok(prCall, "Expected a POST /pulls call");

      const prBody = JSON.parse(prCall.requestBody);
      assert.ok(prBody.title.includes("Test Post Title"), "PR title should include post title");
      assert.strictEqual(prBody.base, "development");
      assert.ok(prBody.head.startsWith("post/"), "PR head should be the feature branch");
    });
  });

  // --- Retry: file already committed with matching content ---

  describe("retry: file exists with matching content", () => {
    it("skips PUT /contents when file content matches", async () => {
      const httpsCalls = [];
      githubRoutes = (method, path, requestBody) => {
        httpsCalls.push({ method, path, requestBody });
        // Override GET /contents to return existing matching file
        if (method === "GET" && path.includes("/contents/")) {
          return {
            statusCode: 200,
            body: {
              sha: "existingfilesha",
              content: toGitHubBase64(SAMPLE_POST)
            }
          };
        }
        return defaultGitHubRoutes(method, path, requestBody);
      };

      const result = await handler(sqsEvent({ taskId: "t1" }));
      assert.strictEqual(result.status, "published");

      // Verify NO PUT /contents call was made
      const putCalls = httpsCalls.filter(c => c.method === "PUT" && c.path.includes("/contents/"));
      assert.strictEqual(putCalls.length, 0, "Should not PUT when file content matches");

      // Verify PR was still created
      const prCalls = httpsCalls.filter(c => c.method === "POST" && c.path.includes("/pulls"));
      assert.strictEqual(prCalls.length, 1, "Should still create PR");
    });
  });

  // --- Retry: file exists with different content ---

  describe("retry: file exists with different content", () => {
    it("includes sha in PUT /contents when updating existing file", async () => {
      const httpsCalls = [];
      githubRoutes = (method, path, requestBody) => {
        httpsCalls.push({ method, path, requestBody });
        // Override GET /contents to return existing file with DIFFERENT content
        if (method === "GET" && path.includes("/contents/")) {
          return {
            statusCode: 200,
            body: {
              sha: "oldfilesha123",
              content: toGitHubBase64("old content that doesn't match")
            }
          };
        }
        return defaultGitHubRoutes(method, path, requestBody);
      };

      const result = await handler(sqsEvent({ taskId: "t1" }));
      assert.strictEqual(result.status, "published");

      // Verify PUT /contents includes sha
      const putCall = httpsCalls.find(c => c.method === "PUT" && c.path.includes("/contents/"));
      assert.ok(putCall, "Expected a PUT /contents call");

      const putBody = JSON.parse(putCall.requestBody);
      assert.strictEqual(putBody.sha, "oldfilesha123", "PUT should include sha when updating");
    });
  });

  // --- Retry: branch and PR already exist ---

  describe("retry: branch and PR already exist", () => {
    it("returns early without file operations when PR already exists", async () => {
      const httpsCalls = [];
      githubRoutes = (method, path, requestBody) => {
        httpsCalls.push({ method, path, requestBody });

        // Token exchange
        if (method === "POST" && path.includes("/access_tokens")) {
          return defaultGitHubRoutes(method, path, requestBody);
        }
        // Get dev branch SHA
        if (method === "GET" && path.includes("/git/ref/heads/development")) {
          return defaultGitHubRoutes(method, path, requestBody);
        }
        // Branch creation → 422 (already exists)
        if (method === "POST" && path.includes("/git/refs")) {
          return {
            statusCode: 422,
            body: { message: "Reference already exists" }
          };
        }
        // List PRs → existing PR
        if (method === "GET" && path.includes("/pulls")) {
          return {
            statusCode: 200,
            body: [{
              html_url: "https://github.com/richcorabbithole/richcorabbithole-site/pull/99",
              number: 99
            }]
          };
        }
        return defaultGitHubRoutes(method, path, requestBody);
      };

      const result = await handler(sqsEvent({ taskId: "t1" }));
      assert.strictEqual(result.status, "published");
      assert.strictEqual(result.prUrl, "https://github.com/richcorabbithole/richcorabbithole-site/pull/99");

      // Verify no file operations (no GET /contents, no PUT /contents)
      const contentCalls = httpsCalls.filter(c => c.path.includes("/contents/"));
      assert.strictEqual(contentCalls.length, 0, "Should not check/commit files when PR already exists");
    });
  });

  // --- Retry: PR creation returns 422 (PR already exists) ---

  describe("retry: PR creation 422 with existing PR", () => {
    it("finds existing PR and succeeds when PR creation returns 422", async () => {
      const httpsCalls = [];
      githubRoutes = (method, path, requestBody) => {
        httpsCalls.push({ method, path, requestBody });

        // PR creation → 422 (already exists)
        if (method === "POST" && path.includes("/pulls") && !path.includes("/access_tokens") && !path.includes("/git/refs")) {
          return {
            statusCode: 422,
            body: { message: "A pull request already exists for richcorabbithole:post/test-post-title." }
          };
        }
        // List PRs → existing PR found
        if (method === "GET" && path.includes("/pulls")) {
          return {
            statusCode: 200,
            body: [{
              html_url: "https://github.com/richcorabbithole/richcorabbithole-site/pull/77",
              number: 77
            }]
          };
        }
        return defaultGitHubRoutes(method, path, requestBody);
      };

      const result = await handler(sqsEvent({ taskId: "t1" }));
      assert.strictEqual(result.status, "published");
      assert.strictEqual(result.prUrl, "https://github.com/richcorabbithole/richcorabbithole-site/pull/77");
      assert.strictEqual(result.prNumber, 77);

      // Verify DynamoDB was updated with the existing PR info
      const updateCalls = mockSend.mock.calls.filter(
        c => c.arguments[0].name === "UpdateCommand"
      );
      const publishedUpdate = updateCalls.find(
        c => c.arguments[0].params.ExpressionAttributeValues[":status"] === "published"
      );
      assert.ok(publishedUpdate, "Expected published status update");
    });

    it("re-throws 422 when no existing PR is found", async () => {
      githubRoutes = (method, path, requestBody) => {
        // PR creation → 422
        if (method === "POST" && path.includes("/pulls") && !path.includes("/access_tokens") && !path.includes("/git/refs")) {
          return { statusCode: 422, body: { message: "Validation Failed" } };
        }
        // List PRs → empty (no existing PR)
        if (method === "GET" && path.includes("/pulls")) {
          return { statusCode: 200, body: [] };
        }
        return defaultGitHubRoutes(method, path, requestBody);
      };

      await assert.rejects(
        () => handler(sqsEvent({ taskId: "t1" })),
        (err) => err.message.includes("422")
      );
    });

    it("re-throws non-422 PR creation errors", async () => {
      githubRoutes = (method, path, requestBody) => {
        if (method === "POST" && path.includes("/pulls") && !path.includes("/access_tokens") && !path.includes("/git/refs")) {
          return { statusCode: 500, body: { message: "Internal Server Error" } };
        }
        return defaultGitHubRoutes(method, path, requestBody);
      };

      await assert.rejects(
        () => handler(sqsEvent({ taskId: "t1" })),
        (err) => err.message.includes("500")
      );
    });
  });

  // --- Empty slug fallback ---

  describe("empty slug fallback", () => {
    it("uses taskId-based slug when title produces empty slug", async () => {
      const httpsCalls = [];
      // Provide a post with a title that slugifies to empty string (all special chars)
      const specialPost = `---
title: "!!!"
description: "test"
publishDate: "2026-02-17"
hyperfixation: "tech"
researchDepth: 3
tags:
  - test
draft: true
---

# Content here`;

      mockSend.mock.mockImplementation(async (cmd) => {
        if (cmd.name === "GetObjectCommand") {
          return {
            Body: { transformToString: async () => specialPost }
          };
        }
        return defaultMockSend(cmd);
      });

      githubRoutes = (method, path, requestBody) => {
        httpsCalls.push({ method, path, requestBody });
        return defaultGitHubRoutes(method, path, requestBody);
      };

      const result = await handler(sqsEvent({ taskId: "t1" }));
      assert.strictEqual(result.status, "published");

      // Verify branch name uses taskId fallback
      const branchCall = httpsCalls.find(c => c.method === "POST" && c.path.includes("/git/refs"));
      assert.ok(branchCall, "Expected branch creation call");
      const branchBody = JSON.parse(branchCall.requestBody);
      assert.ok(branchBody.ref.includes("post/post-t1"), "Branch should use taskId-based fallback slug");
    });
  });

  // --- Error handling ---

  describe("error handling", () => {
    it("marks task failed and re-throws on GitHub API failure", async () => {
      githubRoutes = (method, path, requestBody) => {
        // Token exchange succeeds
        if (method === "POST" && path.includes("/access_tokens")) {
          return defaultGitHubRoutes(method, path, requestBody);
        }
        // Get dev branch fails
        if (method === "GET" && path.includes("/git/ref/heads/development")) {
          return { statusCode: 500, body: { message: "Internal Server Error" } };
        }
        return defaultGitHubRoutes(method, path, requestBody);
      };

      await assert.rejects(
        () => handler(sqsEvent({ taskId: "t1" })),
        (err) => err.message.includes("500")
      );

      const updateCalls = mockSend.mock.calls.filter(
        c => c.arguments[0].name === "UpdateCommand"
      );
      const failedUpdate = updateCalls.find(
        c => c.arguments[0].params.ExpressionAttributeValues[":status"] === "failed"
      );
      assert.ok(failedUpdate, "Expected task to be marked as failed");
    });

    it("re-throws original error even when DynamoDB status update fails", async () => {
      let updateCallCount = 0;
      mockSend.mock.mockImplementation(async (cmd) => {
        if (cmd.name === "UpdateCommand") {
          updateCallCount++;
          // First update (publishing) succeeds, second (failed) throws
          if (updateCallCount >= 2) {
            throw new Error("DynamoDB down too");
          }
          return {};
        }
        return defaultMockSend(cmd);
      });

      githubRoutes = (method, path, requestBody) => {
        if (method === "POST" && path.includes("/access_tokens")) {
          return defaultGitHubRoutes(method, path, requestBody);
        }
        if (method === "GET" && path.includes("/git/ref/heads/development")) {
          return { statusCode: 500, body: { message: "GitHub is down" } };
        }
        return defaultGitHubRoutes(method, path, requestBody);
      };

      await assert.rejects(
        () => handler(sqsEvent({ taskId: "t1" })),
        (err) => err.message.includes("500")
      );
    });

    it("propagates GET /contents errors (non-404) for SQS retry", async () => {
      githubRoutes = (method, path, requestBody) => {
        // GET /contents returns 500
        if (method === "GET" && path.includes("/contents/")) {
          return { statusCode: 500, body: { message: "Server error" } };
        }
        return defaultGitHubRoutes(method, path, requestBody);
      };

      await assert.rejects(
        () => handler(sqsEvent({ taskId: "t1" })),
        (err) => err.message.includes("500")
      );
    });

    it("marks task failed when PR creation fails", async () => {
      githubRoutes = (method, path, requestBody) => {
        // PR creation returns 422 (e.g., PR already exists with same head/base, but different from our check)
        if (method === "POST" && path.includes("/pulls") && !path.includes("/access_tokens")) {
          return { statusCode: 422, body: { message: "Validation Failed" } };
        }
        return defaultGitHubRoutes(method, path, requestBody);
      };

      await assert.rejects(
        () => handler(sqsEvent({ taskId: "t1" })),
        (err) => err.message.includes("422")
      );

      const updateCalls = mockSend.mock.calls.filter(
        c => c.arguments[0].name === "UpdateCommand"
      );
      const failedUpdate = updateCalls.find(
        c => c.arguments[0].params.ExpressionAttributeValues[":status"] === "failed"
      );
      assert.ok(failedUpdate, "Expected task to be marked as failed");
    });

    it("marks task failed when S3 read fails", async () => {
      mockSend.mock.mockImplementation(async (cmd) => {
        if (cmd.name === "GetObjectCommand") {
          throw new Error("S3 bucket not found");
        }
        return defaultMockSend(cmd);
      });

      await assert.rejects(
        () => handler(sqsEvent({ taskId: "t1" })),
        { message: "S3 bucket not found" }
      );
    });
  });
});
