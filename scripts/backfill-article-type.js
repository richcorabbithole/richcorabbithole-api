#!/usr/bin/env node

/**
 * Backfill articleType on existing task records.
 *
 * Sets articleType: "knowledge" and articleTypeInferred: true on all published
 * task records that are missing the articleType field. Pre-articleType records
 * are all knowledge posts — this is a safe assumption for the initial backfill.
 *
 * Usage (dry-run by default):
 *   node scripts/backfill-article-type.js --stage dev --profile richcorabbithole
 *   node scripts/backfill-article-type.js --stage prod --profile richcorabbithole
 *
 * Actually write:
 *   node scripts/backfill-article-type.js --stage dev --profile richcorabbithole --write
 *
 * Options:
 *   --stage <stage>      Serverless stage name (used to derive table name). Default: dev
 *   --table <name>       Override table name directly
 *   --profile <profile>  AWS profile to use
 *   --write              Execute the backfill (default is dry-run)
 */

const { DynamoDBClient, ScanCommand, UpdateItemCommand } = require("@aws-sdk/client-dynamodb");
const { unmarshall } = require("@aws-sdk/util-dynamodb");

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { stage: "dev", table: null, profile: null, write: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--stage" && args[i + 1]) opts.stage = args[++i];
    else if (args[i] === "--table" && args[i + 1]) opts.table = args[++i];
    else if (args[i] === "--profile" && args[i + 1]) opts.profile = args[++i];
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

async function main() {
  const { stage, table, profile, write } = parseArgs();

  if (profile) process.env.AWS_PROFILE = profile;

  const tableName = table || `richcorabbithole-tasks-${stage}`;

  console.log(`\nBackfill articleType → "knowledge"`);
  console.log(`  Table: ${tableName}`);
  console.log(`  Mode:  ${write ? "WRITE (live)" : "dry-run (pass --write to execute)"}\n`);

  const dynamo = new DynamoDBClient({});

  console.log(`Scanning ${tableName}...`);
  const allItems = await scanAllItems(dynamo, tableName);
  console.log(`  Found ${allItems.length} total items`);

  // Target: task records (not config:*) that are missing articleType
  const targets = allItems
    .map(raw => unmarshall(raw))
    .filter(item => !item.taskId.startsWith("config:") && !item.articleType);

  console.log(`  ${targets.length} task records missing articleType\n`);

  if (targets.length === 0) {
    console.log("Nothing to backfill.");
    return;
  }

  let patched = 0;

  for (const item of targets) {
    const { taskId, status, topic } = item;
    const label = topic ? `"${topic}"` : taskId;

    if (write) {
      await dynamo.send(new UpdateItemCommand({
        TableName: tableName,
        Key: { taskId: { S: taskId } },
        UpdateExpression: "SET articleType = :t, articleTypeInferred = :i",
        ExpressionAttributeValues: {
          ":t": { S: "knowledge" },
          ":i": { BOOL: true },
        },
        // Only patch if still missing — safe to re-run
        ConditionExpression: "attribute_not_exists(articleType)",
      }));
      console.log(`  [patched] ${taskId} (${status}) — ${label}`);
    } else {
      console.log(`  [would patch] ${taskId} (${status}) — ${label}`);
    }
    patched++;
  }

  console.log("\n--- Summary ---");
  console.log(`  Records ${write ? "patched" : "to patch"}: ${patched}`);
  if (!write) {
    console.log("\nDry-run complete. Re-run with --write to execute.");
  } else {
    console.log("\nBackfill complete.");
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
