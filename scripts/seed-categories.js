#!/usr/bin/env node

/**
 * Seed (or reseed) the config:categories item in DynamoDB.
 *
 * Wipes the existing item and writes a fresh Map of slug → description
 * using the DEFAULT_CATEGORIES defined in shared-utils.js.
 *
 * Run this after migrating from the old String Set schema (values SS)
 * to the new Map schema (categories M), or any time you want to reset
 * categories to the canonical defaults.
 *
 * Usage:
 *   node scripts/seed-categories.js --stage dev --profile richcorabbithole
 *
 * Options:
 *   --stage <stage>      Serverless stage name (used to derive table name). Default: dev
 *   --table <name>       Override table name directly (skips stage-based derivation)
 *   --profile <profile>  AWS profile to use. Default: default
 *   --dry-run            Print what would be written without touching DynamoDB
 */

const { DynamoDBClient, PutItemCommand } = require("@aws-sdk/client-dynamodb");

// Canonical category definitions — keep in sync with DEFAULT_CATEGORIES in shared-utils.js
const CATEGORIES = [
  { slug: "tech",        description: "computers, software, AI, electronics, and the internet" },
  { slug: "science",     description: "biology, physics, chemistry, astronomy, medicine, and natural phenomena" },
  { slug: "history",     description: "historical events, figures, eras, and cultural history" },
  { slug: "gaming",      description: "video games, tabletop games, game design, and gaming culture" },
  { slug: "maker",       description: "DIY projects, hardware, crafts, woodworking, electronics builds, and hands-on making" },
  { slug: "pop-culture", description: "fictional characters, movies, TV shows, comics, anime, music artists, and media franchises" },
  { slug: "other",       description: "topics that don't fit any other category" },
];

const CATEGORIES_CONFIG_KEY = "config:categories";

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { stage: "dev", table: null, profile: null, dryRun: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--stage" && args[i + 1]) opts.stage = args[++i];
    else if (args[i] === "--table" && args[i + 1]) opts.table = args[++i];
    else if (args[i] === "--profile" && args[i + 1]) opts.profile = args[++i];
    else if (args[i] === "--dry-run") opts.dryRun = true;
  }
  return opts;
}

async function main() {
  const { stage, table, profile, dryRun } = parseArgs();

  if (profile) process.env.AWS_PROFILE = profile;

  const tableName = table || `richcorabbithole-${stage}`;

  console.log(`Table: ${tableName}`);
  console.log(`Dry run: ${dryRun}`);
  console.log("\nCategories to seed:");
  for (const { slug, description } of CATEGORIES) {
    console.log(`  ${slug.padEnd(14)} — ${description}`);
  }

  if (dryRun) {
    console.log("\n[dry-run] No changes written.");
    return;
  }

  // Build the categories Map attribute: { <slug>: { S: <description> }, ... }
  const categoriesMap = {};
  for (const { slug, description } of CATEGORIES) {
    categoriesMap[slug] = { S: description };
  }

  const client = new DynamoDBClient({});

  // PutItem completely replaces the item — this is the "wipe and reseed" semantics.
  await client.send(
    new PutItemCommand({
      TableName: tableName,
      Item: {
        taskId:     { S: CATEGORIES_CONFIG_KEY },
        status:     { S: "config" },
        categories: { M: categoriesMap },
        seededAt:   { S: new Date().toISOString() },
      },
    })
  );

  console.log(`\nSeeded ${CATEGORIES.length} categories into ${tableName}.`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
