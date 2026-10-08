// test/runtime_versie.test.js
//
// Welke runtime draait hier, en zegt hij de waarheid?
//
// WAAROM DEZE TEST BESTAAT
// Het `version`-veld in package.json stond op `1.6.0` terwijl de tags V3.0.0
// t/m V3.3.0 langskwamen. Vier releases, nul bumps. Dat is geen incident maar
// het voorspelbare gedrag van een getal dat met de hand moet worden
// bijgehouden, en het is de reden dat de tag uit de PIN leidend is en dat veld
// alleen als laatste redmiddel dient.
//
// De zwaarste test hieronder is dan ook die ene: een verouderd `version` mag
// de tag niet overschaduwen. Zou dat omklappen, dan rapporteert `/health`
// weer met gezag een verkeerd getal -- erger dan helemaal geen versie, want
// dan stopt iemand met zoeken.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  tagUitUrl,
  vingerafdrukUit,
  versieUitBronnen,
  zoekLockEntry,
  runtimeVersie,
  PAKKETSLEUTEL,
} from "../lib/runtime_versie.js";
import { createTenantApp } from "../index.js";

/** De wortel van de repo, los van waar de test vandaan wordt gestart. */
const WORTEL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Een echte entry, overgenomen uit tenant_ov/node_modules/.package-lock.json
// op 8 oktober 2026. Let op het verschil tussen `version` en de tag in
// `resolved`: dát is het hele probleem, hier vastgelegd zoals het werkelijk
// op schijf stond.
const ECHTE_ENTRY = {
  version: "1.6.0",
  resolved:
    "https://github.com/dennisreus91/Openverduurzamen_tenant_runtime/archive/refs/tags/V3.3.0.tar.gz",
  integrity: "sha512-/orHaz5bFaHGOnmCva9kkOz2lgnHu+ahppL0w3WfzSbMeLOYka8VCnHoPsORaDeP+swSDy3SQ7C1uwuuHszDbg==",
};

// --- 1. De tag uit de URL --------------------------------------------------

test("de tag komt uit de archive-URL", () => {
  assert.equal(tagUitUrl(ECHTE_ENTRY.resolved), "V3.3.0");
  assert.equal(
    tagUitUrl("https://github.com/x/y/archive/refs/tags/v2.0.0-report.6.tar.gz"),
    "v2.0.0-report.6",
    "een tag met een streepje en een punt erin blijft heel"
  );
});

test("de hoofdletter van de tag blijft staan", () => {
  // GitHub-refs zijn case-sensitive: V3.3.0 en v3.3.0 zijn twee verschillende
  // tags, en in dit project bestaan ze beide als aparte taglijn. Normaliseren
  // zou twee verschillende runtimes op één naam laten lijken.
  assert.equal(tagUitUrl("https://x/archive/refs/tags/V3.3.0.tar.gz"), "V3.3.0");
  assert.equal(tagUitUrl("https://x/archive/refs/tags/v3.3.0.tar.gz"), "v3.3.0");
});

test("een URL zonder tag levert niets, en legt niets plat", () => {
  for (const onzin of [
    null,
    undefined,
    "",
    "niet eens een url",
    "https://registry.npmjs.org/express/-/express-4.21.2.tgz",
    "git+https://github.com/x/y.git#V3.3.0",
  ]) {
    assert.equal(tagUitUrl(onzin), null, `verwacht null bij ${JSON.stringify(onzin)}`);
  }
});

// --- 2. De vingerafdruk ---------------------------------------------------

test("de vingerafdruk is het begin van de sha512", () => {
  assert.equal(vingerafdrukUit(ECHTE_ENTRY.integrity), "/orHaz5bFaHG");
  assert.equal(vingerafdrukUit(ECHTE_ENTRY.integrity, 4), "/orH");
});

test("een ontbrekende of andere hash levert niets", () => {
  for (const onzin of [null, undefined, "", "sha1-abc", "abc"]) {
    assert.equal(vingerafdrukUit(onzin), null, `verwacht null bij ${JSON.stringify(onzin)}`);
  }
});

// --- 3. De kern: de pin wint van een verouderd veld ----------------------

test("een verouderd version-veld overschaduwt de tag NIET", () => {
  const uit = versieUitBronnen(ECHTE_ENTRY, "1.6.0");

  assert.equal(uit.tag, "V3.3.0", "dit is wat er werkelijk geïnstalleerd is");
  assert.equal(uit.bron, "pin");
  assert.equal(uit.vingerafdruk, "/orHaz5bFaHG");
  // Het veld mag mee, maar niet als de versie.
  assert.equal(uit.pakket, "1.6.0");
  assert.notEqual(uit.tag, uit.pakket, "juist dit verschil is de hele reden voor deze module");
});

test("zonder pin is het antwoord eerlijk over zijn bron", () => {
  const uit = versieUitBronnen(null, "1.6.0");
  assert.equal(uit.tag, null, "niets verzinnen");
  assert.equal(uit.pakket, "1.6.0");
  assert.equal(uit.bron, "package.json", "zodat niemand dit getal voor de waarheid houdt");
});

test("zonder enige bron staat er onbekend, niet een leeg getal", () => {
  const uit = versieUitBronnen(null, null);
  assert.equal(uit.tag, null);
  assert.equal(uit.pakket, null);
  assert.equal(uit.bron, "onbekend");
});

test("een entry met integrity maar zonder resolved valt terug", () => {
  // Komt voor bij een installatie uit een lokale map of een cache.
  const uit = versieUitBronnen({ version: "1.6.0", integrity: ECHTE_ENTRY.integrity }, "1.6.0");
  assert.equal(uit.bron, "package.json");
  assert.equal(uit.vingerafdruk, "/orHaz5bFaHG", "de vingerafdruk is er wel, en blijft bruikbaar");
});

// --- 4. Het lockfile op schijf vinden ------------------------------------

function maakProject(entry, { diepte = 0 } = {}) {
  const wortel = fs.mkdtempSync(path.join(os.tmpdir(), "runtimeversie-"));
  if (entry) {
    fs.mkdirSync(path.join(wortel, "node_modules"), { recursive: true });
    fs.writeFileSync(
      path.join(wortel, "node_modules", ".package-lock.json"),
      JSON.stringify({ name: "tenant", lockfileVersion: 3, packages: { [PAKKETSLEUTEL]: entry } })
    );
  }
  // Boots de plek na waar deze module geïnstalleerd staat, eventueel dieper.
  const binnen = path.join(wortel, "node_modules", "@openverduurzamen", "tenant-runtime", "lib", ...Array(diepte).fill("diep"));
  fs.mkdirSync(binnen, { recursive: true });
  return { wortel, binnen };
}

test("de entry wordt gevonden vanaf de plek waar de module geïnstalleerd staat", () => {
  const { binnen } = maakProject(ECHTE_ENTRY);
  const entry = zoekLockEntry(binnen);
  assert.ok(entry, "de entry hoort gevonden te worden");
  assert.equal(tagUitUrl(entry.resolved), "V3.3.0");
});

test("er wordt omhoog gelopen, zodat een geneste installatie ook werkt", () => {
  const { binnen } = maakProject(ECHTE_ENTRY, { diepte: 3 });
  assert.ok(zoekLockEntry(binnen), "drie mappen diep hoort nog gevonden te worden");
});

test("geen lockfile betekent geen entry, geen fout", () => {
  const { binnen } = maakProject(null);
  assert.equal(zoekLockEntry(binnen), null);
});

test("een stukgelopen lockfile levert geen uitzondering", () => {
  const { wortel, binnen } = maakProject(ECHTE_ENTRY);
  fs.writeFileSync(path.join(wortel, "node_modules", ".package-lock.json"), "{ dit is geen json");
  assert.equal(zoekLockEntry(binnen), null, "onleesbaar is hetzelfde als afwezig");
});

test("een lockfile zonder onze sleutel levert niets", () => {
  const wortel = fs.mkdtempSync(path.join(os.tmpdir(), "runtimeversie-"));
  fs.mkdirSync(path.join(wortel, "node_modules"), { recursive: true });
  fs.writeFileSync(
    path.join(wortel, "node_modules", ".package-lock.json"),
    JSON.stringify({ packages: { "node_modules/express": { version: "4.21.2" } } })
  );
  assert.equal(zoekLockEntry(wortel), null);
});

// --- 5. In deze repo zelf -------------------------------------------------

test("in de runtime-repo zelf is er geen pin, en dat wordt zo gemeld", () => {
  // Hier is dit pakket geen dependency van iets, dus er is geen entry. Dat is
  // de normale gang van zaken bij `npm test` en hoort geen fout te zijn.
  const uit = runtimeVersie({ vernieuw: true });

  assert.ok(["pin", "package.json", "onbekend"].includes(uit.bron), `onverwachte bron: ${uit.bron}`);
  if (uit.bron !== "pin") assert.equal(uit.tag, null, "zonder pin hoort er geen tag te staan");
  assert.doesNotThrow(() => runtimeVersie({ vernieuw: true }));
});

test("het antwoord wordt gebufferd, want het verandert niet tijdens een proces", () => {
  const een = runtimeVersie({ vernieuw: true });
  const twee = runtimeVersie();
  assert.equal(een, twee, "tweede aanroep hoort hetzelfde object te zijn, zonder schijf te raken");
});

// --- 6. De bewaker tegen opnieuw wegdrijven -------------------------------

test("het version-veld loopt gelijk met de nieuwste tag", () => {
  // Dit is de test die het oorspronkelijke probleem had gevangen: version
  // bleef op 1.6.0 staan terwijl er vier tags langskwamen. Niemand merkte het,
  // want niets keek ernaar.
  //
  // De invariant klopt op elk moment behalve MIDDEN in een release, en
  // scripts/release.sh draait de tests daarom vóór het bumpen -- dan kijkt
  // deze test nog naar het oude, consistente paar.
  //
  // Zonder tags (geïnstalleerde tarball, shallow clone, een kloon zonder
  // tags) valt dit over. Dan slaat de test over in plaats van rood te worden:
  // een test die rood staat om zijn omgeving leert niemand iets.
  let nieuwste;
  try {
    nieuwste = execFileSync("git", ["tag", "--list", "V*", "--sort=-v:refname"], {
      cwd: WORTEL,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split(/\r?\n/)[0]
      .trim();
  } catch {
    nieuwste = "";
  }
  if (!nieuwste) {
    assert.ok(true, "geen tags beschikbaar -- niets te vergelijken");
    return;
  }

  const eigen = JSON.parse(fs.readFileSync(path.join(WORTEL, "package.json"), "utf8")).version;
  assert.equal(
    eigen,
    nieuwste.slice(1),
    `package.json staat op ${eigen} terwijl de nieuwste tag ${nieuwste} is. ` +
      "Gebruik scripts/release.sh, die bumpt en tagt in één handeling."
  );
});

// --- 7. /health draagt het uit -------------------------------------------

test("/health meldt de runtime, zodat je van buiten kunt zien wat er draait", async () => {
  const app = createTenantApp({ id: "testtenant", brand: { name: "Test" } });
  const server = http.createServer(app);
  server.keepAliveTimeout = 1;
  await new Promise((r) => server.listen(0, "127.0.0.1", r));

  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/health`);
    const body = await res.json();

    assert.equal(body.ok, true);
    assert.equal(body.tenant, "testtenant");
    assert.ok(body.runtime, "het runtime-blok hoort erin te staan -- dit is de hele reden voor deze wijziging");
    // Alle vier de velden moeten aanwezig zijn, ook als ze null zijn: een
    // ontbrekend veld is niet te onderscheiden van een oude runtime die het
    // nog niet meldt, en juist dat onderscheid is hier het doel.
    for (const veld of ["tag", "pakket", "bron", "vingerafdruk"]) {
      assert.ok(veld in body.runtime, `${veld} ontbreekt in het runtime-blok`);
    }
    assert.ok(["pin", "package.json", "onbekend"].includes(body.runtime.bron));
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
});
