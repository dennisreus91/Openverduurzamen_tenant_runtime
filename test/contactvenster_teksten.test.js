// test/contactvenster_teksten.test.js
//
// Drie dingen in het bestelvenster, uit de ronde van Dennis op 23 oktober 2026.
//
// 1. DE TOESTEMMINGSREGEL BLEEF STAAN NA HET VERSTUREN
// Na "Bedankt! Het volledige rapport wordt gemaakt" stond er nog een leeg
// aanvinkvakje onder: een keuze die niets meer doet, bij een aanvraag die al
// weg is. De oorzaak is structureel en komt terug: het venster verbergt na
// een geslaagde verzending alles wat een van vier klassen draagt, en de
// toestemmingsregel wordt los aangemaakt in plaatsToestemming() en draagt er
// geen een van. Elk volgend element dat zo wordt bijgeplaatst loopt tegen
// hetzelfde aan.
//
// Een echte klik-test vraagt een DOM in node; die is er voor dit bestand niet.
// Deze leescontrole dekt wat er misging: het element hoort in ALLEBEI de
// lijsten te staan -- verbergen na het versturen én terugzetten bij het
// opnieuw openen. Precies één van de twee vergeten is de fout die je pas ziet
// als een bezoeker het venster een tweede keer opent.
//
// 2. DE NAAM IN DE TOESTEMMINGSTEKST
// Die noemde de adviespartner (WoonWijzerWinkel). Op de pagina van
// OpenVerduurzamen las de bezoeker dan een naam die nergens anders in het
// venster staat. Nu het merk van de tenant, en "Wij" in de tweede zin.
//
// 3. DE AANKONDIGING VAN HET RAPPORT
// Die noemde dezelfde partner. Dit is het bestelvenster van de tenant, niet de
// adviesaanvraag bij de partner.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createTenantApp } from "../index.js";

const WORTEL = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MODAL = fs.readFileSync(path.join(WORTEL, "assets", "contact_modal.js"), "utf-8");

/** De selectorlijsten die bepalen wat er verdwijnt en wat er terugkomt. */
function selectorLijsten() {
  const lijsten = [];
  const naald = '$$(modal, ".contactModal__sectionLabel';
  for (let i = MODAL.indexOf(naald); i >= 0; i = MODAL.indexOf(naald, i + 1)) {
    lijsten.push(MODAL.slice(i, MODAL.indexOf('")', i)));
  }
  return lijsten;
}

test("alles wat het formulier draagt verdwijnt en komt samen terug", () => {
  const lijsten = selectorLijsten();
  assert.equal(
    lijsten.length,
    2,
    "verwacht twee lijsten: een om te verbergen na het versturen, een om terug te zetten bij het openen"
  );
  for (const lijst of lijsten) {
    assert.match(
      lijst,
      /\[data-contact-akkoord-rij\]/,
      "de toestemmingsregel ontbreekt in een van de twee lijsten:\n" + lijst +
        "\nDan blijft er na het versturen een aanvinkvakje onder de bedankregel staan, " +
        "of komt het bij een tweede aanvraag niet meer terug."
    );
  }
});

test("de regel die de test bewaakt bestaat ook echt", () => {
  // Zonder dit zou de test hierboven groen blijven als het attribuut ooit
  // hernoemd wordt: de lijsten noemen het dan nog, het element niet meer.
  assert.match(MODAL, /rij\.setAttribute\("data-contact-akkoord-rij", ""\)/);
});

test("het bestelvenster noemt de adviespartner niet bij naam", () => {
  const aankondiging = MODAL.slice(MODAL.indexOf("Het volledige rapport gaat per e-mail"));
  const zin = aankondiging.slice(0, aankondiging.indexOf('"\n'));
  assert.match(zin, /een specialist van onze verduurzamingspartner/);
  assert.doesNotMatch(
    zin,
    /\+ partner \+/,
    "dit is het bestelvenster van de tenant; de naam van de opvolgpartner leidt daar af"
  );
});

// --- 4. De toestemmingstekst komt uit de runtime, niet uit vier kopieën ---

async function tenant(t, config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tenant-toestemming-"));
  const server = http.createServer(createTenantApp({ id: "testtenant", publicDir: dir, ...config }));
  server.keepAliveTimeout = 1;
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const basis = `http://127.0.0.1:${server.address().port}`;
  return (await (await fetch(basis + "/api/tenant")).json()).lead.tekst;
}

test("de toestemming noemt het merk op de pagina, niet de opvolgpartner", async (t) => {
  const tekst = await tenant(t, {
    brand: { name: "OpenVerduurzamen" },
    report: { adviesPartner: "WoonWijzerWinkel" },
  });
  assert.match(tekst, /dat OpenVerduurzamen mijn gegevens/);
  assert.match(tekst, /Wij gaan zorgvuldig met je gegevens om/);
  assert.doesNotMatch(
    tekst,
    /WoonWijzerWinkel/,
    "een naam die nergens anders in het venster staat, als afsluiter van een bestelling bij OpenVerduurzamen"
  );
});

test("een tenant onder zijn eigen naam ziet zijn eigen naam", async (t) => {
  const tekst = await tenant(t, { brand: { name: "WoonWijzerWinkel" } });
  assert.match(tekst, /dat WoonWijzerWinkel mijn gegevens/);
});
