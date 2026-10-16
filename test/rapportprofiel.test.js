// test/rapportprofiel.test.js
//
// Wat `report.profiel: "standaard"` betekent voor deze dienst.
//
// WAAROM DEZE TEST BESTAAT
// Op 14 oktober 2026 verhuisden de gedeelde rapportinstellingen naar
// STANDAARD_RAPPORTPROFIEL in de report-api en gingen de tenants over op
// `profiel: "standaard"`. Maar dat profiel werd alleen daar opgelost; de
// runtime las `config.report.labelPdfUpload` letterlijk, dat veld bestond niet
// meer, en het uploadvak voor een energielabel verdween bij elke tenant met
// het profiel. Zonder foutmelding, zonder gefaalde test, zonder logregel.
//
// Dat laatste is de reden dat dit bestand er is: er was niets wat dit zag.

import test from "node:test";
import assert from "node:assert/strict";
import { rapportprofiel } from "../lib/rapportprofiel.js";

test("het profiel levert de gedeelde waarden", () => {
  assert.equal(rapportprofiel({ report: { profiel: "standaard" } }).labelPdfUpload, true);
  assert.equal(rapportprofiel({ report: { profiel: "STANDAARD" } }).labelPdfUpload, true,
    "hoofdletters mogen geen verschil maken");
});

test("wie het profiel niet vraagt, krijgt het niet", () => {
  // Een integrator die zijn velden zelf uitschrijft houdt zijn eigen gedrag.
  assert.equal(rapportprofiel({ report: {} }).labelPdfUpload, undefined);
  assert.equal(rapportprofiel({}).labelPdfUpload, undefined);
  assert.equal(rapportprofiel(undefined).labelPdfUpload, undefined);
  assert.equal(rapportprofiel({ report: { profiel: "eigen" } }).labelPdfUpload, undefined);
});

test("de tenant gaat over het profiel heen", () => {
  // Een tenant die het vak expliciet uitzet houdt dat, ook met het profiel.
  // Zonder deze regel zou het profiel een bewuste keuze overschrijven.
  const uit = rapportprofiel({ report: { profiel: "standaard", labelPdfUpload: false } });
  assert.equal(uit.labelPdfUpload, false);
});

test("eigen velden blijven staan naast het profiel", () => {
  const uit = rapportprofiel({
    report: { profiel: "standaard", midCta: "advies", adviesPartner: "WoonWijzerWinkel" },
  });
  assert.equal(uit.labelPdfUpload, true);
  assert.equal(uit.midCta, "advies");
  assert.equal(uit.adviesPartner, "WoonWijzerWinkel");
});

test("de echte configs van de twee levende tenants krijgen het vak terug", async (t) => {
  // De reden dat deze test bestaat, met de werkelijke bestanden erbij: beide
  // stonden op `profiel: "standaard"` zonder eigen vlag, en bij allebei was
  // het uploadvak dus verdwenen.
  //
  // De tenantrepo's staan naast deze; zijn ze er niet (een kale omgeving),
  // dan slaat deze test over in plaats van te vallen op een ontbrekend
  // bestand -- dan zou hij iets anders melden dan wat hij bewaakt.
  const basis = `file:///${process.cwd().replace(/\\/g, "/")}/..`;
  for (const map of ["tenant_der", "tenant_softbee"]) {
    let config;
    try {
      ({ default: config } = await import(`${basis}/${map}/tenant.config.js`));
    } catch {
      t.skip(`${map} staat niet naast deze repo`);
      return;
    }
    assert.equal(rapportprofiel(config).labelPdfUpload, true, map);
  }
});
