// lib/rapportprofiel.js
//
// Wat `report.profiel: "standaard"` in een tenantconfig betekent voor DEZE
// dienst.
//
// WAAROM DIT BESTAAT
// Op 14 oktober 2026 verhuisden de gedeelde rapportinstellingen uit elke
// tenantconfig naar STANDAARD_RAPPORTPROFIEL in lib/tenants.js van de
// report-api, en gingen de tenants over op `profiel: "standaard"`. Bedoeld
// als opschoning: vijf kopieën van hetzelfde terug naar één.
//
// Maar dat profiel wordt ALLEEN in de report-api opgelost. De runtime leest
// de config letterlijk, en nam hier zijn eigen beslissing:
//
//     return config?.report?.labelPdfUpload === true;
//
// Dat veld bestond sinds die dag niet meer, dus dit gaf false en het
// uploadvak voor een energielabel verdween bij elke tenant met het profiel --
// zonder foutmelding, zonder gefaalde test, zonder logregel. De opmerking in
// tenant_der noemt `labelPdfUpload` zelfs als iets wat uit het profiel komt:
// de bedoeling klopte, het mechanisme ontbrak.
//
// WAAROM HIER MAAR EEN DEEL VAN HET PROFIEL STAAT
// De report-api gebruikt het hele profiel om te rekenen en te renderen. Deze
// dienst doet daar niets mee; hij hoeft alleen te weten welke invoervakken hij
// toont. Alleen die velden staan hieronder. Komt er een veld bij dat de
// runtime ook nodig heeft, dan hoort het hier én daar -- en een test die dat
// bewaakt kan niet bestaan, want de twee diensten delen geen code. Daarom
// staat de bron hier met naam genoemd.
//
// Bron van waarheid: Openverduurzamen_report_api/lib/tenants.js,
// STANDAARD_RAPPORTPROFIEL. Wijk hier niet van af zonder dat daar mee te
// nemen: de report-api weigert een upload die deze dienst wel toont, en dan
// krijgt de bezoeker een vak dat niet werkt.

/** De velden uit het gedeelde profiel waar DEZE dienst iets mee doet. */
const STANDAARD = Object.freeze({
  labelPdfUpload: true,
});

/**
 * Het opgeloste rapportprofiel van deze tenant.
 *
 * `profiel: "standaard"` levert de gedeelde waarden; wat de tenant zelf zet
 * gaat daaroverheen. Een tenant die een vak expliciet uitzet
 * (`labelPdfUpload: false`) houdt dat dus, ook met het profiel.
 */
export function rapportprofiel(config) {
  const report = config?.report || {};
  const gevraagd = String(report.profiel || "").trim().toLowerCase() === "standaard";
  return { ...(gevraagd ? STANDAARD : {}), ...report };
}

export default { rapportprofiel };
