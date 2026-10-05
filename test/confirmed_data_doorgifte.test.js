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

test("een formulier zonder doel levert een leeg veld, geen gegokte waarde", () => {
  const { verduurzamingsdoel, ...zonderDoel } = VOLLEDIG;
  const uit = normalizeConfirmedDataInput(zonderDoel);
  assert.equal(uit.verduurzamingsdoel, "", "leeg, en de report-api negeert dat");
});

test("onzin in het doelveld gaat er ongewijzigd door en wordt verderop genegeerd", () => {
  // De runtime keurt niet: de report-api heeft de lijst met toegestane
  // waarden (ALLOWED.verduurzamingsdoel) en negeert wat daar niet in staat.
  // Twee plekken die hetzelfde keuren lopen uit elkaar.
  const uit = normalizeConfirmedDataInput({ ...VOLLEDIG, verduurzamingsdoel: "iets_anders" });
  assert.equal(uit.verduurzamingsdoel, "iets_anders");
});

test("de witte lijst laat onbekende velden wel vallen", () => {
  const uit = normalizeConfirmedDataInput({ ...VOLLEDIG, een_veld_dat_niet_bestaat: "x" });
  assert.equal("een_veld_dat_niet_bestaat" in uit, false);
});
