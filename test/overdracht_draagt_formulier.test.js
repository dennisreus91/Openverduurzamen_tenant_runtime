// test/overdracht_draagt_formulier.test.js
//
// De overdracht draagt het controleformulier mee.
//
// WAAROM DIT ERBIJ MOEST (22 oktober 2026)
// Softbee had een eigen frontend met een eigen scherm. Die liep steeds achter
// op die van OV: de volgorde klopte niet (eerst doorrekenen, dan pas de
// invoer vragen die het rapport bepaalt) en elke verbetering moest twee keer
// worden gebouwd. Nu draaien beide tenants dezelfde applicatie, en die
// applicatie begint met het antwoord van /api/mid/lookup.
//
// De overdracht vroeg de report-api alleen om het model, zonder
// `validatieformulier: true`. Daarmee kon de pagina dat scherm niet tonen en
// moest de partnerroute wel een eigen formulier houden. Deze test legt de
// twee schakels vast: wat we VRAGEN bij het uitlezen, en wat we TERUGGEVEN
// als de adviseur de link opent.
//
// Geen netwerk naar buiten: de report-api is nep en draait lokaal.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tenant-overdracht-form-"));
process.env.ORDERS_DATA_DIR = DATA_DIR;
const { createTenantApp } = await import("../index.js");

const SLEUTEL = "partner-sleutel-voor-de-test";

const MODEL = {
  source: "epa",
  address: { postalcode: "2625ZD", housenumber: "9", houseaddition: "" },
  building: { build_year: 1969, ag_m2: 135 },
  official: { label: "C" },
};
const VALIDATIEFORMULIER = {
  required: { build_year: { value: 1969 } },
  optional: { existing_measures: { value: ["dakisolatie"], source: "epa" } },
};
const LUCHTFOTO = { url: "https://voorbeeld/luchtfoto.jpg", contour_rel: [[0, 0], [1, 0], [1, 1]] };

async function server(t, handler) {
  const s = http.createServer(handler);
  s.keepAliveTimeout = 1;
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  t.after(async () => {
    s.closeAllConnections?.();
    await new Promise((r) => s.close(r));
  });
  return `http://127.0.0.1:${s.address().port}`;
}

function leesBody(req) {
  return new Promise((r) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => r(d));
  });
}

async function opzet(t) {
  const gevraagd = [];
  const reportApi = await server(t, async (req, res) => {
    const body = await leesBody(req);
    if (req.url === "/api/epa/ingest") {
      gevraagd.push(JSON.parse(body));
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(
        JSON.stringify({
          model: MODEL,
          preview: { address: { addr_line: "Teststraat 9, 2625ZD Delft" }, official: { label: "C" } },
          validation_form: VALIDATIEFORMULIER,
          luchtfoto: LUCHTFOTO,
          request_id: "req-123",
          source_facts: { woning: { build_year: 1969 } },
          address: MODEL.address,
        })
      );
    }
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "nep" }));
  });

  const omgeving = {
    FULL_APP_RENDER_URL: `${reportApi}/api/full/render`,
    OVERDRACHT_API_KEY: SLEUTEL,
    OVERDRACHT_TERUG_HOSTS: "softbee.nl",
  };
  const oud = { ...process.env };
  Object.assign(process.env, omgeving);
  t.after(() => {
    for (const k of Object.keys(omgeving)) delete process.env[k];
    Object.assign(process.env, oud);
  });

  const app = createTenantApp({ id: "testtenant", brand: { name: "Test" }, payment: { priceEur: 30 } });
  const basis = await server(t, app);
  return { basis, gevraagd };
}

const GELDIG = {
  epa_base64: "UEsDBA==",
  adviseur_id: "ADV-1042",
  adviseur_email: "adviseur@voorbeeld.nl",
  terug_url: "https://app.softbee.nl/dossier/77",
};

test("het uitlezen vraagt om het controleformulier", async (t) => {
  const { basis, gevraagd } = await opzet(t);
  const res = await fetch(`${basis}/api/epa/overdracht`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": SLEUTEL },
    body: JSON.stringify(GELDIG),
  });
  assert.equal(res.status, 201);
  assert.equal(gevraagd.length, 1);
  assert.equal(
    gevraagd[0].validatieformulier,
    true,
    "zonder deze vlag levert de .epa-route alleen het model, en kan de pagina " +
      "het controlescherm niet tonen -- dan moet de partnerroute een eigen formulier houden"
  );
});

test("en de link geeft dat formulier terug, met de luchtfoto erbij", async (t) => {
  const { basis } = await opzet(t);
  const aangemaakt = await (
    await fetch(`${basis}/api/epa/overdracht`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": SLEUTEL },
      body: JSON.stringify(GELDIG),
    })
  ).json();

  const token = new URL(aangemaakt.url).searchParams.get("overdracht");
  assert.ok(token, "de link hoort een token te dragen");

  const j = await (await fetch(`${basis}/api/overdracht/${token}`)).json();
  assert.deepEqual(j.validation_form, VALIDATIEFORMULIER);
  assert.deepEqual(j.luchtfoto, LUCHTFOTO);
  assert.equal(j.request_id, "req-123");
  assert.deepEqual(j.address, MODEL.address);
  // Wat er al stond, blijft staan.
  assert.deepEqual(j.epa_model, MODEL);
  assert.equal(j.terug_url, "https://app.softbee.nl/dossier/77");
});

test("de woninggegevens blijven van het bestand, niet van het scherm", async (t) => {
  // De afspraak met Softbee (15 oktober 2026): het .epa is leidend en de
  // adviseur corrigeert niets op ons scherm. Het formulier gaat daarom mee
  // als WEERGAVE. Deze test bewaakt dat er geen route ontstaat waarlangs het
  // scherm de woninggegevens alsnog terugstuurt: de overdracht kent alleen
  // `voorkeuren`, en die gaan over de klant.
  const { basis } = await opzet(t);
  const aangemaakt = await (
    await fetch(`${basis}/api/epa/overdracht`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": SLEUTEL },
      body: JSON.stringify({ ...GELDIG, doel: "laagste_investering", max_budget_eur: 15000 }),
    })
  ).json();
  const token = new URL(aangemaakt.url).searchParams.get("overdracht");
  const j = await (await fetch(`${basis}/api/overdracht/${token}`)).json();

  assert.deepEqual(j.voorkeuren, { verduurzamingsdoel: "laagste_investering", max_budget_eur: 15000 });
  assert.equal(j.confirmed_data, undefined, "de overdracht hoort geen woningformulier terug te nemen");
});
