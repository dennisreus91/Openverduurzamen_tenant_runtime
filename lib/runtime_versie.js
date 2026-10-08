// lib/runtime_versie.js
//
// Welke runtime draait hier werkelijk?
//
// WAAROM DIT BESTAAT
// Dat was tot nu toe van buiten niet vast te stellen. `/health` gaf alleen
// `ok`, `tenant` en `ts`, en nergens stond een versie. Precies die blinde vlek
// zat onder het lead-BCC-incident (2 sep 2026): de deploy leek te slagen
// terwijl de OUDE runtime bleef draaien, en er was geen enkele manier om dat
// te zien zonder het Render-dashboard open te trekken.
//
// WAAROM NIET HET `version`-VELD UIT package.json
// Omdat dat veld niet werkt. Het stond op `1.6.0` terwijl de tags V3.0.0,
// V3.1.0, V3.2.0 en V3.3.0 langskwamen -- vier releases waarin niemand het
// meebumpte (vastgesteld 8 okt 2026). Een getal dat met de hand
// bijgehouden moet worden, loopt achter, en een versie die achterloopt is
// erger dan geen versie: die liegt met gezag.
//
// WAT DE BRON WEL IS
// npm schrijft bij het installeren de WERKELIJK gebruikte URL in het verborgen
// lockfile van het host-project: `node_modules/.package-lock.json`, onder de
// sleutel `node_modules/@openverduurzamen/tenant-runtime`. Daarin staat:
//
//   resolved   https://github.com/.../archive/refs/tags/V3.3.0.tar.gz
//   integrity  sha512-/orHaz5bFaHG...
//
// Dat is geen administratie die iemand moet bijwerken -- het IS de pin die
// geïnstalleerd is, door npm zelf opgeschreven. Vandaar de tag uit `resolved`
// als primaire bron, met het `version`-veld alleen als laatste redmiddel.
//
// De `integrity` gaat mee als korte vingerafdruk. Die identificeert de BYTES,
// niet de naam, en dat is precies wat je wil weten bij "draait de nieuwe code
// nou echt": een tag kan verplaatst worden, een sha512 niet.
//
// OPENBAARHEID
// Dit komt op `/health` te staan, dat zonder sleutel open is. Geen bezwaar:
// de runtime-repo is publiek -- de tarball is keyloos op te halen, dat is nou
// juist waarom de pin een https-tarball is -- dus de tag verraadt niets wat
// niet al openbaar is.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

/** De sleutel waaronder npm deze package in het lockfile zet. */
export const PAKKETSLEUTEL = "node_modules/@openverduurzamen/tenant-runtime";

/**
 * De tag uit een GitHub-archive-URL.
 *
 * Let op de hoofdletter: GitHub-refs zijn case-sensitive, `V3.3.0` en `v3.3.0`
 * zijn twee verschillende tags. Daarom wordt de tag letterlijk overgenomen en
 * niet genormaliseerd.
 */
export function tagUitUrl(url) {
  const m = /\/archive\/refs\/tags\/(.+?)\.tar\.gz(?:[?#].*)?$/.exec(String(url || ""));
  return m ? m[1] : null;
}

/** De eerste tekens van de sha512, genoeg om twee archieven te onderscheiden. */
export function vingerafdrukUit(integrity, lengte = 12) {
  const m = /^sha512-(.+)$/.exec(String(integrity || "").trim());
  return m ? m[1].slice(0, lengte) : null;
}

/**
 * Stel de versie vast uit de twee bronnen. Puur, zodat dit zonder schijf te
 * toetsen is.
 *
 * @param {object|null} entry      de lockfile-entry van deze package
 * @param {string|null} eigenVersie het `version`-veld uit onze package.json
 */
export function versieUitBronnen(entry, eigenVersie) {
  const tag = tagUitUrl(entry?.resolved);
  const vingerafdruk = vingerafdrukUit(entry?.integrity);

  if (tag) return { tag, pakket: eigenVersie || null, bron: "pin", vingerafdruk };

  // Geen pin te vinden: dan is het veld uit package.json het enige wat er is.
  // `bron` zegt dat eerlijk, zodat niemand dit getal voor de waarheid houdt.
  return { tag: null, pakket: eigenVersie || null, bron: eigenVersie ? "package.json" : "onbekend", vingerafdruk };
}

function leesJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Zoek het verborgen lockfile van het host-project.
 *
 * Geïnstalleerd staat dit bestand op
 * `<host>/node_modules/@openverduurzamen/tenant-runtime/lib/`, dus het
 * lockfile ligt op `<host>/node_modules/.package-lock.json`. Dat pad wordt
 * eerst geprobeerd; daarna wordt omhoog gelopen, zodat een andere indeling
 * (npm-workspaces, een geneste installatie) ook gevonden wordt.
 *
 * In de runtime-repo zelf bestaat zo'n entry niet -- daar is dit pakket geen
 * dependency van iets. Dan levert dit `null` en valt de versie terug op
 * package.json. Dat is geen fout maar de normale gang van zaken bij
 * `npm test`.
 */
export function zoekLockEntry(startDir, sleutel = PAKKETSLEUTEL) {
  let dir = startDir;
  for (let i = 0; i < 8; i += 1) {
    const kandidaat = path.join(dir, "node_modules", ".package-lock.json");
    const lock = leesJson(kandidaat);
    const entry = lock?.packages?.[sleutel];
    if (entry && (entry.resolved || entry.version)) return entry;

    const ouder = path.dirname(dir);
    if (ouder === dir) break;
    dir = ouder;
  }
  return null;
}

const HIER = path.dirname(fileURLToPath(import.meta.url));
const PAKKETMAP = path.dirname(HIER);

let gecached = null;

/**
 * De versie van de draaiende runtime.
 *
 * Gebufferd: `/health` kan door een monitor vaak aangeroepen worden en het
 * lockfile is enkele tienduizenden bytes. Er verandert hier tijdens het leven
 * van het proces niets, want een nieuwe pin betekent een nieuwe deploy.
 *
 * Valt nooit om. Een onleesbaar lockfile levert `bron: "onbekend"`, geen
 * uitzondering -- een gezondheidsroute die klapt op zijn eigen versieveld is
 * erger dan geen versieveld.
 */
export function runtimeVersie({ vernieuw = false, startDir = PAKKETMAP } = {}) {
  if (gecached && !vernieuw) return gecached;

  let eigenVersie = null;
  try {
    eigenVersie = leesJson(path.join(PAKKETMAP, "package.json"))?.version || null;
  } catch {
    eigenVersie = null;
  }

  let entry = null;
  try {
    entry = zoekLockEntry(startDir);
  } catch {
    entry = null;
  }

  gecached = versieUitBronnen(entry, eigenVersie);
  return gecached;
}

export default { runtimeVersie, versieUitBronnen, tagUitUrl, vingerafdrukUit, zoekLockEntry, PAKKETSLEUTEL };
