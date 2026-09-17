import assert from "node:assert/strict";
import { test } from "node:test";
import { gmailSent } from "../src/api/routes/connectors.ts";
import type { ApiCtx } from "../src/api/routes/route.ts";

test("sent mail requires portal identity and ignores a forged principal query", async () => {
  let status = 0;
  let requestedPrincipal = "";
  const ctx = {
    actor: null,
    url: new URL("http://localhost/v1/connectors/gmail/sent?principalId=someone-else"),
    res: {
      setHeader() {},
      writeHead(code: number) {
        status = code;
      },
      end() {},
    },
    deps: {
      connectorTokens: {
        async connectorDerivedAuth(_host: string, principal: string) {
          requestedPrincipal = principal;
          return null;
        },
      },
    },
  } as unknown as ApiCtx;
  await gmailSent(ctx);
  assert.equal(status, 403);
  assert.equal(requestedPrincipal, "");
  ctx.actor = { p: "signed-in-user" } as ApiCtx["actor"];
  await gmailSent(ctx);
  assert.equal(status, 409);
  assert.equal(requestedPrincipal, "signed-in-user");
  requestedPrincipal = "";
  ctx.url.searchParams.set("accountType", "forged");
  await gmailSent(ctx);
  assert.equal(status, 400);
  assert.equal(requestedPrincipal, "");
});
