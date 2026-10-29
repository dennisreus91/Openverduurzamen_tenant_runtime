#!/usr/bin/env node
//
// lokale-keten.mjs — de hele keten op je eigen machine, zonder een betaalde aanroep.
//
// WAAROM DIT BESTAAT
// Op 29 oktober 2026 kwamen drie fouten achter elkaar aan het licht die geen enkele
// testsuite kon zien, omdat ze geen van drieën in één onderdeel zaten:
//
//   1. De tenant-kopie van mid_app.js verving "WoonWijzerWinkel" door "OpenVerduurzamen"
//      in het rapport -- een overblijfsel van toen die tenant andersom gekopieerd werd.
//   2. Het contactvenster beloofde bij de gegevenspoort contact dat daar niet gegeven
//      wordt.
//   3. De cachemarkering liep achter, dus terugkerende bezoekers kregen de oude app.
//
// De runtime deed niets fout, de report-api deed niets fout, en de tenant-assets hebben
// geen tests. Alleen de drie samen, in een browser, lieten het zien. Dit script maakt dat
// goedkoop: een nagebootste databron en een nagebootst taalmodel, en daar de echte
// report-api en de echte tenant bovenop.
//
// GEBRUIK
//   node scripts/lokale-keten.mjs ../tenant_woonwijzerwinkel
//
// De report-api wordt standaard naast deze repo gezocht (../Openverduurzamen_report_api);
// met REPORT_API_DIR wijs je hem ergens anders heen. Stoppen met Ctrl+C.
//
// WAT HET NIET DEKT
// Mailen en pdf's maken staan uit (geen RESEND_API_KEY, geen PDFBOLT_API_KEY) en dat is
// met opzet: die twee horen hard te falen in plaats van te lijken te werken. Ook echte
// woningdata zit er niet in -- de nagebootste bron geeft altijd dezelfde voorbeeldwoning.
// Dit script bewijst dat de onderdelen op elkaar aansluiten, niet dat de getallen kloppen.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RUNTIME = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REPORT_API = process.env.REPORT_API_DIR || path.join(path.dirname(RUNTIME), "Openverduurzamen_report_api");
const TENANT = path.resolve(process.argv[2] || path.join(path.dirname(RUNTIME), "tenant_woonwijzerwinkel"));

const alsUrl = (p) => "file:///" + p.replace(/\\/g, "/");

for (const [naam, dir] of [["report-api", REPORT_API], ["tenant", TENANT]]) {
  if (!fs.existsSync(dir)) {
    console.error(`${naam} niet gevonden: ${dir}`);
    console.error("Geef de tenant als argument mee, en wijs de report-api aan met REPORT_API_DIR.");
    process.exit(2);
  }
}

const { nepDataApi, nepTaalmodel, voorbeeldRapport } = await import(
  alsUrl(path.join(REPORT_API, "test/helpers/nepbronnen.js"))
);

const SLEUTEL = "lokale-keten-" + "s".repeat(24);
const REPORT_PORT = Number(process.env.REPORT_PORT || 8791);
const TENANT_PORT = Number(process.env.TENANT_PORT || 8790);

const bron = await nepDataApi();
const model = await nepTaalmodel(voorbeeldRapport());

const api = spawn(process.execPath, ["server.js"], {
  cwd: REPORT_API,
  env: {
    ...process.env,
    PORT: String(REPORT_PORT),
    AUDIT_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "lokale-keten-audit-")),
    ENRICHED_API_BASE_URL: bron.url,
    ENRICHED_APP_KEY: "test-app-key",
    ANTHROPIC_BASE_URL: model.url,
    ANTHROPIC_API_KEY: "test-dummy-key",
    EPA_API_KEYS: `tenant=${SLEUTEL}`,
    NODE_ENV: "test",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
api.stdout.on("data", (d) => process.stdout.write("[report-api] " + d));
api.stderr.on("data", (d) => process.stdout.write("[report-api!] " + d));

for (let i = 0; i < 80; i++) {
  try {
    await fetch(`http://127.0.0.1:${REPORT_PORT}/methodiek`);
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 250));
  }
}

// De tenant draait in DIT proces, met de runtime uit deze werkmap -- niet met de gepinde
// kopie uit zijn node_modules. Je toetst dus wat je net hebt gebouwd.
Object.assign(process.env, {
  // MET het pad erbij: de runtime leidt de lookup-url af door "/api/full/render" aan het
  // eind te vervangen. Zonder dat pad post de lookup naar de wortel en krijg je een 404.
  FULL_APP_RENDER_URL: `http://127.0.0.1:${REPORT_PORT}/api/full/render`,
  FULL_APP_RENDER_API_KEY: SLEUTEL,
  ORDERS_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "lokale-keten-orders-")),
  APP_BASE_URL: `http://localhost:${TENANT_PORT}`,
  WWW_INTERNAL_EMAIL: "adviseur@example.nl",
  WWW_INTERNAL_PASSWORD: "lokaal-wachtwoord",
  WWW_INTERNAL_SESSION_SECRET: "s".repeat(48),
  LEAD_EMAIL: "lokaal@example.nl",
});
for (const weg of ["RESEND_API_KEY", "PDFBOLT_API_KEY", "CENTRAAL_API_URL"]) delete process.env[weg];

const { createTenantApp } = await import(alsUrl(path.join(RUNTIME, "index.js")));
const config = (await import(alsUrl(path.join(TENANT, "tenant.config.js")))).default;

createTenantApp(config).listen(TENANT_PORT, () => {
  console.log(`\n  tenant      http://localhost:${TENANT_PORT}`);
  console.log(`  report-api  http://127.0.0.1:${REPORT_PORT}`);
  console.log(`  woning      Teststraat 1, 1234AB Teststad (altijd dezelfde)`);
  console.log(`  poort       ${config.features?.gegevensPoort || "uit"}`);
  console.log(`\n  Let op: gebruik een venster ZONDER adviseurssessie. Een ingelogde`);
  console.log(`  browser slaat de gegevenspoort over, en dan test je hem niet.\n`);
});

// Hoeveel bronaanroepen zijn er gedaan? Dat is de vraag achter "doet het volledige rapport
// de data opnieuw op" -- hier is het antwoord te tellen in plaats van te geloven.
let vorig = 0;
setInterval(() => {
  if (bron.aanroepen.length !== vorig) {
    vorig = bron.aanroepen.length;
    console.log(`  [bron] ${vorig} aanroep(en) tot nu toe`);
  }
}, 10000).unref?.();

process.on("SIGINT", () => {
  console.log(`\n  [bron] totaal ${bron.aanroepen.length} aanroep(en):`);
  for (const u of bron.aanroepen) console.log(`         ${u}`);
  api.kill("SIGTERM");
  process.exit(0);
});
