// test/maatregelkeuze.test.js
//
// De vraag naar een specifieke maatregel (WoonWijzerWinkel, 22 november 2026).
// Gedeeld bij de runtime, net als energierekening.js. Aan per tenant met
// report.maatregelKeuze; de rekenregel zit in de report-api
// (lib/voorkeursmaatregel.js).

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { createTenantApp } from "../index.js";

const WORTEL = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const BRON = fs.readFileSync(path.join(WORTEL, "assets", "maatregelkeuze.js"), "utf-8");

function laad() {
  const ctx = { window: {} };
  vm.createContext(ctx);
  vm.runInContext(BRON, ctx);
  return ctx.window.OVMaatregelkeuze;
}

// De keuzes van VOORKEURSMAATREGELEN in de report-api. Deze lijst is de
// afspraak: een waarde die de report-api niet kent valt daar stil weg.
const KEUZES = ["warmtepomp", "zonnepanelen", "dakisolatie", "gevelisolatie", "vloerisolatie", "hr_glas"];

test("de keuzes zijn die van de report-api, in de volgorde van het formulier", () => {
  assert.deepEqual(Array.from(laad().KEUZES, (k) => k.waarde), KEUZES);
  assert.deepEqual(Array.from(laad().VELDEN), ["maatregel_behoefte", "voorkeursmaatregel"]);
});

test("eerst ja/nee; de maatregelen staan pas in beeld na ja", () => {
  const html = laad().blokHtml({ waarden: {} });
  assert.match(html, /Hebt u behoefte aan een specifieke maatregel\?/);
  assert.match(html, /data-field="maatregel_behoefte" value="ja"/);
  assert.match(html, /data-field="maatregel_behoefte" value="nee"/);
  assert.match(html, /data-maatregelkeuze-opties style="margin-top:8px;display:none"/);
  for (const k of KEUZES) assert.match(html, new RegExp(`data-field="voorkeursmaatregel" value="${k}"`));
});

test("precies een keuze: alle maatregelen zijn radio's in dezelfde groep", () => {
  const html = laad().blokHtml({ waarden: {} });
  const radios = html.match(/<input type="radio" name="voorkeursmaatregel"/g) || [];
  // De zes keuzes plus de onzichtbare terugval "geen".
  assert.equal(radios.length, KEUZES.length + 1);
  assert.doesNotMatch(html, /type="checkbox"/);
});

test("een gekozen maatregel komt terug, met ja aangevinkt en de opties open", () => {
  const html = laad().blokHtml({ waarden: { voorkeursmaatregel: "warmtepomp" } });
  assert.match(html, /value="ja" checked/);
  assert.match(html, /value="warmtepomp" checked/);
  assert.match(html, /data-maatregelkeuze-opties style="margin-top:8px"/);
});

test("nee komt terug als nee, met de opties dicht", () => {
  const html = laad().blokHtml({ waarden: { maatregel_behoefte: "nee", voorkeursmaatregel: "geen" } });
  assert.match(html, /value="nee" checked/);
  assert.match(html, /display:none/);
});

test("zonder argumenten valt het blok niet om", () => {
  assert.ok(laad().blokHtml().includes("data-maatregelkeuze"));
});

async function tenant(t, report = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tenant-maatregelkeuze-"));
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
  const server = http.createServer(createTenantApp({ id: "testtenant", brand: { name: "Test" }, publicDir: dir, report }));
  server.keepAliveTimeout = 1;
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test("de runtime serveert het blok", async (t) => {
  const basis = await tenant(t);
  const res = await fetch(`${basis}/assets/maatregelkeuze.js`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /OVMaatregelkeuze/);
});

test("/api/tenant zegt of de vraag aan staat", async (t) => {
  const uit = await (await fetch(`${await tenant(t)}/api/tenant`)).json();
  assert.equal(uit.maatregelKeuze, false);
  const aan = await (await fetch(`${await tenant(t, { maatregelKeuze: true })}/api/tenant`)).json();
  assert.equal(aan.maatregelKeuze, true);
});
