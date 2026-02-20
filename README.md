# richcorabbithole-api

Serverless agent pipeline for the richcorabbithole blog. Automates blog post creation through a multi-stage pipeline: Research, Write, Edit, SEO, Publish.

Built on AWS Lambda, API Gateway, SQS, S3, DynamoDB, and the Claude API.

## Architecture

```
Client (CLI) ─── POST /research ───> API Gateway (IAM auth)
                                         │
                                    research.js (accept)
                                    ┌────────────────────┐
                                    │ Validate input      │
                                    │ Create DynamoDB rec  │
                                    │ Send SQS message     │
                                    │ Return 202 + taskId  │
                                    └────────┬───────────┘
                                             │
                                      ResearchQueue (SQS)
                                    (VisibilityTimeout: 960s)
                                             │
                                    researchWorker.js
                                    ┌────────────────────┐
                                    │ Idempotency check   │
                                    │ Fetch API key       │
                                    │ Call Claude API      │
                                    │ Save research to S3  │
                                    │ Update DynamoDB      │
                                    └────────┬───────────┘
                                             │
                                       WriteQueue (SQS)
                                    (VisibilityTimeout: 960s)
                                             │
                                    writeWorker.js
                                    ┌────────────────────┐
                                    │ Read research from S3│
                                    │ Call Claude API      │
                                    │ Save draft to S3     │
                                    │ Update DynamoDB      │
                                    └────────┬───────────┘
                                             │
                                        EditQueue (SQS)
                                    (VisibilityTimeout: 240s)
                                             │
                                    editWorker.js
                                    ┌────────────────────┐
                                    │ Read draft from S3   │
                                    │ Call Claude API      │
                                    │ Save edited to S3    │
                                    │ Update DynamoDB      │
                                    └────────┬───────────┘
                                             │
                                        SeoQueue (SQS)
                                    (VisibilityTimeout: 120s)
                                             │
                                    seoWorker.js
                                    ┌────────────────────┐
                                    │ Read edited from S3  │
                                    │ Call Claude API      │
                                    │ Save final to S3     │
                                    │ Update DynamoDB      │
                                    └────────┬───────────┘
                                             │
                                      PublishQueue (SQS)
                                    (VisibilityTimeout: 120s)
                                             │
                                    publishWorker.js
                                    ┌────────────────────┐
                                    │ Read final from S3   │
                                    │ Create GitHub branch  │
                                    │ Commit markdown file  │
                                    │ Open PR → development │
                                    │ Update DynamoDB      │
                                    └────────────────────┘
                                             │
                                    On failure (2x) ──> DLQ (per queue)
```

### Services

- **Lambda** (Node.js 24) - Serverless functions
- **API Gateway** - REST endpoint with IAM authorization
- **SQS** - Async job queue with dead letter queue
- **S3** - Research content storage (`richcorabbithole-research-{stage}`)
- **DynamoDB** - Task tracking (`richcorabbithole-tasks-{stage}`, GSI on `status` for querying by pipeline stage, GSI on `parentTaskId` for querying series child tasks)
- **Secrets Manager** - Claude API key and GitHub App credentials
- **GitHub API** - PR creation via GitHub App (installation token auth)

## Project Structure

```
src/
  hello.js              # Health check endpoint
  research.js           # Thin accept handler (validate, queue, 202)
  researchWorker.js     # SQS research worker (Claude API, S3, DynamoDB; masterclass fan-out)
  writeWorker.js        # SQS writing worker (drafts & revisions; series-aware frontmatter)
  editWorker.js         # SQS editing worker (copy editing & polishing)
  seoWorker.js          # SQS SEO worker (metadata optimization)
  publishWorker.js      # SQS publish worker (single post or series PR collection)
  lib/
    shared-utils.js     # Shared AWS utilities (clients, helpers, SQS send)
tests/
  hello.test.js         # Tests for health check
  research.test.js      # Tests for accept handler
  researchWorker.test.js # Tests for research worker (including masterclass fan-out)
  writeWorker.test.js   # Tests for write worker (including series child task)
  editWorker.test.js    # Tests for edit worker
  seoWorker.test.js     # Tests for SEO worker
  publishWorker.test.js # Tests for publish worker (including series collection)
  cli.test.js           # Tests for CLI commands (including series-status)
  test-helpers/
    mock-aws.js         # AWS SDK mock infrastructure
    worker-test-utils.js # Shared worker test behaviors
scripts/
  cli.js                # Unified CLI (publish, research, draft, read-draft, approve, reject, delete, series-status)
.github/workflows/
  test.yml              # Run tests on PRs + EoL check
  deploy-dev.yml        # Deploy on merge to development
  deploy-prod.yml       # Deploy on release from main
  codex-review.yml      # Automated code review on PRs
```

## Prerequisites

- Node.js 24+
- AWS CLI configured with a `richcorabbithole` profile
- Serverless Framework v4 (`npm install -g serverless`)

## Setup

```bash
npm install
```

## Deploy

### GitHub Actions (recommended)

Deployments are automated via GitHub Actions with OIDC authentication:

- **Dev**: Merge a PR to `development` branch
- **Prod**: Create a release from `main` branch

### Local

```bash
# Deploy to dev
npm run deploy:dev

# Deploy to prod
npm run deploy:prod
```

## CLI Usage

All pipeline operations go through a single CLI at `scripts/cli.js`:

```bash
node scripts/cli.js <command> [options]
```

### Commands

**publish** — Run the full pipeline with live progress (Research → Write → Edit → SEO → Publish):

```bash
node scripts/cli.js publish "quantum computing" --category tech --profile richcorabbithole
node scripts/cli.js publish "black holes" --category science --stage prod --profile richcorabbithole
node scripts/cli.js publish "machine learning fundamentals" --article-type masterclass --profile richcorabbithole
```

**research** — Trigger a research task via the API (SigV4-signed):

```bash
npm run research -- --topic "serverless architecture" --profile richcorabbithole
npm run research -- --topic "AWS Lambda cold starts" --stage prod --profile richcorabbithole
```

**draft** — Enqueue a write job for an already-researched task:

```bash
npm run draft -- <taskId> --profile richcorabbithole
```

**read-draft** — Display the current draft for a task:

```bash
npm run read-draft -- <taskId> --profile richcorabbithole
```

**approve** — Mark a published task as approved training data:

```bash
node scripts/cli.js approve <taskId> --stage prod --profile richcorabbithole
```

**reject** — Mark a published task as rejected (bad data):

```bash
node scripts/cli.js reject <taskId> --stage prod --profile richcorabbithole
```

Both commands set an `approval` field (`"approved"` or `"rejected"`) and a timestamp (`approvedAt` / `rejectedAt`) on the DynamoDB task record. Tasks with no `approval` field have not been reviewed yet. This data is used for training data curation — scan for `approval = "approved"` to collect positive examples.

**series-status** — Show the status of all parts in a masterclass series (pass any task ID from the series):

```bash
node scripts/cli.js series-status <taskId> --stage dev --profile richcorabbithole
```

Prints a table of part number, title, and pipeline status for all sibling tasks in the series.

**delete** — Delete a task record and all affiliated S3 objects:

```bash
node scripts/cli.js delete <taskId> --stage dev --profile richcorabbithole
```

Removes all S3 objects associated with the task (`research/`, `drafts/`, `edited/`, `final/`) then deletes the DynamoDB item. S3 objects are deleted first so the record is never orphaned without its files.

### Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--topic` | (required for `research`) | Research topic (max 500 characters) |
| `--category` | (optional) | Blog category slug — e.g. `tech`, `science`, `history`, `gaming`, `maker`, `pop-culture`, `other`. New categories can be invented by the pipeline. |
| `--article-type` | (optional) | Override article type — `knowledge`, `best-of`, `how-to`, `masterclass`. If omitted, Claude infers the best type for the topic. |
| `--stage` | `dev` | Target stage (`dev` or `prod`) |
| `--profile` | `AWS_PROFILE` env var | AWS CLI profile for credentials |

### Example: `publish`

```
🚀 Starting pipeline (dev)...
📝 Topic: quantum computing
🏷️  Category: tech

✅ Pipeline started — task ID: a1b2c3d4-...

[3s] Starting...
[6s] Researching...
[45s] Research complete
[48s] Writing draft...
[120s] Draft complete
[123s] Editing...
[150s] Edit complete
[153s] SEO optimization...
[165s] SEO complete
[168s] Creating PR...
[171s] Published!

--- Summary ---
Task ID:  a1b2c3d4-...
S3 file:  final/a1b2c3d4-....md
PR:       https://github.com/richcorabbithole/richcorabbithole-site/pull/42
Branch:   post/quantum-computing-from-qubits-to-error-correction

Stage timestamps:
  Researched: 2026-02-17T10:00:45Z
  Drafted:    2026-02-17T10:02:00Z
  Edited:     2026-02-17T10:02:30Z
  Ready:      2026-02-17T10:02:45Z
  Published:  2026-02-17T10:02:51Z

Title: Quantum Computing: From Qubits to Error Correction
Word count: 1247

Total time: 171s
```

### Example: `research`

```
📡 Calling research API (dev)...
🔍 Topic: serverless architecture

✅ Status: 202

📄 Response:
{
  "taskId": "a1b2c3d4-...",
  "status": "pending",
  "message": "Research task queued for processing"
}

💡 Track your task: GET /research/a1b2c3d4-...
```

### Pipeline Status Flow

**Standard articles:** `pending` → `researching` → `researched` → `writing` → `drafted` → `editing` → `edited` → `optimizing` → `ready` → `publishing` → `published` (or `failed` at any step).

**Masterclass series (parent task):** `pending` → `researching` → `series_researched` → `publishing` → `published`

**Masterclass series (child tasks):** `pending` → `writing` → `drafted` → `editing` → `edited` → `optimizing` → `ready` → `waiting_for_siblings` (if other parts are still in progress) or straight to `published` (if last part to finish).

The parent task stores `seriesTitle`, `seriesSlug`, `totalParts`, and `seriesOutline` (JSON — persisted before fan-out so retries reuse the same outline). Each child task stores `parentTaskId`, `part`, `totalParts`, `seriesSlug`, and `seriesTitle`. On retry, `publishWorker` filters siblings to `part` in `1..totalParts` to discard any orphaned children from a prior (different) outline attempt.

## Stages

| Stage | Domain | Description |
|-------|--------|-------------|
| `dev` | `dev-api.richcorabbithole.com` | Development |
| `prod` | `api.richcorabbithole.com` | Production |

Custom domains are configured via API Gateway (EDGE) with Cloudflare DNS (gray cloud / DNS-only).

## IAM

Two separate IAM layers:

- **Lambda execution role** (defined in `serverless.yml` provider.iam) - What the functions can do at runtime (S3, DynamoDB, SQS, Secrets Manager)
- **Deployer permissions** - What can create/modify infrastructure. Used by both the `serverless-deployer` IAM user (local) and the `github-actions-richcorabbithole-deployer` OIDC role (CI/CD)

## License

MIT
