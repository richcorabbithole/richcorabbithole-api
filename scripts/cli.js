#!/usr/bin/env node

/**
 * Unified CLI for the richcorabbithole pipeline.
 *
 * Subcommands:
 *   research --topic <topic>  — Trigger a research task via the API (SigV4-signed)
 *   draft <taskId>            — Enqueue a write job for an already-researched task
 *   read-draft <taskId>       — Display the current draft for a task
 *
 * Usage:
 *   node scripts/cli.js research --topic "serverless architecture" --stage dev --profile richcorabbithole
 *   node scripts/cli.js draft <taskId> --stage dev --profile richcorabbithole
 *   node scripts/cli.js read-draft <taskId> --stage dev --profile richcorabbithole
 *
 * Environment Variables:
 *   AWS_PROFILE=richcorabbithole (alternative to --profile flag)
 */

const { SQSClient, SendMessageCommand, GetQueueUrlCommand } = require("@aws-sdk/client-sqs");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, GetCommand } = require("@aws-sdk/lib-dynamodb");
const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const { fromIni } = require("@aws-sdk/credential-provider-ini");

// --- Argument parsing ---

const args = process.argv.slice(2);
const command = args[0];
const positionalArgs = [];
let topic = null;
let stage = "dev";
let profile = null;

for (let i = 1; i < args.length; i++) {
  if (args[i] === "--topic") {
    if (!args[i + 1] || args[i + 1].startsWith("--")) {
      console.error("Error: --topic flag requires a value");
      process.exit(1);
    }
    topic = args[i + 1];
    i++;
  } else if (args[i] === "--stage") {
    if (!args[i + 1] || args[i + 1].startsWith("--")) {
      console.error("Error: --stage flag requires a value");
      process.exit(1);
    }
    stage = args[i + 1];
    i++;
  } else if (args[i] === "--profile") {
    if (!args[i + 1] || args[i + 1].startsWith("--")) {
      console.error("Error: --profile flag requires a value");
      process.exit(1);
    }
    profile = args[i + 1];
    i++;
  } else if (!args[i].startsWith("--")) {
    positionalArgs.push(args[i]);
  }
}

// Set profile from environment if not provided via flag
if (!profile && process.env.AWS_PROFILE) {
  profile = process.env.AWS_PROFILE;
}

// --- Resource naming patterns (from serverless.yml custom section) ---

const TABLE_NAME = `richcorabbithole-tasks-${stage}`;
const BUCKET_NAME = `richcorabbithole-research-${stage}`;
const WRITE_QUEUE_NAME = `richcorabbithole-writer-queue-${stage}`;

// API endpoint configuration
const ENDPOINTS = {
  dev: "dev-api.richcorabbithole.com",
  prod: "api.richcorabbithole.com"
};

// --- Helpers ---

function countWords(text) {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

// --- AWS client factory ---

function makeClientConfig() {
  const config = { region: "us-east-1" };
  if (profile) {
    config.credentials = fromIni({ profile });
  }
  return config;
}

// --- Subcommands ---

/**
 * research --topic <topic> — Call the /research API endpoint with SigV4 auth.
 */
async function researchCommand() {
  if (!topic) {
    console.error("Usage: node scripts/cli.js research --topic \"your topic\" [--stage dev] [--profile name]");
    process.exit(1);
  }

  if (topic.startsWith("--")) {
    console.error("Error: Invalid topic. Topic cannot start with \"--\"");
    console.error("Did you forget to provide a value for a flag?");
    process.exit(1);
  }

  const hostname = ENDPOINTS[stage];
  if (!hostname) {
    console.error(`Unknown stage: ${stage}. Use 'dev' or 'prod'`);
    process.exit(1);
  }

  // Lazy-load SigV4 dependencies (only needed for this subcommand)
  const { SignatureV4 } = require("@smithy/signature-v4");
  const { HttpRequest } = require("@smithy/protocol-http");
  const { defaultProvider } = require("@aws-sdk/credential-provider-node");
  const { Hash } = require("@smithy/hash-node");
  const https = require("https");

  console.log(`📡 Calling research API (${stage})...`);
  console.log(`🔍 Topic: ${topic}\n`);

  // Prepare request body
  const body = JSON.stringify({ topic });

  // Create HTTP request
  const request = new HttpRequest({
    method: "POST",
    protocol: "https:",
    hostname: hostname,
    path: "/research",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(body)),
      "Host": hostname
    },
    body: body
  });

  // Sign request with AWS Signature V4
  const signer = new SignatureV4({
    credentials: profile ? fromIni({ profile }) : defaultProvider(),
    region: "us-east-1",
    service: "execute-api",
    sha256: Hash.bind(null, "sha256")
  });

  const signedRequest = await signer.sign(request);

  // Make HTTPS request
  const response = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: signedRequest.hostname,
      path: signedRequest.path,
      method: signedRequest.method,
      headers: signedRequest.headers
    }, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: data
        });
      });
    });

    req.on("error", reject);
    req.write(body);
    req.end();
  });

  // Parse and display response
  const isSuccess = response.statusCode >= 200 && response.statusCode < 300;
  const statusSymbol = isSuccess ? "✅" : "❌";
  console.log(`${statusSymbol} Status: ${response.statusCode}\n`);

  try {
    const result = JSON.parse(response.body);
    console.log("📄 Response:");
    console.log(JSON.stringify(result, null, 2));

    if (result.taskId) {
      console.log(`\n💡 Track your task: GET /research/${result.taskId}`);
    }
  } catch (e) {
    console.log("📄 Response:");
    console.log(response.body);
  }

  // Exit with error code for non-2xx responses
  if (response.statusCode >= 400) {
    process.exit(1);
  }
}

/**
 * draft <taskId> — Enqueue a write job on the WriteQueue.
 */
async function draftCommand(taskId) {
  if (!taskId) {
    console.error("Usage: node scripts/cli.js draft <taskId> [--stage dev] [--profile name]");
    process.exit(1);
  }

  console.log(`📝 Enqueuing write job (${stage})...`);
  console.log(`🔑 Task: ${taskId}\n`);

  const sqsClient = new SQSClient(makeClientConfig());

  // Resolve the queue URL from the known queue name
  let queueUrl;
  try {
    const resp = await sqsClient.send(
      new GetQueueUrlCommand({ QueueName: WRITE_QUEUE_NAME })
    );
    queueUrl = resp.QueueUrl;
  } catch (err) {
    if (err.name === "QueueDoesNotExist" || err.name === "AWS.SimpleQueueService.NonExistentQueue") {
      console.error(`❌ Queue not found: ${WRITE_QUEUE_NAME}`);
      console.error(`\n💡 Tip: Make sure the API is deployed to the ${stage} stage`);
      process.exit(1);
    }
    throw err;
  }

  await sqsClient.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify({ taskId })
    })
  );

  console.log(`✅ Write job enqueued for task ${taskId}`);
  console.log(`📬 Queue: ${WRITE_QUEUE_NAME}`);
}

/**
 * read-draft <taskId> — Fetch and display the current draft.
 */
async function readDraftCommand(taskId) {
  if (!taskId) {
    console.error("Usage: node scripts/cli.js read-draft <taskId> [--stage dev] [--profile name]");
    process.exit(1);
  }

  console.log(`📖 Reading draft (${stage})...`);
  console.log(`🔑 Task: ${taskId}\n`);

  const clientConfig = makeClientConfig();

  // Fetch task record from DynamoDB
  const dynamoClient = new DynamoDBClient(clientConfig);
  const docClient = DynamoDBDocumentClient.from(dynamoClient);

  const taskResult = await docClient.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { taskId }
    })
  );

  if (!taskResult.Item) {
    console.error(`❌ Task not found: ${taskId}`);
    console.error(`\n💡 Tip: Check the task ID and make sure you're using the correct --stage`);
    process.exit(1);
  }

  const task = taskResult.Item;
  console.log(`📋 Status: ${task.status}`);

  if (!task.draftS3Key) {
    console.log(`\n⏳ No draft available yet.`);
    if (task.s3Key) {
      console.log(`   Research is saved at: ${task.s3Key}`);
    }
    console.log(`   Current status: ${task.status}`);
    return;
  }

  if (task.revisionCount !== undefined) {
    console.log(`🔄 Revision: ${task.revisionCount}`);
  }

  // Fetch draft from S3
  const s3Client = new S3Client(clientConfig);
  const s3Result = await s3Client.send(
    new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: task.draftS3Key
    })
  );

  const draftContent = await s3Result.Body.transformToString();

  // Parse frontmatter (split on --- fences)
  const fmMatch = draftContent.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);

  if (fmMatch) {
    const frontmatter = fmMatch[1];
    const body = fmMatch[2];

    // Extract title from frontmatter
    const titleMatch = frontmatter.match(/^title:\s*["']?(.+?)["']?\s*$/m);
    if (titleMatch) {
      console.log(`📰 Title: ${titleMatch[1]}`);
    }

    // Word count
    const wordCount = countWords(body);
    console.log(`📊 Word count: ${wordCount}`);

    console.log(`\n--- Frontmatter ---\n${frontmatter}\n---`);

    // Preview: first ~20 lines of body
    const bodyLines = body.trim().split("\n");
    const previewLines = bodyLines.slice(0, 20);
    console.log(`\n--- Body preview (first ${Math.min(20, bodyLines.length)} of ${bodyLines.length} lines) ---\n`);
    console.log(previewLines.join("\n"));

    if (bodyLines.length > 20) {
      console.log(`\n... (${bodyLines.length - 20} more lines)`);
    }
  } else {
    // No frontmatter detected — just print the raw content
    console.log(`\n--- Draft content ---\n`);
    const lines = draftContent.trim().split("\n");
    const wordCount = countWords(draftContent);
    console.log(`📊 Word count: ${wordCount}`);
    console.log(lines.slice(0, 30).join("\n"));
    if (lines.length > 30) {
      console.log(`\n... (${lines.length - 30} more lines)`);
    }
  }
}

// --- Main ---

async function main() {
  if (!command) {
    console.error("Usage: node scripts/cli.js <command> [options]");
    console.error("\nCommands:");
    console.error("  research --topic <topic>  Trigger a research task via the API");
    console.error("  draft <taskId>            Enqueue a write job for an already-researched task");
    console.error("  read-draft <taskId>       Display the current draft for a task");
    console.error("\nFlags:");
    console.error("  --stage <stage>     Target stage: dev or prod (default: dev)");
    console.error("  --profile <name>    AWS CLI profile for credentials");
    process.exit(1);
  }

  try {
    switch (command) {
      case "research":
        await researchCommand();
        break;
      case "draft":
        await draftCommand(positionalArgs[0]);
        break;
      case "read-draft":
        await readDraftCommand(positionalArgs[0]);
        break;
      default:
        console.error(`Unknown command: ${command}`);
        console.error("\nAvailable commands: research, draft, read-draft");
        process.exit(1);
    }
  } catch (error) {
    console.error(`❌ Error: ${error.message}`);
    if (error.code === "ENOTFOUND") {
      console.error(`\n💡 Tip: Make sure the API is deployed to the ${stage} stage`);
    } else if (error.name === "CredentialsProviderError") {
      console.error("\n💡 Tip: Configure AWS credentials with:");
      if (profile) {
        console.error(`   aws configure --profile ${profile}`);
      } else {
        console.error("   aws configure");
        console.error("   or pass --profile <name> flag");
        console.error("   or set AWS_PROFILE environment variable");
      }
    }
    process.exit(1);
  }
}

main();
