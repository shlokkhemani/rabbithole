import assert from "node:assert/strict";
import { handleFetchProxyRequest, MAX_RESPONSE_BYTES } from "../../workers/fetch-proxy/index.js";

await rejectsNonGet();
await rejectsUnallowlistedHost();
await stripsCookieAndAuthHeaders();
await enforcesStreamingSizeCap();

console.log("fetch proxy worker verification passed");

async function rejectsNonGet() {
  const res = await handleFetchProxyRequest(new Request("https://proxy.test/?url=https://arxiv.org/abs/1706.03762", {
    method: "POST",
  }));
  assert.equal(res.status, 405);
}

async function rejectsUnallowlistedHost() {
  const res = await handleFetchProxyRequest(new Request("https://proxy.test/?url=https://example.com/"));
  assert.equal(res.status, 400);
  assert.match(await res.text(), /not allowlisted/);
}

async function stripsCookieAndAuthHeaders() {
  let upstreamRequest = null;
  const res = await handleFetchProxyRequest(new Request("https://proxy.test/?url=https://arxiv.org/abs/1706.03762", {
    headers: {
      Origin: "https://app.example",
      Cookie: "session=secret",
      Authorization: "Bearer secret",
    },
  }), {
    upstreamFetch: async (request) => {
      upstreamRequest = request;
      return new Response("<article>ok</article>", {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "set-cookie": "upstream=secret",
          "www-authenticate": "Basic realm=test",
        },
      });
    },
  });

  assert.equal(upstreamRequest.headers.get("cookie"), null);
  assert.equal(upstreamRequest.headers.get("authorization"), null);
  assert.equal(res.headers.get("set-cookie"), null);
  assert.equal(res.headers.get("www-authenticate"), null);
  assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(res.headers.get("access-control-allow-origin"), "https://app.example");
  assert.equal(await res.text(), "<article>ok</article>");
}

async function enforcesStreamingSizeCap() {
  const res = await handleFetchProxyRequest(new Request("https://proxy.test/?url=https://openreview.net/forum?id=test"), {
    upstreamFetch: async () => new Response(oversizeStream(), {
      headers: { "content-type": "application/pdf" },
    }),
  });
  assert.equal(res.status, 200);
  await assert.rejects(() => res.arrayBuffer(), /25 MB proxy limit/);
}

function oversizeStream() {
  let sent = 0;
  return new ReadableStream({
    pull(controller) {
      sent += 1;
      controller.enqueue(new Uint8Array(1024 * 1024));
      if (sent > Math.ceil(MAX_RESPONSE_BYTES / (1024 * 1024)) + 2) controller.close();
    },
  });
}
