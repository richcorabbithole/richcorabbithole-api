#!/usr/bin/env node

/**
 * CLI tool to call the /research endpoint with AWS IAM authorization
 * Uses AWS credentials from your configured profile
 * 
 * Usage:
 *   node scripts/call-research-api.js "your research topic"
 *   node scripts/call-research-api.js --topic "serverless architecture" --stage dev --profile richcorabbithole
 * 
 * Environment Variables:
 *   AWS_PROFILE=richcorabbithole (alternative to --profile flag)
 */

const { SignatureV4 } = require('@smithy/signature-v4');
const { HttpRequest } = require('@smithy/protocol-http');
const { defaultProvider } = require('@aws-sdk/credential-provider-node');
const { fromIni } = require('@aws-sdk/credential-provider-ini');
const { Hash } = require('@smithy/hash-node');
const https = require('https');

// Parse command line arguments
const args = process.argv.slice(2);
let topic = null;
let stage = 'dev';
let profile = null;

// Parse named arguments
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--topic') {
    if (!args[i + 1] || args[i + 1].startsWith('--')) {
      console.error('Error: --topic flag requires a value');
      process.exit(1);
    }
    topic = args[i + 1];
    i++;
  } else if (args[i] === '--stage') {
    if (!args[i + 1] || args[i + 1].startsWith('--')) {
      console.error('Error: --stage flag requires a value');
      process.exit(1);
    }
    stage = args[i + 1];
    i++;
  } else if (args[i] === '--profile') {
    if (!args[i + 1] || args[i + 1].startsWith('--')) {
      console.error('Error: --profile flag requires a value');
      process.exit(1);
    }
    profile = args[i + 1];
    i++;
  } else if (!args[i].startsWith('--') && topic === null) {
    topic = args[i];
  }
}

// Set profile from environment if not provided via flag
if (!profile && process.env.AWS_PROFILE) {
  profile = process.env.AWS_PROFILE;
}

// Validate topic
if (!topic) {
  console.error('Usage: node scripts/call-research-api.js "your research topic"');
  console.error('   or: node scripts/call-research-api.js --topic "topic" --stage dev --profile richcorabbithole');
  process.exit(1);
}

if (topic.startsWith('--')) {
  console.error('Error: Invalid topic. Topic cannot start with "--"');
  console.error('Did you forget to provide a value for a flag?');
  process.exit(1);
}

// API endpoint configuration
const ENDPOINTS = {
  dev: 'dev-api.richcorabbithole.com',
  prod: 'api.richcorabbithole.com'
};

const hostname = ENDPOINTS[stage];
if (!hostname) {
  console.error(`Unknown stage: ${stage}. Use 'dev' or 'prod'`);
  process.exit(1);
}

async function callResearchAPI() {
  try {
    console.log(`📡 Calling research API (${stage})...`);
    console.log(`🔍 Topic: ${topic}\n`);

    // Prepare request body
    const body = JSON.stringify({ topic });

    // Create HTTP request
    const request = new HttpRequest({
      method: 'POST',
      protocol: 'https:',
      hostname: hostname,
      path: '/research',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(body)),
        'Host': hostname
      },
      body: body
    });

    // Sign request with AWS Signature V4
    const signer = new SignatureV4({
      credentials: profile ? fromIni({ profile }) : defaultProvider(),
      region: 'us-east-1',
      service: 'execute-api',
      sha256: Hash.bind(null, 'sha256')
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
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: data
          });
        });
      });

      req.on('error', reject);
      req.write(body);
      req.end();
    });

    // Parse and display response
    const isSuccess = response.statusCode >= 200 && response.statusCode < 300;
    const statusSymbol = isSuccess ? '✅' : '❌';
    console.log(`${statusSymbol} Status: ${response.statusCode}\n`);
    
    try {
      const result = JSON.parse(response.body);
      console.log('📄 Response:');
      console.log(JSON.stringify(result, null, 2));
      
      if (result.taskId) {
        console.log(`\n💡 Track your task: GET /research/${result.taskId}`);
      }
    } catch (e) {
      console.log('📄 Response:');
      console.log(response.body);
    }

    // Exit with error code for non-2xx responses
    if (response.statusCode >= 400) {
      process.exit(1);
    }

  } catch (error) {
    console.error('❌ Error:', error.message);
    if (error.code === 'ENOTFOUND') {
      console.error(`\n💡 Tip: Make sure the API is deployed to ${stage} stage`);
    } else if (error.name === 'CredentialsProviderError') {
      console.error('\n💡 Tip: Configure AWS credentials with:');
      if (profile) {
        console.error(`   aws configure --profile ${profile}`);
      } else {
        console.error('   aws configure');
        console.error('   or pass --profile <name> flag');
        console.error('   or set AWS_PROFILE environment variable');
      }
    }
    process.exit(1);
  }
}

callResearchAPI();
