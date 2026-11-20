// test/rapport_wensen.test.js
//
// De vragen bij de download van het snelle rapport en de aanvraag van het volledige
// (feedback WoonWijzerWinkel, 20 november 2026): expertgesprek, offertes,
// voorkeursscenario en aanvullende vragen. Zie lib/rapport_wensen.js.
//
// Wat hier vastligt:
// - een tenant zonder `features.rapportVragen` merkt er niets van;
// - de antwoorden staan bovenaan de leadmail en gaan mee naar de centrale database;
// - ja op het gesprek of op offertes is de toestemming, twee keer nee niet -- en dan gaat
//   er, net als bij een niet aangezet vinkje, geen mail naar de partner.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createTenantApp } from "../index.js";
import { bouwLeadMail } from "../lib/mail_client.js";
import { leadPayload } from "../lib/centraal.js";
import {
  leesRapportWensen,
  ontbrekendeWensen,
  toestemmingUitWensen,
  toestemmingsTekstUitWensen,
  rapportVragen,
} from "../lib/rapport_wensen.js";

const CONFIG = { id: "testtenant", brand: { name: "WoonWijzerWinkel" }, contact: { email: "info@tenant.nl" } };

test("antwoorden worden opgeschoond; onbekend is niet hetzelfde als nee", () => {
  assert.equal(leesRapportWensen(null), null);
  assert.equal(leesRapportWensen({}), null);
  assert.deepEqual(leesRapportWensen({ expertGesprek: "ja", offertes: "nee", scenario: "  Naar label A  " }), {
    expertGesprek: true, offertes: false, scenario: "Naar label A",
  });
  const half = leesRapportWensen({ expertGesprek: "misschien", scenario: "Geen voorkeur" });
  assert.equal(half.expertGesprek, null);
  assert.deepEqual(ontbrekendeWensen(half), ["gesprek met een expert", "offertes"]);
  assert.equal(leesRapportWensen({ scenario: "x".repeat(500) }).scenario.length, 200);
});

test("ja op gesprek of offertes is toestemming, met de vraag als tekst", () => {
  const nee = leesRapportWensen({ expertGesprek: "nee", offertes: "nee", scenario: "Geen voorkeur" });
  assert.equal(toestemmingUitWensen(nee), false);
  assert.equal(toestemmingsTekstUitWensen(nee, CONFIG), "");

  const offertes = leesRapportWensen({ expertGesprek: "nee", offertes: "ja", scenario: "Geen voorkeur" });
  assert.equal(toestemmingUitWensen(offertes), true);
  assert.equal(toestemmingsTekstUitWensen(offertes, CONFIG), rapportVragen(CONFIG).offertes + " Ja.");
  assert.match(rapportVragen(CONFIG).expertGesprek, /expert van WoonWijzerWinkel/);
});

test("de leadmail zet de wensen bovenaan, en hernoemt de opmerkingen", () => {
  process.env.LEAD_EMAIL = "crm@tenant.nl";
  const wensen = leesRapportWensen({ expertGesprek: "ja", offertes: "nee", scenario: "Naar label A – Dakisolatie" });
  const mail = bouwLeadMail({
    firstName: "Jan", lastName: "Jansen", email: "jan@voorbeeld.nl", phone: "0612345678",
    message: "Kan het in het voorjaar?", sourcePage: "snel_rapport_download", config: CONFIG, wensen,
  });
  assert.match(mail.html, /Wensen van de klant/);
  assert.match(mail.html, /Rapport doornemen met een expert<\/td><td[^>]*>Ja</);
  assert.match(mail.html, /Direct offertes<\/td><td[^>]*>Nee</);
  assert.match(mail.html, /Naar label A – Dakisolatie/);
  assert.match(mail.html, /Aanvullende vragen of opmerkingen/);
  assert.ok(mail.html.indexOf("Wensen van de klant") < mail.html.indexOf("Kan het in het voorjaar?"));

  // Zonder wensen blijft de mail zoals hij was.
  const gewoon = bouwLeadMail({
    firstName: "Jan", lastName: "Jansen", email: "jan@voorbeeld.nl", phone: "0612345678",
    message: "Hallo", sourcePage: "contact", config: CONFIG,
  });
  assert.doesNotMatch(gewoon.html, /Wensen van de klant/);
  assert.match(gewoon.html, />Opmerkingen</);
  delete process.env.LEAD_EMAIL;
});

test("de centrale database krijgt de wensen in `extra`", () => {
  const wensen = leesRapportWensen({ expertGesprek: "nee", offertes: "ja", scenario: "Geen voorkeur" });
  const p = leadPayload({ email: "jan@voorbeeld.nl", wensen }, CONFIG);
  assert.deepEqual(p.extra.wensen, { expert_gesprek: false, offertes: true, scenario: "Geen voorkeur" });
  assert.equal(leadPayload({ email: "jan@voorbeeld.nl" }, CONFIG).extra, undefined);
});

// ── De route ────────────────────────────────────────────────────────────────

async function tenant(t, features) {
  const app = createTenantApp({ ...CONFIG, features });
  const server = http.createServer(app);
  server.keepAliveTimeout = 1;
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  });
  const basis = `http://127.0.0.1:${server.address().port}`;
  return {
    haal: (pad) => fetch(basis + pad),
    post: (pad, body) => fetch(basis + pad, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }),
  };
}

const AANVRAAG = {
  firstName: "Jan", lastName: "Jansen", email: "jan@voorbeeld.nl", phone: "0612345678",
  sourcePage: "snel_rapport_download",
};

test("/api/tenant geeft de vragen alleen als de tenant ze aanzet", async (t) => {
  const uit = await tenant(t, {});
  assert.equal((await (await uit.haal("/api/tenant")).json()).rapportVragen, false);
  const aan = await tenant(t, { rapportVragen: true, gegevensPoort: "bij_download" });
  const d = await (await aan.haal("/api/tenant")).json();
  assert.equal(d.gegevensPoort, "bij_download");
  assert.match(d.rapportVragen.expertGesprek, /WoonWijzerWinkel/);
  assert.equal(d.rapportVragen.geenVoorkeur, "Geen voorkeur");
});

test("twee keer nee: rapport gaat door, maar er gaat geen mail naar de partner", async (t) => {
  const oud = process.env.RESEND_API_KEY;
  delete process.env.RESEND_API_KEY;
  t.after(() => { if (oud !== undefined) process.env.RESEND_API_KEY = oud; });
  const aan = await tenant(t, { rapportVragen: true, gegevensPoort: "bij_download" });
  // Een los vinkje op true telt niet meer als de vragen er zijn: de antwoorden beslissen.
  const r = await aan.post("/api/lead", {
    ...AANVRAAG, akkoord: true, wensen: { expertGesprek: "nee", offertes: "nee", scenario: "Geen voorkeur" },
  });
  assert.equal(r.status, 200, "zonder mail hoort de route gewoon te slagen");
  // En de poortcookie staat er, zodat het volledige rapport daarna aangevraagd kan worden.
  assert.match((r.headers.getSetCookie?.() || []).join("; "), /=/);
});

test("ja op offertes: de route probeert te mailen", async (t) => {
  const oud = process.env.RESEND_API_KEY;
  delete process.env.RESEND_API_KEY;
  t.after(() => { if (oud !== undefined) process.env.RESEND_API_KEY = oud; });
  const echteError = console.error;
  console.error = () => {};
  t.after(() => { console.error = echteError; });
  const aan = await tenant(t, { rapportVragen: true, gegevensPoort: "bij_download" });
  const r = await aan.post("/api/lead", {
    ...AANVRAAG, akkoord: false, wensen: { expertGesprek: "nee", offertes: "ja", scenario: "Geen voorkeur" },
  });
  // Zonder RESEND_API_KEY strandt het mailen: het bewijs dat er gemaild werd.
  assert.equal(r.status, 500);
});

test("zonder de vragen aan worden meegestuurde wensen genegeerd", async (t) => {
  const oud = process.env.RESEND_API_KEY;
  delete process.env.RESEND_API_KEY;
  t.after(() => { if (oud !== undefined) process.env.RESEND_API_KEY = oud; });
  const uit = await tenant(t, { gegevensPoort: "bij_download" });
  const r = await uit.post("/api/lead", {
    ...AANVRAAG, akkoord: false, wensen: { expertGesprek: "ja", offertes: "ja", scenario: "x" },
  });
  assert.equal(r.status, 200, "het vinkje beslist, en dat stond uit");
});
