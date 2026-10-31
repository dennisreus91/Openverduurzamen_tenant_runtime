// test/energierekening.test.js
//
// Het blok waarin de bewoner zijn huishouden en zijn eigen jaarverbruik
// invult. Gedeeld bij de runtime, om dezelfde reden als contact_modal.js.
//
// WAAROM DIT GETOETST WORDT
// De vier velden lopen van dit blok naar `confirmed_data`, naar de report-api
// en daar naar de verbruiksladder. Elke schakel is een witte lijst, en een
// lijst die je vergeet laat het antwoord STIL vallen -- geen foutmelding,
// alleen een rapport dat rekent alsof er niets is ingevuld. Daarom staat hier
// de veldnamen-afspraak zelf in een test: wie een naam verandert, verandert
// hem op beide kanten of hij ziet het hier.

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
const BRON = fs.readFileSync(path.join(WORTEL, "assets", "energierekening.js"), "utf-8");

/** Het bestand draaien zoals een browser dat doet, en de api teruggeven. */
function laad() {
  const ctx = { window: {} };
  vm.createContext(ctx);
  vm.runInContext(BRON, ctx);
  return ctx.window.OVEnergierekening;
}

// De namen die de report-api verwacht (lib/confirmed_data.js). Deze lijst is
// de afspraak; hij hoort niet uit het bestand zelf te komen, want dan toetst
// hij zichzelf.
const VERWACHTE_VELDEN = ["aantal_bewoners", "eigen_gas_m3", "eigen_stroom_kwh", "eigen_teruglevering_kwh"];

test("het bestand draait en levert de vier veldnamen die de report-api kent", () => {
  const api = laad();
  assert.ok(api, "window.OVEnergierekening bestaat");
  // Array.from, want het bestand draait in een eigen vm-realm en zijn Array
  // is een ander Array dan die van de test.
  assert.deepEqual(Array.from(api.VELDEN), VERWACHTE_VELDEN);
});

test("elk veld staat als invoerveld in de html, met precies die data-field", () => {
  const html = laad().blokHtml({ waarden: {} });
  for (const veld of VERWACHTE_VELDEN) {
    assert.match(html, new RegExp(`data-field="${veld}"`), `${veld} ontbreekt in het blok`);
  }
  // Nummervelden, want het zijn getallen en geen keuzes.
  assert.equal((html.match(/type="number"/g) || []).length, VERWACHTE_VELDEN.length);
});

test("ingevulde waarden komen terug in het veld, zodat de omweg naar de leverancier te overleven is", () => {
  // De bewoner verlaat het tabblad om zijn jaarafrekening op te zoeken en komt
  // terug. Stond zijn antwoord er dan niet meer, dan is de link een val in
  // plaats van een hulp.
  const html = laad().blokHtml({ waarden: { aantal_bewoners: 3, eigen_gas_m3: 1100, eigen_stroom_kwh: 2900 } });
  assert.match(html, /data-field="aantal_bewoners"[^>]*value="3"/);
  assert.match(html, /data-field="eigen_gas_m3"[^>]*value="1100"/);
  assert.match(html, /data-field="eigen_stroom_kwh"[^>]*value="2900"/);
  assert.match(html, /data-field="eigen_teruglevering_kwh"[^>]*value=""/);
});

test("de html ontsnapt aan wat erin gezet wordt", () => {
  const html = laad().blokHtml({ waarden: { eigen_gas_m3: '"><script>alert(1)</script>' } });
  assert.ok(!html.includes("<script>"), "er staat een scripttag in het blok");
  assert.match(html, /&lt;script&gt;/);
});

test("elke leverancier heeft een link, en die gaat naar een nieuw tabblad met noopener", () => {
  const api = laad();
  assert.ok(api.LEVERANCIERS.length >= 8, `maar ${api.LEVERANCIERS.length} leveranciers`);
  for (const l of api.LEVERANCIERS) {
    assert.ok(l.naam, "een leverancier zonder naam");
    assert.match(l.url, /^https:\/\//, `${l.naam} heeft geen https-link`);
  }
  const html = api.blokHtml({ waarden: {} });
  const links = html.match(/<a href="https:\/\/[^"]+"[^>]*>/g) || [];
  assert.ok(links.length >= api.LEVERANCIERS.length, "niet elke leverancier staat in de html");
  for (const a of links) {
    assert.match(a, /target="_blank"/);
    assert.match(a, /rel="noopener/);
  }
});

test("het blok zegt WAT de bewoner zoekt, want een diepe link landt op het inlogscherm", () => {
  // Zonder die regel is de link een belofte die hij niet nakomt: niet
  // ingelogd kom je op het dashboard uit en niet op de verbruikspagina.
  const html = laad().blokHtml({ waarden: {} });
  assert.match(html, /gas in m³/);
  assert.match(html, /stroom in kWh/);
  assert.match(html, /teruglevering in kWh/);
  assert.match(html, /Waar vind ik dit\?/);
});

test("nergens een inlogveld: de bewoner logt in bij zijn leverancier, niet bij ons", () => {
  const html = laad().blokHtml({ waarden: {} });
  assert.ok(!/type="password"/.test(html));
  assert.ok(!/wachtwoord/i.test(html.replace(/U logt in op de site van uw leverancier[^<]*/g, "")));
  assert.match(html, /U logt in op de site van uw leverancier, nooit bij ons/);
});

test("op een alleen-lezen scherm staan de velden uit", () => {
  const html = laad().blokHtml({ waarden: {}, alleenLezen: true });
  assert.equal((html.match(/ disabled/g) || []).length, VERWACHTE_VELDEN.length);
});

test("zonder argumenten valt het blok niet om", () => {
  const api = laad();
  assert.ok(api.blokHtml().includes("wizardSection"));
  assert.ok(api.blokHtml({}).includes("wizardSection"));
});

// ---------------------------------------------------------------------------
// De runtime serveert het, en de tenant kan het overnemen
// ---------------------------------------------------------------------------

async function tenant(t, { eigenAsset = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tenant-energierekening-"));
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
  if (eigenAsset !== null) {
    fs.writeFileSync(path.join(dir, "assets", "energierekening.js"), eigenAsset, "utf8");
  }
  const server = http.createServer(createTenantApp({ id: "testtenant", brand: { name: "Test" }, publicDir: dir }));
  server.keepAliveTimeout = 1;
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test("zonder eigen kopie komt energierekening.js uit de runtime", async (t) => {
  const basis = await tenant(t);
  const res = await fetch(`${basis}/assets/energierekening.js`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /OVEnergierekening/);
});

test("een eigen kopie van de tenant wint, zodat een overstap een voor een kan", async (t) => {
  const basis = await tenant(t, { eigenAsset: "/* eigen kopie */" });
  const res = await fetch(`${basis}/assets/energierekening.js`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /eigen kopie/);
});
