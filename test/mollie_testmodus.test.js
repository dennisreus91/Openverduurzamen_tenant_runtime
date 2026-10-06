// test/mollie_testmodus.test.js
//
// De keuze tussen de live- en de testsleutel van Mollie.
//
// WAAROM DEZE TEST BESTAAT
// Een tenant die per ongeluk in testmodus staat, levert betaalde rapporten uit
// zonder dat er geld binnenkomt -- en dat merk je pas aan het eind van de
// maand. Daarom mag de testsleutel nooit vanzelf gekozen worden omdat hij
// toevallig gezet is: er is een eigen schakelaar voor, en die kan alleen uit
// de omgeving komen, nooit uit een request.
//
// Andersom net zo belangrijk: staat de schakelaar aan met een live-sleutel,
// dan moet het stoppen in plaats van echte betalingen aan te maken terwijl
// iedereen denkt te testen.

import test from "node:test";
import assert from "node:assert/strict";
import { createMolliePayment, mollieTestmodus } from "../lib/mollie_client.js";

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

// createMolliePayment() kiest de sleutel vóór het netwerk; een fout in de
// sleutelkeuze komt er dus uit zonder dat er een aanroep naar Mollie gaat.
// Een geldige combinatie faalt verderop op het netwerk, en dat onderscheid is
// precies wat deze tests lezen.
async function sleutelfout() {
  try {
    await createMolliePayment({ amountEur: 30, description: "t", redirectUrl: "https://x", webhookUrl: "https://x" });
    return null;
  } catch (e) {
    return String(e?.message || e);
  }
}

test("zonder schakelaar blijft de live-sleutel gelden, ook als er een testsleutel staat", async () => {
  const fout = await metOmgeving(
    { MOLLIE_TESTMODE: undefined, MOLLIE_API_KEY: undefined, MOLLIE_API_KEY_TEST: "test_abc123" },
    sleutelfout
  );
  assert.match(String(fout), /MOLLIE_API_KEY ontbreekt/, "een gezette testsleutel mag niets overnemen");
  assert.equal(metOmgeving({ MOLLIE_TESTMODE: undefined }, mollieTestmodus), false);
});

test("met de schakelaar aan is de testsleutel verplicht", async () => {
  const fout = await metOmgeving(
    { MOLLIE_TESTMODE: "1", MOLLIE_API_KEY: "live_echt", MOLLIE_API_KEY_TEST: undefined },
    sleutelfout
  );
  assert.match(String(fout), /MOLLIE_API_KEY_TEST ontbreekt/, "niet stilletjes terugvallen op de live-sleutel");
});

test("een live-sleutel in het testveld wordt geweigerd", async () => {
  const fout = await metOmgeving(
    { MOLLIE_TESTMODE: "1", MOLLIE_API_KEY: "live_echt", MOLLIE_API_KEY_TEST: "live_perongeluk" },
    sleutelfout
  );
  assert.match(String(fout), /geen testsleutel/, "anders komen er echte betalingen terwijl iedereen denkt te testen");
});

test("de schakelaar staat alleen aan bij exact 1", () => {
  for (const waarde of ["1", " 1 "]) {
    assert.equal(metOmgeving({ MOLLIE_TESTMODE: waarde }, mollieTestmodus), true, `${JSON.stringify(waarde)} hoort aan te zetten`);
  }
  for (const waarde of [undefined, "", "0", "true", "ja", "test"]) {
    assert.equal(
      metOmgeving({ MOLLIE_TESTMODE: waarde }, mollieTestmodus),
      false,
      `${JSON.stringify(waarde)} mag de testmodus niet aanzetten`
    );
  }
});
