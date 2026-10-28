// test/een_tool.test.js
//
// `features.eenTool`: de tenant heeft EEN tool in plaats van twee ingangen.
//
// WAAROM DEZE SCHAKELAAR BESTAAT
// De interne flow had een eigen intakepagina (/intern/full_start.html) naast
// de publieke tool op /. Twee formulieren voor dezelfde woning, die uit
// elkaar liepen: de publieke kreeg de upload van een energielabel, het aantal
// zonnepanelen en de advertentie erbij, de interne niet. Een adviseur die de
// interne pagina gebruikte kreeg daardoor een ander rapport dan dezelfde
// woning via de publieke kant -- zonder dat iets dat meldde.
//
// Dit mag geen standaardgedrag worden -- een tenant die de schakelaar niet zet
// houdt de twee ingangen -- dus beide kanten staan hieronder.
//
// LET OP, 28 oktober 2026: hier stond "WoonWijzerWinkel houdt de oude
// indeling". Dat was achterhaald, en die regel heeft de fout helpen vasthouden:
// in de WWW-config ontbrak `eenTool`, een gastlogin kwam daardoor op het oude
// formulier uit, en dit commentaar leek te zeggen dat dat zo hoorde. Alle vier
// de tenants hebben de schakelaar nu aan.
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

async function tenant(t, features) {
  const oud = { ...process.env };
  Object.assign(process.env, INLOG);
  const server = http.createServer(
    createTenantApp({ id: "testtenant", brand: { name: "Test" }, ...(features ? { features } : {}) })
  );
  server.keepAliveTimeout = 1;
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
    for (const k of Object.keys(INLOG)) delete process.env[k];
    Object.assign(process.env, oud);
  });

  const basis = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${basis}/api/internal/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: INLOG.WWW_INTERNAL_EMAIL, password: INLOG.WWW_INTERNAL_PASSWORD }),
  });
  const json = await login.json();
  const cookie = (login.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]).join("; ");
  return {
    loginAntwoord: json,
    haal: (pad) => fetch(`${basis}${pad}`, { redirect: "manual", headers: { cookie, accept: "text/html" } }),
  };
}

test("met een tool komt de adviseur na het inloggen op de tool uit", async (t) => {
  const s = await tenant(t, { eenTool: true });
  assert.equal(s.loginAntwoord.redirect, "/");
  assert.equal((await s.haal("/intern")).headers.get("location"), "/");
  const oudeBladwijzer = await s.haal("/intern/full_start.html");
  assert.equal(oudeBladwijzer.status, 302, "geen 404 voor wie de oude pagina nog in zijn favorieten heeft");
  assert.equal(oudeBladwijzer.headers.get("location"), "/");
});

test("zonder de schakelaar blijft de interne intakepagina de werkplek", async (t) => {
  const s = await tenant(t);
  assert.equal(s.loginAntwoord.redirect, "/intern/full_start.html");
  assert.equal((await s.haal("/intern")).headers.get("location"), "/intern/full_start.html");
  assert.notEqual((await s.haal("/intern/full_start.html")).status, 302);
});


// ── Van buiten af te lezen ────────────────────────────────────────────────────
//
// WAAROM /health DEZE VLAGGEN NOEMT
// De fout bij de WoonWijzerWinkel was een week onzichtbaar omdat er niets was
// dat hem meldde: de pagina zag normaal uit, /health zweeg erover, en het
// verschil was alleen te merken via een inlog die je niet dagelijks doet. De
// sleutel staat in het Render-dashboard en de config in een andere repo, dus
// van buiten af nakijken is de enige controle die blijft werken.
test("/health noemt of de tenant een tool heeft en wat zijn dagplafond is", async (t) => {
  const s = await tenant(t, { eenTool: true, dagplafond: 100 });
  const d = await (await s.haal("/health")).json();
  assert.equal(d.een_tool, true);
  assert.equal(d.dagplafond, 100);
});

test("/health zegt ook wanneer er geen plafond is, in plaats van het veld weg te laten", async (t) => {
  // Een ontbrekend veld leest als "oude runtime"; null leest als "geen plafond".
  const s = await tenant(t);
  const d = await (await s.haal("/health")).json();
  assert.equal(d.een_tool, false);
  assert.ok("dagplafond" in d, "het veld hoort er te staan");
  assert.equal(d.dagplafond, null);
});
