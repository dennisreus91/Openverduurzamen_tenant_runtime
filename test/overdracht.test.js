// test/overdracht.test.js
//
// De overdracht: een partner (Softbee) stuurt een .epa, krijgt een link, en
// de adviseur bestelt op rekening van de partner.
//
// WAAROM DEZE TEST BESTAAT
// Elke link is een recht om op rekening van de partner te bestellen. Wat hier
// vastligt: zonder sleutel staat de ingang dicht, een kapot bestand komt als
// foutcode bij de partner terug (en niet als een dode link bij de adviseur),
// een link levert hoogstens één bestelling op, en elke bestelling wordt
// getekend gemeld -- want daarop factureert de partner zijn adviseur.
//
// Geen netwerk naar buiten: de report-api en de webhookontvanger zijn nep en
// draaien hier lokaal.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

// VOOR de import van index.js: de stores lezen ORDERS_DATA_DIR bij het laden.
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tenant-overdracht-"));
process.env.ORDERS_DATA_DIR = DATA_DIR;
const { createTenantApp } = await import("../index.js");
const { createOrder } = await import("../lib/orders_store.js");
const { terugUrlToegestaan, onderteken, valideerOverdracht, maskeerEmail } = await import("../lib/overdracht.js");

const SLEUTEL = "partner-sleutel-voor-de-test";
const GEHEIM = "webhookgeheim-voor-de-test";

const MODEL = {
  source: "epa",
  address: { postalcode: "2625ZD", housenumber: "9", houseaddition: "" },
  building: { build_year: 1969, ag_m2: 135 },
  official: { label: "C" },
};
const PREVIEW = {
  address: { addr_line: "Teststraat 9, 2625ZD Delft" },
  official: { label: "C" },
  is_registered: true,
  registratienummer: "123456",
};

/** Een lokale http-server met een handler; geeft de basis-url terug. */
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

/**
 * Een tenant met een nep-report-api en een nep-webhook.
 * `ingest` bepaalt wat de report-api op het uitlezen antwoordt.
 */
async function opzet(t, { env = {}, ingest = { status: 200, body: { model: MODEL, preview: PREVIEW } } } = {}) {
  const meldingen = [];
  const reportApi = await server(t, async (req, res) => {
    await leesBody(req);
    if (req.url === "/api/epa/ingest") {
      res.writeHead(ingest.status, { "content-type": "application/json" });
      return res.end(JSON.stringify(ingest.body));
    }
    // Renderen lukt niet: de bestelling eindigt dan als "error", en dat
    // hoort als rapport.mislukt bij de partner aan te komen.
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "nep-render faalt" }));
  });
  const webhook = await server(t, async (req, res) => {
    const body = await leesBody(req);
    meldingen.push({ headers: req.headers, body, json: JSON.parse(body) });
    res.writeHead(200);
    res.end("ok");
  });

  const omgeving = {
    FULL_APP_RENDER_URL: `${reportApi}/api/full/render`,
    OVERDRACHT_API_KEY: SLEUTEL,
    OVERDRACHT_WEBHOOK_URL: `${webhook}/haak`,
    OVERDRACHT_WEBHOOK_SECRET: GEHEIM,
    OVERDRACHT_TERUG_HOSTS: "softbee.nl",
    OVERDRACHT_PRIJS_EUR: "25",
    ...env,
  };
  const oud = { ...process.env };
  for (const [k, v] of Object.entries(omgeving)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  t.after(() => {
    for (const k of Object.keys(omgeving)) delete process.env[k];
    Object.assign(process.env, oud);
  });

  const app = createTenantApp({ id: "testtenant", brand: { name: "Test" }, payment: { priceEur: 30 } });
  const basis = await server(t, app);
  const maak = (body, sleutel = SLEUTEL) =>
    fetch(`${basis}/api/epa/overdracht`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(sleutel ? { "x-api-key": sleutel } : {}) },
      body: JSON.stringify(body),
    });
  return { basis, maak, meldingen };
}

const GELDIG = {
  epa_base64: "UEsDBA==",
  adviseur_id: "ADV-1042",
  adviseur_email: "Adviseur@Voorbeeld.nl",
  dossier_id: "DOS-77",
  terug_url: "https://app.softbee.nl/dossier/77",
};

async function wachtTot(voorwaarde, ms = 3000) {
  const eind = Date.now() + ms;
  while (Date.now() < eind) {
    if (voorwaarde()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

test("zonder sleutel in de omgeving staat de ingang dicht, niet open", async (t) => {
  const { maak } = await opzet(t, { env: { OVERDRACHT_API_KEY: undefined } });
  const r = await maak(GELDIG);
  assert.equal(r.status, 503);
  assert.equal((await r.json()).code, "overdracht_uit");
});

test("een verkeerde of ontbrekende sleutel geeft 401", async (t) => {
  const { maak } = await opzet(t);
  assert.equal((await maak(GELDIG, "fout")).status, 401);
  assert.equal((await maak(GELDIG, "")).status, 401);
});

test("verplichte velden en een vreemde terug-URL worden geweigerd", async (t) => {
  const { maak } = await opzet(t);
  const r = await maak({ epa_base64: "", adviseur_email: "geen-adres", terug_url: "https://softbee.nl.evil.com/x" });
  assert.equal(r.status, 400);
  const j = await r.json();
  assert.deepEqual(Object.keys(j.field_errors).sort(), ["adviseur_email", "adviseur_id", "epa_base64", "terug_url"]);
});

test("een afgewezen bestand komt met de foutcode van de report-api terug bij de partner", async (t) => {
  const { maak } = await opzet(t, {
    ingest: { status: 422, body: { error: "Niet geregistreerd", code: "epa_not_registered" } },
  });
  const r = await maak(GELDIG);
  assert.equal(r.status, 422);
  assert.equal((await r.json()).code, "epa_not_registered");
});

test("van overdracht tot bestelling: één bestelling per link, op rekening, en getekend gemeld", async (t) => {
  const { basis, maak, meldingen } = await opzet(t);

  const r = await maak(GELDIG);
  assert.equal(r.status, 201);
  const od = await r.json();
  assert.match(od.overdracht_id, /^od_[0-9a-f]{18}$/);
  assert.equal(od.samenvatting.label, "C");
  const token = new URL(od.url).searchParams.get("overdracht");
  assert.ok(token && token !== od.overdracht_id, "het id voor de partner is niet het token uit de link");

  const kop = { "x-api-key": SLEUTEL };
  let stand = await (await fetch(`${basis}/api/epa/overdracht/${od.overdracht_id}`, { headers: kop })).json();
  assert.equal(stand.status, "open");
  assert.equal(stand.adviseur_id, "ADV-1042");

  const pagina = await (await fetch(`${basis}/api/overdracht/${token}`)).json();
  assert.equal(pagina.preview.registratienummer, "123456");
  assert.equal(pagina.terug_url, GELDIG.terug_url);
  assert.equal(pagina.mail_naar, "a***@voorbeeld.nl");
  assert.equal(pagina.bestelling, null);

  const bestel = (body) =>
    fetch(`${basis}/api/overdracht/${token}/bestellen`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  assert.equal((await bestel({ accept_terms: false })).status, 400, "zonder akkoord geen bestelling");
  assert.equal((await bestel({ accept_terms: true, doel: "iets_anders" })).status, 400);

  const eerste = await bestel({ accept_terms: true, doel: "laagste_investering" });
  assert.equal(eerste.status, 201);
  const b1 = await eerste.json();
  const b2 = await (await bestel({ accept_terms: true })).json();
  assert.equal(b2.al_besteld, true);
  assert.equal(b2.order_id, b1.order_id, "een tweede klik levert geen tweede bestelling op");

  const orders = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "full_orders.json"), "utf-8")).orders;
  const order = orders.find((o) => o.id === b1.order_id);
  assert.equal(order.payment.status, "op_rekening");
  assert.equal(order.amount_eur, 25);
  assert.equal(order.email, "adviseur@voorbeeld.nl");
  assert.equal(order.source_meta.overdracht_id, od.overdracht_id);
  assert.equal(order.confirmed_data.verduurzamingsdoel, "laagste_investering");

  assert.ok(await wachtTot(() => meldingen.some((m) => m.json.type === "rapport.mislukt")), "de mislukte render wordt gemeld");
  const besteld = meldingen.find((m) => m.json.type === "rapport.besteld");
  assert.ok(besteld, "de bestelling wordt gemeld");
  assert.equal(besteld.json.id, `${b1.order_id}.rapport.besteld`);
  assert.equal(besteld.json.data.adviseur_id, "ADV-1042");
  assert.equal(besteld.json.data.dossier_id, "DOS-77");

  // De handtekening klopt met het geheim, over precies de verstuurde body.
  const [tDeel, v1Deel] = String(besteld.headers["x-overdracht-signature"]).split(",");
  const tijd = tDeel.slice(2);
  const verwacht = crypto.createHmac("sha256", GEHEIM).update(`${tijd}.${besteld.body}`).digest("hex");
  assert.equal(v1Deel.slice(3), verwacht);

  stand = await (await fetch(`${basis}/api/epa/overdracht/${od.overdracht_id}`, { headers: kop })).json();
  assert.equal(stand.status, "mislukt");
  assert.equal(stand.bestelling.bestelling_id, b1.order_id);
});

test("het maandoverzicht telt alleen geleverde rapporten, in de maand van levering", async (t) => {
  const { basis } = await opzet(t);
  const basisOrder = {
    tenant_id: "testtenant", address: { postalcode: "1234AB", housenumber: "1" }, amount_eur: 25,
    source_meta: { source: "overdracht", overdracht_id: "od_x", adviseur_id: "ADV-9", dossier_id: "D;1" },
  };
  createOrder({ ...basisOrder, id: "geleverd-okt", status: "mailed", created_at: "2026-09-30T22:00:00Z", mailed_at: "2026-10-01T08:00:00Z" });
  createOrder({ ...basisOrder, id: "mislukt-okt", status: "error", created_at: "2026-10-02T08:00:00Z", mailed_at: null });
  createOrder({ ...basisOrder, id: "gewone-okt", status: "mailed", mailed_at: "2026-10-03T08:00:00Z", source_meta: { source: "epa" } });

  const kop = { "x-api-key": SLEUTEL };
  const j = await (await fetch(`${basis}/api/epa/overdrachten?maand=2026-10`, { headers: kop })).json();
  assert.deepEqual(j.rapporten.map((r) => r.bestelling_id), ["geleverd-okt"]);
  assert.equal(j.rapporten[0].bedrag_eur, "25.00");

  const csv = await (await fetch(`${basis}/api/epa/overdrachten?maand=2026-10&formaat=csv`, { headers: kop })).text();
  assert.match(csv.split("\n")[0], /^bestelling_id;overdracht_id;adviseur_id/);
  assert.match(csv, /"D;1"/, "een puntkomma in een kenmerk breekt de kolommen niet");

  assert.equal((await fetch(`${basis}/api/epa/overdrachten?maand=2026-13`, { headers: kop })).status, 400);
});

test("de terug-URL mag alleen https naar een host van de partner", () => {
  const hosts = ["softbee.nl"];
  assert.equal(terugUrlToegestaan("https://softbee.nl/x", hosts), true);
  assert.equal(terugUrlToegestaan("https://app.softbee.nl/x", hosts), true);
  assert.equal(terugUrlToegestaan("http://softbee.nl/x", hosts), false);
  assert.equal(terugUrlToegestaan("https://nepsoftbee.nl/x", hosts), false);
  assert.equal(terugUrlToegestaan("https://softbee.nl@evil.com/x", hosts), false);
  assert.equal(terugUrlToegestaan("javascript:alert(1)", hosts), false);
  // Zonder ingestelde hosts mag er geen enkele terug-URL.
  assert.ok(valideerOverdracht({ ...GELDIG }, { hosts: [] }).fouten.terug_url);
});

test("handtekening en maskering", () => {
  assert.equal(onderteken("{}", "g", 100), `t=100,v1=${crypto.createHmac("sha256", "g").update("100.{}").digest("hex")}`);
  assert.equal(maskeerEmail("piet@softbee.nl"), "p***@softbee.nl");
  assert.equal(maskeerEmail("kapot"), "");
});

// --- De voorkeuren van de adviseur horen in de bestelling ------------------
//
// WAT HIER MISGING (22 oktober 2026)
// De adviseur vult op de overdrachtspagina vier dingen in die niets over de
// woning zeggen maar over wat de klant wil en kan: het doel, een maximaal
// budget, een gemeentelijke subsidie en of er een verbouwing gepland staat.
// Het snelle rapport dat hij op datzelfde scherm ziet rekent daar al mee --
// epa_app.js stuurt ze naar /api/mid/stream. De bestelling van het volledige
// rapport stuurde alleen het doel mee.
//
// Gevolg: twee documenten over dezelfde woning met andere scenario's, en
// niets dat uitlegt waarom. Precies het soort verschil dat pas opvalt als een
// klant ze naast elkaar legt.
//
// Keuren gebeurt niet hier maar in de report-api (lib/confirmed_data.js), die
// een bedrag buiten zijn grenzen weglaat in plaats van klemt. Deze test
// bewaakt alleen dat ze meekomen -- en dat onzin niet meekomt.

test("budget, subsidie en verbouwing komen mee in de bestelling op rekening", async (t) => {
  const { basis, maak } = await opzet(t);
  const od = await (await maak(GELDIG)).json();
  const token = new URL(od.url).searchParams.get("overdracht");

  const r = await fetch(`${basis}/api/overdracht/${token}/bestellen`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      accept_terms: true,
      doel: "laagste_investering",
      max_budget_eur: "15000",
      gemeentelijke_subsidie_eur: 1200,
      verbouwing: "ja",
    }),
  });
  assert.equal(r.status, 201);
  const { order_id } = await r.json();

  const orders = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "full_orders.json"), "utf-8")).orders;
  const cd = orders.find((o) => o.id === order_id).confirmed_data;
  assert.equal(cd.verduurzamingsdoel, "laagste_investering");
  assert.equal(cd.max_budget_eur, 15000, "een bedrag als tekst hoort als getal in de bestelling te staan");
  assert.equal(cd.gemeentelijke_subsidie_eur, 1200);
  assert.equal(cd.verbouwing, "ja");
});

test("onzin in de voorkeuren komt er niet in, en houdt de bestelling niet tegen", async (t) => {
  const { basis, maak } = await opzet(t);
  const od = await (await maak(GELDIG)).json();
  const token = new URL(od.url).searchParams.get("overdracht");

  const r = await fetch(`${basis}/api/overdracht/${token}/bestellen`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      accept_terms: true,
      max_budget_eur: "veel",
      gemeentelijke_subsidie_eur: "",
      verbouwing: "misschien",
    }),
  });
  assert.equal(r.status, 201, "een onleesbaar bedrag mag de bestelling niet blokkeren");
  const { order_id } = await r.json();

  const orders = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "full_orders.json"), "utf-8")).orders;
  const cd = orders.find((o) => o.id === order_id).confirmed_data;
  assert.equal(cd.max_budget_eur, undefined);
  assert.equal(cd.gemeentelijke_subsidie_eur, undefined);
  assert.equal(cd.verbouwing, undefined, "alleen ja of nee; de rekenkern kent niets anders");
});
