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
  const mail = adviesAanvraagMail({ config: DER, firstName: "Jan", lastName: "Jansen", adres: "Horst 36 22, 8225NP Lelystad", akkoord: true });
  assert.equal(mail.to, "dennisreus91@gmail.com");
  assert.match(mail.subject, /vrijblijvend advies/i);
  assert.match(mail.subject, /Horst 36 22/);
  assert.match(mail.intro, /WoonWijzerWinkel/);
  assert.match(mail.intro, /De Energie Raadgever/);
});

test("zonder adviceRequest kent de tenant deze aanvraag niet", () => {
  assert.equal(adviesAanvraagMail({ config: { id: "woonwijzerwinkel" }, firstName: "a", lastName: "b", akkoord: true }), null);
  assert.equal(adviesAanvraagMail({ config: { adviceRequest: { recipient: "  " } }, akkoord: true }), null);
});

test("het losse rapport verbergt knoppen en de mobiele weergave", () => {
  const html = losRapportHtml({ adres: "Horst 36 22", rapportHtml: '<div class="mid-grid">x</div>', tenantNaam: "De Energie Raadgever" });
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /#pdfRapport .mid-report .mid-mobile-stack\{display:none!important\}/);
  assert.match(html, /\.mid-footer-cta,\.contactCta,\.rapportActies\{display:none!important\}/);
  assert.match(html, /<div class="mid-grid">x<\/div>/);
  assert.match(html, /De Energie Raadgever · Horst 36 22/);
  assert.doesNotMatch(losRapportHtml({ adres: "<script>", rapportHtml: "" }), /<script>/);
});

// --- De pdf staat liggend, en de tabel blijft staan ------------------------
//
// WAAROM DIT EEN TEST VERDIENT (21 oktober 2026)
// Staand A4 houdt bij 10 mm marge ~718 CSS-pixels over, en het rapport zelf
// schakelt onder 768 naar de gestapelde telefoonweergave (mid_renderer.js).
// De pdf toonde daardoor drie maatregelen onder elkaar in plaats van de
// vergelijkingstabel. Ronald Krijgsman zag dat bij het downloaden en vroeg om
// "één A4 in landschap, naast elkaar".
//
// De breedte alleen is niet genoeg: we weten niet met welke viewportbreedte
// PDFBolt de media query beoordeelt, en die media query komt NA ons blok
// binnen (hij zit in de meegestuurde rapport-html). Bij gelijke specificiteit
// wint de laatste, dus zonder de id-selector zou de telefoonweergave alsnog
// winnen. Deze test bewaakt allebei.

test("de pdf is liggend en dwingt de vergelijkingstabel af", () => {
  const html = losRapportHtml({ adres: "Horst 36 22", rapportHtml: "<div>x</div>" });

  assert.match(html, /@page\{size:A4 landscape/, "liggend, anders valt het rapport terug op de telefoonweergave");

  // De id-selector is het punt: zonder `#pdfRapport` ervoor weegt onze regel
  // even zwaar als die uit de media query, en dan beslist de volgorde.
  assert.match(html, /#pdfRapport \.mid-report \.mid-grid\{display:grid!important\}/);
  assert.match(html, /<div id="pdfRapport"><div>x<\/div><\/div>/);
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
    akkoord: true,
  });
  assert.match(mail.subject, /^Volledig rapport aangevraagd/);
  assert.equal(mail.heading, "Volledig rapport aangevraagd");
  assert.match(mail.intro, /volledige verduurzamingsrapport aangevraagd/);
  assert.match(mail.intro, /toestemming gegeven om het met .* door te spreken/);
  assert.doesNotMatch(mail.intro, /vrijblijvend advies/);
});

test("zonder die waarde blijft het de adviesaanvraag die het was", () => {
  for (const soort of [undefined, "", "advies"]) {
    const mail = adviesAanvraagMail({ config: DER, firstName: "Test", lastName: "Bewoner", adres: "X", akkoord: true, ...(soort === undefined ? {} : { soort }) });
    assert.match(mail.subject, /^Aanvraag vrijblijvend advies/, JSON.stringify(soort));
    assert.match(mail.intro, /vrijblijvend advies aan bij/);
  }
});

// --- Geen toestemming, geen partnermail -----------------------------------
//
// WAAROM DIT ERBIJ KWAM (18 oktober 2026)
// Het toestemmingsvinkje onder het snelle rapport was `required`: je kon het
// volledige rapport niet aanvragen zonder akkoord te gaan met doorgifte aan de
// partner. Dat is geen vrije toestemming, en de privacyverklaring beloofde het
// tegendeel ("opvolging -- alleen als u daar toestemming voor geeft").
//
// Het vinkje is nu optioneel. Daarmee verschuift het risico naar deze functie:
// zonder toestemming mogen naam, e-mailadres, telefoonnummer, adres en het
// rapport NIET naar de opvolgpartner. Het rapport voor de bezoeker hangt hier
// niet aan -- dat loopt via /api/internal/full/render.

test("zonder toestemming gaat er niets naar de partner", () => {
  for (const akkoord of [undefined, false, null, "true", 1]) {
    assert.equal(
      adviesAanvraagMail({
        config: DER,
        firstName: "Test",
        lastName: "Bewoner",
        adres: "Horst 36 22, 8225NP Lelystad",
        soort: "volledig_rapport",
        ...(akkoord === undefined ? {} : { akkoord }),
      }),
      null,
      `akkoord=${JSON.stringify(akkoord)} hoort geen partnermail op te leveren`
    );
  }
});

test("alleen een echte true telt, geen waarheidsachtige waarde", () => {
  // De standaard is met opzet NIET true: een permissieve standaardwaarde op
  // een toestemmingsvlag is precies hoe dit de eerste keer misging.
  assert.equal(adviesAanvraagMail({ config: DER, adres: "X" }), null, "zonder akkoord geen mail");
  assert.ok(adviesAanvraagMail({ config: DER, adres: "X", akkoord: true }), "met akkoord wel");
});
