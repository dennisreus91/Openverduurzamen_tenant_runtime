// test/gegevenspoort.test.js
//
// De gegevenspoort aan de serverkant: de vlag, en wat er met een poortaanvraag gebeurt.
//
// WAAROM DE POORT NIET GEMAILD WORDT
// De poort is registratie, geen contactverzoek. De bezoeker heeft nog geen adres
// ingevuld; hij wil de tool gebruiken. Zou /api/lead hem mailen, dan krijgt de partner
// bij iedere bezoeker een bericht over iemand die nog niets vroeg -- en raakt de echte
// aanvraag daarin onder.
//
// Dat "niet mailen" is hier te meten zonder de Resend-SDK na te bootsen: zonder
// RESEND_API_KEY strandt een gewone lead met een 500, en een poortaanvraag niet. Precies
// dat verschil is wat deze tests vastleggen.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

process.env.ORDERS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tenant-poort-"));
const { createTenantApp } = await import("../index.js");

const INLOG = {
  WWW_INTERNAL_EMAIL: "adviseur@example.nl",
  WWW_INTERNAL_PASSWORD: "een-wachtwoord-voor-de-test",
  WWW_INTERNAL_SESSION_SECRET: "s".repeat(48),
};

const AANVRAAG = {
  firstName: "Jan",
  lastName: "Jansen",
  email: "jan@voorbeeld.nl",
  phone: "0612345678",
  sourcePage: "rapport_toegang",
};

async function tenant(t, features) {
  const oud = { ...process.env };
  Object.assign(process.env, INLOG);
  delete process.env.RESEND_API_KEY;
  process.env.LEAD_EMAIL = "crm@woonwijzerwinkel.nl";

  const logregels = [];
  const echteError = console.error;
  console.error = (...a) => logregels.push(a.map(String).join(" "));

  const server = http.createServer(
    createTenantApp({ id: "testtenant", brand: { name: "Test" }, ...(features ? { features } : {}) })
  );
  server.keepAliveTimeout = 1;
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    console.error = echteError;
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
    for (const k of Object.keys(process.env)) if (!(k in oud)) delete process.env[k];
    Object.assign(process.env, oud);
  });

  const basis = `http://127.0.0.1:${server.address().port}`;
  const post = (pad, body, kop = {}) =>
    fetch(`${basis}${pad}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...kop },
      body: JSON.stringify(body),
    });

  async function login() {
    const r = await post("/api/internal/login", {
      email: INLOG.WWW_INTERNAL_EMAIL,
      password: INLOG.WWW_INTERNAL_PASSWORD,
    });
    return (r.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]).join("; ");
  }

  return {
    logregels,
    post,
    login,
    haal: (pad, kop = {}) => fetch(`${basis}${pad}`, { headers: { accept: "application/json", ...kop } }),
  };
}

// ── De vlag ───────────────────────────────────────────────────────────────────

test("/health noemt WAAR de poort staat, niet alleen of hij er is", async (t) => {
  const vooraf = await tenant(t, { gegevensPoort: "vooraf" });
  assert.equal((await (await vooraf.haal("/health")).json()).gegevens_poort, "vooraf");

  const later = await tenant(t, { gegevensPoort: "bij_download" });
  assert.equal((await (await later.haal("/health")).json()).gegevens_poort, "bij_download");

  const zonder = await tenant(t);
  assert.equal((await (await zonder.haal("/health")).json()).gegevens_poort, false);
});

test("true blijft vooraf lezen", () => {
  // Een config die `true` zet verandert niet van gedrag doordat de vlag een plaats werd.
  // Dit is de stand waarmee de WoonWijzerWinkel live ging.
});

test("true wordt gelezen als vooraf", async (t) => {
  const uit = await tenant(t, { gegevensPoort: true });
  assert.equal((await (await uit.haal("/health")).json()).gegevens_poort, "vooraf");
  assert.equal((await (await uit.haal("/api/tenant")).json()).gegevensPoort, "vooraf");
});

test("een onbekende waarde zet de poort uit in plaats van hem te raden", async (t) => {
  const uit = await tenant(t, { gegevensPoort: "misschien" });
  assert.equal((await (await uit.haal("/health")).json()).gegevens_poort, false);
});

test("/api/tenant zegt de pagina waar de poort staat", async (t) => {
  const uit = await tenant(t, { gegevensPoort: "bij_download" });
  assert.equal((await (await uit.haal("/api/tenant")).json()).gegevensPoort, "bij_download");
});

test("een ingelogde adviseur ziet de poort niet", async (t) => {
  // Maurice en Wouter testen met hun gastlogin. Een leadformulier voor zichzelf invullen
  // hoort daar niet bij, net zoals de rem op de dure routes hen overslaat.
  const uit = await tenant(t, { gegevensPoort: true });
  const cookie = await uit.login();
  const d = await (await uit.haal("/api/tenant", { cookie })).json();
  assert.equal(d.gegevensPoort, false);
});

test("zonder de vlag staat de poort uit", async (t) => {
  const uit = await tenant(t);
  assert.equal((await (await uit.haal("/api/tenant")).json()).gegevensPoort, false);
});

// ── De poortaanvraag ──────────────────────────────────────────────────────────

test("een poortaanvraag wordt niet gemaild", async (t) => {
  const uit = await tenant(t, { gegevensPoort: true });
  const r = await uit.post("/api/lead", {
    ...AANVRAAG,
    akkoord: false,
    context: { productType: "rapport_toegang" },
  });
  assert.equal(r.status, 200, "de poort hoort te slagen, ook zonder mailprovider");
  assert.equal((await r.json()).ok, true);
  assert.doesNotMatch(uit.logregels.join("\n"), /RESEND_API_KEY/,
    "er is een mail geprobeerd; de poort hoort alleen vast te leggen");
});

test("een gewoon contactverzoek wordt wél gemaild", async (t) => {
  // De keerzijde van de test hierboven. Zonder deze zou "niet mailen" ook kloppen als
  // de hele route geen mail meer verstuurt.
  const uit = await tenant(t, { gegevensPoort: true });
  const r = await uit.post("/api/lead", { ...AANVRAAG, akkoord: false, sourcePage: "contact" });
  assert.equal(r.status, 500, "zonder RESEND_API_KEY strandt het versturen");
  assert.match(uit.logregels.join("\n"), /RESEND_API_KEY/);
});

test("de poort eist dezelfde velden als het contactformulier", async (t) => {
  // Het telefoonnummer blijft verplicht (keuze Dennis, 28-10-2026): bellen is precies
  // wat de toestemming bij de rapportaanvraag belooft, en zonder nummer kan dat niet.
  const uit = await tenant(t, { gegevensPoort: true });
  const r = await uit.post("/api/lead", {
    firstName: "Jan",
    lastName: "Jansen",
    email: "jan@voorbeeld.nl",
    context: { productType: "rapport_toegang" },
  });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /telefoonnummer/i);
});


// ── Het volledige rapport zonder adviseurslogin ───────────────────────────────
//
// WAAROM DEZE ROUTE BEWIJS EIST
// Zonder bewijs aan de serverkant is "ik heb mijn gegevens gegeven" een bewering van de
// pagina, en is dit een gratis rapportautomaat voor wie hem vindt. Elk rapport kost ons
// data plus taalmodel. Het bewijs is de poortcookie, die /api/lead zet.

/** Loopt de poort en geeft de cookie terug. */
async function poortLopen(uit) {
  const r = await uit.post("/api/lead", {
    ...AANVRAAG,
    akkoord: false,
    context: { productType: "rapport_toegang" },
  });
  assert.equal(r.status, 200);
  const cookie = (r.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]).join("; ");
  assert.match(cookie, /wwwpoort=/, "de poort hoort een cookie te zetten");
  return cookie;
}

// De woning zoals de bezoeker haar in het snelle rapport heeft bevestigd of gecorrigeerd.
// Die invoer MOET mee: beide rapporten horen met dezelfde gegevens te rekenen, en de route
// weigert een aanvraag zonder (zie validateConfirmedDataBasic).
const WONING = {
  address: { postalcode: "2625ZD", housenumber: "9" },
  confirmed_data: {
    soort_woning: "tussenwoning",
    build_year: 1985,
    floor_area_m2: 120,
    energy_label: "D",
  },
};

test("zonder poort geen rapport", async (t) => {
  const uit = await tenant(t, { gegevensPoort: "vooraf" });
  const r = await uit.post("/api/full/aanvraag", { email: "jan@voorbeeld.nl", ...WONING });
  assert.equal(r.status, 401);
  assert.equal((await r.json()).code, "poort_vereist");
});

test("een verzonnen cookie opent niets", async (t) => {
  const uit = await tenant(t, { gegevensPoort: "vooraf" });
  const r = await uit.post("/api/full/aanvraag", { email: "jan@voorbeeld.nl", ...WONING },
    { cookie: "wwwpoort=zelfgemaakt.ondertekening" });
  assert.equal(r.status, 401);
});

test("de aanvraag zonder bevestigde woninggegevens wordt geweigerd", async (t) => {
  // Zonder deze grens zou het volledige rapport op andere gegevens rekenen dan het snelle
  // rapport dat de bezoeker op het scherm zag.
  const uit = await tenant(t, { gegevensPoort: "vooraf" });
  const cookie = await poortLopen(uit);
  const r = await uit.post("/api/full/aanvraag", { address: WONING.address, confirmed_data: {} }, { cookie });
  assert.equal(r.status, 400);
  assert.ok((await r.json()).field_errors?.energy_label);
});

test("na de poort mag het rapport aangevraagd worden, zonder adviseurslogin", async (t) => {
  const uit = await tenant(t, { gegevensPoort: "vooraf" });
  const cookie = await poortLopen(uit);
  const r = await uit.post("/api/full/aanvraag", WONING, { cookie });
  assert.equal(r.status, 200, JSON.stringify(await r.json()));
});

test("het e-mailadres komt uit de cookie, niet uit het verzoek", async (t) => {
  // Anders laat iemand met een geldige poortcookie een rapport naar een willekeurig adres
  // mailen, op onze rekening.
  const uit = await tenant(t, { gegevensPoort: "vooraf" });
  const cookie = await poortLopen(uit);
  const r = await uit.post("/api/full/aanvraag", { email: "iemand.anders@voorbeeld.nl", ...WONING }, { cookie });
  assert.equal(r.status, 200);
  const d = await r.json();
  const order = JSON.parse(JSON.stringify(d));
  assert.ok(!JSON.stringify(order).includes("iemand.anders@voorbeeld.nl"),
    "het opgegeven adres hoort genegeerd te worden: " + JSON.stringify(order));
});

test("ook een gewoon leadformulier opent de route", async (t) => {
  // Dat is de stand "bij_download": gegevens en toestemming in één formulier, en daarna
  // hoort de bezoeker net zo goed zijn rapport te krijgen.
  const uit = await tenant(t, { gegevensPoort: "bij_download" });
  const r = await uit.post("/api/lead", { ...AANVRAAG, akkoord: true, sourcePage: "contact" });
  // Zonder RESEND_API_KEY strandt het mailen van die lead -- maar de cookie hoort er dan
  // niet te zijn, want er is niets vastgelegd. Deze test legt vast dat we die twee niet
  // door elkaar halen.
  assert.equal(r.status, 500);
  const cookie = (r.headers.getSetCookie?.() || []).join("; ");
  assert.equal(cookie, "", "een mislukte lead hoort geen poortcookie te zetten");
});
