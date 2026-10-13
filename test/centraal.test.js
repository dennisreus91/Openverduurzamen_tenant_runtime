// test/centraal.test.js
//
// Het melden van een opgeleverde bestelling bij de centrale database.
//
// WAAROM DEZE TEST BESTAAT, EN WAAROM HIJ ER ANDERS UITZIET DAN EERST
// Dit is een koppeling met een dienst die hier niet draait. De eerste versie
// van deze test bootste een gateway na die ik zelf verzonnen had, en die deed
// braaf wat mijn code verwachtte: aanmaken, dan leveren. De echte dienst heeft
// een toestandsmachine (gateway/store.py, bestelactie): `lever` mag alleen
// vanuit `in_behandeling`, en een geweigerde stap antwoordt 200 met
// {"gelukt": false}. Mijn code zou dus hebben gemeld dat er geleverd was
// terwijl de bestelling op `aangemaakt` bleef staan -- en de test zou groen
// zijn gebleven, want hij toetste mijn aanname tegen mijn aanname.
//
// De nepgateway hieronder volgt daarom het contract van de echte: statussen,
// overgangen en de vorm van de antwoorden.

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

/**
 * Een nepgateway met de toestandsmachine van de echte.
 * `vanaf` zet de stand waarin een nieuwe bestelling terechtkomt, zodat een
 * test ook de geweigerde overgang kan uitlokken.
 */
async function nepGateway({ vanaf = null } = {}) {
  const ontvangen = [];
  let stand = null;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const json = body ? JSON.parse(body) : null;
      ontvangen.push({ pad: req.url, auth: req.headers.authorization, body: json });
      const antwoord = (code, data) => {
        res.writeHead(code, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
      };
      if (req.url === "/api/v1/bestellingen") {
        stand = vanaf || json?.status || "aangemaakt";
        return antwoord(201, { id: 42, status: stand, bedrag: json?.bedrag, product: json?.product });
      }
      const m = req.url.match(/^\/api\/v1\/bestellingen\/(\d+)\/(.+)$/);
      if (!m) return antwoord(404, { fout: "niet_gevonden" });
      const actie = m[2];
      let gelukt = false;
      if (actie === "start-poging" && stand === "betaald") {
        stand = "in_behandeling";
        gelukt = true;
      } else if (actie === "lever" && stand === "in_behandeling") {
        stand = "geleverd";
        gelukt = true;
      }
      return antwoord(200, { gelukt, bestelling: { id: 42, status: stand } });
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, ontvangen, stand: () => stand, close: () => new Promise((r) => server.close(r)) };
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

const AAN = (url) => ({ CENTRAAL_API_URL: url, CENTRAAL_API_SLEUTEL: "x".repeat(40) });

test("zonder url of sleutel doet de koppeling niets", () => {
  delete process.env.CENTRAAL_API_URL;
  delete process.env.CENTRAAL_API_SLEUTEL;
  assert.equal(centraalAan(), false);
});

test("de verzoekvorm volgt het contract van de agent-API", () => {
  const p = bestellingPayload(ORDER, CONFIG);
  assert.equal(p.bedrag, "30.00", "bedrag als tekst met twee decimalen");
  assert.equal(p.valuta, "EUR");
  assert.equal(p.status, "betaald", "we melden pas na de oplevering");
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
  assert.equal(p.status, "betaald", "ook een gratis rapport wacht nergens meer op");
  assert.equal("mollie_payment_id" in p, false, "geen Mollie-id bij een gratis rapport");
});

test("een Mollie-id dat de gateway toch zou afwijzen gaat niet mee", () => {
  // De gateway weigert de HELE bestelling met een 400 op een id dat niet aan
  // zijn patroon voldoet. Dat is een slechte ruil voor een veld dat mag
  // ontbreken.
  const p = bestellingPayload({ ...ORDER, payment: { id: "pay_123" } }, CONFIG);
  assert.equal("mollie_payment_id" in p, false);
});

test("een geslaagde melding loopt de hele route na en levert echt op", async (t) => {
  const g = await nepGateway();
  t.after(g.close);
  const uit = await metOmgeving(AAN(g.url), () => meldBestelling(ORDER, CONFIG));
  assert.equal(uit.gemeld, true);
  assert.equal(uit.id, 42);
  assert.equal(uit.status_bijgewerkt, true);
  assert.deepEqual(
    g.ontvangen.map((o) => o.pad),
    ["/api/v1/bestellingen", "/api/v1/bestellingen/42/start-poging", "/api/v1/bestellingen/42/lever"],
  );
  assert.equal(g.stand(), "geleverd", "de bestelling staat daar ook werkelijk op geleverd");
  assert.match(g.ontvangen[0].auth, /^Bearer /);
});

test("een geweigerde overgang telt niet als opgeleverd, ook al is het een 200", async (t) => {
  // Dit is de regressie waar de eerste versie in liep: /<id>/<actie> antwoordt
  // 200 met gelukt:false als de stap niet mag. Wie naar de http-status kijkt,
  // boekt een levering die niet gebeurd is.
  const g = await nepGateway({ vanaf: "aangemaakt" });
  t.after(g.close);
  const uit = await metOmgeving(AAN(g.url), () => meldBestelling(ORDER, CONFIG));
  assert.equal(uit.gemeld, true, "de bestelling staat er wel in");
  assert.equal(uit.status_bijgewerkt, false);
  assert.equal(uit.geweigerd_bij, "start-poging");
  assert.notEqual(g.stand(), "geleverd");
});

test("stond hij er al als geleverd, dan blijft het bij één aanroep", async (t) => {
  const g = await nepGateway({ vanaf: "geleverd" });
  t.after(g.close);
  const uit = await metOmgeving(AAN(g.url), () => meldBestelling(ORDER, CONFIG));
  assert.equal(uit.gemeld, true);
  assert.equal(uit.status_bijgewerkt, true);
  assert.equal(g.ontvangen.length, 1, "geen overbodige stappen op een afgeronde bestelling");
});

test("een afwijzing geeft de veldfouten terug, zodat de eerste poging zichzelf documenteert", async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ fout: "ongeldige_invoer", fouten: { status: "een van: aangemaakt, betaald" } }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  const uit = await metOmgeving(AAN(`http://127.0.0.1:${server.address().port}`), () =>
    meldBestelling(ORDER, CONFIG),
  );
  assert.equal(uit.gemeld, false);
  assert.equal(uit.reden, "aanmaken_400");
  assert.match(JSON.stringify(uit.fouten), /een van/);
});

test("een onbereikbare centrale dienst gooit niet, maar meldt zich netjes", async () => {
  const uit = await metOmgeving(AAN("http://127.0.0.1:1"), () => meldBestelling(ORDER, CONFIG));
  assert.equal(uit.gemeld, false);
  assert.ok(["onbereikbaar", "timeout"].includes(uit.reden), uit.reden);
});
