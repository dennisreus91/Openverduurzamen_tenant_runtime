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
import http from "node:http";
import { createTenantApp } from "../index.js";

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

test("/health noemt of de gegevenspoort aanstaat", async (t) => {
  const uit = await tenant(t, { gegevensPoort: true });
  assert.equal((await (await uit.haal("/health")).json()).gegevens_poort, true);

  const zonder = await tenant(t);
  assert.equal((await (await zonder.haal("/health")).json()).gegevens_poort, false);
});

test("/api/tenant zegt de pagina of de poort getoond moet worden", async (t) => {
  const uit = await tenant(t, { gegevensPoort: true });
  assert.equal((await (await uit.haal("/api/tenant")).json()).gegevensPoort, true);
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
