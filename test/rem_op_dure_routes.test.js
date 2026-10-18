// test/rem_op_dure_routes.test.js
//
// De rem op de routes die geld kosten, en het adres waarop die rem telt.
//
// WAAROM DEZE TEST ER TOE DOET
// Een tenant zonder `features.toegang` laat /api/mid/lookup en /api/mid/stream
// voor iedereen open. De sleutel naar de report-api zit in de tenant, dus wie
// die routes aanroept betaalt niet zelf: een adreslookup is vijf betaalde
// Altum-aanroepen. Er stond nergens een grens.
//
// En een grens is niets waard als de afzender zelf mag zeggen wie hij is. De
// runtime stond op `trust proxy: true` en las bovendien de EERSTE waarde uit
// X-Forwarded-For -- die zet de client. Eén headerregel en je had bij elk
// verzoek een "nieuw" adres. Dat raakte niet alleen deze rem maar ook de rem
// op het raden van het adviseurswachtwoord.
//
// Daarom staat hieronder niet alleen "de rem telt", maar vooral: "de rem telt
// het adres dat Render heeft gezien, en niet wat de client erover beweert".
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tenant-rem-"));
process.env.ORDERS_DATA_DIR = DATA_DIR;
const { createTenantApp } = await import("../index.js");

const INLOG = {
  WWW_INTERNAL_EMAIL: "adviseur@example.nl",
  WWW_INTERNAL_PASSWORD: "een-wachtwoord-voor-de-test",
  WWW_INTERNAL_SESSION_SECRET: "s".repeat(48),
};

const ADRES = { postalcode: "2625ZD", housenumber: "9" };

async function tenant(t, { env = {}, features } = {}) {
  const oud = { ...process.env };
  Object.assign(process.env, INLOG, env);
  const app = createTenantApp({ id: "testtenant", brand: { name: "Test" }, ...(features ? { features } : {}) });
  const s = http.createServer(app);
  s.keepAliveTimeout = 1;
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  t.after(async () => {
    s.closeAllConnections?.();
    await new Promise((r) => s.close(r));
    for (const k of Object.keys({ ...INLOG, ...env })) delete process.env[k];
    Object.assign(process.env, oud);
  });

  const basis = `http://127.0.0.1:${s.address().port}`;
  return {
    basis,
    /**
     * Een adreslookup.
     *
     * `gezien` is het adres dat Render aan X-Forwarded-For toevoegt (de
     * laatste waarde, en de enige die we vertrouwen). `beweert` is wat de
     * client er zelf voorzet.
     */
    lookup: ({ gezien = "198.51.100.7", beweert = null, cookie = "" } = {}) =>
      fetch(`${basis}/api/mid/lookup`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": beweert ? `${beweert}, ${gezien}` : gezien,
          ...(cookie ? { cookie } : {}),
        },
        body: JSON.stringify(ADRES),
      }),
    inloggen: async () => {
      const res = await fetch(`${basis}/api/internal/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: INLOG.WWW_INTERNAL_EMAIL, password: INLOG.WWW_INTERNAL_PASSWORD }),
      });
      return (res.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]).join("; ");
    },
  };
}

/** Hoeveel aanroepen er doorkomen voordat de rem erop gaat. */
async function telTotDeRem(doe, hoogstens = 12) {
  let door = 0;
  for (let i = 0; i < hoogstens; i++) {
    const res = await doe();
    if (res.status === 429) return { door, gestopt: true, laatste: res };
    door += 1;
  }
  return { door, gestopt: false, laatste: null };
}

test("na het afgesproken aantal gaat de rem erop", async (t) => {
  const s = await tenant(t, { env: { TENANT_DURE_AANROEPEN_PER_UUR: "3" } });
  const uit = await telTotDeRem(() => s.lookup());
  assert.equal(uit.gestopt, true, "de rem hoort erop te gaan");
  assert.equal(uit.door, 3);
  const body = await uit.laatste.json();
  assert.equal(body.code, "te_veel_aanvragen");
  assert.ok(uit.laatste.headers.get("retry-after"), "zegt erbij hoe lang");
});

test("een ander adres telt apart", async (t) => {
  const s = await tenant(t, { env: { TENANT_DURE_AANROEPEN_PER_UUR: "2" } });
  await s.lookup({ gezien: "203.0.113.1" });
  await s.lookup({ gezien: "203.0.113.1" });
  assert.equal((await s.lookup({ gezien: "203.0.113.1" })).status, 429);
  assert.notEqual((await s.lookup({ gezien: "203.0.113.2" })).status, 429, "de buurman heeft er niets mee te maken");
});

test("op X-Forwarded-For valt niet te tellen, en daarom doen we dat ook niet", async (t) => {
  // Deze test legt een BEPERKING vast, geen eigenschap.
  //
  // Met twee proxies ervoor (Cloudflare + Render) wijst req.ip naar de
  // eerste waarde uit X-Forwarded-For, en die zet de client zelf. Wie hem
  // bij elk verzoek verandert, loopt om de rem heen. Precies daarom is
  // CF-Connecting-IP de bron zodra er een Cloudflare voor staat -- en achter
  // Render staat die er altijd. Hier staat dat de terugval het alleen niet
  // redt; de test hieronder staat dat de echte weg het wel doet.
  const s = await tenant(t, { env: { TENANT_DURE_AANROEPEN_PER_UUR: "3" } });
  let nummer = 0;
  const uit = await telTotDeRem(() => s.lookup({ gezien: "198.51.100.9", beweert: `10.0.0.${++nummer}` }));
  assert.equal(uit.gestopt, false, "zonder CF-Connecting-IP houdt de rem niets tegen");
});

test("wie is ingelogd heeft er geen last van", async (t) => {
  // Een adviseur die tien woningen achter elkaar doorrekent hoort geen rem
  // tegen te komen; het gaat om de aanroeper zonder formulier en zonder
  // account.
  const s = await tenant(t, { env: { TENANT_DURE_AANROEPEN_PER_UUR: "2" } });
  const cookie = await s.inloggen();
  assert.ok(cookie, "ingelogd");
  for (let i = 0; i < 5; i++) {
    assert.notEqual((await s.lookup({ gezien: "198.51.100.44", cookie })).status, 429);
  }
});

test("op nul staat de rem uit", async (t) => {
  const s = await tenant(t, { env: { TENANT_DURE_AANROEPEN_PER_UUR: "0" } });
  const uit = await telTotDeRem(() => s.lookup({ gezien: "198.51.100.55" }), 8);
  assert.equal(uit.gestopt, false);
});

test("achter Cloudflare telt CF-Connecting-IP, en niet wat de client zegt", async (t) => {
  // Hier ging het twee keer mis, allebei stil. Render zet Cloudflare voor
  // elke dienst, dus X-Forwarded-For heeft meerdere waarden: de eerste zet
  // de client (te verzinnen) en de laatste is een adres van de edge (dat
  // verspringt per verzoek). Geen van beide is bruikbaar als sleutel.
  // Cloudflare schrijft CF-Connecting-IP zelf en overschrijft wat de client
  // erin zet; dat is het enige adres dat klopt én vastligt.
  const s = await tenant(t, { env: { TENANT_DURE_AANROEPEN_PER_UUR: "3" } });
  const doe = (echt, verzonnen) =>
    fetch(`${s.basis}/api/mid/lookup`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": echt,
        "x-forwarded-for": `${verzonnen}, 172.70.1.${Math.floor(Math.random() * 200) + 1}`,
      },
      body: JSON.stringify(ADRES),
    });

  let n = 0;
  const uit = await telTotDeRem(() => doe("203.0.113.77", `10.0.0.${++n}`));
  assert.equal(uit.gestopt, true, "dezelfde bezoeker hoort geremd te worden");
  assert.equal(uit.door, 3);

  assert.notEqual((await doe("203.0.113.78", "10.0.0.1")).status, 429, "een andere bezoeker niet");
});

test("de bron van het afzenderadres is af te lezen op /health", async (t) => {
  // Zonder dit is niet te zien welke weg de telling neemt, en dat is precies
  // hoe de twee vorige fouten onopgemerkt bleven. De NAAM van de bron, nooit
  // het adres: /health is openbaar.
  const s = await tenant(t);
  const zonder = await (await fetch(`${s.basis}/health`)).json();
  assert.equal(zonder.afzender_bron, "req.ip");

  const met = await (await fetch(`${s.basis}/health`, { headers: { "cf-connecting-ip": "203.0.113.5" } })).json();
  assert.equal(met.afzender_bron, "cf-connecting-ip");
  assert.equal(JSON.stringify(met).includes("203.0.113.5"), false, "geen IP-adres in een openbaar antwoord");
});

test("de rem zit op elke dure route, niet alleen op de lookup", async (t) => {
  const s = await tenant(t, { env: { TENANT_DURE_AANROEPEN_PER_UUR: "1" } });
  const paden = ["/api/mid/lookup", "/api/full/lookup-address", "/api/mid/stream", "/api/epa/ingest", "/api/label-pdf/ingest"];
  for (const pad of paden) {
    const doe = () =>
      fetch(`${s.basis}${pad}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": `192.0.2.1, 198.51.100.${paden.indexOf(pad) + 100}` },
        body: JSON.stringify(ADRES),
      });
    await doe();
    assert.equal((await doe()).status, 429, `${pad} hoort geremd te worden`);
  }
});
