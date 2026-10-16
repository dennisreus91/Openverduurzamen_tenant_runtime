// test/order_invoersoort.test.js
//
// Wat er van de invoer op de BESTELLING terechtkomt.
//
// WAAROM DEZE TEST BESTAAT
// Een bestelling kan sinds oktober 2026 uit drie bronnen komen: een adres, een
// geupload energielabelrapport en een .epa-opname. Aan de bestelling zelf was
// dat niet te zien, terwijl het juist het eerste is wat je wilt weten als een
// rapport er vreemd uitziet -- de drie routes voeden de rekenkern anders.
//
// En belangrijker: de opname zelf moet op de bestelling staan, want
// fetchFullReportHtml() leest hem daar vandaan. Staat hij er niet, dan rekent
// het volledige rapport alsnog met schattingen uit openbare bronnen. Dat
// gebeurt zonder foutmelding; het rapport komt gewoon, maar met andere
// getallen dan het snelle rapport dat de klant al gezien heeft.
//
// Deze test schrijft naar een eigen tijdelijke map en raakt geen netwerk: er
// is geen render-URL, geen Mollie-sleutel en geen mailsleutel, dus de
// verwerking die daarna op de achtergrond start valt meteen stil.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// VOOR de import van index.js: lib/orders_store.js leest ORDERS_DATA_DIR bij
// het laden van de module, niet bij elke schrijfactie. Daarom een dynamische
// import hieronder in plaats van bovenaan.
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tenant-orders-"));
process.env.ORDERS_DATA_DIR = DATA_DIR;

const INLOG = {
  WWW_INTERNAL_EMAIL: "adviseur@example.nl",
  WWW_INTERNAL_PASSWORD: "een-wachtwoord-voor-de-test",
  WWW_INTERNAL_SESSION_SECRET: "s".repeat(48),
};

const OPNAME = {
  source: "epa",
  address: { postalcode: "5654PM", housenumber: "373", houseaddition: "" },
  building: { build_year: 1969, ag_m2: 135 },
  official: { label: "C", beng2_primary_fossil_kwh_m2: 228.56 },
  schil: { roof: { area_m2: 63.9, rc: 0.35 }, facade: { area_m2: 53.5, rc: 1.47 } },
  installations: { heating_is_gas: true },
};

const bestellingen = () => {
  const f = path.join(DATA_DIR, "full_orders.json");
  if (!fs.existsSync(f)) return [];
  const ruw = JSON.parse(fs.readFileSync(f, "utf8"));
  return Array.isArray(ruw) ? ruw : Object.values(ruw?.orders || ruw || {});
};

async function tenant(t) {
  Object.assign(process.env, INLOG);
  const { createTenantApp } = await import("../index.js");
  const server = http.createServer(createTenantApp({ id: "testtenant", brand: { name: "Test" } }));
  server.keepAliveTimeout = 1;
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  });

  const basis = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${basis}/api/internal/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: INLOG.WWW_INTERNAL_EMAIL, password: INLOG.WWW_INTERNAL_PASSWORD }),
  });
  assert.equal(login.status, 200);
  const cookie = (login.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]).join("; ");

  return (body) =>
    fetch(`${basis}/api/internal/full/render`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify(body),
    });
}

test("de opname staat op de bestelling, met de invoersoort erbij", async (t) => {
  const render = await tenant(t);
  const res = await render({ email: "klant@example.nl", epa_model: OPNAME, source: "epa" });
  const tekst = await res.text();
  assert.equal(res.status, 200, tekst);
  const { order_id } = JSON.parse(tekst);

  const order = bestellingen().find((o) => o.id === order_id);
  assert.ok(order, "de bestelling is aangemaakt");
  assert.deepEqual(order.epa_model, OPNAME, "zonder dit rekent het volledige rapport met schattingen");
  assert.equal(order.source_meta?.invoer, "epa");
  assert.equal(order.address.postalcode, "5654PM", "het adres komt uit de opname");
});

test("een energielabelrapport is als invoer te onderscheiden van een .epa", async (t) => {
  const render = await tenant(t);
  const res = await render({
    email: "klant@example.nl",
    epa_model: { ...OPNAME, source: "label_pdf" },
    source: "label_pdf",
  });
  assert.equal(res.status, 200);
  const { order_id } = await res.json();
  assert.equal(bestellingen().find((o) => o.id === order_id)?.source_meta?.invoer, "label_pdf");
});

test("zonder opname heet de invoer gewoon een adres", async (t) => {
  const render = await tenant(t);
  const res = await render({
    email: "klant@example.nl",
    address: { postalcode: "5654PM", housenumber: "373" },
    confirmed_data: { soort_woning: "tussenwoning", build_year: 1969, floor_area_m2: 135, energy_label: "c" },
  });
  const tekst = await res.text();
  assert.equal(res.status, 200, tekst);
  const { order_id } = JSON.parse(tekst);
  const order = bestellingen().find((o) => o.id === order_id);
  assert.equal(order?.source_meta?.invoer, "adres");
  assert.equal(order?.epa_model, null);
});
