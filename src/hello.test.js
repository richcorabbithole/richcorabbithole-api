const { describe, it } = require("node:test");
const assert = require("node:assert");
const { handler } = require("./hello.js");

describe("hello handler", () => {
  it("returns 200 with greeting message", async () => {
    const result = await handler({});

    assert.strictEqual(result.statusCode, 200);

    const body = JSON.parse(result.body);
    assert.strictEqual(body.message, "Hello from richcorabbithole");
  });
});
