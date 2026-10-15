// test/centrale_rapportlink.test.js
//
// Het rapport komt van de report-api, en de link in de mail ook.
//
// WAAROM DEZE TESTS BESTAAN
// Deze tenant maakte zijn eigen pdf en bouwde zijn eigen downloadlink. Die
// link hangt aan de hostnaam van de tenant en sterft zodra die wordt
// opgeschort of hernoemd -- bij twee tenants is dat al gebeurd, en alle
// verstuurde links deden het daarna niet meer. De report-api is gedeeld en
// blijft staan, dus bewaart die voortaan het rapport en geeft er de link bij.
//
// De terugval is met opzet aanwezig: een oudere report-api of een sleutel
// zonder partnernaam stuurt die velden niet mee, en dan moet een betaalde
// bestelling gewoon doorlopen in plaats van blijven hangen op een
// configuratiefout.

import test from "node:test";
import assert from "node:assert/strict";
import { leesRenderAntwoord, kiesDownloadLink } from "../index.js";

// --- het antwoord van de report-api uitlezen --------------------------------

test("de pdf en de link komen mee uit het antwoord", () => {
  const uit = leesRenderAntwoord({
    html: "<html>rapport</html>",
    meta: { address_line: "Langekamp 9" },
    rapport_url: "https://report.example.nl/r/" + "a".repeat(64),
    pdf_base64: Buffer.from("%PDF-1.4 test").toString("base64"),
  });
  assert.equal(uit.html, "<html>rapport</html>");
  assert.equal(uit.meta.address_line, "Langekamp 9");
  assert.equal(uit.rapportUrl, "https://report.example.nl/r/" + "a".repeat(64));
  assert.equal(uit.pdfBytes.toString(), "%PDF-1.4 test");
});

test("een oudere report-api laat beide velden weg", () => {
  // Dan valt de verwerking terug op de eigen PDFBolt en de eigen link; de
  // bestelling loopt gewoon door.
  const uit = leesRenderAntwoord({ html_document: "<html>oud</html>" });
  assert.equal(uit.html, "<html>oud</html>");
  assert.equal(uit.rapportUrl, "");
  assert.equal(uit.pdfBytes, null);
});

test("een leeg of onzinnig antwoord levert geen half resultaat op", () => {
  for (const json of [null, undefined, {}, { pdf_base64: "" }, { rapport_url: 42 }]) {
    const uit = leesRenderAntwoord(json);
    assert.equal(uit.pdfBytes, null, JSON.stringify(json));
    assert.equal(uit.rapportUrl, "", JSON.stringify(json));
  }
});

// --- welke link in de mail komt ---------------------------------------------

const EIGEN = { basisUrl: "https://deenergieraadgever.openverduurzamen.nl", orderId: "ord_1", downloadToken: "tok1" };

test("de centrale link gaat voor op de eigen", () => {
  const centraal = "https://report.example.nl/r/" + "b".repeat(64);
  assert.equal(kiesDownloadLink({ ...EIGEN, rapportUrl: centraal }), centraal);
});

test("zonder centrale link de eigen, zodat de klant altijd iets krijgt", () => {
  assert.equal(
    kiesDownloadLink({ ...EIGEN, rapportUrl: "" }),
    "https://deenergieraadgever.openverduurzamen.nl/r/ord_1?t=tok1"
  );
});

test("een onbruikbare centrale link telt niet als link", () => {
  // Geen http en geen halve waarde: liever de eigen link dan een kapotte.
  for (const rommel of ["", "  ", null, 42, "http://onveilig.example.nl/r/x", "/r/relatief"]) {
    assert.equal(
      kiesDownloadLink({ ...EIGEN, rapportUrl: rommel }),
      "https://deenergieraadgever.openverduurzamen.nl/r/ord_1?t=tok1",
      JSON.stringify(rommel)
    );
  }
});

test("zonder beide blijft de link leeg in plaats van kapot", () => {
  // Het mailsjabloon laat het blok dan weg; een halve URL in een mail is
  // erger dan geen link.
  assert.equal(kiesDownloadLink({ rapportUrl: "", basisUrl: "", orderId: "ord_1", downloadToken: "tok1" }), "");
  assert.equal(kiesDownloadLink({ ...EIGEN, rapportUrl: "", downloadToken: "" }), "");
  assert.equal(kiesDownloadLink({ ...EIGEN, rapportUrl: "", orderId: "" }), "");
});

test("een slash te veel in de basis-URL levert geen dubbele slash op", () => {
  assert.equal(
    kiesDownloadLink({ ...EIGEN, basisUrl: "https://example.nl/", rapportUrl: "" }),
    "https://example.nl/r/ord_1?t=tok1"
  );
});
