/**
 * Research Accept Handler
 *
 * Thin entry point for the research pipeline. Validates the request,
 * creates a task record in DynamoDB, and queues the work for the
 * researchWorker Lambda via SQS. Returns immediately with a taskId
 * that the client can use to poll for status.
 *
 * Flow: Client → API Gateway → this function → SQS → researchWorker
 */

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, PutCommand } = require("@aws-sdk/lib-dynamodb");
const { SQSClient, SendMessageCommand } = require("@aws-sdk/client-sqs");
const { randomUUID } = require("crypto");

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const sqsClient = new SQSClient({});

module.exports.handler = async (event) => {
  try {
    // Expects a topic key which contains a string
    const body = JSON.parse(event.body || "{}");
    const { topic } = body;

    if (!topic) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Missing required field: topic" })
      };
    }

    const taskId = randomUUID();
    const now = new Date().toISOString();

    // Place Dynamo Record with a pending status for tracking through pipeline


    try {
      await docClient.send(
        new PutCommand({
          TableName: process.env.TABLE_NAME,
          Item: {
            taskId,
            status: "pending",
            topic,
            createdAt: now,
            updatedAt: now
          }
        })
      );
    } catch (err) {
      const errMsg = 'Failed to create task record';
      console.error(errMsg, err);
      throw new Error(errMsg);
    }

    // Place on queue for Research worker to pick up
    try {
      await sqsClient.send(
        new SendMessageCommand({
          QueueUrl: process.env.RESEARCH_QUEUE_URL,
          MessageBody: JSON.stringify({
            taskId,
            topic
          })
        })
      );
    } catch (err) {
      const errMsg = 'Failed to place message on queue';
      console.error(errMsg, err);

      // Mark the orphaned DynamoDB record as failed so it doesn't appear permanently pending
      try {
        await docClient.send(
          new PutCommand({
            TableName: process.env.TABLE_NAME,
            Item: {
              taskId,
              status: "failed",
              topic,
              createdAt: now,
              updatedAt: new Date().toISOString(),
              error: errMsg
            }
          })
        );
      } catch (updateErr) {
        console.error('Failed to mark task as failed', updateErr);
      }

      throw new Error(errMsg);
    }
    
    return {
      statusCode: 202,
      body: JSON.stringify({
        taskId,
        status: "pending",
        message: "Research task queued for processing"
      })
    };
  } catch (error) {

    console.error("Failed to accept research request:", error);

    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message || error })
    };
  }
};
