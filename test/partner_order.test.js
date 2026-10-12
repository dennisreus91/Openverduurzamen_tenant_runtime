// test/partner_order.test.js
//
// Het volledige rapport zonder betaalstap, aangevraagd door een eigen dienst
// van de tenant (de chatadviseur van WoonWijzerWinkel).
//
// WAAROM DEZE TEST BESTAAT
// Deze route slaat Mollie over. Staat hij per ongeluk open, dan kan iedereen
// gratis volledige rapporten bestellen op kosten van het platform. Dus: zonder
// PARTNER_ORDER_API_KEY is hij dicht, en met een verkeerde sleutel ook. Het
// succespad (render, PDF, mail) is hetzelfde als de interne aanvraag en wordt
// hier niet nog eens doorlopen: dat zou de report-api en Resend aanroepen.

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTenantApp } from "../index.js";

process.env.ORDERS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "partner-order-"));

async function metApp(fn) {
  const app = createTenantApp({ id: "testtenant", publicDir: os.tmpdir(), brand: { name: "Test" } });
  const server = http.createServer(app);
  server.keepAliveTimeout = 1;
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
}

function post(base, body, key) {
  const headers = { "content-type": "application/json" };
  if (key) headers["x-api-key"] = key;
  return fetch(`${base}/api/partner/full/order`, { method: "POST", headers, body: JSON.stringify(body) });
}

const GELDIG = { email: "klant@example.nl", address: { postalcode: "3131KZ", housenumber: "8" } };

test("zonder PARTNER_ORDER_API_KEY staat de route dicht", async () => {
  delete process.env.PARTNER_ORDER_API_KEY;
  await metApp(async (base) => {
    const res = await post(base, GELDIG, "iets");
    assert.equal(res.status, 503);
  });
});

test("een ontbrekende of verkeerde sleutel geeft 401", async () => {
  process.env.PARTNER_ORDER_API_KEY = "geheim";
  await metApp(async (base) => {
    assert.equal((await post(base, GELDIG)).status, 401);
    assert.equal((await post(base, GELDIG, "fout")).status, 401);
  });
});

test("ongeldige invoer geeft 400 met veldfouten, zonder order", async () => {
  process.env.PARTNER_ORDER_API_KEY = "geheim";
  await metApp(async (base) => {
    const res = await post(base, { email: "geen-mail", address: {} }, "geheim");
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.ok(data.field_errors.email);
    assert.ok(data.field_errors.postalcode);
    assert.ok(data.field_errors.housenumber);
  });
  assert.equal(fs.existsSync(path.join(process.env.ORDERS_DATA_DIR, "full_orders.json")), false);
});
