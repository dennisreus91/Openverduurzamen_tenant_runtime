// lib/rapport_wensen.js
//
// De vragen die de bezoeker beantwoordt bij de download van het snelle rapport of de
// aanvraag van het volledige rapport, en wat de runtime met de antwoorden doet.
//
// WAAROM DIT BESTAAT (feedback WoonWijzerWinkel, 20 november 2026)
// De WoonWijzerWinkel wil bij die twee momenten niet alleen contactgegevens, maar ook
// weten wat de bewoner wil:
//   1. het rapport vrijblijvend doornemen met een expert, voor gericht advies;
//   2. direct offertes voor de geadviseerde maatregelen;
//   3. welk scenario de voorkeur heeft ("geen voorkeur" mag);
//   4. aanvullende vragen in een opmerkingenveld (het bestaande veld `message`).
//
// Opt-in per tenant met `features.rapportVragen: true`. Een tenant zonder die regel merkt
// van deze code niets: het venster houdt dan het losse toestemmingsvinkje.
//
// DE TOESTEMMING KOMT UIT DE ANTWOORDEN
// Met deze vragen aan valt het losse vinkje weg. Vraag 1 en 2 zijn zelf de expliciete
// vraag of er contact mag komen: wie op een van beide "ja" zegt, vraagt erom. Wie twee
// keer "nee" zegt, krijgt zijn rapport net zo goed.
//
// De tenant krijgt in deze stand WEL altijd een mail, ook bij twee keer nee (besluit
// Dennis, 20 november 2026): hij wil postcode en e-mailadres in zijn CRM, zodat wij
// kunnen matchen. Die mail draagt dan "geen contact gewenst" in onderwerp en kop, en het
// venster zegt vooraf dat de gegevens naar het merk gaan. De toestemmingsvlag naar de
// centrale database blijft false. De tekst waarmee de toestemming gegeven
// is, is de tekst van de vraag of vragen waarop hij ja zei -- zonder die tekst is een
// vastgelegde toestemming niets waard (zie lib/centraal.js).

export const GEEN_VOORKEUR = "Geen voorkeur";

/** Staan de vragen aan voor deze tenant? */
export function rapportVragenAan(config) {
  return config?.features?.rapportVragen === true;
}

/** De teksten van de vragen, met de naam van de tenant erin. Een bron voor venster en server. */
export function rapportVragen(config) {
  const naam = String(config?.brand?.name || "ons").trim();
  return {
    expertGesprek: `Wilt u het rapport vrijblijvend doornemen met een expert van ${naam}, voor gericht advies waarmee u ook echt kunt verduurzamen?`,
    offertes: "Wilt u direct offertes ontvangen voor de geadviseerde maatregelen?",
    scenario: "Welk scenario heeft uw voorkeur?",
    geenVoorkeur: GEEN_VOORKEUR,
    opmerkingen: "Aanvullende vragen of opmerkingen",
  };
}

function jaNee(waarde) {
  if (waarde === true || waarde === "ja") return true;
  if (waarde === false || waarde === "nee") return false;
  return null;
}

/**
 * De antwoorden uit een request-body, opgeschoond. Geeft null als er niets bruikbaars in
 * staat. Een onbekende waarde wordt null en niet "nee": niet beantwoord is iets anders dan
 * nee gezegd.
 */
export function leesRapportWensen(ruw) {
  if (!ruw || typeof ruw !== "object") return null;
  const expertGesprek = jaNee(ruw.expertGesprek);
  const offertes = jaNee(ruw.offertes);
  const scenario = String(ruw.scenario ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
  if (expertGesprek === null && offertes === null && !scenario) return null;
  return { expertGesprek, offertes, scenario };
}

/** Wat er ontbreekt, als leesbare namen. Leeg = compleet. */
export function ontbrekendeWensen(wensen) {
  const mist = [];
  if (wensen?.expertGesprek == null) mist.push("gesprek met een expert");
  if (wensen?.offertes == null) mist.push("offertes");
  if (!wensen?.scenario) mist.push("voorkeursscenario");
  return mist;
}

/** Ja op vraag 1 of 2 is de vraag om contact. */
export function toestemmingUitWensen(wensen) {
  return wensen?.expertGesprek === true || wensen?.offertes === true;
}

/** De tekst waarop de bezoeker ja zei; leeg als hij nergens ja op zei. */
export function toestemmingsTekstUitWensen(wensen, config) {
  const v = rapportVragen(config);
  const ja = [];
  if (wensen?.expertGesprek === true) ja.push(v.expertGesprek + " Ja.");
  if (wensen?.offertes === true) ja.push(v.offertes + " Ja.");
  return ja.join(" ");
}

const leesbaar = (b) => (b === true ? "Ja" : b === false ? "Nee" : "Niet beantwoord");

/** Rijen voor de leadmail, in de volgorde van het venster. */
export function wensenRijen(wensen) {
  if (!wensen) return [];
  return [
    ["Rapport doornemen met een expert", leesbaar(wensen.expertGesprek)],
    ["Direct offertes", leesbaar(wensen.offertes)],
    ["Voorkeursscenario", wensen.scenario || "Niet beantwoord"],
  ];
}

/** Compact, voor het veld `extra` van de centrale database (max 8 KB in totaal). */
export function wensenVoorCentraal(wensen) {
  if (!wensen) return null;
  return {
    expert_gesprek: wensen.expertGesprek,
    offertes: wensen.offertes,
    scenario: wensen.scenario || null,
  };
}
