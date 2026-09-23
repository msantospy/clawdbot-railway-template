import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// CRLF vira LF: o checkout no Windows troca as quebras e o fim de funcao
// ("\n}\n") deixaria de casar, esticando o recorte para o arquivo inteiro.
const src = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");

function corpo(nome, fim) {
  return src.slice(src.indexOf(`function ${nome}`), src.indexOf(fim, src.indexOf(`function ${nome}`)));
}

test("dashboard Basic fica desligado por padrao (service worker nao manda Basic)", () => {
  assert.match(src, /const DASHBOARD_BASIC = process\.env\.WRAPPER_DASHBOARD_BASIC\?\.trim\(\)\.toLowerCase\(\) === "true";/);
  const fn = corpo("requireDashboardAuth", "\n}\n");
  // A primeira linha decide: sem o modo antigo, nada de Basic.
  assert.match(fn, /^function requireDashboardAuth\(req, res, next\) \{\s*if \(!DASHBOARD_BASIC\) return next\(\);/);
});

test("sem o Basic na frente, o token do gateway nunca e injetado", () => {
  const fn = corpo("attachGatewayAuthHeader", "proxy.on(\"proxyReqWs\"");
  const guarda = fn.indexOf("if (!DASHBOARD_BASIC) return;");
  assert.ok(guarda > 0, "falta a guarda do modo antigo");
  assert.ok(
    guarda < fn.indexOf("OPENCLAW_GATEWAY_TOKEN"),
    "a guarda tem de vir antes de o token ser colado no pedido",
  );
});

test("/setup continua exigindo a senha", () => {
  const fn = corpo("requireSetupAuth", "\n}\n");
  assert.doesNotMatch(fn, /DASHBOARD_BASIC/);
  assert.match(fn, /password !== SETUP_PASSWORD/);
});
