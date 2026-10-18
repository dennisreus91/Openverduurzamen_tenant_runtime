// test/overdracht_telt_mee.test.js
//
// Een bestelling op rekening telt mee, en loopt tegen het dagplafond aan.
//
// WAAROM DEZE TEST BESTAAT
// De overdracht kent een eigen maandoverzicht (GET /api/epa/overdrachten) --
// daarop factureert de partner. Maar voor ONZE kosten was die bestelling
// onzichtbaar: /api/internal/quota liet een rustige dag zien terwijl er
// tientallen rapporten op rekening uitgingen, en het dagplafond gold er niet
// voor. Een rapport op rekening is voor de adviseur gratis en kost ons het
// taalmodel plus de rapportbouw, precies als elk ander rapport.
//
// Wat hier vastligt: de bestelling verhoogt de dagteller, en bij een vol
// dagplafond komt er geen bestelling meer bij.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tenant-od-telling-"));
process.env.ORDERS_DATA_DIR = DATA_DIR;
const { createTenantApp } = await import("../index.js");

const SLEUTEL = "partner-sleutel-voor-de-test";
const BEHEER = "beheersleutel-voor-de-test";

const MODEL = {
  source: "epa",
  address: { postalcode: "2625ZD", housenumber: "9", houseaddition: "" },
  building: { build_year: 1969, ag_m2: 135 },
  official: { label: "C" },
};
const PREVIEW = { address: { addr_line: "Teststraat 9" }, official: { label: "C" }, is_registered: true };

const GELDIG = {
  epa_base64: "UEsDBA==",
  adviseur_id: "ADV-1042",
  adviseur_email: "adviseur@voorbeeld.nl",
  terug_url: "https://app.softbee.nl/dossier/77",
};

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

async function opzet(t, { dagplafond } = {}) {
  const reportApi = await server(t, (req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      if (req.url === "/api/epa/ingest") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ model: MODEL, preview: PREVIEW }));
      }
      // Renderen lukt niet; dat maakt voor de telling niet uit -- de
      // bestelling is dan al aangemaakt en heeft ons al geld gekost.
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "nep-render faalt" }));
    });
  });

  const omgeving = {
    FULL_APP_RENDER_URL: `${reportApi}/api/full/render`,
    OVERDRACHT_API_KEY: SLEUTEL,
    OVERDRACHT_TERUG_HOSTS: "softbee.nl",
    ADMIN_API_KEY: BEHEER,
  };
  const oud = { ...process.env };
  Object.assign(process.env, omgeving);
  t.after(() => {
    for (const k of Object.keys(omgeving)) delete process.env[k];
    Object.assign(process.env, oud);
  });

  const app = createTenantApp({
    id: "testtenant",
    brand: { name: "Test" },
    payment: { priceEur: 30 },
    ...(dagplafond ? { features: { dagplafond } } : {}),
  });
  const basis = await server(t, app);

  /** Een nieuwe overdracht, en het token uit de adviseurslink. */
  const nieuweLink = async () => {
    const r = await fetch(`${basis}/api/epa/overdracht`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": SLEUTEL },
      body: JSON.stringify(GELDIG),
    });
    assert.equal(r.status, 201);
    return new URL((await r.json()).url).searchParams.get("overdracht");
  };

  return {
    basis,
    nieuweLink,
    bestel: (token) =>
      fetch(`${basis}/api/overdracht/${token}/bestellen`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accept_terms: true }),
      }),
    stand: () => fetch(`${basis}/api/internal/quota?token=${BEHEER}`).then((r) => r.json()),
  };
}

test("een bestelling op rekening verhoogt de dagteller", async (t) => {
  const s = await opzet(t);
  const voor = (await s.stand()).dag_gebruik;

  const res = await s.bestel(await s.nieuweLink());
  assert.equal(res.status, 201);

  const na = await s.stand();
  assert.equal(na.dag_gebruik, voor + 1, "anders is de dag onzichtbaar in de kostenteller");
  assert.ok(na.kosten_schatting.vandaag_eur > 0);
});

test("een tweede bestelling op dezelfde link telt niet nog eens mee", async (t) => {
  // Eén bestelling per link; de tweede klik geeft dezelfde bestelling terug
  // en kost dus niets extra's.
  const s = await opzet(t);
  const token = await s.nieuweLink();
  assert.equal((await s.bestel(token)).status, 201);
  const voor = (await s.stand()).dag_gebruik;
  const weer = await s.bestel(token);
  assert.equal((await weer.json()).al_besteld, true);
  assert.equal((await s.stand()).dag_gebruik, voor);
});

test("bij een vol dagplafond komt er geen bestelling meer bij", async (t) => {
  const s = await opzet(t, { dagplafond: 1 });
  // De dagteller staat door de tests hierboven al boven de 1; dat is precies
  // de situatie die we willen zien.
  const res = await s.bestel(await s.nieuweLink());
  assert.equal(res.status, 429);
  const uit = await res.json();
  assert.equal(uit.code, "dagplafond_bereikt");
  assert.equal(uit.dagplafond, 1);
});

test("het plafond houdt de bestelling tegen, niet alleen de melding", async (t) => {
  // Een 429 die tóch een bestelling had aangemaakt zou het ergste van twee
  // werelden zijn: de partner denkt dat het mislukte en wij betalen.
  const s = await opzet(t, { dagplafond: 1 });
  const token = await s.nieuweLink();
  const voor = (await s.stand()).dag_gebruik;
  assert.equal((await s.bestel(token)).status, 429);
  assert.equal((await s.stand()).dag_gebruik, voor, "er is niets aangemaakt");
  const pagina = await (await fetch(`${s.basis}/api/overdracht/${token}`)).json();
  assert.equal(pagina.bestelling, null, "en de link is nog bruikbaar als het plafond morgen weer open is");
});
