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
                                        SQS Queue
                                    (VisibilityTimeout: 960s)
                                             │
                                    researchWorker.js
                                    ┌────────────────────┐
                                    │ Idempotency check   │
                                    │ Fetch API key       │
                                    │ Call Claude API      │
                                    │ Save to S3           │
                                    │ Update DynamoDB      │
                                    └────────┬───────────┘
                                             │
                                    On failure (2x) ──> DLQ
```

### Services

- **Lambda** (Node.js 22) - Serverless functions
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
  researchWorker.js     # SQS worker (Claude API, S3, DynamoDB)
scripts/
  call-research-api.js  # CLI tool with SigV4 signing
.github/workflows/
  deploy-dev.yml        # Deploy on merge to development
  deploy-prod.yml       # Deploy on release from main
  codex-review.yml      # Automated code review on PRs
```

## Prerequisites

- Node.js 22+
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

Trigger research tasks from the command line using IAM-signed requests:

```bash
# Basic usage
npm run research -- --topic "serverless architecture" --profile richcorabbithole

# Specify stage
npm run research -- --topic "AWS Lambda cold starts" --stage prod --profile richcorabbithole

# Or run directly
node scripts/call-research-api.js --topic "your topic" --profile richcorabbithole
```

### Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--topic` | (required) | Research topic (max 500 characters) |
| `--stage` | `dev` | Target stage (`dev` or `prod`) |
| `--profile` | `AWS_PROFILE` env var | AWS CLI profile for SigV4 signing |

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

The worker picks up the task from SQS, calls the Claude API, and saves the research markdown to S3. Task status progresses: `pending` -> `researching` -> `researched` (or `failed`).

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
