// test/opname_correcties.test.js
//
// De adviseur corrigeert op het scherm een waarde die wij verkeerd uit zijn
// .epa lazen (besluit Dennis, 23 oktober 2026). Die correctie moet in ALLE
// rapporten landen, niet alleen in het snelle.
//
// WAAROM EEN LEESCONTROLE EN GEEN KLIKTEST
// Het snelle rapport gaat door /api/mid/stream, die het hele verzoek
// doorgeeft: daar komt de correctie vanzelf mee. Het volledige rapport loopt
// anders -- dat wordt later gerenderd, uit een BEWAARDE bestelling. Vergeet
// één van de vier plekken waar een bestelling ontstaat de correcties op te
// slaan, dan zag de adviseur op het scherm 2,80 en staat er in zijn PDF 3,49.
// Dat is precies het soort verschil dat niemand meldt en iedereen gelooft.
//
// Deze test kijkt daarom naar alle plekken tegelijk, en niet naar één pad.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WORTEL = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const INDEX = fs.readFileSync(path.join(WORTEL, "index.js"), "utf-8");

/** De blokken waarmee een bestelling wordt aangemaakt. */
function bestellingBlokken() {
  const blokken = [];
  const naald = "createOrder({";
  for (let i = INDEX.indexOf(naald); i >= 0; i = INDEX.indexOf(naald, i + 1)) {
    // Tot de eerste regel die alleen uit `});` bestaat: dat is het einde van
    // het object dat erin gaat.
    const staart = INDEX.slice(i, i + 4000);
    const eind = staart.search(/\n\s{4}\}\);/);
    blokken.push(staart.slice(0, eind > 0 ? eind : 4000));
  }
  return blokken;
}

test("elke bestelling bewaart de correcties van de adviseur", () => {
  const blokken = bestellingBlokken();
  assert.ok(blokken.length >= 3, `verwacht minstens drie plekken waar een bestelling ontstaat, gevonden ${blokken.length}`);
  for (const blok of blokken) {
    assert.match(
      blok,
      /opname_correcties:/,
      "een bestelling wordt hier aangemaakt zonder de correcties van de adviseur:\n" +
        blok.slice(0, 400) +
        "\n\nDan rekent het volledige rapport met onze oorspronkelijke uitlezing, " +
        "terwijl de adviseur op het scherm zijn eigen waarde zag staan."
    );
  }
});

test("het volledige rapport krijgt ze mee naar de report-api", () => {
  const i = INDEX.indexOf("if (order.epa_model) reqBody.epa_model = order.epa_model;");
  assert.ok(i > 0, "de plek waar het .epa-model meegaat is niet gevonden");
  const venster = INDEX.slice(i, i + 700);
  assert.match(venster, /reqBody\.opname_correcties = order\.opname_correcties/);
});

test("de vormcontrole laat alleen eenvoudige paden en waarden door", () => {
  // De inhoudelijke controle hoort in de report-api (lib/epa_correcties.js):
  // die weet welke velden bestaan en binnen welke grenzen. Hier wordt alleen
  // bewaakt dat er geen diepe objecten of eindeloze sleutels doorheen gaan.
  const i = INDEX.indexOf("function leesOpnameCorrecties(");
  assert.ok(i > 0, "leesOpnameCorrecties() ontbreekt");
  const fn = INDEX.slice(i, i + 900);
  assert.match(fn, /Array\.isArray\(bron\)/, "een array is geen tabel met correcties");
  assert.match(fn, /slice\(0, 80\)/, "er hoort een bovengrens op het aantal velden te staan");
  assert.match(fn, /\.test\(pad\)/, "de sleutel hoort op vorm gecontroleerd te worden");
});

test("het pad-patroon laat de echte velden toe en gewone onzin niet", () => {
  // Hetzelfde patroon als in index.js; verandert dat daar, dan hoort deze
  // test mee te veranderen -- en dat is het punt.
  const patroon = /^[a-z_]+(\.[a-z0-9_]+){1,3}$/i;
  for (const pad of [
    "schil.roof.rc",
    "schil.windows.u",
    "installations.heat_distribution",
    "official.beng2_primary_fossil_kwh_m2",
    "building.build_year",
  ]) {
    assert.ok(patroon.test(pad), `${pad} hoort door de vormcontrole te komen`);
  }
  for (const pad of ["schil", "../etc/passwd", "schil.roof.rc.diep.te.diep", "schil..rc", ""]) {
    assert.ok(!patroon.test(pad), `${pad} hoort geweigerd te worden`);
  }
});
