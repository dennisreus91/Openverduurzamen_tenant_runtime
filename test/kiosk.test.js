// test/kiosk.test.js
//
// De advies-app op de digitale zuil (WoonWijzerWinkel, 22 november 2026).
// assets/kiosk.js doet alleen iets bij ?kanaal=kiosk; het gedrag in de
// browser (venster, links, stilte) is met Playwright nagelopen, hier de
// kanaalbepaling en het opruimen van de sessie.

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
const BRON = fs.readFileSync(path.join(WORTEL, "assets", "kiosk.js"), "utf-8");

function opslag(begin = {}) {
  const m = new Map(Object.entries(begin));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    clear: () => m.clear(),
    _map: m,
  };
}

// Zonder document: alleen de kanaalbepaling en de sessie, geen listeners.
function laad(search, sessie = opslag()) {
  const window = { location: { search, pathname: "/" }, sessionStorage: sessie };
  window.parent = window;
  const ctx = { window, URLSearchParams, URL };
  vm.createContext(ctx);
  vm.runInContext(BRON, ctx);
  return { kiosk: window.OVKiosk, sessie };
}

test("zonder parameter: website, en niets gewist", () => {
  const { kiosk, sessie } = laad("", opslag({ contact: "x" }));
  assert.equal(kiosk.kanaal(), "website");
  assert.equal(sessie.getItem("contact"), "x");
});

test("?kanaal=kiosk: zuil, en de sessie van de vorige bezoeker is weg", () => {
  const { kiosk, sessie } = laad("?kanaal=kiosk", opslag({ contact: "vorige bezoeker" }));
  assert.equal(kiosk.kanaal(), "kiosk");
  assert.equal(sessie.getItem("contact"), null);
  assert.equal(sessie.getItem("ov_kanaal"), "kiosk");
});

test("een vervolgpagina zonder parameter weet het nog, zonder te wissen", () => {
  const { kiosk, sessie } = laad("", opslag({ ov_kanaal: "kiosk", contact: "deze bezoeker" }));
  assert.equal(kiosk.kanaal(), "kiosk");
  assert.equal(sessie.getItem("contact"), "deze bezoeker");
});

test("expliciet website wint van een oude zuilsessie; onzin is website", () => {
  assert.equal(laad("?kanaal=website", opslag({ ov_kanaal: "kiosk" })).kiosk.kanaal(), "website");
  assert.equal(laad("?kanaal=iets").kiosk.kanaal(), "website");
});

test("zonder sessionStorage (privévenster, geblokkeerd) valt het niet om", () => {
  const kapot = { getItem() { throw new Error("nee"); }, setItem() { throw new Error("nee"); }, clear() { throw new Error("nee"); } };
  assert.equal(laad("?kanaal=kiosk", kapot).kiosk.kanaal(), "kiosk");
  assert.equal(laad("", kapot).kiosk.kanaal(), "website");
});

test("de runtime serveert het script", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tenant-kiosk-"));
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
  const server = http.createServer(createTenantApp({ id: "testtenant", brand: { name: "Test" }, publicDir: dir }));
  server.keepAliveTimeout = 1;
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const res = await fetch(`http://127.0.0.1:${server.address().port}/assets/kiosk.js`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /OVKiosk/);
});

test("een lead van de zuil zegt dat in de leadmail; van de website niet", async () => {
  const { bouwLeadMail } = await import("../lib/mail_client.js");
  const basis = { firstName: "A", lastName: "B", email: "a@b.nl", phone: "0612345678", config: { id: "t", brand: { name: "T" }, contact: { email: "partner@voorbeeld.nl" } }, to: "partner@voorbeeld.nl" };
  assert.match(bouwLeadMail({ ...basis, kanaal: "kiosk" }).html, /Zuil in de winkel/);
  assert.doesNotMatch(bouwLeadMail({ ...basis, kanaal: "website" }).html, /Zuil in de winkel/);
  assert.doesNotMatch(bouwLeadMail(basis).html, /Kanaal/);
});

test("op de zuil geen label-upload (DigiD): alleen het adres", () => {
  // Het gedrag zelf is met Playwright op de WWW-startpagina nagelopen; hier
  // dat de regels erin staan en alleen onder html.ov-kiosk gelden.
  assert.match(BRON, /html\.ov-kiosk \[data-pdf-upload\]/);
  assert.match(BRON, /html\.ov-kiosk \.intakeOfScheiding/);
  assert.match(BRON, /of upload het energielabel/);
  assert.doesNotMatch(BRON, /[^-]\[data-pdf-upload\]\{display:none/);
});
