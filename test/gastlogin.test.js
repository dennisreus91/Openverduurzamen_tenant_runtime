// test/gastlogin.test.js
//
// Een tweede inlog naast het vaste account, om de tool aan iemand te kunnen
// laten zien.
//
// WAAROM DEZE TEST ER TOE DOET
// Een extra inlog is pas iets waard als hij ook weer dicht kan, en als hij
// niet per ongeluk meer mag dan de bedoeling is. Drie dingen moeten daarom
// kloppen, en ze falen alle drie stil:
//
//   1. de gast komt binnen -- anders sta je met een klant aan de lijn;
//   2. hij komt NIET verder dan zijn eigen rapportlimiet, want elk volledig
//      rapport kost ongeveer EUR 1,35 en is achter de login gratis;
//   3. zijn cookie werkt niet meer zodra de regel uit GASTLOGINS weg is.
//      Zonder punt 3 is intrekken geen intrekken maar wachten tot de cookie
//      van zeven dagen verloopt.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { leesGastlogins } from "../lib/gastlogins.js";

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tenant-gast-"));
process.env.ORDERS_DATA_DIR = DATA_DIR;

const INLOG = {
  WWW_INTERNAL_EMAIL: "eigenaar@example.nl",
  WWW_INTERNAL_PASSWORD: "het-vaste-wachtwoord",
  WWW_INTERNAL_SESSION_SECRET: "s".repeat(48),
};

const AANVRAAG = {
  email: "klant@example.nl",
  address: { postalcode: "5654PM", housenumber: "373" },
  confirmed_data: { soort_woning: "tussenwoning", build_year: 1969, floor_area_m2: 135, energy_label: "c" },
};

/**
 * Een draaiende tenant met de poort aan.
 *
 * `gastlogins` is de inhoud van de omgevingsvariabele. Die wordt bij het
 * opstarten gelezen, dus hij moet staan voordat de app wordt gebouwd --
 * precies zoals in Render, waar een wijziging een herstart is.
 */
async function tenant(t, { gastlogins = "", features = { toegang: true } } = {}) {
  const oud = { ...process.env };
  Object.assign(process.env, INLOG, { GASTLOGINS: gastlogins });
  const { createTenantApp } = await import("../index.js");
  const server = http.createServer(
    createTenantApp({ id: "testtenant", brand: { name: "Test" }, features })
  );
  server.keepAliveTimeout = 1;
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
    delete process.env.GASTLOGINS;
    Object.assign(process.env, oud);
  });

  const basis = `http://127.0.0.1:${server.address().port}`;
  const inloggen = async (email, password) => {
    const res = await fetch(`${basis}/api/internal/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const cookie = (res.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]).join("; ");
    return { status: res.status, cookie };
  };
  return {
    basis,
    inloggen,
    render: (cookie) =>
      fetch(`${basis}/api/internal/full/render`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify(AANVRAAG),
      }),
    quota: (cookie) => fetch(`${basis}/api/internal/quota`, { headers: { cookie } }),
    // Of de poort opengaat. Een testtenant heeft geen paginasjablonen, dus
    // wie binnen is krijgt een 404 en geen 200; waar het om gaat is dat hij
    // NIET naar de inlogpagina wordt gestuurd.
    poort: (cookie) =>
      fetch(`${basis}/full_start.html`, {
        redirect: "manual",
        headers: { accept: "text/html", ...(cookie ? { cookie } : {}) },
      }),
  };
}

/** Binnen betekent: niet teruggestuurd naar de inlogpagina. */
function verwachtBinnen(res, bericht = "hoort binnen te zijn") {
  assert.notEqual(res.status, 302, bericht);
  assert.notEqual(res.status, 401, bericht);
}

// --- Het lezen van de omgevingsvariabele ------------------------------------

test("een regel met drie velden levert een account met eigen limiet", () => {
  const { accounts, klachten } = leesGastlogins({ GASTLOGINS: "Demo@Klant.NL|Wacht|2" });
  assert.deepEqual(accounts, [{ email: "demo@klant.nl", wachtwoord: "Wacht", dagmax: 2 }]);
  assert.deepEqual(klachten, []);
});

test("zonder derde veld geldt de standaardlimiet, en die is te verzetten", () => {
  assert.equal(leesGastlogins({ GASTLOGINS: "a@b.nl|w" }).accounts[0].dagmax, 3);
  assert.equal(leesGastlogins({ GASTLOGINS: "a@b.nl|w", GASTLOGIN_DAGMAX: "7" }).accounts[0].dagmax, 7);
});

test("meerdere accounts, gescheiden door een regeleinde of een puntkomma", () => {
  const { accounts } = leesGastlogins({ GASTLOGINS: "a@b.nl|w1|1\nc@d.nl|w2|2 ; e@f.nl|w3" });
  assert.deepEqual(accounts.map((a) => a.email), ["a@b.nl", "c@d.nl", "e@f.nl"]);
});

test("een wachtwoord met een dubbele punt erin blijft heel", () => {
  // Daarom is de streep het scheidingsteken en niet de dubbele punt: in een
  // gegenereerd wachtwoord komt die gewoon voor.
  const { accounts } = leesGastlogins({ GASTLOGINS: "a@b.nl|aB3:xY7:qq|1" });
  assert.equal(accounts[0].wachtwoord, "aB3:xY7:qq");
});

test("een onleesbare regel wordt overgeslagen en gemeld, zonder het wachtwoord", () => {
  const { accounts, klachten } = leesGastlogins({ GASTLOGINS: "kapot-zonder-streep\ngoed@b.nl|w|1" });
  assert.deepEqual(accounts.map((a) => a.email), ["goed@b.nl"]);
  assert.equal(klachten.length, 1);
  assert.doesNotMatch(klachten[0], /kapot-zonder-streep/, "geen hele regel in het log");
});

test("een regel zonder wachtwoord levert geen account op", () => {
  // Anders zou een lege tweede kolom een account zonder wachtwoord maken.
  assert.equal(leesGastlogins({ GASTLOGINS: "a@b.nl|" }).accounts.length, 0);
  assert.equal(leesGastlogins({ GASTLOGINS: "a@b.nl" }).accounts.length, 0);
});

// --- De inlog zelf ----------------------------------------------------------

test("een gast komt binnen met zijn eigen wachtwoord, en niet met dat van de eigenaar", async (t) => {
  const s = await tenant(t, { gastlogins: "gast@klant.nl|gastwachtwoord|2" });

  const gast = await s.inloggen("gast@klant.nl", "gastwachtwoord");
  assert.equal(gast.status, 200);
  await verwachtBinnen(await s.poort(gast.cookie), "de poort gaat voor hem open");

  const verkeerd = await s.inloggen("gast@klant.nl", INLOG.WWW_INTERNAL_PASSWORD);
  assert.equal(verkeerd.status, 401, "het vaste wachtwoord hoort niet op een gastaccount te werken");
});

test("het vaste account verandert niet", async (t) => {
  const s = await tenant(t, { gastlogins: "gast@klant.nl|gastwachtwoord|2" });
  const eigenaar = await s.inloggen(INLOG.WWW_INTERNAL_EMAIL, INLOG.WWW_INTERNAL_PASSWORD);
  assert.equal(eigenaar.status, 200);
  await verwachtBinnen(await s.poort(eigenaar.cookie));
});

test("zonder GASTLOGINS verandert er niets", async (t) => {
  const s = await tenant(t);
  assert.equal((await s.inloggen("gast@klant.nl", "gastwachtwoord")).status, 401);
  assert.equal((await s.inloggen(INLOG.WWW_INTERNAL_EMAIL, INLOG.WWW_INTERNAL_PASSWORD)).status, 200);
});

test("de regel weghalen sluit een lopende sessie af", async (t) => {
  // Het hart van de zaak: intrekken moet NU werken, niet als de cookie over
  // zeven dagen verloopt.
  const met = await tenant(t, { gastlogins: "tijdelijk@klant.nl|w|2" });
  const sessie = await met.inloggen("tijdelijk@klant.nl", "w");
  assert.equal(sessie.status, 200);
  await verwachtBinnen(await met.poort(sessie.cookie));

  // Zelfde sessiegeheim, dus de handtekening klopt nog; alleen het account
  // bestaat niet meer.
  const zonder = await tenant(t, { gastlogins: "" });
  const na = await zonder.poort(sessie.cookie);
  assert.equal(na.status, 302, "die cookie hoort nu naar de inlogpagina te leiden");
  assert.equal(na.headers.get("location"), "/intern");
});

// --- De eigen rapportlimiet -------------------------------------------------

test("een gast loopt tegen zijn eigen limiet aan, de eigenaar niet", async (t) => {
  const s = await tenant(t, {
    gastlogins: "limiet@klant.nl|w|1",
    features: { toegang: true, dagplafond: 100 },
  });
  const gast = (await s.inloggen("limiet@klant.nl", "w")).cookie;

  assert.equal((await s.render(gast)).status, 200, "het eerste rapport gaat door");

  const tweede = await s.render(gast);
  assert.equal(tweede.status, 429);
  const uit = await tweede.json();
  assert.equal(uit.code, "accountlimiet_bereikt");
  assert.equal(uit.dagmax, 1);
  assert.match(uit.error, /vandaag al 1 volledige rapporten/);

  // De teller van de tenant staat nu op 1 en het plafond op 100, dus de
  // eigenaar mag nog gewoon. De limiet van de gast is van hem alleen.
  const eigenaar = (await s.inloggen(INLOG.WWW_INTERNAL_EMAIL, INLOG.WWW_INTERNAL_PASSWORD)).cookie;
  assert.equal((await s.render(eigenaar)).status, 200);
});

test("het dagplafond van de tenant gaat voor de ruimte van een gast", async (t) => {
  // Een gast met een royale limiet mag nooit door het plafond van de tenant
  // heen; daarom staat zijn controle NA die van het plafond.
  const s = await tenant(t, {
    gastlogins: "royaal@klant.nl|w|50",
    features: { toegang: true, dagplafond: 2 },
  });
  const gast = (await s.inloggen("royaal@klant.nl", "w")).cookie;
  // De dagteller van deze map staat al op 2 door de vorige test.
  const res = await s.render(gast);
  assert.equal(res.status, 429);
  assert.equal((await res.json()).code, "dagplafond_bereikt");
});

test("een gast ziet zijn eigen stand en niet de omzet van de tenant", async (t) => {
  const s = await tenant(t, { gastlogins: "kijker@klant.nl|w|4" });
  const gast = (await s.inloggen("kijker@klant.nl", "w")).cookie;
  const q = await (await s.quota(gast)).json();
  assert.equal(q.account, "kijker@klant.nl");
  assert.equal(q.dagmax, 4);
  assert.equal(q.dag_resterend, 4);
  assert.equal(q.history, undefined, "de maandgeschiedenis van de tenant is niets voor een gast");
  assert.equal(q.kosten_schatting, undefined, "en het kostenplaatje al helemaal niet");

  const eigenaar = (await s.inloggen(INLOG.WWW_INTERNAL_EMAIL, INLOG.WWW_INTERNAL_PASSWORD)).cookie;
  const qe = await (await s.quota(eigenaar)).json();
  assert.ok(qe.history, "de eigenaar ziet wel alles");
  assert.ok(qe.kosten_schatting);
});
