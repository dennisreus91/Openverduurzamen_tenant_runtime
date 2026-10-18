// lib/gastlogins.js
//
// Extra inloggen naast het vaste account, met een eigen rapportlimiet.
//
// WAAROM DIT ER IS (18 oktober 2026)
// De tenant kende een account: WWW_INTERNAL_EMAIL + WWW_INTERNAL_PASSWORD.
// Bij OpenVerduurzamen staat de hele site daarachter (features.toegang), dus
// wie de tool wil laten zien moet dat ene wachtwoord delen. Dat heeft twee
// nadelen die allebei pas opvallen als het misgaat: je kunt de toegang van
// een gast niet intrekken zonder jezelf buiten te sluiten, en in het
// auditlog is niet te zien wie welk rapport heeft aangevraagd.
//
// Een gastlogin is daarom een gewoon account met twee verschillen:
//   - hij staat in een eigen omgevingsvariabele, dus intrekken is een regel
//     weghalen en herstarten;
//   - hij heeft een eigen dagelijkse rapportlimiet, los van het dagplafond
//     van de tenant. Elk volledig rapport kost ongeveer EUR 1,35 en achter
//     de login is dat gratis voor wie inlogt; het dagplafond van 100 is een
//     vangnet tegen ontsporing, geen rem die je aan een onbekende meegeeft.
//
// GEEN VERLOOPDATUM
// Bewust niet gebouwd: een datum die je bij het aanmaken invult is een datum
// die je bij het verlengen vergeet, en dan sta je met een klant aan de lijn
// die niet naar binnen kan. Intrekken is een handeling van tien seconden in
// het Render-dashboard.
//
// FORMAAT
//   GASTLOGINS="naam@klant.nl|WachtwoordHier|3"
//
// Meerdere accounts: een per regel, of gescheiden door een puntkomma. De
// velden zijn gescheiden door een rechte streep, omdat een dubbele punt in
// een wachtwoord gewoon voorkomt en een streep vrijwel nooit. Het derde veld
// (de dagelijkse rapportlimiet) mag weg; dan geldt GASTLOGIN_DAGMAX, en
// anders 3.
//
// Het wachtwoord staat in platte tekst in de omgevingsvariabele, net als dat
// van het vaste account. Dat is geen versimpeling voor de gelegenheid maar
// dezelfde keuze als hiernaast: er is geen gebruikersbeheer en geen database
// met accounts, en een hash zonder registratieproces voegt hier niets toe --
// wie de omgevingsvariabelen kan lezen is al binnen.

/** Waar niets is opgegeven: hoeveel volledige rapporten een gast per dag mag. */
export const GASTLOGIN_DAGMAX_STANDAARD = 3;

function standaardDagmax(env) {
  const n = Number(env.GASTLOGIN_DAGMAX);
  if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  return GASTLOGIN_DAGMAX_STANDAARD;
}

/**
 * Lees de gastaccounts uit de omgeving.
 *
 * @returns {{accounts: Array<{email: string, wachtwoord: string, dagmax: number}>,
 *            klachten: string[]}}
 *   `klachten` beschrijft regels die zijn overgeslagen. De aanroeper logt ze
 *   bij het opstarten: een typefout in een omgevingsvariabele hoort niet stil
 *   te eindigen in een account dat het niet doet.
 */
export function leesGastlogins(env = process.env) {
  const ruw = String(env.GASTLOGINS || "").trim();
  const accounts = [];
  const klachten = [];
  if (!ruw) return { accounts, klachten };

  const dagmaxStandaard = standaardDagmax(env);
  const regels = ruw.split(/[\n;]+/).map((r) => r.trim()).filter(Boolean);

  for (const regel of regels) {
    const velden = regel.split("|").map((v) => v.trim());
    const [email, wachtwoord, dagmaxRuw] = velden;

    if (velden.length < 2 || !email || !wachtwoord) {
      klachten.push(`overgeslagen (verwacht 'email|wachtwoord' of 'email|wachtwoord|dagmax'): ${korten(regel)}`);
      continue;
    }
    if (!email.includes("@")) {
      klachten.push(`overgeslagen (geen e-mailadres): ${korten(regel)}`);
      continue;
    }

    let dagmax = dagmaxStandaard;
    if (dagmaxRuw !== undefined && dagmaxRuw !== "") {
      const n = Number(dagmaxRuw);
      if (!Number.isFinite(n) || n < 0) {
        klachten.push(`dagmax '${dagmaxRuw}' niet te lezen voor ${email}; ${dagmaxStandaard} aangehouden`);
      } else {
        dagmax = Math.floor(n);
      }
    }

    const genormaliseerd = email.toLowerCase();
    if (accounts.some((a) => a.email === genormaliseerd)) {
      klachten.push(`${genormaliseerd} staat er twee keer in; de eerste telt`);
      continue;
    }
    accounts.push({ email: genormaliseerd, wachtwoord, dagmax });
  }

  return { accounts, klachten };
}

/**
 * Een regel kan een wachtwoord bevatten; dat hoort niet in het log.
 *
 * Alleen het deel voor de eerste streep komt erin, en alleen als die streep
 * er is. Staat er geen streep, dan is niet te zeggen wat de regel bevat --
 * misschien juist het wachtwoord -- en noemen we er niets van.
 */
function korten(regel) {
  if (!regel.includes("|")) return "een regel zonder streep";
  const email = regel.split("|")[0].trim();
  return email ? `'${email}|…'` : "een regel die met een streep begint";
}

export default { leesGastlogins, GASTLOGIN_DAGMAX_STANDAARD };
