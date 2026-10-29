// test/rapport_partner.test.js
//
// /health zegt onder welke partner de report-api onze sleutel kent.
//
// WAAROM DEZE TEST BESTAAT
// Op 29 oktober 2026 bleek dat op de WoonWijzerWinkel-tenant nog nooit een volledig
// rapport geleverd was. In FULL_APP_RENDER_API_KEY stond de GEDEELDE tenant-sleutel, en
// die draagt geen partnernaam. De runtime stuurt bij elk rapport `bewaar_rapport` mee, en
// bewaren eist juist een naam -- dus elke aanvraag strandde op een 400 van de report-api.
//
// Het snelle rapport bewaart niets en werkte gewoon. De fout trof dus alleen het product
// dat verkocht wordt, en kwam pas aan het licht toen iemand het bestelde: de klant kreeg
// een nette mail dat het niet gelukt was, en de reden stond in een logregel.
//
// Sindsdien vraagt de runtime het antwoord op bij /api/wie-ben-ik en zet het in /health.
// Daarmee is een verkeerd gezette sleutel van buiten af te zien -- dat is wat deze test
// vastlegt, inclusief het geval waarin het antwoord "geen naam" is, want dat is precies
// de stand die stil fout gaat.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createTenantApp } from "../index.js";

/** Een report-api die antwoordt wat de test wil, en bijhoudt wat hij kreeg. */
async function nepReportApi(antwoord) {
  const ontvangen = [];
  const srv = http.createServer((req, res) => {
    ontvangen.push({ url: req.url, sleutel: req.headers["x-api-key"] || null });
    if (antwoord === null) {
      res.writeHead(401).end(JSON.stringify({ error: "Ongeldige sleutel" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(antwoord));
  });
  srv.keepAliveTimeout = 1;
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return {
    ontvangen,
    url: `http://127.0.0.1:${srv.address().port}`,
    sluit: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); }),
  };
}

async function tenant(t, { renderUrl, sleutel = "een-sleutel" } = {}) {
  const oud = { ...process.env };
  if (renderUrl === undefined) delete process.env.FULL_APP_RENDER_URL;
  else process.env.FULL_APP_RENDER_URL = renderUrl;
  process.env.FULL_APP_RENDER_API_KEY = sleutel;

  const server = http.createServer(createTenantApp({ id: "testtenant", brand: { name: "Test" } }));
  server.keepAliveTimeout = 1;
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
    for (const k of Object.keys(process.env)) if (!(k in oud)) delete process.env[k];
    Object.assign(process.env, oud);
  });
  const basis = `http://127.0.0.1:${server.address().port}`;
  return async () => (await fetch(`${basis}/health`)).json();
}

test("met een partnersleutel noemt /health de partner", async (t) => {
  const api = await nepReportApi({ partner: "woonwijzerwinkel", kan_bewaren: true });
  t.after(() => api.sluit());
  const health = await tenant(t, { renderUrl: `${api.url}/api/full/render` });
  const d = await health();
  assert.equal(d.rapport_partner, "woonwijzerwinkel");
  assert.equal(d.rapport_kan_bewaren, true);
  assert.match(api.ontvangen[0].url, /\/api\/wie-ben-ik$/, "het pad hoort van de renderurl afgeleid te worden");
  assert.equal(api.ontvangen[0].sleutel, "een-sleutel", "met dezelfde sleutel als de rapportaanvraag");
});

test("met de gedeelde sleutel staat er geen partner, en dat is de stille fout", async (t) => {
  // Dit is exact de stand waarin het volledige rapport niet geleverd kan worden terwijl
  // alles er verder gezond uitziet.
  const api = await nepReportApi({ partner: null, kan_bewaren: false });
  t.after(() => api.sluit());
  const d = await (await tenant(t, { renderUrl: `${api.url}/api/full/render` }))();
  assert.equal(d.rapport_partner, null);
  assert.equal(d.rapport_kan_bewaren, false);
});

test("een geweigerde sleutel geeft de reden mee", async (t) => {
  const api = await nepReportApi(null);
  t.after(() => api.sluit());
  const d = await (await tenant(t, { renderUrl: `${api.url}/api/full/render` }))();
  assert.equal(d.rapport_kan_bewaren, false);
  assert.equal(d.rapport_partner_reden, "http_401");
});

test("zonder renderurl valt /health niet om", async (t) => {
  // /health is juist het laatste dat mag breken als er iets niet geconfigureerd is.
  const d = await (await tenant(t, { renderUrl: undefined }))();
  assert.equal(d.ok, true);
  assert.equal(d.rapport_partner, null);
  assert.equal(d.rapport_partner_reden, "geen_render_url");
});

test("een onbereikbare report-api geeft een reden en geen fout", async (t) => {
  const d = await (await tenant(t, { renderUrl: "http://127.0.0.1:1/api/full/render" }))();
  assert.equal(d.ok, true);
  assert.equal(d.rapport_partner_reden, "onbereikbaar");
});

test("het antwoord wordt onthouden: /health vraagt het niet elke keer opnieuw", async (t) => {
  // Anders doet elke statuscontrole een extra aanroep naar de report-api, en die staat
  // ook op het pad van echte rapporten.
  const api = await nepReportApi({ partner: "woonwijzerwinkel", kan_bewaren: true });
  t.after(() => api.sluit());
  const health = await tenant(t, { renderUrl: `${api.url}/api/full/render` });
  await health();
  await health();
  await health();
  assert.equal(api.ontvangen.length, 1);
});
