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

const { PutCommand } = require("@aws-sdk/lib-dynamodb");
const { randomUUID } = require("crypto");
const { getDocClient, updateTaskStatus, sendSqsMessage } = require("./lib/shared-utils");

/**
 * Lambda handler for the research entry point (POST /research).
 *
 * Validates the request body, creates a pending task record in DynamoDB,
 * and enqueues the task for the researchWorker via SQS. Returns 202 with
 * the new taskId, or 4xx/5xx on validation or infrastructure errors.
 *
 * @param {object} event - API Gateway proxy event with a JSON-encoded body.
 * @returns {Promise<{statusCode: number, body: string}>} API Gateway proxy response.
 */
module.exports.handler = async (event) => {
  try {
    // Expects a topic key which contains a string
    let body;
    try {
      body = JSON.parse(event.body || "{}");
    } catch (parseErr) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Invalid JSON in request body" })
      };
    }

    const { topic, category } = body;

    if (!topic || typeof topic !== "string") {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Missing required field: topic (must be a string)" })
      };
    }

    if (topic.length > 500) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "topic must be 500 characters or fewer" })
      };
    }

    // Categories are open-ended — the pipeline can invent new ones.
    // Validate that the value is a well-formed lowercase slug and within the same
    // 32-char length cap enforced on model output in researchWorker.
    if (category !== undefined) {
      if (!/^[a-z][a-z0-9-]*$/.test(category)) {
        return {
          statusCode: 400,
          body: JSON.stringify({ error: "Invalid category. Must be a lowercase word or hyphenated slug (e.g. 'tech', 'true-crime')." })
        };
      }
      if (category.length > 32) {
        return {
          statusCode: 400,
          body: JSON.stringify({ error: "category must be 32 characters or fewer." })
        };
      }
    }

    const taskId = randomUUID();
    const now = new Date().toISOString();

    // Place Dynamo Record with a pending status for tracking through pipeline
    const item = {
      taskId,
      status: "pending",
      topic,
      createdAt: now,
      updatedAt: now
    };
    if (category) item.category = category;

    try {
      await getDocClient().send(
        new PutCommand({
          TableName: process.env.TABLE_NAME,
          Item: item
        })
      );
    } catch (err) {
      const errMsg = 'Failed to create task record';
      console.error(errMsg, err);
      throw new Error(errMsg);
    }

    // Place on queue for Research worker to pick up
    try {
      await sendSqsMessage(process.env.RESEARCH_QUEUE_URL, { taskId, topic, category });
    } catch (err) {
      const errMsg = 'Failed to place message on queue';
      console.error(errMsg, err);

      // Mark the orphaned DynamoDB record as failed so it doesn't appear permanently pending
      try {
        await updateTaskStatus(taskId, "failed", { error: errMsg });
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
