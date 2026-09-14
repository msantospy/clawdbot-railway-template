import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import express from "express";
import httpProxy from "http-proxy";

// /hooks/* must reach the gateway with its body intact.
//
// express.json() drains the request stream. A catch-all proxy mounted after it
// forwards Content-Length over a stream that is already empty, so the gateway
// blocks waiting for bytes that never arrive and drops the socket at its 30s
// body-read timeout — surfacing as a 502 with no gateway-side log line.

test("server.js does not apply the JSON parser to machine routes", () => {
  const src = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  assert.doesNotMatch(
    src,
    /app\.use\(express\.json\(/,
    "express.json() must not be mounted unconditionally — it would eat the /hooks and /v1 body",
  );
  assert.match(src, /isMachineRoute\(req\.path\)\s*\?\s*next\(\)/);
  assert.match(src, /startsWith\("\/hooks"\)\s*\|\|\s*p\.startsWith\("\/v1\/"\)/);
});

// /v1/chat/completions is full operator access to the gateway, and this wrapper
// runs on a public domain. It is exempt from dashboard Basic auth so the caller
// can use the Authorization header for the gateway bearer — which means the
// wrapper must not fill that header in for a caller who sent nothing, or the
// endpoint is open to anyone who finds the URL.
test("the gateway token is never injected into /v1 requests", () => {
  const src = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const fn = src.slice(
    src.indexOf("function attachGatewayAuthHeader"),
    src.indexOf("proxy.on(\"proxyReqWs\""),
  );
  assert.match(fn, /startsWith\("\/v1\/"\)\)\s*return;/);
  assert.ok(
    fn.indexOf("/v1/") < fn.indexOf("OPENCLAW_GATEWAY_TOKEN"),
    "the /v1 guard must come before the token is attached",
  );
});

/** Upstream that reports how many body bytes actually arrived. */
function upstreamRecebendoCorpo() {
  return http.createServer((req, res) => {
    let bytes = 0;
    req.on("data", (c) => (bytes += c.length));
    req.on("end", () => res.end(JSON.stringify({ bytes })));
  });
}

function escutar(servidor) {
  return new Promise((r) => servidor.listen(0, "127.0.0.1", () => r(servidor.address().port)));
}

async function postar(porta, corpo) {
  const r = await fetch(`http://127.0.0.1:${porta}/hooks/agent`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: corpo,
    signal: AbortSignal.timeout(2000),
  });
  return r.json();
}

test("the /hooks bypass is what lets the body through", async (t) => {
  const upstream = upstreamRecebendoCorpo();
  const portaUp = await escutar(upstream);
  const proxy = httpProxy.createProxyServer({ target: `http://127.0.0.1:${portaUp}` });

  const parseJson = express.json({ limit: "1mb" });
  const comBypass = express();
  comBypass.use((req, res, next) =>
    req.path.startsWith("/hooks") ? next() : parseJson(req, res, next),
  );
  comBypass.use((req, res) => proxy.web(req, res));

  const semBypass = express();
  semBypass.use(parseJson); // o jeito antigo
  semBypass.use((req, res) => proxy.web(req, res));

  const frenteOk = http.createServer(comBypass);
  const frenteRuim = http.createServer(semBypass);
  const portaOk = await escutar(frenteOk);
  const portaRuim = await escutar(frenteRuim);
  t.after(() => {
    for (const s of [upstream, frenteOk, frenteRuim]) s.closeAllConnections?.(), s.close();
    proxy.close();
  });

  const carga = JSON.stringify({ agentId: "main", text: "oi" });

  assert.deepEqual(
    await postar(portaOk, carga),
    { bytes: Buffer.byteLength(carga) },
    "com o bypass, o corpo chega inteiro ao upstream",
  );

  // Sem o bypass o upstream fica esperando o corpo: aqui isso vira o timeout do
  // cliente; em produção vira o corte de 30s do gateway e o 502 do wrapper.
  await assert.rejects(() => postar(portaRuim, carga));
});
