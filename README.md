# richcorabbithole-api

Serverless agent pipeline for the richcorabbithole blog. Built on AWS Lambda, S3, and DynamoDB.

## Architecture

- **Lambda** - Serverless functions (Node.js 20)
- **S3** - Research content storage (`richcorabbithole-research-{stage}`)
- **DynamoDB** - Task tracking (`richcorabbithole-tasks-{stage}`)

## Project Structure

```
src/        # Lambda function handlers
scripts/    # Utility and deployment scripts
docs/       # Project documentation
```

## Setup

```bash
npm install
```

## Deploy

```bash
# Deploy to dev
npm run deploy:dev

# Or directly
serverless deploy --stage dev --aws-profile richcorabbithole
```

## Stages

- `dev` - Development
- `prod` - Production
