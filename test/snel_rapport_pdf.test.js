// test/snel_rapport_pdf.test.js
//
// De downloadknop onder het snelle rapport levert een pdf, geen printvenster.
//
// WAAROM DEZE ROUTE BESTAAT
// De knop riep `window.print()` aan. Ronald Krijgsman testte de tool op
// 21 oktober 2026 en kreeg de printdialoog met een printer erin; wat eruit
// komt hangt dan af van zijn browser en zijn printerinstellingen in plaats
// van van ons.
//
// WAAROM HIJ DE HTML VAN DE BROWSER AANNEEMT EN NIET OPNIEUW RENDERT
// Het snelle rapport bevat adviestekst van een taalmodel. Serverzijdig
// opnieuw opbouwen zou dus een ander rapport opleveren dan de bezoeker voor
// zich ziet, en er per download opnieuw voor betalen. Keuze Dennis,
// 21 oktober 2026: de download verwerkt uitsluitend wat er al is. Dat is
// dezelfde weg die de leadmail al bewandelt, die het snelle rapport ook als
// pdf-bijlage meestuurt.
//
// WAT DEZE TEST BEWAAKT
//   1. er komt een echte pdf uit, met een bestandsnaam waar het adres in zit;
//   2. de html die naar PDFBolt gaat is de html van de browser, in de
//      liggende wrapper -- dus zonder herberekening;
//   3. een leeg of veel te groot verzoek wordt geweigerd;
//   4. valt PDFBolt om, dan komt er een nette fout in plaats van een half
//      bestand. De knop in de browser valt daarop terug op `window.print()`,
//      precies het gedrag van voorheen.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

// PDFBOLT_URL wordt bij het laden van lib/pdfbolt_client.js uitgelezen, dus
// hij moet staan voordat index.js geimporteerd wordt.
let laatsteAanroep = null;
let pdfboltStatus = 200;

const nepPdfbolt = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    try {
      const json = JSON.parse(body);
      laatsteAanroep = {
        sleutel: req.headers["api-key"] || null,
        html: Buffer.from(json.html, "base64").toString("utf-8"),
        format: json.format,
        preferCssPageSize: json.preferCssPageSize,
      };
    } catch {
      laatsteAanroep = { fout: body.slice(0, 200) };
    }
    if (pdfboltStatus !== 200) {
      res.writeHead(pdfboltStatus, { "content-type": "text/plain" });
      return res.end("pdfbolt is stuk");
    }
    res.writeHead(200, { "content-type": "application/pdf" });
    // Genoeg om een pdf te zijn voor wie naar de eerste bytes kijkt.
    res.end(Buffer.from("%PDF-1.4\n%nep\n", "utf-8"));
  });
});

await new Promise((r) => nepPdfbolt.listen(0, "127.0.0.1", r));
process.env.PDFBOLT_URL = `http://127.0.0.1:${nepPdfbolt.address().port}/v1/direct`;
process.env.PDFBOLT_API_KEY = "test-sleutel";

const { createTenantApp } = await import("../index.js");

async function tenant(t) {
  const server = http.createServer(
    createTenantApp({ id: "testtenant", brand: { name: "De Energie Raadgever" } })
  );
  server.keepAliveTimeout = 1;
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

const post = (basis, body) =>
  fetch(`${basis}/api/mid/pdf`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

test.after(() => {
  nepPdfbolt.closeAllConnections?.();
  nepPdfbolt.close();
});

test("de knop levert een pdf met het adres in de bestandsnaam", async (t) => {
  pdfboltStatus = 200;
  const basis = await tenant(t);

  const res = await post(basis, {
    html: '<div class="mid-report"><div class="mid-grid">drie maatregelen</div></div>',
    address: { postalcode: "2925CT", housenumber: "52" },
  });

  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/pdf");
  assert.match(res.headers.get("content-disposition") || "", /attachment; filename="snel_verduurzamingsinzicht_2925CT_52\.pdf"/);

  const bytes = Buffer.from(await res.arrayBuffer());
  assert.match(bytes.subarray(0, 5).toString("utf-8"), /^%PDF-/);
});

test("wat naar PDFBolt gaat is de html van de browser, liggend ingepakt", async (t) => {
  pdfboltStatus = 200;
  laatsteAanroep = null;
  const basis = await tenant(t);

  await post(basis, {
    html: '<div class="mid-report">ONGEWIJZIGDE RAPPORTTEKST</div>',
    address: { postalcode: "2925CT", housenumber: "52" },
  });

  assert.ok(laatsteAanroep, "PDFBolt is aangeroepen");
  assert.equal(laatsteAanroep.sleutel, "test-sleutel");
  // Geen herberekening: de tekst van het scherm staat er letterlijk in.
  assert.match(laatsteAanroep.html, /ONGEWIJZIGDE RAPPORTTEKST/);
  // En hij staat liggend, anders valt het rapport terug op de telefoonweergave.
  assert.match(laatsteAanroep.html, /@page\{size:A4 landscape/);
  assert.match(laatsteAanroep.html, /#pdfRapport \.mid-report \.mid-grid\{display:grid!important\}/);
  // De tenantnaam en het adres staan in de kop van het bestand.
  assert.match(laatsteAanroep.html, /De Energie Raadgever · 2925CT 52/);
  assert.equal(laatsteAanroep.preferCssPageSize, true);
});

test("zonder html of met te veel html komt er geen pdf", async (t) => {
  pdfboltStatus = 200;
  const basis = await tenant(t);

  const leeg = await post(basis, { html: "   ", address: null });
  assert.equal(leeg.status, 400);
  assert.equal((await leeg.json()).code, "pdf_geen_html");

  const teGroot = await post(basis, { html: "x".repeat(1_500_001), address: null });
  assert.equal(teGroot.status, 413);
  assert.equal((await teGroot.json()).code, "pdf_te_groot");
});

// --- Van buiten af te zien of deze tenant pdf's kan maken ------------------
//
// De sleutel staat in het Render-dashboard en niet in de repo, dus of een
// tenant hem heeft is van hieruit niet te zien. Ontbreekt hij, dan valt de
// downloadknop terug op de printdialoog en krijgt de leadmail html in plaats
// van een pdf -- allebei stil. `/health` zegt het nu hardop, net zoals het al
// doet voor de koppeling met de centrale dienst.

test("health vertelt of de pdf-sleutel er is", async (t) => {
  const basis = await tenant(t);

  const met = await (await fetch(`${basis}/health`)).json();
  assert.equal(met.pdf, true);

  const bewaard = process.env.PDFBOLT_API_KEY;
  delete process.env.PDFBOLT_API_KEY;
  try {
    const zonder = await (await fetch(`${basis}/health`)).json();
    assert.equal(zonder.pdf, false, "zonder sleutel moet health dat melden");
  } finally {
    process.env.PDFBOLT_API_KEY = bewaard;
  }
});

test("valt PDFBolt om, dan komt er een nette fout", async (t) => {
  pdfboltStatus = 500;
  const basis = await tenant(t);

  const res = await post(basis, { html: "<div>x</div>", address: null });
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.code, "pdf_mislukt");
  // Geen PDFBolt-interne tekst naar de browser.
  assert.doesNotMatch(JSON.stringify(body), /pdfbolt is stuk/i);
});
