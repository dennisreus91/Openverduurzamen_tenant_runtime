// test/privacyverklaring.test.js
//
// De pagina waar het toestemmingsvinkje naar verwijst.
//
// WAAROM DEZE TEST BESTAAT
// Het vinkje in het contactvenster zei "zie de privacyverklaring" en er stond
// geen link -- `contact.privacyUrl` was bij alle vier de tenants leeg. De
// bezoeker geeft daar naam, e-mailadres en telefoonnummer af, die met een
// partner gedeeld worden, onder een akkoord dat naar een document verwijst
// dat niet bestond. Gezien op 17 oktober 2026.
//
// Twee dingen moeten kloppen en ze worden allebei snel gebroken: de pagina
// moet er zijn, en hij moet ZONDER INLOG bereikbaar zijn. Dat tweede is het
// makkelijkst te vergeten: `features.toegang` zet de hele tenant op slot, en
// dan komt de link in het vinkje op een inlogscherm uit -- precies voor de
// bezoeker die nog moet beslissen of hij zijn gegevens afgeeft.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTenantApp } from "../index.js";

const INLOG = {
  WWW_INTERNAL_EMAIL: "adviseur@example.nl",
  WWW_INTERNAL_PASSWORD: "een-wachtwoord-voor-de-test",
  WWW_INTERNAL_SESSION_SECRET: "s".repeat(48),
};

/** Een tenant met een eigen publicDir, zodat we de sjablonen kunnen zetten. */
async function tenant(t, { metPagina = true, toegang = true, extraConfig = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tenant-privacy-"));
  fs.mkdirSync(path.join(dir, "templates"), { recursive: true });
  if (metPagina) {
    fs.writeFileSync(
      path.join(dir, "templates", "privacyverklaring.html"),
      "<!doctype html><html><body><h1>Privacyverklaring</h1><p>{{TENANT_NAME}}</p></body></html>"
    );
  }
  const oud = { ...process.env };
  Object.assign(process.env, INLOG);
  const server = http.createServer(
    createTenantApp({
      id: "testtenant",
      brand: { name: "Test" },
      publicDir: dir,
      ...(toegang ? { features: { toegang: true } } : {}),
      ...extraConfig,
    })
  );
  server.keepAliveTimeout = 1;
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
    for (const k of Object.keys(INLOG)) delete process.env[k];
    Object.assign(process.env, oud);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const basis = `http://127.0.0.1:${server.address().port}`;
  return (pad) => fetch(`${basis}${pad}`, { redirect: "manual", headers: { accept: "text/html" } });
}

test("de privacyverklaring is bereikbaar zonder inlog, ook met de poort dicht", async (t) => {
  const haal = await tenant(t, { toegang: true });
  // De tool zelf zit op slot...
  assert.equal((await haal("/")).status, 302, "de tool hoort achter de login te blijven");
  // ...maar de verklaring niet.
  const res = await haal("/privacyverklaring.html");
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Privacyverklaring/);
});

test("de algemene voorwaarden net zo: je leest ze vóór je akkoord geeft", async (t) => {
  const haal = await tenant(t, { toegang: true });
  assert.notEqual((await haal("/algemene-voorwaarden.html")).status, 302);
});

// --------------------------------------------------------------------------
// De gedeelde verklaring uit de runtime
//
// Tot 18 oktober 2026 gaf een tenant zonder eigen pagina hier een 404. Dat
// was precies het gat: geen van de vier tenants leverde die pagina mee, dus
// liep het vinkje "zie de privacyverklaring" bij allemaal dood. De runtime
// levert hem nu zelf, gevuld met de gegevens van de tenant.
// --------------------------------------------------------------------------

test("een tenant zonder eigen pagina krijgt die van de runtime, met zijn eigen gegevens", async (t) => {
  const haal = await tenant(t, {
    metPagina: false,
    toegang: false,
    extraConfig: {
      brand: { name: "Testmerk", legalName: "Testmerk B.V." },
      contact: { email: "hallo@testmerk.nl", phone: "085-1234567", address1: "Teststraat 1", address2: "1234 AB Teststad" },
    },
  });
  const res = await haal("/privacyverklaring.html");
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Testmerk B\.V\./, "de verwerkingsverantwoordelijke is de tenant zelf");
  assert.match(html, /Teststraat 1, 1234 AB Teststad/, "het adres komt uit contact.address1\\/2");
  assert.match(html, /hallo@testmerk\.nl/);
  assert.doesNotMatch(html, /\{\{/, "er mag geen onvervulde plaatshouder blijven staan");
});

test("zonder opvolgpartner belooft de verklaring geen doorgifte", async (t) => {
  const haal = await tenant(t, { metPagina: false, toegang: false });
  const html = await (await haal("/privacyverklaring.html")).text();
  assert.match(html, /niet naar een andere partij/, "de bezoeker hoort te lezen dat er niets doorgaat");
  assert.doesNotMatch(
    html,
    /<td>opvolging/,
    "zonder partner hoort er geen opvolgregel in de tabel met derden te staan"
  );
});

test("mét opvolgpartner staat die naam er, in de tabel en bij de grondslag", async (t) => {
  const haal = await tenant(t, {
    metPagina: false,
    toegang: false,
    extraConfig: { report: { adviesPartner: "WoonWijzerWinkel" } },
  });
  const html = await (await haal("/privacyverklaring.html")).text();
  assert.match(html, /<td>WoonWijzerWinkel<\/td>/, "de partner hoort in de tabel met derden");
  assert.match(html, /toestemming, die u altijd kunt intrekken/, "en de grondslag hoort erbij");
  assert.doesNotMatch(html, /niet naar een andere partij/);
});

test("een eigen pagina van de tenant gaat voor die van de runtime", async (t) => {
  const haal = await tenant(t, { metPagina: true, toegang: false });
  const html = await (await haal("/privacyverklaring.html")).text();
  assert.doesNotMatch(html, /Autoriteit Persoonsgegevens/, "dit hoort de eigen, korte pagina te zijn");
});

test("het toestemmingsvinkje krijgt vanzelf een link naar die pagina", async (t) => {
  const haal = await tenant(t, { metPagina: false, toegang: false });
  const body = await (await haal("/api/tenant")).json();
  assert.equal(body.lead.privacyUrl, "/privacyverklaring.html");
});

test("een tenant met een eigen url op zijn website houdt die", async (t) => {
  const haal = await tenant(t, {
    metPagina: false,
    toegang: false,
    extraConfig: { contact: { privacyUrl: "https://voorbeeld.nl/privacy" } },
  });
  const body = await (await haal("/api/tenant")).json();
  assert.equal(body.lead.privacyUrl, "https://voorbeeld.nl/privacy");
});
