#!/usr/bin/env node

/**
 * CLI tool to call the /research endpoint with AWS IAM authorization
 * Uses AWS credentials from your configured profile
 * 
 * Usage:
 *   node scripts/call-research-api.js "your research topic"
 *   node scripts/call-research-api.js --topic "serverless architecture" --stage dev
 */

const { SignatureV4 } = require('@smithy/signature-v4');
const { HttpRequest } = require('@smithy/protocol-http');
const { defaultProvider } = require('@aws-sdk/credential-provider-node');
const { Hash } = require('@smithy/hash-node');
const https = require('https');

// Parse command line arguments
const args = process.argv.slice(2);
let topic = args[0];
let stage = 'dev';

// Parse named arguments
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--topic' && args[i + 1]) {
    topic = args[i + 1];
    i++;
  } else if (args[i] === '--stage' && args[i + 1]) {
    stage = args[i + 1];
    i++;
  } else if (!args[i].startsWith('--') && i === 0) {
    topic = args[i];
  }
}

if (!topic) {
  console.error('Usage: node scripts/call-research-api.js "your research topic"');
  console.error('   or: node scripts/call-research-api.js --topic "topic" --stage dev');
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
        'Content-Length': Buffer.byteLength(body),
        'Host': hostname
      },
      body: body
    });

    // Sign request with AWS Signature V4
    const signer = new SignatureV4({
      credentials: defaultProvider(),
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
    console.log(`✅ Status: ${response.statusCode}\n`);
    
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

  } catch (error) {
    console.error('❌ Error:', error.message);
    if (error.code === 'ENOTFOUND') {
      console.error(`\n💡 Tip: Make sure the API is deployed to ${stage} stage`);
    } else if (error.name === 'CredentialsProviderError') {
      console.error('\n💡 Tip: Configure AWS credentials with:');
      console.error('   aws configure --profile richcorabbithole');
    }
    process.exit(1);
  }
}

callResearchAPI();
