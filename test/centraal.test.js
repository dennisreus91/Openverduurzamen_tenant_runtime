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
import { bestellingPayload, centraalAan, kiesTeMelden, meldBestelling } from "../lib/centraal.js";

// Zoals createOrder() hem werkelijk wegschrijft. Let op wat er NIET in staat:
// geen `download_url`. Dat veld bestaat alleen in buildOrderPublicView, en
// daar als relatief pad. De eerste versie van deze test zette het er wel in,
// en bevestigde daarmee een aanname die in productie niet opgaat.
const ORDER = {
  id: "ord_123",
  tenant_id: "deenergieraadgever",
  download_token: "geheimtoken",
  status: "mailed",
  email: "bewoner@example.com",
  amount_eur: 30,
  payment: { id: "tr_abc123", status: "paid" },
  address: { postalcode: "5654PM", housenumber: "373" },
  confirmed_data: { soort_woning: "tussenwoning" },
  source_meta: { source: "internal_full_start" },
};
const BASIS_AAN = { APP_BASE_URL: "https://deenergieraadgever.openverduurzamen.nl" };
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
        // Zoals de echte sinds 13 okt 2026: een bestelling begint altijd als
        // `aangemaakt`, elke andere status is een 400.
        if (json?.status && json.status !== "aangemaakt") {
          return antwoord(400, {
            fout: "ongeldige_invoer",
            fouten: { status: "alleen aangemaakt; verder via POST /api/v1/bestellingen/<id>/<actie>" },
          });
        }
        stand = vanaf || "aangemaakt";
        return antwoord(201, { id: 42, status: stand, bedrag: json?.bedrag, product: json?.product });
      }
      const m = req.url.match(/^\/api\/v1\/bestellingen\/(\d+)\/(.+)$/);
      if (!m) return antwoord(404, { fout: "niet_gevonden" });
      const actie = m[2];
      let gelukt = false;
      if (actie === "bevestig" && (stand === "aangemaakt" || stand === "betaald")) {
        stand = "betaald";
        gelukt = true;
      } else if (actie === "start-poging" && stand === "betaald") {
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
  const oud = process.env.APP_BASE_URL;
  process.env.APP_BASE_URL = BASIS_AAN.APP_BASE_URL;
  const p = bestellingPayload(ORDER, CONFIG);
  if (oud === undefined) delete process.env.APP_BASE_URL;
  else process.env.APP_BASE_URL = oud;
  assert.equal(p.bedrag, "30.00", "bedrag als tekst met twee decimalen");
  assert.equal(p.valuta, "EUR");
  assert.equal("status" in p, false, "de status mag bij het aanmaken alleen aangemaakt zijn");
  assert.equal(p.klant.email, "bewoner@example.com");
  assert.equal(p.mollie_payment_id, "tr_abc123");
  assert.equal(
    p.rapportlocatie,
    "https://deenergieraadgever.openverduurzamen.nl/r/ord_123?t=geheimtoken",
    "dezelfde link als in de mail, zelf opgebouwd",
  );
  assert.equal(p.invoer.order_id, "ord_123");
  // Agent en partner komen uit de sleutel, nooit uit de body.
  assert.equal("agent" in p, false);
  assert.equal("partner" in p, false);
});

test("een gratis rapport meldt een bedrag van nul, geen lege waarde", () => {
  const p = bestellingPayload({ ...ORDER, amount_eur: 0, payment: { id: null } }, CONFIG);
  assert.equal(p.bedrag, "0.00");
  assert.equal("status" in p, false);
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
    [
      "/api/v1/bestellingen",
      "/api/v1/bestellingen/42/bevestig",
      "/api/v1/bestellingen/42/start-poging",
      "/api/v1/bestellingen/42/lever",
    ],
  );
  assert.equal(g.stand(), "geleverd", "de bestelling staat daar ook werkelijk op geleverd");
  assert.match(g.ontvangen[0].auth, /^Bearer /);
});

test("een geweigerde overgang telt niet als opgeleverd, ook al is het een 200", async (t) => {
  // Dit is de regressie waar de eerste versie in liep: /<id>/<actie> antwoordt
  // 200 met gelukt:false als de stap niet mag. Wie naar de http-status kijkt,
  // boekt een levering die niet gebeurd is.
  const g = await nepGateway({ vanaf: "geannuleerd" });
  t.after(g.close);
  const uit = await metOmgeving(AAN(g.url), () => meldBestelling(ORDER, CONFIG));
  assert.equal(uit.gemeld, true, "de bestelling staat er wel in");
  assert.equal(uit.status_bijgewerkt, false);
  assert.equal(uit.geweigerd_bij, "bevestig");
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

// ── Wie er deze ronde aan de beurt is ────────────────────────────────────────

/** `n` bestellingen, nieuwste eerst, zoals listOrders ze teruggeeft. */
function bestellingen(n, overschrijf = () => ({})) {
  return Array.from({ length: n }, (_, i) => ({
    id: `ord_${String(n - i).padStart(4, "0")}`,
    status: "mailed",
    created_at: new Date(Date.UTC(2026, 0, 1) + (n - i) * 3600_000).toISOString(),
    ...overschrijf(i),
  }));
}

test("alleen opgeleverde bestellingen die er nog niet in staan", () => {
  const lijst = [
    { id: "a", status: "mailed", created_at: "2026-01-01T00:00:00Z" },
    { id: "b", status: "paid", created_at: "2026-01-02T00:00:00Z" },
    { id: "c", status: "mailed", created_at: "2026-01-03T00:00:00Z", centraal_gemeld_at: "2026-01-03T01:00:00Z" },
    null,
  ];
  assert.deepEqual(kiesTeMelden(lijst).map((o) => o.id), ["a"]);
});

test("een oude bestelling voorbij de nieuwste tweehonderd komt wél aan de beurt", () => {
  // Dit is de regressie: de ronde keek naar listOrders(200), dus bij meer dan
  // 200 bestellingen was een oude, nog niet gemelde onzichtbaar -- voorgoed.
  // Precies de bestellingen die bij het aanzetten van de koppeling moeten
  // worden ingehaald.
  const lijst = bestellingen(300, (i) => (i === 299 ? {} : { centraal_gemeld_at: "2026-02-01T00:00:00Z" }));
  const oudste = lijst[299];
  assert.equal(oudste.centraal_gemeld_at, undefined, "de oudste is de enige ongemelde");
  assert.deepEqual(kiesTeMelden(lijst).map((o) => o.id), [oudste.id]);
});

test("oudste eerst, en hoogstens een hap per ronde", () => {
  const gekozen = kiesTeMelden(bestellingen(60), 25);
  assert.equal(gekozen.length, 25, "niet alles in één ronde");
  assert.equal(gekozen[0].id, "ord_0001", "de oudste gaat voor");
  const tijden = gekozen.map((o) => o.created_at);
  assert.deepEqual(tijden, [...tijden].sort(), "oplopend in tijd");
});

test("geen lijst, geen ronde", () => {
  assert.deepEqual(kiesTeMelden(undefined), []);
  assert.deepEqual(kiesTeMelden(bestellingen(5), 0), []);
});

// ── De downloadlink ─────────────────────────────────────────────────────────

test("zonder APP_BASE_URL gaat er geen rapportlocatie mee", () => {
  const oud = process.env.APP_BASE_URL;
  delete process.env.APP_BASE_URL;
  try {
    assert.equal("rapportlocatie" in bestellingPayload(ORDER, CONFIG), false);
  } finally {
    if (oud !== undefined) process.env.APP_BASE_URL = oud;
  }
});

test("een http-basis gaat niet mee, want de gateway eist https", () => {
  // Weglaten is beter dan de hele bestelling laten stranden op een 400 om een
  // veld dat mag ontbreken. Dit raakt lokaal draaien, niet productie.
  const oud = process.env.APP_BASE_URL;
  process.env.APP_BASE_URL = "http://localhost:3000";
  try {
    assert.equal("rapportlocatie" in bestellingPayload(ORDER, CONFIG), false);
  } finally {
    if (oud === undefined) delete process.env.APP_BASE_URL;
    else process.env.APP_BASE_URL = oud;
  }
});

test("een order zonder token levert geen halve link op", () => {
  const oud = process.env.APP_BASE_URL;
  process.env.APP_BASE_URL = BASIS_AAN.APP_BASE_URL;
  try {
    const { download_token, ...zonder } = ORDER;
    assert.equal("rapportlocatie" in bestellingPayload(zonder, CONFIG), false);
  } finally {
    if (oud === undefined) delete process.env.APP_BASE_URL;
    else process.env.APP_BASE_URL = oud;
  }
});
