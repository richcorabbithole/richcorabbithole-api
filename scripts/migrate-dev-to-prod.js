#!/usr/bin/env node

/**
 * Migrate groomed dev records to prod.
 *
 * Copies DynamoDB task items from richcorabbithole-tasks-{from} to
 * richcorabbithole-tasks-{to}, then copies any affiliated S3 objects
 * from richcorabbithole-research-{from} to richcorabbithole-research-{to}.
 *
 * Skips config:* items (those are seeded separately via seed-categories.js).
 * Idempotent — PutItem overwrites existing records, S3 copy overwrites existing objects.
 *
 * Usage (dry-run by default):
 *   node scripts/migrate-dev-to-prod.js --profile richcorabbithole
 *
 * Actually write:
 *   node scripts/migrate-dev-to-prod.js --profile richcorabbithole --write
 *
 * Filter by status:
 *   node scripts/migrate-dev-to-prod.js --profile richcorabbithole --status published --write
 *
 * Options:
 *   --from <stage>       Source stage. Default: dev
 *   --to <stage>         Destination stage. Default: prod
 *   --profile <profile>  AWS profile to use
 *   --status <status>    Only migrate tasks with this status value (optional)
 *   --write              Execute the migration (default is dry-run)
 */

const { DynamoDBClient, ScanCommand, PutItemCommand } = require("@aws-sdk/client-dynamodb");
const { marshall, unmarshall } = require("@aws-sdk/util-dynamodb");
const { S3Client, HeadObjectCommand, CopyObjectCommand } = require("@aws-sdk/client-s3");

const S3_PREFIXES = ["research/", "drafts/", "edited/", "final/"];

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { from: "dev", to: "prod", profile: null, status: null, write: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--from" && args[i + 1]) opts.from = args[++i];
    else if (args[i] === "--to" && args[i + 1]) opts.to = args[++i];
    else if (args[i] === "--profile" && args[i + 1]) opts.profile = args[++i];
    else if (args[i] === "--status" && args[i + 1]) opts.status = args[++i];
    else if (args[i] === "--write") opts.write = true;
  }
  return opts;
}

async function scanAllItems(dynamo, tableName) {
  const items = [];
  let lastKey;
  do {
    const resp = await dynamo.send(new ScanCommand({
      TableName: tableName,
      ...(lastKey ? { ExclusiveStartKey: lastKey } : {})
    }));
    items.push(...(resp.Items || []));
    lastKey = resp.LastEvaluatedKey;
  } while (lastKey);
  return items;
}

async function s3ObjectExists(s3, bucket, key) {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (err) {
    if (err.name === "NotFound" || err.$metadata?.httpStatusCode === 404) return false;
    throw err;
  }
}

async function main() {
  const { from, to, profile, status: filterStatus, write } = parseArgs();

  if (profile) process.env.AWS_PROFILE = profile;

  const srcTable = `richcorabbithole-tasks-${from}`;
  const dstTable = `richcorabbithole-tasks-${to}`;
  const srcBucket = `richcorabbithole-research-${from}`;
  const dstBucket = `richcorabbithole-research-${to}`;

  console.log(`\nMigration: ${from} → ${to}`);
  console.log(`  DynamoDB: ${srcTable} → ${dstTable}`);
  console.log(`  S3:       ${srcBucket} → ${dstBucket}`);
  if (filterStatus) console.log(`  Filter:   status = "${filterStatus}"`);
  console.log(`  Mode:     ${write ? "WRITE (live)" : "dry-run (pass --write to execute)"}\n`);

  const dynamo = new DynamoDBClient({});
  const s3 = new S3Client({});

  // --- Scan source table ---
  console.log(`Scanning ${srcTable}...`);
  const allItems = await scanAllItems(dynamo, srcTable);
  console.log(`  Found ${allItems.length} total items`);

  // Filter out config:* items and apply optional status filter
  const taskItems = allItems.filter(raw => {
    const item = unmarshall(raw);
    if (item.taskId.startsWith("config:")) return false;
    if (filterStatus && item.status !== filterStatus) return false;
    return true;
  });

  console.log(`  ${taskItems.length} task items to migrate (after filters)\n`);

  if (taskItems.length === 0) {
    console.log("Nothing to migrate.");
    return;
  }

  // --- Migrate ---
  let dynamoWritten = 0;
  let s3Copied = 0;
  let s3Missing = 0;

  for (const raw of taskItems) {
    const item = unmarshall(raw);
    const { taskId, status, topic } = item;
    const label = topic ? `"${topic}"` : taskId;

    // DynamoDB
    if (write) {
      await dynamo.send(new PutItemCommand({ TableName: dstTable, Item: raw }));
      dynamoWritten++;
    } else {
      console.log(`  [dynamo] would write ${taskId} (${status}) — ${label}`);
      dynamoWritten++;
    }

    // S3 — check each prefix
    for (const prefix of S3_PREFIXES) {
      const key = `${prefix}${taskId}.md`;
      const exists = await s3ObjectExists(s3, srcBucket, key);
      if (!exists) {
        s3Missing++;
        continue;
      }

      if (write) {
        await s3.send(new CopyObjectCommand({
          CopySource: `${srcBucket}/${key}`,
          Bucket: dstBucket,
          Key: key,
          ServerSideEncryption: "AES256"
        }));
        console.log(`  [s3] copied ${key}`);
        s3Copied++;
      } else {
        console.log(`  [s3]   would copy ${srcBucket}/${key} → ${dstBucket}/${key}`);
        s3Copied++;
      }
    }
  }

  // --- Summary ---
  console.log("\n--- Summary ---");
  console.log(`  DynamoDB items ${write ? "written" : "to write"}: ${dynamoWritten}`);
  console.log(`  S3 objects ${write ? "copied" : "to copy"}:     ${s3Copied}`);
  console.log(`  S3 misses (expected): ${s3Missing}`);
  if (!write) {
    console.log("\nDry-run complete. Re-run with --write to execute.");
  } else {
    console.log("\nMigration complete.");
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
