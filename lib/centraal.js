// lib/centraal.js
//
// Een opgeleverde bestelling melden bij de centrale database van
// ai_adviseur_centraal, via zijn agent-API.
//
// WAAROM DOORSTUREN EN NIET RECHTSTREEKS SCHRIJVEN
// De eerste regel van die API is "Agents schrijven nooit direct in de
// database". Het schema, de migraties en de statusovergangen horen bij die
// dienst; twee diensten die één schema bezitten lopen uiteen. De tenant staat
// er ook al in als voorbeeld, in config/agents.yaml.
//
// WAAROM NA AFLOOP EN NIET IN HET BESTELPAD
// De runtime moet een bestelling kunnen aannemen als de centrale dienst plat
// ligt. De pdf staat op de lokale schijf en de downloadlink van 365 dagen
// wordt hier bediend, dus de uitvoering hoort lokaal. De centrale dienst is de
// administratie. Mislukt het melden, dan probeert de herstelronde het later en
// merkt de klant niets.
//
// WAAROM DRIE STAPPEN EN NIET ÉÉN
// De werkadministratie daar is een toestandsmachine, en `lever` mag alleen
// vanuit `in_behandeling` (gateway/store.py, bestelactie). Wij melden een
// bestelling die al helemaal klaar is, dus lopen we de route in één keer na:
// aanmaken als `betaald` (dat zet bevestigd_op), `start-poging`, `lever`. Elke
// stap die we overslaan laat de bestelling in een stand staan die niet waar is.
//
// LET OP BIJ HET LEZEN VAN DE ANTWOORDEN
// Een geweigerde stap is géén foutcode: /<id>/<actie> antwoordt 200 met
// {"gelukt": false}. Wie alleen naar de http-status kijkt, denkt dat hij
// geleverd heeft terwijl de bestelling op `aangemaakt` bleef staan. Daarom
// kijken we hier naar `gelukt`.
//
// Agent en partner komen uit de sleutel, nooit uit de body. Eén sleutel per
// partner dus; die hoort bij de tenant, niet bij de code.

const BASIS = () => String(process.env.CENTRAAL_API_URL || "").trim().replace(/\/+$/, "");
const SLEUTEL = () => String(process.env.CENTRAAL_API_SLEUTEL || "").trim();
const TIMEOUT_MS = Number(process.env.CENTRAAL_TIMEOUT_MS || 15000);

// Zoals de gateway hem accepteert (MOLLIE_RE). Een id dat hier niet aan
// voldoet laten we weg: anders wordt de hele bestelling geweigerd met een 400
// om een veld dat we ook gewoon niet hadden hoeven sturen.
const MOLLIE_RE = /^(tr|ord|sub)_[A-Za-z0-9]{4,60}$/;

/** Staat het melden aan? Zonder url of sleutel doet deze module niets. */
export function centraalAan() {
  return Boolean(BASIS() && SLEUTEL());
}

/** "12.95" uit 12.95, 12 of "12"; de API eist hoogstens twee decimalen. */
function bedrag(waarde) {
  const n = Number(waarde);
  return Number.isFinite(n) && n >= 0 ? n.toFixed(2) : "0.00";
}

/**
 * De bestelling zoals de centrale database hem wil hebben.
 *
 * `rapportlocatie` moet een verwijzing zijn (https:// of s3://), geen bestand:
 * we sturen de downloadlink die ook in de mail stond. Dat is precies het veld
 * waarvan we eerder vaststelden dat het bewaard moet blijven -- een verstuurde
 * link is een feit over de buitenwereld, niet iets om later af te leiden.
 *
 * `status: "betaald"` omdat we pas melden als het rapport verstuurd is. Een
 * gratis rapport is ook "betaald": het bedrag is dan 0,00 en er is niets meer
 * af te wikkelen. Er is geen aparte status voor, en het alternatief --
 * "aangemaakt" -- zou betekenen dat de bestelling nog op betaling wacht.
 */
export function bestellingPayload(order, config) {
  const product = String(config?.features?.centraalProduct || "volledig-verduurzamingsrapport");
  const mollie = String(order?.payment?.id || "");
  return {
    product,
    klant: { email: String(order?.email || "") },
    bedrag: bedrag(order?.amount_eur),
    valuta: "EUR",
    status: "betaald",
    ...(MOLLIE_RE.test(mollie) ? { mollie_payment_id: mollie } : {}),
    ...(order?.download_url ? { rapportlocatie: order.download_url } : {}),
    // De invoer waarop dit rapport rust, zodat een bestelling in het overzicht
    // navraagbaar is zonder de runtime erbij te halen.
    invoer: {
      order_id: order?.id || null,
      adres: order?.address || null,
      confirmed_data: order?.confirmed_data || null,
      bron: order?.source_meta?.source || null,
    },
  };
}

async function post(pad, body) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASIS()}${pad}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${SLEUTEL()}` },
      body: JSON.stringify(body ?? {}),
      signal: ac.signal,
    });
    let json = null;
    try {
      json = await res.json();
    } catch {}
    return { status: res.status, json };
  } finally {
    clearTimeout(t);
  }
}

/** Eén stap in de werkadministratie. Geweigerd = 200 met gelukt:false. */
async function stap(id, actie) {
  const uit = await post(`/api/v1/bestellingen/${encodeURIComponent(id)}/${actie}`, {});
  return {
    gelukt: uit.status === 200 && uit.json?.gelukt === true,
    status: uit.status,
    stand: uit.json?.bestelling?.status || null,
  };
}

/**
 * Meldt een opgeleverde bestelling. Gooit nooit: een storing bij de
 * administratie mag de keten niet raken. Geeft terug of het gelukt is en, bij
 * een afwijzing, wat de gateway erover zei -- die noemt in zijn foutmelding de
 * toegestane waarden, dus een eerste mislukking is zelf de documentatie.
 *
 * `gemeld` gaat over het bestaan van de bestelling; `status_bijgewerkt` over
 * de vraag of hij ook op `geleverd` staat. Die twee uit elkaar houden is het
 * verschil tussen een bestelling die kwijt is en een die alleen administratief
 * achterloopt.
 */
export async function meldBestelling(order, config) {
  if (!centraalAan()) return { gemeld: false, reden: "centraal_uit" };
  try {
    const aangemaakt = await post("/api/v1/bestellingen", bestellingPayload(order, config));
    if (aangemaakt.status !== 200 && aangemaakt.status !== 201) {
      return {
        gemeld: false,
        reden: `aanmaken_${aangemaakt.status}`,
        fouten: aangemaakt.json?.fouten || aangemaakt.json?.fout || null,
      };
    }
    const id = aangemaakt.json?.id ?? aangemaakt.json?.bestelling?.id ?? null;
    if (!id) return { gemeld: false, reden: "geen_id_in_antwoord" };

    // Stond hij er al (een herhaalde melding na een time-out), en is hij daar
    // al geleverd, dan is er niets meer te doen.
    if (aangemaakt.json?.status === "geleverd") return { gemeld: true, id, status_bijgewerkt: true };

    // De bestelling is hier al afgerond, dus we lopen de route in één keer na.
    // Mislukt een stap, dan staat hij er wél in en loopt alleen de status
    // achter -- een administratief verschil, geen verloren bestelling.
    const gestart = await stap(id, "start-poging");
    if (!gestart.gelukt) {
      return { gemeld: true, id, status_bijgewerkt: false, geweigerd_bij: "start-poging", stand: gestart.stand };
    }
    const geleverd = await stap(id, "lever");
    return {
      gemeld: true,
      id,
      status_bijgewerkt: geleverd.gelukt,
      ...(geleverd.gelukt ? {} : { geweigerd_bij: "lever", stand: geleverd.stand }),
    };
  } catch (e) {
    return {
      gemeld: false,
      reden: e?.name === "AbortError" ? "timeout" : "onbereikbaar",
      fout: String(e?.message || e).slice(0, 200),
    };
  }
}
