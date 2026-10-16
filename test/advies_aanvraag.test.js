// Aanvraag voor vrijblijvend advies vanuit het snelle rapport.
//
// De Energie Raadgever stuurt de aanvraag met het snelle rapport naar een
// partner (WoonWijzerWinkel) op een vast adres uit de tenantconfig, niet naar
// LEAD_EMAIL. Een tenant zonder adviceRequest mag hier niets van merken.

import test from "node:test";
import assert from "node:assert/strict";
import { adviesAanvraagMail, losRapportHtml } from "../lib/advies_aanvraag.js";

const DER = {
  id: "deenergieraadgever",
  brand: { name: "De Energie Raadgever" },
  adviceRequest: { recipient: "dennisreus91@gmail.com", partnerName: "WoonWijzerWinkel" },
};

test("de aanvraag gaat naar het vaste adres van de partner", () => {
  const mail = adviesAanvraagMail({ config: DER, firstName: "Jan", lastName: "Jansen", adres: "Horst 36 22, 8225NP Lelystad" });
  assert.equal(mail.to, "dennisreus91@gmail.com");
  assert.match(mail.subject, /vrijblijvend advies/i);
  assert.match(mail.subject, /Horst 36 22/);
  assert.match(mail.intro, /WoonWijzerWinkel/);
  assert.match(mail.intro, /De Energie Raadgever/);
});

test("zonder adviceRequest kent de tenant deze aanvraag niet", () => {
  assert.equal(adviesAanvraagMail({ config: { id: "woonwijzerwinkel" }, firstName: "a", lastName: "b" }), null);
  assert.equal(adviesAanvraagMail({ config: { adviceRequest: { recipient: "  " } } }), null);
});

test("het losse rapport verbergt knoppen en de mobiele weergave", () => {
  const html = losRapportHtml({ adres: "Horst 36 22", rapportHtml: '<div class="mid-grid">x</div>', tenantNaam: "De Energie Raadgever" });
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /mid-mobile-stack,.mid-footer-cta/);
  assert.match(html, /<div class="mid-grid">x<\/div>/);
  assert.match(html, /De Energie Raadgever · Horst 36 22/);
  assert.doesNotMatch(losRapportHtml({ adres: "<script>", rapportHtml: "" }), /<script>/);
});

// --- Wat er gevraagd is, staat in de mail ----------------------------------
//
// WAAROM DIT ERBIJ KWAM (16 oktober 2026)
// De OpenVerduurzamen-tool vraagt onder het snelle rapport het VOLLEDIGE
// rapport aan, met toestemming om het met de partner door te spreken. Die
// aanvraag ging als "Aanvraag vrijblijvend advies" de deur uit -- onwaar
// tegenover de partij die opvolgt, want die belt dan over een adviesgesprek
// terwijl de klant op een rapport wacht. Gezien bij de eerste proefaanvraag.

test("een aanvraag voor het volledige rapport heet ook zo", () => {
  const mail = adviesAanvraagMail({
    config: DER,
    firstName: "Test",
    lastName: "Bewoner",
    adres: "Parkweg 72 G, 2271AM Voorburg",
    soort: "volledig_rapport",
  });
  assert.match(mail.subject, /^Volledig rapport aangevraagd/);
  assert.equal(mail.heading, "Volledig rapport aangevraagd");
  assert.match(mail.intro, /volledige verduurzamingsrapport aangevraagd/);
  assert.match(mail.intro, /toestemming gegeven om het met .* door te spreken/);
  assert.doesNotMatch(mail.intro, /vrijblijvend advies/);
});

test("zonder die waarde blijft het de adviesaanvraag die het was", () => {
  for (const soort of [undefined, "", "advies"]) {
    const mail = adviesAanvraagMail({ config: DER, firstName: "Test", lastName: "Bewoner", adres: "X", ...(soort === undefined ? {} : { soort }) });
    assert.match(mail.subject, /^Aanvraag vrijblijvend advies/, JSON.stringify(soort));
    assert.match(mail.intro, /vrijblijvend advies aan bij/);
  }
});
