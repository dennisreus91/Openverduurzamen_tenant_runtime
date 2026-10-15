// test/dagplafond.test.js
//
// Hoeveel volledige rapporten mag een tenant op een dag intern maken?
//
// WAAROM DEZE TEST BESTAAT
// Er was al een maandteller, maar die TELT alleen -- getQuotaMax() wordt
// nergens vergeleken met de stand. Er was dus geen enkele grens: een script
// of een vastgelopen knop kon ongemerkt honderden rapporten aanvragen, en elk
// rapport kost geld (vijf betaalde adresaanroepen plus het taalmodel). Dat
// merk je pas als de rekening komt.
//
// Het plafond staat per dag en niet per maand, met opzet: een maandplafond
// laat een ontsporing drie weken doorlopen voordat iemand het merkt.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tenant-plafond-"));
process.env.ORDERS_DATA_DIR = DATA_DIR;

const INLOG = {
  WWW_INTERNAL_EMAIL: "adviseur@example.nl",
  WWW_INTERNAL_PASSWORD: "een-wachtwoord-voor-de-test",
  WWW_INTERNAL_SESSION_SECRET: "s".repeat(48),
};

const AANVRAAG = {
  email: "klant@example.nl",
  address: { postalcode: "5654PM", housenumber: "373" },
  confirmed_data: { soort_woning: "tussenwoning", build_year: 1969, floor_area_m2: 135, energy_label: "c" },
};

async function tenant(t, features) {
  Object.assign(process.env, INLOG);
  const { createTenantApp } = await import("../index.js");
  const server = http.createServer(
    createTenantApp({ id: "testtenant", brand: { name: "Test" }, ...(features ? { features } : {}) })
  );
  server.keepAliveTimeout = 1;
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  });

  const basis = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${basis}/api/internal/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: INLOG.WWW_INTERNAL_EMAIL, password: INLOG.WWW_INTERNAL_PASSWORD }),
  });
  const cookie = (login.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]).join("; ");
  return {
    render: () =>
      fetch(`${basis}/api/internal/full/render`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify(AANVRAAG),
      }),
    quota: () => fetch(`${basis}/api/internal/quota`, { headers: { cookie } }).then((r) => r.json()),
  };
}

test("met een plafond van twee is de derde aanvraag van die dag te veel", async (t) => {
  const s = await tenant(t, { dagplafond: 2 });
  assert.equal((await s.render()).status, 200, "de eerste gaat door");
  assert.equal((await s.render()).status, 200, "de tweede ook");

  const derde = await s.render();
  assert.equal(derde.status, 429);
  const uit = await derde.json();
  assert.equal(uit.code, "dagplafond_bereikt");
  assert.match(uit.error, /vandaag al 2 rapporten/);
});

test("de stand is op te vragen, anders is het plafond onzichtbaar", async (t) => {
  const s = await tenant(t, { dagplafond: 2 });
  const q = await s.quota();
  assert.equal(q.dagplafond, 2);
  assert.equal(q.dag_gebruik, 2, "de twee uit de vorige test staan er nog");
  assert.equal(q.dag_resterend, 0);
});

test("zonder plafond verandert er niets voor de tenants die er niet om vroegen", async (t) => {
  const s = await tenant(t);
  assert.equal((await s.render()).status, 200, "ook al staat de dagteller allang boven twee");
  const q = await s.quota();
  assert.equal(q.dagplafond, 0);
  assert.equal(q.dag_resterend, null);
});
