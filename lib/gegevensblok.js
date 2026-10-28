// Machineleesbaar blok onder een mail aan een partner.
//
// WAAROM DIT BESTAAT
// Sinds eind oktober 2026 leest de WoonWijzerWinkel onze mails met een CRM-import mee: er zit een
// machine tussen de verzender en de lezer. Daarmee is de opmaak een koppelvlak geworden. De
// leadmail van deze runtime is een HTML-tabel met rijen als "Voornaam" en "E-mailadres", de
// leadmail van de centrale dienst is lopende tekst met "Naam:" en "E-mail:", en de rapportmail is
// een brief aan de klant met een downloadlink. Drie formaten, drie parsers, en elk van de drie
// breekt zodra iemand aan de opmaak komt -- bij ons blijft dan alles groen.
//
// Daarom krijgt elke mail aan een partner hetzelfde afgebakende blok: een vaste veldenlijst in een
// vaste volgorde. Bij een HTML-mail gaat dat blok mee als tekstversie (text/plain). De lezer ziet
// de opgemaakte mail, de machine leest de tekstversie, en de opmaak mag veranderen zonder dat de
// import dat merkt.
//
// DRIE AFSPRAKEN
// 1. Elk veld uit VELDEN staat er altijd, ook leeg ("Adres:"). Een parser hoeft dus nooit een
//    ontbrekend veld op te vangen.
// 2. Elke waarde staat op een regel: witruimte wordt platgeslagen, zodat een adres met een
//    regeleinde het blok niet uit elkaar trekt.
// 3. `Soort` zegt waar het om gaat en `Nummer` draagt het voorvoegsel mee (L- voor een lead, B-
//    voor een bestelling). Zo leest een parser de leadmail en de bestelmelding met dezelfde code,
//    zonder de nummers te verwarren.
//
// Dezelfde afspraken en dezelfde veldenlijst staan in de centrale dienst (gateway/leads.py in
// ai_adviseur_centraal). Verandert er hier iets, dan daar ook -- anders krijgt de partner alsnog
// twee formaten.
//
// LET OP: `Nummer` is leeg bij een lead uit deze runtime. Die krijgt zijn nummer pas van de
// centrale dienst, en dat melden gebeurt na het mailen, zodat een storing daar de bezoeker niet
// laat wachten. Het e-mailadres is de sleutel waarop gematcht wordt; dat is ook de unieke sleutel
// van de klantentabel en het enige gegeven dat bij een lead en bij een bestelling aanwezig is.

export const START = "--- GEGEVENS (machineleesbaar; deze regels niet wijzigen) ---";
export const EINDE = "--- EINDE GEGEVENS ---";
export const VELDEN = ["Soort", "Nummer", "Naam", "E-mail", "Telefoon", "Adres", "Partner", "Bron", "Aangemaakt"];
export const LEAD_VOORVOEGSEL = "L-";
export const BESTEL_VOORVOEGSEL = "B-";

/** Een regel zonder besturingstekens; anders breekt een waarde het blok open. */
export function eenRegel(waarde) {
  if (waarde === undefined || waarde === null) return "";
  // Besturingstekens worden een spatie; daarna slaat de split op whitespace alles plat.
  // JS rekent ook U+2028 en U+2029 (regelscheiders) als whitespace, en die zouden het blok
  // anders in tweeen trekken bij een lezer die ze als regeleinde opvat.
  // eslint-disable-next-line no-control-regex
  // Drie streepjes achter elkaar worden er een. Zonder dit kan een bezoeker met
  // "--- EINDE GEGEVENS ---" in zijn naam het blok vroegtijdig afsluiten, en leest een
  // parser de velden daarna niet meer. Beide markeringen hebben die drie streepjes nodig.
  return String(waarde).replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
    .replace(/-{3,}/g, "-")
    .split(/\s+/).join(" ").trim();
}

/** Het blok: elk veld uit VELDEN, in die volgorde, ook leeg. */
export function gegevensblok(waarden = {}) {
  const regels = [START];
  for (const veld of VELDEN) {
    const waarde = eenRegel(waarden[veld]);
    regels.push(waarde ? veld + ": " + waarde : veld + ":");
  }
  regels.push(EINDE);
  return regels.join("\n");
}

/** De adresregel van een bestelling, zoals de rapportmail hem ook opbouwt. */
export function adresVanOrder(order) {
  const a = order?.address || {};
  const nummer = [a.housenumber, a.houseletter, a.houseaddition].filter(Boolean).map((s) => String(s).trim()).join("");
  return String(a.addr_line || [a.postalcode, nummer].filter(Boolean).join(" ")).trim();
}
