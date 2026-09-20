import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";

import { createApp } from "../src/app.js";

test("健康检查连接数据库", async () => {
  const server = createApp(":memory:").listen(0);
  await once(server, "listening");
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/health`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, "ok");
  } finally {
    server.close();
  }
});
