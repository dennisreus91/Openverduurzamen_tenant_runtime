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
async function tenant(t, { metPagina = true, toegang = true } = {}) {
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

test("een tenant zonder die pagina krijgt een nette melding, geen stacktrace", async (t) => {
  const haal = await tenant(t, { metPagina: false, toegang: false });
  const res = await haal("/privacyverklaring.html");
  assert.equal(res.status, 404);
  assert.match(await res.text(), /Privacyverklaring niet beschikbaar/);
});
