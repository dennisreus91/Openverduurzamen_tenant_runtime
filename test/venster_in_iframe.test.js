// test/venster_in_iframe.test.js
//
// Het contactvenster (download, volledig rapport) in een meegroeiende iframe op de
// website van de partner (WoonWijzerWinkel, 26 november 2026). Het gedrag in de
// browser is met Playwright op woonwijzerwinkel.nl nagelopen (desktop, tablet,
// mobiel en de zuil); hier het afgesproken berichtenverkeer met de inbouwcode.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WORTEL = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const BRON = fs.readFileSync(path.join(WORTEL, "assets", "contact_modal.js"), "utf-8");

test("het venster vraagt de pagina eromheen welk deel in beeld is", () => {
  assert.match(BRON, /type: "ov-zicht-vraag"/);
  assert.match(BRON, /e\.data\.type === "ov-zicht"/);
  // alleen antwoorden van de eigen ouder tellen
  assert.match(BRON, /e\.source !== window\.parent/);
});

test("zonder antwoord valt het terug op een IntersectionObserver", () => {
  assert.match(BRON, /new IntersectionObserver/);
});

test("openen plaatst het venster en sluiten zet de tijdelijke hoogte terug", () => {
  const open = BRON.slice(BRON.indexOf("function open(source)"));
  assert.match(open.slice(0, open.indexOf("\n    }\n")), /plaatsInBeeld\(\)/);
  const dicht = BRON.slice(BRON.indexOf("function close()"));
  assert.match(dicht.slice(0, dicht.indexOf("\n    }\n")), /vensterMinHoogte = 0/);
  assert.match(BRON, /modal\.classList\.contains\("is-open"\) \? vensterMinHoogte : 0/);
});

test("focus laat de pagina eromheen niet verspringen", () => {
  assert.match(BRON, /focus\(\{ preventScroll: true \}\)/);
});
