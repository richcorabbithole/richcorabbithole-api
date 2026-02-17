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
                                    └────────────────────┘
                                             │
                                    On failure (2x) ──> DLQ (per queue)
```

### Services

- **Lambda** (Node.js 24) - Serverless functions
- **API Gateway** - REST endpoint with IAM authorization
- **SQS** - Async job queue with dead letter queue
- **S3** - Research content storage (`richcorabbithole-research-{stage}`)
- **DynamoDB** - Task tracking (`richcorabbithole-tasks-{stage}`)
- **Secrets Manager** - Claude API key storage

## Project Structure

```
src/
  hello.js              # Health check endpoint
  research.js           # Thin accept handler (validate, queue, 202)
  researchWorker.js     # SQS research worker (Claude API, S3, DynamoDB)
  writeWorker.js        # SQS writing worker (drafts & revisions)
  editWorker.js         # SQS editing worker (copy editing & polishing)
  seoWorker.js          # SQS SEO worker (metadata optimization)
  lib/
    shared-utils.js     # Shared AWS utilities (clients, helpers, SQS send)
tests/
  hello.test.js         # Tests for health check
  research.test.js      # Tests for accept handler
  researchWorker.test.js # Tests for research worker
  writeWorker.test.js   # Tests for write worker
  editWorker.test.js    # Tests for edit worker
  seoWorker.test.js     # Tests for SEO worker
  test-helpers/
    mock-aws.js         # AWS SDK mock infrastructure
    worker-test-utils.js # Shared worker test behaviors
scripts/
  cli.js                # Unified CLI (research, draft, read-draft)
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

### Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--topic` | (required for `research`) | Research topic (max 500 characters) |
| `--stage` | `dev` | Target stage (`dev` or `prod`) |
| `--profile` | `AWS_PROFILE` env var | AWS CLI profile for credentials |

### Example Output

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

The pipeline picks up the task from SQS and progresses it through stages. Task status progresses: `pending` → `researching` → `researched` → `writing` → `drafted` → `editing` → `edited` → `optimizing` → `ready` (or `failed` at any step).

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
