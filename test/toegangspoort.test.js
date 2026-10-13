// test/toegangspoort.test.js
//
// `features.toegang` zet de hele tenant achter de adviseurslogin.
//
// WAAROM DEZE TEST ER TOE DOET
// Een poort heeft twee manieren om stuk te zijn, en ze zijn allebei erg. Hij
// kan te weinig tegenhouden -- dan staat een tenant open die nog niet publiek
// hoort te zijn. En hij kan te veel tegenhouden: de webhook van Mollie, of de
// downloadlink van 365 dagen die al bij klanten in de mailbox ligt. Dat
// tweede merk je pas weken later, bij iemand die zijn rapport nog eens wil
// openen. Beide kanten staan hieronder.

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createTenantApp } from "../index.js";

const INLOG = {
  WWW_INTERNAL_EMAIL: "adviseur@example.nl",
  WWW_INTERNAL_PASSWORD: "een-wachtwoord-voor-de-test",
  WWW_INTERNAL_SESSION_SECRET: "s".repeat(48),
};

/** Een draaiende tenant; `toegang` zet de poort aan. */
async function tenant(t, { toegang = false, omgeving = {} } = {}) {
  const oud = { ...process.env };
  Object.assign(process.env, INLOG, omgeving);
  const app = createTenantApp({
    id: "testtenant",
    brand: { name: "Test" },
    ...(toegang ? { features: { toegang: true } } : {}),
  });
  const server = http.createServer(app);
  server.keepAliveTimeout = 1;
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
    for (const k of Object.keys({ ...INLOG, ...omgeving })) delete process.env[k];
    Object.assign(process.env, oud);
  });
  const basis = `http://127.0.0.1:${server.address().port}`;
  return {
    basis,
    haal: (pad, opties = {}) =>
      fetch(`${basis}${pad}`, { redirect: "manual", ...opties }),
    pagina: (pad, opties = {}) =>
      fetch(`${basis}${pad}`, { redirect: "manual", headers: { accept: "text/html", ...(opties.headers || {}) }, ...opties }),
  };
}

test("zonder de schakelaar verandert er niets", async (t) => {
  const s = await tenant(t);
  const res = await s.pagina("/full_start.html");
  assert.notEqual(res.status, 401);
  assert.notEqual(res.status, 302, "geen omleiding naar de login");
  const h = await (await s.haal("/health")).json();
  assert.equal(h.toegang, false);
});

test("met de schakelaar gaat een pagina naar de login", async (t) => {
  const s = await tenant(t, { toegang: true });
  const res = await s.pagina("/full_start.html");
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "/intern");
  const wortel = await s.pagina("/");
  assert.equal(wortel.status, 302);
});

test("een verzoek dat geen pagina vraagt krijgt een nette 401, geen omleiding", async (t) => {
  // Een formulier dat met fetch() praat heeft niets aan een 302 naar html.
  const s = await tenant(t, { toegang: true });
  const res = await s.haal("/api/full/lookup-address", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ postalcode: "5654PM", housenumber: "373" }),
  });
  assert.equal(res.status, 401);
  assert.equal((await res.json()).code, "toegang_vereist");
});

test("wat van buiten moet blijven werken, blijft werken", async (t) => {
  const s = await tenant(t, { toegang: true });

  // Toezicht.
  const h = await s.haal("/health");
  assert.equal(h.status, 200);
  assert.equal((await h.json()).toegang, true);

  // De inlogpagina zelf -- anders kom je er nooit in.
  assert.notEqual((await s.pagina("/intern")).status, 302);

  // Mollie meldt zich zonder cookie. Welk antwoord de webhook geeft doet er
  // hier niet toe; het mag alleen niet de poort zijn die hem tegenhoudt.
  const webhook = await s.haal("/api/full/webhook/mollie", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "tr_onbekend" }),
  });
  assert.notEqual(webhook.status, 401);

  // De downloadlink van 365 dagen. Een onbekende bestelling geeft 404 --
  // precies het punt: hij komt tot de route, niet tot de poort.
  const download = await s.pagina("/r/bestaatniet");
  assert.notEqual(download.status, 401);
  assert.notEqual(download.status, 302);

  // En de statusvraag die de afrondpagina stelt.
  assert.notEqual((await s.haal("/api/full/order/bestaatniet")).status, 401);
});

test("na inloggen gaat de poort open", async (t) => {
  const s = await tenant(t, { toegang: true });
  const inlog = await s.haal("/api/internal/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: INLOG.WWW_INTERNAL_EMAIL, password: INLOG.WWW_INTERNAL_PASSWORD }),
  });
  assert.equal(inlog.status, 200);
  const koek = (inlog.headers.get("set-cookie") || "").split(";")[0];
  assert.match(koek, /^wwwintern=/);

  const res = await s.pagina("/full_start.html", { headers: { accept: "text/html", cookie: koek } });
  assert.notEqual(res.status, 302, "met een geldige sessie geen omleiding meer");
  assert.notEqual(res.status, 401);
});

test("een verzonnen cookie opent niets", async (t) => {
  const s = await tenant(t, { toegang: true });
  const res = await s.pagina("/full_start.html", {
    headers: { accept: "text/html", cookie: "wwwintern=verzonnen.handtekening" },
  });
  assert.equal(res.status, 302);
});

test("zonder sessiegeheim staat de tenant dicht in plaats van open", async (t) => {
  // getInternalSecret() valt terug op een willekeurige sleutel, dus geen
  // enkele cookie verifieert. Dat is de goede kant om op te falen, maar het
  // moet wel een bewuste eigenschap zijn en geen toeval.
  const s = await tenant(t, { toegang: true, omgeving: { WWW_INTERNAL_SESSION_SECRET: "" } });
  assert.equal((await s.pagina("/full_start.html")).status, 302);
  const inlog = await s.haal("/api/internal/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: INLOG.WWW_INTERNAL_EMAIL, password: INLOG.WWW_INTERNAL_PASSWORD }),
  });
  const koek = (inlog.headers.get("set-cookie") || "").split(";")[0];
  const res = await s.pagina("/full_start.html", { headers: { accept: "text/html", cookie: koek } });
  assert.equal(res.status, 302, "ook met een verse cookie blijft hij dicht");
});
