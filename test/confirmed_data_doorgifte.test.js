// Regressietest voor de velden die naar het volledige rapport gaan.
//
// WAAROM DEZE TEST BESTAAT
// normalizeConfirmedDataInput is een handmatige witte lijst. Wat er niet in
// staat, valt weg -- en dat gebeurt stil: een ontbrekend veld betekent alleen
// dat de report-api zijn standaard gebruikt.
//
// Dat is hier een keer bijna misgegaan met het verduurzamingsdoel. De route
// van het snelle rapport geeft de body ongewijzigd door, dus daar kwam het
// doel wel aan. Het volledige rapport loopt via de orderflow en dus langs deze
// lijst. Zonder het veld erin kreeg dezelfde woning twee rapporten met andere
// pakketten: het snelle met de keuze van de klant, het volledige met de
// goedkoopste route. Precies het verschil dat we uit de rekenkern hebben
// gehaald, nu via het formulier weer binnen.
//
// Dezelfde les als test/brand_payload.test.js, een laag eerder.

import test from "node:test";
import assert from "node:assert/strict";
import { normalizeConfirmedDataInput } from "../index.js";

const VOLLEDIG = {
  soort_woning: "tussenwoning",
  build_year: 1985,
  floor_area_m2: 120,
  energy_label: "c",
  ventilation_type: "mechanisch",
  heating_supply: "cv_ketel",
  heat_distribution: "radiatoren_convectoren",
  existing_measures: ["dakisolatie", "zonnepanelen"],
  verduurzamingsdoel: "kortste_terugverdientijd",
};

test("elk veld uit het formulier komt door", () => {
  const uit = normalizeConfirmedDataInput(VOLLEDIG);
  for (const sleutel of Object.keys(VOLLEDIG)) {
    assert.ok(sleutel in uit, `${sleutel} valt weg op weg naar het volledige rapport`);
  }
  assert.equal(uit.verduurzamingsdoel, "kortste_terugverdientijd");
  assert.equal(uit.soort_woning, "tussenwoning");
  assert.deepEqual(uit.existing_measures, ["dakisolatie", "zonnepanelen"]);
});

test("zonder keuze blijft het veld weg, zodat de order niet verandert", () => {
  for (const leeg of [undefined, null, "", "   "]) {
    const { verduurzamingsdoel, ...rest } = VOLLEDIG;
    const uit = normalizeConfirmedDataInput(leeg === undefined ? rest : { ...rest, verduurzamingsdoel: leeg });
    assert.equal("verduurzamingsdoel" in uit, false, `${JSON.stringify(leeg)} voegde het veld toe`);
  }
});

test("onzin in het doelveld gaat er ongewijzigd door en wordt verderop genegeerd", () => {
  // De runtime keurt niet: de report-api heeft de lijst met toegestane
  // waarden (ALLOWED.verduurzamingsdoel) en negeert wat daar niet in staat.
  // Twee plekken die hetzelfde keuren lopen uit elkaar.
  const uit = normalizeConfirmedDataInput({ ...VOLLEDIG, verduurzamingsdoel: "iets_anders" });
  assert.equal(uit.verduurzamingsdoel, "iets_anders");
});

// Omgekeerd sinds 13 oktober 2026. Er is geen witte lijst meer: een veld dat
// de report-api erbij krijgt, bereikt het volledige rapport vanzelf. Kent hij
// het niet, dan geeft hij een 400 met een veldfout. Dat is het hele punt --
// een onbekend veld hoort op te vallen, niet te verdwijnen.
test("een onbekend veld gaat door; de report-api beslist erover", () => {
  const uit = normalizeConfirmedDataInput({ ...VOLLEDIG, een_veld_dat_niet_bestaat: "x" });
  assert.equal(uit.een_veld_dat_niet_bestaat, "x");
});

test("de invoer blijft begrensd: te veel velden en te lange waarden worden gekapt", () => {
  const veel = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`veld_${i}`, "x"]));
  assert.ok(Object.keys(normalizeConfirmedDataInput(veel)).length <= 40, "niet meer dan veertig velden");
  const lang = normalizeConfirmedDataInput({ soort_woning: "x".repeat(5000) });
  assert.equal(lang.soort_woning.length, 200);
});
