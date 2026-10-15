// test/pdf_bestandsnaam.test.js
//
// Het rapport in de mail heet naar het adres.
//
// WAAROM DEZE TEST BESTAAT
// De bijlage heette `<ordernummer>-<productnaam>.pdf`, bijvoorbeeld
// "ord_8f2c1a-volledig-verduurzamingsrapport.pdf". Een ordernummer zegt de
// bewoner niets, en wie twee woningen laat doorrekenen houdt twee bestanden
// over die hij niet uit elkaar kan houden. De WoonWijzerWinkel-adviseur
// noemde zijn pdf al naar het adres; dit trekt de ingangen gelijk (opmerking
// Dennis, 15 oktober 2026).

import test from "node:test";
import assert from "node:assert/strict";
import { rapportBestandsnaam } from "../index.js";

const ORDER = { id: "ord_8f2c1a", address: { postalcode: "2253VM", housenumber: "29" } };

test("het volledige adres uit de report-api wint", () => {
  // Precies de naam die de WoonWijzerWinkel-adviseur ook maakt, zodat een
  // rapport uit een tenant en een rapport uit de adviseur in dezelfde
  // mailbox niet uit elkaar lopen.
  assert.equal(
    rapportBestandsnaam(ORDER, { address_line: "De Savornin Lohmanplantsoen 29, 2253VM Voorschoten" }),
    "verduurzamingsrapport-de-savornin-lohmanplantsoen-29-2253vm-voorschoten.pdf"
  );
});

test("zonder adresregel postcode en huisnummer", () => {
  // De report-api stuurt meta.address_line mee, maar een rapport uit de cache
  // of een oudere report-api hoeft dat niet te hebben. Postcode plus nummer
  // is genoeg om de woning te herkennen.
  assert.equal(rapportBestandsnaam(ORDER, null), "verduurzamingsrapport-2253vm-29.pdf");
  assert.equal(
    rapportBestandsnaam({ ...ORDER, address: { ...ORDER.address, houseaddition: "A" } }, {}),
    "verduurzamingsrapport-2253vm-29a.pdf",
    "toevoeging tegen het nummer aan, zoals in de mail"
  );
});

test("zonder adres toch een naam", () => {
  // Een bijlage zonder naam is erger dan een vage naam.
  assert.equal(rapportBestandsnaam({}, null), "verduurzamingsrapport-woning.pdf");
  assert.equal(rapportBestandsnaam({ address: {} }, { address_line: "" }), "verduurzamingsrapport-woning.pdf");
});

test("de naam blijft een bruikbaar bestandsnaam", () => {
  // Accenten, leestekens en een te lang adres mogen geen rare bestandsnaam
  // opleveren; een mailclient of bestandssysteem struikelt daarover.
  const naam = rapportBestandsnaam({}, { address_line: "Sint-Józefstraat 1/3, 1234 AB 's-Hertogenbosch" });
  assert.match(naam, /^verduurzamingsrapport-[a-z0-9-]+\.pdf$/, naam);
  assert.equal(naam.includes("--"), false, "geen dubbele streepjes");

  const lang = rapportBestandsnaam({}, { address_line: "A".repeat(200) });
  assert.ok(lang.length <= "verduurzamingsrapport-.pdf".length + 60, `te lang: ${lang.length}`);
  assert.equal(lang.endsWith("-.pdf"), false, "niet eindigen op een streepje");
});
