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
// Sinds 10 november 2026 staat de KEUZE vooraan: een schatting of het eigen
// verbruik. Hij hoort in deze lijst omdat hij langs dezelfde witte lijsten
// loopt als de andere vier -- confirmed_data, de report-api, de ladder.
const VERWACHTE_VELDEN = ["verbruik_bron", "aantal_bewoners", "eigen_gas_m3", "eigen_stroom_kwh", "eigen_teruglevering_kwh"];
// De vier getalvelden; `verbruik_bron` is een radiogroep en telt apart.
const GETALVELDEN = ["aantal_bewoners", "eigen_gas_m3", "eigen_stroom_kwh", "eigen_teruglevering_kwh"];

test("het bestand draait en levert de veldnamen die de report-api kent", () => {
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
  // Nummervelden, want het zijn getallen; de keuze is een radiogroep.
  assert.equal((html.match(/type="number"/g) || []).length, GETALVELDEN.length);
  assert.equal((html.match(/type="radio"/g) || []).length, 2, 'een schatting of het eigen verbruik');
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
  // Vier getalvelden plus de twee radioknoppen van de keuze.
  assert.equal((html.match(/ disabled/g) || []).length, GETALVELDEN.length + 2);
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

// --- De keuze: een schatting of het eigen verbruik (10 november 2026) -------

test("de keuze staat vooraan, met de koopwoning-waarschuwing erbij", () => {
  const html = laad().blokHtml({ waarden: {} });
  assert.match(html, /data-verbruik-keuze/);
  assert.ok(
    html.indexOf("data-verbruik-keuze") < html.indexOf('data-field="aantal_bewoners"'),
    "de keuze komt voor de velden die eraan hangen",
  );
  // Zonder deze zin vult een koper zijn eigen rekening in en rekent het
  // rapport met de woning waar hij nu woont.
  assert.match(html, /wilt <strong>kopen<\/strong>/);
  assert.match(html, /Kies dan de schatting/);
});

test("zonder keuze staat 'een schatting' aan, en zijn de eigen velden verborgen", () => {
  const html = laad().blokHtml({ waarden: {} });
  assert.match(html, /value="schatting"[^>]* checked/, "schatting is voorgeselecteerd");
  assert.doesNotMatch(html, /value="eigen"[^>]* checked/);
  // De groep met de drie getallen staat er wel in -- omschakelen gebeurt in de
  // browser zonder nieuwe aanroep -- maar verborgen.
  assert.match(html, /data-verbruik-groep="eigen" style="grid-column:1\/-1;display:none"/);
  assert.match(html, /data-verbruik-groep="schatting">/, "het aantal bewoners staat juist wel open");
});

test("met 'eigen' zijn de drie getallen open en staat het aantal bewoners dicht", () => {
  const html = laad().blokHtml({ waarden: { verbruik_bron: "eigen" } });
  assert.match(html, /value="eigen"[^>]* checked/);
  assert.match(html, /data-verbruik-groep="schatting" style="display:none"/);
  assert.doesNotMatch(html, /data-verbruik-groep="eigen"[^>]*display:none/);
});

test("de hulp met de leverancierslinks hangt aan de eigen opgave", () => {
  // Bij een schatting hoeft niemand zijn jaarafrekening op te zoeken, dus die
  // uitleg hoort daar niet te staan.
  const schatting = laad().blokHtml({ waarden: {} });
  const eigen = laad().blokHtml({ waarden: { verbruik_bron: "eigen" } });
  const hulpIn = (html) => html.slice(html.indexOf("energierekeningHulp") - 200, html.indexOf("energierekeningHulp"));
  assert.match(hulpIn(schatting), /display:none/, "verborgen bij een schatting");
  assert.doesNotMatch(hulpIn(eigen), /display:none/);
});

test("de keuze draagt de stijlen die de tenant-CSS overrulen", () => {
  // LIVE GEZIEN BIJ DE WOONWIJZERWINKEL, 10 november 2026. Twee regels van de
  // tenant braken dit blok, en geen van beide is in een DOM-shim te zien:
  //
  //   input, select, textarea { width:100%; height:44px; ... }
  //     -> de radioknop werd 811 bij 44 pixels
  //   .wizardField label span { color: var(--brand); font-weight:600 }
  //     -> de hele optietekst werd merkrood en vet
  //
  // Vandaar inline stijlen. Deze test is er zodat ze niet als rommel worden
  // opgeruimd door iemand die de pagina niet in een browser heeft gezien.
  const html = laad().blokHtml({ waarden: {} });
  const radios = html.match(/<input type="radio"[^>]*>/g) || [];
  assert.equal(radios.length, 2);
  for (const r of radios) {
    assert.match(r, /width:16px/, "anders rekt input{width:100%} de radio op");
    assert.match(r, /height:16px/);
    assert.match(r, /flex:none/);
  }
  // Elke span binnen een optielabel moet zijn kleur terugnemen.
  const keuze = html.slice(html.indexOf("data-verbruik-keuze"), html.indexOf("data-verbruik-groep"));
  const spans = keuze.match(/<span[^>]*>/g) || [];
  assert.ok(spans.length >= 4, `verwacht meerdere spans, kreeg ${spans.length}`);
  for (const s of spans) {
    assert.match(s, /color:inherit/, `span zonder eigen kleur: ${s}`);
  }
});
