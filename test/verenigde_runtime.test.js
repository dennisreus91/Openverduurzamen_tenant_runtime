// test/verenigde_runtime.test.js
//
// WAAROM DEZE TEST BESTAAT
// De runtime liep uiteen in drie lijnen die alle drie in productie stonden:
//
//   main                 de EPA-routes, het rapportprofiel, het doel
//   v2.0.1 .. v2.0.11    de lead-PDF van het snelle rapport en MAIL_BCC
//   release/der-report   aantal zonnepanelen, adviesaanvraag, listing-extract
//
// Elke tenant pinde een andere lijn, en geen enkele tag bevatte alles. Een
// tenant overzetten betekende daardoor altijd iets inleveren: wie van de
// PDF-lijn naar main ging, verloor de lead-PDF; wie naar de DER-tak ging,
// verloor de EPA-upload. Op 6 oktober 2026 zijn de drie lijnen samengevoegd.
//
// Deze test bewaakt die vereniging: hij valt om zodra een route van een van de
// drie lijnen uit de runtime verdwijnt. Dat is precies de fout die een
// volgende samenvoeging stil kan maken -- een ontbrekende route geeft een 404
// op één tenant, niet een rode test.
//
// NIET gedekt, op geen enkele lijn: de bijlage-keten van de lead-mail (de
// PDF-lijn hangt daaraan). lib/mail_client.js verstuurt via de Resend-SDK, en
// die is zonder module-mocking niet te onderscheppen. Dat pad is te
// controleren door één testlead te versturen.

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createTenantApp } from "../index.js";

/** Start een server en geef { port, close } terug. */
async function listen(handler) {
  const server = http.createServer(handler);
  server.keepAliveTimeout = 1;
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  };
}

// De routes die elke lijn meebracht, met de lijn erbij zodat een rode test
// meteen zegt wélke lijn eruit gevallen is.
const ROUTES = [
  { lijn: "main", methode: "POST", pad: "/api/epa/ingest" },
  { lijn: "main", methode: "POST", pad: "/api/epa/feedback" },
  { lijn: "main", methode: "GET", pad: "/api/admin/feedback" },
  { lijn: "release/der-report", methode: "POST", pad: "/api/mid/listing-extract" },
  // Gemeenschappelijk, maar wel de kern van de flow: valt die weg, dan is er
  // geen rapport meer.
  { lijn: "alle", methode: "POST", pad: "/api/mid/stream" },
  { lijn: "alle", methode: "POST", pad: "/api/mid/full-report-handoff" },
  { lijn: "alle", methode: "POST", pad: "/api/lead" },
  { lijn: "alle", methode: "GET", pad: "/api/tenant" },
];

test("de verenigde runtime heeft de routes van alle drie de lijnen", async () => {
  // Zonder FULL_APP_RENDER_URL doen de proxyroutes geen enkele externe
  // aanroep: ze antwoorden met een 500 over de ontbrekende configuratie. Dat
  // is genoeg -- deze test gaat over het bestaan van de route, niet over wat
  // ze oplevert. Een onbekende route geeft 404.
  const prevUrl = process.env.FULL_APP_RENDER_URL;
  delete process.env.FULL_APP_RENDER_URL;

  const app = createTenantApp({ id: "testtenant", brand: { name: "Test" } });
  const server = await listen(app);

  try {
    for (const { lijn, methode, pad } of ROUTES) {
      const res = await fetch(`http://127.0.0.1:${server.port}${pad}`, {
        method: methode,
        headers: { "Content-Type": "application/json" },
        ...(methode === "POST" ? { body: "{}" } : {}),
      });
      assert.notEqual(res.status, 404, `${methode} ${pad} ontbreekt (lijn: ${lijn})`);
      assert.notEqual(res.status, 405, `${methode} ${pad} accepteert deze methode niet (lijn: ${lijn})`);
    }
  } finally {
    await server.close();
    if (prevUrl === undefined) delete process.env.FULL_APP_RENDER_URL;
    else process.env.FULL_APP_RENDER_URL = prevUrl;
  }
});

test("de witte lijst draagt de velden van alle drie de lijnen", async () => {
  // normalizeConfirmedDataInput is per lijn uitgebreid: het aantal
  // zonnepanelen op de DER-tak, het doel op main. Beide moeten erin zitten,
  // en beide voorwaardelijk -- een order zonder die velden houdt exact
  // dezelfde confirmed_data als voorheen.
  const { normalizeConfirmedDataInput } = await import("../index.js");

  const leeg = normalizeConfirmedDataInput({});
  assert.equal("solar_panels_count" in leeg, false, "zonder waarde hoort het veld weg te blijven");
  assert.equal("verduurzamingsdoel" in leeg, false, "zonder waarde hoort het veld weg te blijven");

  const gevuld = normalizeConfirmedDataInput({
    solar_panels_count: 12,
    verduurzamingsdoel: "kortste_terugverdientijd",
  });
  assert.equal(gevuld.solar_panels_count, 12, "het aantal panelen (van release/der-report)");
  assert.equal(gevuld.verduurzamingsdoel, "kortste_terugverdientijd", "het doel (van main)");
});

test("de ligging van een appartement bereikt het volledige rapport", async () => {
  // Dit veld bepaalt of vloer en dak warmte naar buiten verliezen (NTA 8800,
  // 8.5). Het snelle rapport kreeg het al mee -- die route geeft de body
  // ongewijzigd door -- maar het volledige rapport loopt langs deze witte
  // lijst en kreeg het nooit. Dezelfde woning werd daardoor twee keer anders
  // doorgerekend, zonder dat er iets faalde.
  const { normalizeConfirmedDataInput } = await import("../index.js");

  assert.equal(
    "ligging_appartement" in normalizeConfirmedDataInput({}),
    false,
    "zonder waarde hoort het veld weg te blijven"
  );
  assert.equal(
    normalizeConfirmedDataInput({ ligging_appartement: "bovenste_verdieping" }).ligging_appartement,
    "bovenste_verdieping"
  );
  assert.equal(
    "ligging_appartement" in normalizeConfirmedDataInput({ ligging_appartement: "  " }),
    false,
    "witruimte telt niet als keuze"
  );
});
