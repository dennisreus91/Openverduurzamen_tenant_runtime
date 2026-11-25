// test/scenarionaam.test.js
//
// De scenariokeuze in het downloadvenster leest de naam uit de zichtbare tekst van de
// scenariokaart (scenarioTekst in assets/contact_modal.js). De maatregellinks dragen een
// verborgen hint voor schermlezers, "(opent in een nieuw tabblad)". innerText neemt die
// mee, en live (WWW, 24-11-2026) stond hij in de keuzelijst. Deze test haalt de functie
// uit het bestand en voert hem uit op een kaarttekst zoals de browser hem geeft.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const bron = fs.readFileSync(new URL("../assets/contact_modal.js", import.meta.url), "utf8");

function haalFunctie(naam) {
  const start = bron.indexOf(`function ${naam}(`);
  assert.ok(start >= 0, `${naam} staat niet meer in contact_modal.js`);
  let diepte = 0;
  for (let i = bron.indexOf("{", start); i < bron.length; i++) {
    if (bron[i] === "{") diepte++;
    else if (bron[i] === "}" && --diepte === 0) return new Function(`${bron.slice(start, i + 1)}; return ${naam};`)();
  }
  throw new Error(`${naam}: geen einde gevonden`);
}

const scenarioTekst = haalFunctie("scenarioTekst");

test("de schermlezerhint van een maatregellink komt niet in de scenarionaam", () => {
  const kaart = {
    innerText: [
      "Scenario 1",
      "C → A",
      "NETTO INVESTERING",
      "€ 4.000",
      "MAATREGELEN",
      "Spouwmuur isoleren (opent in een nieuw tabblad)",
      "Ca. 8 zonnepanelen op het dak(opent in een nieuw tabblad)",
      "ISDE: indicatief € 900",
    ].join("\n"),
  };
  const naam = scenarioTekst(kaart);
  assert.doesNotMatch(naam, /tabblad/);
  assert.equal(naam, "Scenario 1 – C → A: spouwmuur isoleren + ca. 8 zonnepanelen (€ 4.000 netto)");
});

test("een kaart zonder links houdt zijn naam", () => {
  const naam = scenarioTekst({ innerText: "Scenario 2\nB → A\nINVESTERING\n€ 1.200\nMAATREGELEN\nHybride warmtepomp van 5 kW" });
  assert.equal(naam, "Scenario 2 – B → A: hybride warmtepomp (€ 1.200)");
});
