import assert from "node:assert/strict";
import { it } from "node:test";
import { copyInternalRequest } from "../server/app.js";

it("preserves authorization and cookies when adapting an IncomingMessage-like request", () => {
  const request = { method: "POST", url: "/api/explain-image" };
  Object.defineProperty(request, "headers", {
    enumerable: false,
    configurable: true,
    value: {
      authorization: "Bearer presentation-session",
      cookie: "__session=abc",
      host: "localhost:8787",
    },
  });

  const adapted = copyInternalRequest(request, {
    url: "/api/explain",
    body: { problem: "x+1=2" },
  });

  assert.equal(adapted.headers.authorization, "Bearer presentation-session");
  assert.equal(adapted.headers.cookie, "__session=abc");
  assert.equal(adapted.url, "/api/explain");
  assert.deepEqual(adapted.body, { problem: "x+1=2" });
});
