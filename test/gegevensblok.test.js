// test/gegevensblok.test.js
//
// Het machineleesbare blok onder de mails aan een partner.
//
// WAAROM DEZE TEST BESTAAT
// Deze tests houden geen opmaak mooi. Ze staan er omdat de WoonWijzerWinkel deze mails met een
// CRM-import leest: verandert een veldnaam of de volgorde, dan valt die import stil zonder dat
// wij iets zien. Breekt een test hieronder, dan is dat geen test die bijgesteld moet worden maar
// een wijziging die eerst bij de partner gemeld moet worden.
//
// Dezelfde afspraken staan in de centrale dienst (tests/test_leads.py in ai_adviseur_centraal).
// Beide kanten moeten hetzelfde blok opleveren, anders krijgt de partner alsnog twee formaten.

import test from "node:test";
import assert from "node:assert/strict";
import { EINDE, START, VELDEN, gegevensblok } from "../lib/gegevensblok.js";
import { bouwBestelMelding, bouwLeadMail } from "../lib/mail_client.js";

const LEAD = {
  firstName: "Jan",
  lastName: "Jansen",
  email: "jan@voorbeeld.nl",
  phone: "0612345678",
  adres: "Langekamp 9, 3848DX Harderwijk",
  message: "Graag contact.",
  sourcePage: "/verduurzamingsadvies",
  config: {
    id: "woonwijzerwinkel",
    brand: { name: "WoonWijzerWinkel" },
    mail: { fromAddress: "Test <no-reply@openverduurzamen.nl>" },
    contact: { email: "info@tenant.nl" },
    product: { name: "Volledig Verduurzamingsinzicht" },
  },
};

const ORDER = {
  id: "OV-2026-0042",
  email: "jan@voorbeeld.nl",
  amount_eur: 30,
  address: { postalcode: "3848DX", housenumber: "9" },
  source_meta: { source: "website" },
  created_at: "2026-10-28T09:12:00.000Z",
};

function metOmgeving(vars, fn) {
  const oud = {};
  for (const [k, v] of Object.entries(vars)) {
    oud[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(oud)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** De velden uit het blok, in de volgorde waarin ze erin staan. */
function blok(tekst) {
  assert.equal(tekst.split(START).length, 2, "precies één keer een beginregel");
  assert.equal(tekst.split(EINDE).length, 2, "precies één keer een eindregel");
  const regels = tekst.split(START)[1].split(EINDE)[0].trim().split("\n");
  return regels.map((r) => {
    const i = r.indexOf(":");
    return [r.slice(0, i), r.slice(i + 1).trim()];
  });
}

test("de velden staan er altijd, in een vaste volgorde", () => {
  const rijen = blok(gegevensblok({ Soort: "lead" }));
  assert.deepEqual(rijen.map(([k]) => k), VELDEN);
});

test("een leeg veld blijft staan, zodat een parser niets hoeft op te vangen", () => {
  const rijen = Object.fromEntries(blok(gegevensblok({ Soort: "lead", Naam: "Jan" })));
  assert.equal(rijen.Telefoon, "");
  assert.equal(rijen.Adres, "");
  assert.equal(Object.keys(rijen).length, VELDEN.length);
});

test("een waarde met een regeleinde trekt het blok niet open", () => {
  const rijen = Object.fromEntries(blok(gegevensblok({ Naam: "Jan\nJansen", Adres: "Langekamp 9\n3848DX" })));
  assert.equal(Object.keys(rijen).length, VELDEN.length);
  assert.equal(rijen.Naam, "Jan Jansen");
  assert.equal(rijen.Adres, "Langekamp 9 3848DX");
});

test("een waarde die op de eindregel lijkt breekt het blok niet af", () => {
  // Zonder deze grens kan een bezoeker met een adres als "--- EINDE GEGEVENS ---" de parser
  // laten stoppen voordat hij alles heeft gelezen.
  const tekst = gegevensblok({ Naam: `x ${EINDE} y` });
  assert.equal(tekst.split(EINDE).length, 2);
});

// ── De leadmail ───────────────────────────────────────────────────────────────
test("de leadmail krijgt een tekstversie met het blok", () => {
  const m = metOmgeving({ LEAD_EMAIL: "crm@woonwijzerwinkel.nl" }, () => bouwLeadMail(LEAD));
  const rijen = Object.fromEntries(blok(m.text));
  assert.equal(rijen.Soort, "lead");
  assert.equal(rijen.Naam, "Jan Jansen");
  assert.equal(rijen["E-mail"], "jan@voorbeeld.nl");
  assert.equal(rijen.Telefoon, "0612345678");
  assert.equal(rijen.Adres, "Langekamp 9, 3848DX Harderwijk");
  assert.equal(rijen.Partner, "woonwijzerwinkel");
  assert.equal(rijen.Bron, "/verduurzamingsadvies");
  assert.match(rijen.Aangemaakt, /^\d{4}-\d{2}-\d{2}T/);
});

test("de opgemaakte versie blijft erbij: de lezer krijgt niet de tekstversie te zien", () => {
  const m = metOmgeving({ LEAD_EMAIL: "crm@woonwijzerwinkel.nl" }, () => bouwLeadMail(LEAD));
  assert.match(m.html, /Nieuwe contactaanvraag/);
  assert.match(m.html, /Jan/);
});

test("zonder naam blijft het veld leeg in plaats van (naam onbekend)", () => {
  // "(naam onbekend)" is een mededeling aan de lezer. Een CRM dat dat als naam opslaat heeft een
  // klant die zo heet.
  const m = metOmgeving({ LEAD_EMAIL: "crm@woonwijzerwinkel.nl" }, () =>
    bouwLeadMail({ ...LEAD, firstName: "", lastName: "" }));
  assert.equal(Object.fromEntries(blok(m.text)).Naam, "");
  assert.match(m.subject, /naam onbekend/, "in het onderwerp mag die mededeling wel staan");
});

test("de leadmail uit deze runtime heeft geen nummer: matchen gaat op e-mailadres", () => {
  // De lead krijgt zijn nummer van de centrale dienst, en dat melden gebeurt ná het mailen zodat
  // een storing daar de bezoeker niet laat wachten. Het veld hoort dan leeg te zijn en niet
  // gevuld met iets wat op een nummer lijkt.
  const m = metOmgeving({ LEAD_EMAIL: "crm@woonwijzerwinkel.nl" }, () => bouwLeadMail(LEAD));
  assert.equal(Object.fromEntries(blok(m.text)).Nummer, "");
});

// ── De bestelmelding ──────────────────────────────────────────────────────────
test("de bestelmelding is opt-in", () => {
  metOmgeving({ BESTEL_MELDING_EMAIL: undefined }, () => {
    assert.throws(() => bouwBestelMelding({ order: ORDER, config: LEAD.config }), /BESTEL_MELDING_EMAIL/);
  });
});

test("de bestelmelding draagt hetzelfde blok, met een eigen voorvoegsel", () => {
  const m = metOmgeving({ BESTEL_MELDING_EMAIL: "crm@woonwijzerwinkel.nl" }, () =>
    bouwBestelMelding({ order: ORDER, config: LEAD.config }));
  assert.deepEqual(m.to, ["crm@woonwijzerwinkel.nl"]);
  const rijen = Object.fromEntries(blok(m.text));
  assert.deepEqual(Object.keys(rijen), VELDEN, "zelfde velden als bij een lead");
  assert.equal(rijen.Soort, "bestelling");
  assert.equal(rijen.Nummer, "B-OV-2026-0042");
  assert.equal(rijen["E-mail"], "jan@voorbeeld.nl");
  assert.equal(rijen.Adres, "3848DX 9");
  assert.equal(rijen.Partner, "woonwijzerwinkel");
  assert.equal(rijen.Aangemaakt, "2026-10-28T09:12:00.000Z");
});

test("een bestelling heeft geen naam en geen telefoonnummer, en doet dus niet alsof", () => {
  const m = metOmgeving({ BESTEL_MELDING_EMAIL: "crm@woonwijzerwinkel.nl" }, () =>
    bouwBestelMelding({ order: ORDER, config: LEAD.config }));
  const rijen = Object.fromEntries(blok(m.text));
  assert.equal(rijen.Naam, "");
  assert.equal(rijen.Telefoon, "");
});

test("de bestelmelding bevat geen rapport en geen downloadlink", () => {
  // Deze mail gaat over wie er besteld heeft, niet over wat er in het rapport staat. Wie meeleest
  // met de rapporten houdt daarvoor de BCC op de klantmail.
  const m = metOmgeving({ BESTEL_MELDING_EMAIL: "crm@woonwijzerwinkel.nl" }, () =>
    bouwBestelMelding({ order: { ...ORDER, download_token: "geheim", download_path: "/x.pdf" }, config: LEAD.config }));
  assert.equal(m.attachments, undefined);
  assert.ok(!/\/r\//.test(m.html) && !/geheim/.test(m.html), "geen downloadlink in de mail");
  assert.ok(!/geheim/.test(m.text));
});

test("de bestelmelding gaat niet in BCC mee met wie de rapportmail leest", () => {
  // Anders krijgt dezelfde lezer twee mails per bestelling, en is niet te zien welke de melding is.
  const m = metOmgeving(
    { BESTEL_MELDING_EMAIL: "crm@woonwijzerwinkel.nl", MAIL_BCC_ADDRESSES: "eigenaar@openverduurzamen.nl" },
    () => bouwBestelMelding({ order: ORDER, config: LEAD.config }),
  );
  assert.equal(m.bcc, undefined);
});

test("meerdere ontvangers, komma-gescheiden", () => {
  const m = metOmgeving({ BESTEL_MELDING_EMAIL: "a@www.nl, b@www.nl" }, () =>
    bouwBestelMelding({ order: ORDER, config: LEAD.config }));
  assert.deepEqual(m.to, ["a@www.nl", "b@www.nl"]);
});

test("een bedrag van nul wordt niet weggelaten maar als nul getoond", () => {
  // Bij een tenant die achteraf factureert is EUR 0,00 de waarheid; een lege regel leest als
  // "onbekend".
  const m = metOmgeving({ BESTEL_MELDING_EMAIL: "crm@woonwijzerwinkel.nl" }, () =>
    bouwBestelMelding({ order: { ...ORDER, amount_eur: 0 }, config: LEAD.config }));
  assert.match(m.html, /EUR 0,00/);
});
