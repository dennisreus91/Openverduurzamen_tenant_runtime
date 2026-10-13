// test/centraal.test.js
//
// Het melden van een opgeleverde bestelling bij de centrale database.
//
// WAAROM DEZE TEST BESTAAT
// Dit is een koppeling met een dienst die hier niet draait, en die op
// 13 oktober 2026 twee dagen oud was. Wat we zelf in de hand hebben is de
// vorm van het verzoek en het gedrag bij een storing -- en juist dat laatste
// moet kloppen: de administratie mag de keten nooit raken.

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { bestellingPayload, centraalAan, meldBestelling } from "../lib/centraal.js";

const ORDER = {
  id: "ord_123",
  email: "bewoner@example.com",
  amount_eur: 30,
  payment: { id: "tr_abc123" },
  download_url: "https://deenergieraadgever.openverduurzamen.nl/r/ord_123?t=geheim",
  address: { postalcode: "5654PM", housenumber: "373" },
  confirmed_data: { soort_woning: "tussenwoning" },
  source_meta: { source: "internal_full_start" },
};
const CONFIG = { id: "deenergieraadgever" };

/** Een nepgateway die vastlegt wat er binnenkwam. */
async function nepGateway(handler) {
  const ontvangen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      ontvangen.push({ pad: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
      handler(req, res, ontvangen.length);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, ontvangen, close: () => new Promise((r) => server.close(r)) };
}

function metOmgeving(waarden, fn) {
  const oud = { ...process.env };
  Object.assign(process.env, waarden);
  return (async () => {
    try {
      return await fn();
    } finally {
      for (const k of Object.keys(waarden)) delete process.env[k];
      Object.assign(process.env, oud);
    }
  })();
}

test("zonder url of sleutel doet de koppeling niets", () => {
  delete process.env.CENTRAAL_API_URL;
  delete process.env.CENTRAAL_API_SLEUTEL;
  assert.equal(centraalAan(), false);
});

test("de verzoekvorm volgt het contract van de agent-API", () => {
  const p = bestellingPayload(ORDER, CONFIG);
  assert.equal(p.bedrag, "30.00", "bedrag als tekst met twee decimalen");
  assert.equal(p.valuta, "EUR");
  assert.equal(p.klant.email, "bewoner@example.com");
  assert.equal(p.mollie_payment_id, "tr_abc123");
  assert.match(p.rapportlocatie, /^https:\/\//, "een verwijzing, geen bestand");
  assert.equal(p.invoer.order_id, "ord_123");
  // Agent en partner komen uit de sleutel, nooit uit de body.
  assert.equal("agent" in p, false);
  assert.equal("partner" in p, false);
});

test("een gratis rapport meldt een bedrag van nul, geen lege waarde", () => {
  const p = bestellingPayload({ ...ORDER, amount_eur: 0, payment: { id: null } }, CONFIG);
  assert.equal(p.bedrag, "0.00");
  assert.equal("mollie_payment_id" in p, false, "geen Mollie-id bij een gratis rapport");
});

test("een geslaagde melding stuurt de sleutel mee en levert daarna op", async (t) => {
  const g = await nepGateway((req, res, n) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(n === 1 ? { id: 42 } : { ok: true }));
  });
  t.after(g.close);
  const uit = await metOmgeving({ CENTRAAL_API_URL: g.url, CENTRAAL_API_SLEUTEL: "x".repeat(40) }, () =>
    meldBestelling(ORDER, CONFIG),
  );
  assert.equal(uit.gemeld, true);
  assert.equal(uit.id, 42);
  assert.equal(uit.status_bijgewerkt, true);
  assert.deepEqual(g.ontvangen.map((o) => o.pad), ["/api/v1/bestellingen", "/api/v1/bestellingen/42/lever"]);
  assert.match(g.ontvangen[0].auth, /^Bearer /);
});

test("een afwijzing geeft de veldfouten terug, zodat de eerste poging zichzelf documenteert", async (t) => {
  const g = await nepGateway((req, res) => {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ fouten: { status: "een van: aangemaakt, betaald, geleverd" } }));
  });
  t.after(g.close);
  const uit = await metOmgeving({ CENTRAAL_API_URL: g.url, CENTRAAL_API_SLEUTEL: "x".repeat(40) }, () =>
    meldBestelling(ORDER, CONFIG),
  );
  assert.equal(uit.gemeld, false);
  assert.equal(uit.reden, "aanmaken_400");
  assert.match(JSON.stringify(uit.fouten), /een van/);
});

test("een onbereikbare gateway gooit niet, maar meldt zich netjes", async () => {
  const uit = await metOmgeving(
    { CENTRAAL_API_URL: "http://127.0.0.1:1", CENTRAAL_API_SLEUTEL: "x".repeat(40) },
    () => meldBestelling(ORDER, CONFIG),
  );
  assert.equal(uit.gemeld, false);
  assert.ok(["onbereikbaar", "timeout"].includes(uit.reden), uit.reden);
});

test("blijft de levering hangen, dan staat de bestelling er wel in", async (t) => {
  const g = await nepGateway((req, res, n) => {
    if (n === 1) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: 7 }));
      return;
    }
    res.writeHead(409, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ fout: "statusovergang_geweigerd" }));
  });
  t.after(g.close);
  const uit = await metOmgeving({ CENTRAAL_API_URL: g.url, CENTRAAL_API_SLEUTEL: "x".repeat(40) }, () =>
    meldBestelling(ORDER, CONFIG),
  );
  assert.equal(uit.gemeld, true, "de bestelling is geregistreerd");
  assert.equal(uit.status_bijgewerkt, false, "alleen de status bleef achter");
});
