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
// De runtime moet een bestelling kunnen aannemen als de gateway plat ligt. De
// pdf staat op de lokale schijf en de downloadlink van 365 dagen wordt hier
// bediend, dus de uitvoering hoort lokaal. De gateway is de administratie.
// Mislukt het melden, dan probeert de herstelronde het later en merkt de klant
// niets.
//
// WAAROM ALLEEN DE OPLEVERING
// De agent-API kent de hele levenscyclus (bevestig, start-poging, lever,
// terugbetaald, rapportmail-opnieuw). Die afbeelden kan later; op 13 oktober
// 2026 is dat contract twee dagen oud en veranderden de statusovergangen nog
// diezelfde dag. Eén melding van een voltooide bestelling raakt alleen het
// stabielste deel -- aanmaken -- en levert het centrale overzicht meteen op.
//
// Agent en partner komen uit de sleutel, nooit uit de body. Eén sleutel per
// partner dus; die hoort bij de tenant, niet bij de code.

const BASIS = () => String(process.env.CENTRAAL_API_URL || "").trim().replace(/\/+$/, "");
const SLEUTEL = () => String(process.env.CENTRAAL_API_SLEUTEL || "").trim();
const TIMEOUT_MS = Number(process.env.CENTRAAL_TIMEOUT_MS || 15000);

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
 */
export function bestellingPayload(order, config) {
  const product = String(config?.features?.centraalProduct || "volledig-verduurzamingsrapport");
  return {
    product,
    klant: { email: String(order?.email || "") },
    bedrag: bedrag(order?.amount_eur),
    valuta: "EUR",
    ...(order?.payment?.id ? { mollie_payment_id: order.payment.id } : {}),
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

/**
 * Meldt een opgeleverde bestelling. Gooit nooit: een storing bij de
 * administratie mag de keten niet raken. Geeft terug of het gelukt is en, bij
 * een afwijzing, wat de gateway erover zei -- die noemt in zijn foutmelding de
 * toegestane waarden, dus een eerste mislukking is zelf de documentatie.
 */
export async function meldBestelling(order, config) {
  if (!centraalAan()) return { gemeld: false, reden: "centraal_uit" };
  try {
    const aangemaakt = await post("/api/v1/bestellingen", bestellingPayload(order, config));
    if (aangemaakt.status !== 200 && aangemaakt.status !== 201) {
      return { gemeld: false, reden: `aanmaken_${aangemaakt.status}`, fouten: aangemaakt.json?.fouten || aangemaakt.json?.fout || null };
    }
    const id = aangemaakt.json?.id ?? aangemaakt.json?.bestelling?.id ?? null;
    if (!id) return { gemeld: false, reden: "geen_id_in_antwoord" };

    // De bestelling is al geleverd voordat wij hem melden. Lukt die stap niet,
    // dan staat hij er wel in en is alleen de status nog "aangemaakt" -- dat is
    // een administratief verschil, geen verloren bestelling.
    const geleverd = await post(`/api/v1/bestellingen/${encodeURIComponent(id)}/lever`, {});
    return {
      gemeld: true,
      id,
      status_bijgewerkt: geleverd.status === 200,
      ...(geleverd.status === 200 ? {} : { lever_status: geleverd.status, lever_fout: geleverd.json?.fout || null }),
    };
  } catch (e) {
    return { gemeld: false, reden: e?.name === "AbortError" ? "timeout" : "onbereikbaar", fout: String(e?.message || e).slice(0, 200) };
  }
}
