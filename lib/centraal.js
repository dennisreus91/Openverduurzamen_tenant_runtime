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
// WAAROM VIER STAPPEN EN NIET ÉÉN
// De werkadministratie daar is een toestandsmachine (gateway/store.py,
// bestelactie): `bevestig` gaat van aangemaakt naar betaald, `start-poging`
// naar in_behandeling, en pas dan mag `lever`. Een nieuwe bestelling begint
// bovendien altijd als `aangemaakt` -- sinds 13 oktober 2026 weigert het
// aanmaken elke andere status met een 400. Wij melden een bestelling die al
// helemaal klaar is, dus lopen we die route in één keer na. Elke stap die we
// overslaan laat de bestelling in een stand staan die niet waar is.
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
 * De downloadlink van het rapport, als https-verwijzing.
 *
 * Een opgeslagen order heeft GEEN `download_url`-veld: die bestaat alleen in
 * de publieke weergave, en daar als relatief pad. De mail bouwt hem net zo als
 * hier, uit APP_BASE_URL en het token, in een lokale variabele die nergens
 * wordt bewaard. Wie `order.download_url` leest krijgt dus altijd undefined --
 * en dan verdwijnt juist het veld dat we wilden vastleggen, zonder melding.
 *
 * De gateway eist `s3://` of `https://`; een http-basis (lokaal) laten we
 * weg in plaats van de hele bestelling erop te laten stranden.
 */
function rapportLink(order) {
  const gegeven = String(order?.download_url || "");
  if (/^(https|s3):\/\//.test(gegeven)) return gegeven;
  const basis = String(process.env.APP_BASE_URL || "").trim().replace(/\/+$/, "");
  if (!/^https:\/\//.test(basis) || !order?.id || !order?.download_token) return null;
  return `${basis}/r/${encodeURIComponent(order.id)}?t=${encodeURIComponent(order.download_token)}`;
}

/**
 * De bestelling zoals de centrale database hem wil hebben.
 *
 * `rapportlocatie` moet een verwijzing zijn (https:// of s3://), geen bestand:
 * we sturen dezelfde downloadlink die ook in de mail stond -- zelf opgebouwd,
 * want hij staat niet op de order (zie rapportLink hierboven). Dat is precies het veld
 * waarvan we eerder vaststelden dat het bewaard moet blijven -- een verstuurde
 * link is een feit over de buitenwereld, niet iets om later af te leiden.
 *
 * Geen `status` in de body: die mag bij het aanmaken alleen `aangemaakt` zijn.
 * Naar `betaald` gaat het met de actie `bevestig`, hieronder. Een gratis
 * rapport loopt dezelfde route -- het bedrag is dan 0,00 en er is verder
 * niets af te wikkelen.
 */
export function bestellingPayload(order, config) {
  const product = String(config?.features?.centraalProduct || "volledig-verduurzamingsrapport");
  const mollie = String(order?.payment?.id || "");
  const link = rapportLink(order);
  return {
    product,
    klant: { email: String(order?.email || "") },
    bedrag: bedrag(order?.amount_eur),
    valuta: "EUR",
    ...(MOLLIE_RE.test(mollie) ? { mollie_payment_id: mollie } : {}),
    ...(link ? { rapportlocatie: link } : {}),
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

/**
 * Welke bestellingen de herstelronde deze keer meldt: opgeleverd, nog niet
 * gemeld, oudste eerst, hoogstens `max`.
 *
 * Staat hier en niet in index.js omdat juist de keuze fout kan gaan en de
 * ronde zelf in een closure zit die geen test kan aanroepen. De valkuil: de
 * ronde keek naar de 200 nieuwste bestellingen. Die grens hoort bij een
 * vastgelopen render -- altijd iets van vandaag -- maar een bestelling die de
 * centrale database nog niet kent kan juist oud zijn, en kwam voorbij plek 200
 * nooit meer aan de beurt.
 */
export function kiesTeMelden(orders, max = 25) {
  return (Array.isArray(orders) ? orders : [])
    .filter((o) => o && o.status === "mailed" && !o.centraal_gemeld_at)
    .sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")))
    .slice(0, Math.max(0, max));
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
    let stand = aangemaakt.json?.status || null;
    for (const actie of ["bevestig", "start-poging", "lever"]) {
      const uit = await stap(id, actie);
      stand = uit.stand || stand;
      if (!uit.gelukt) return { gemeld: true, id, status_bijgewerkt: false, geweigerd_bij: actie, stand };
    }
    return { gemeld: true, id, status_bijgewerkt: true };
  } catch (e) {
    return {
      gemeld: false,
      reden: e?.name === "AbortError" ? "timeout" : "onbereikbaar",
      fout: String(e?.message || e).slice(0, 200),
    };
  }
}

/**
 * Een lead zoals POST /api/v1/leads hem wil hebben.
 *
 * TOESTEMMING IS NIET OPTIONEEL
 * De centrale dienst weigert een lead zonder `toestemming: true` en zonder de tekst
 * waarmee de bezoeker instemde. Terecht: zonder vastgelegde instemming hoort een lead
 * daar niet te staan. Die tekst komt hier binnen als `toestemmingTekst` en gaat
 * letterlijk mee -- nooit samengevat en nooit verzonnen.
 *
 * `mailen: false`: de tenant mailt zijn lead zelf naar LEAD_EMAIL. Zou de centrale
 * dienst ook mailen, dan krijgt de partner elke lead twee keer.
 */
export function leadPayload(lead, config) {
  const klant = { email: String(lead?.email || "") };
  const naam = [lead?.firstName, lead?.lastName].filter(Boolean).join(" ").trim();
  if (naam) klant.naam = naam.slice(0, 200);
  if (lead?.phone) klant.telefoon = String(lead.phone).slice(0, 40);
  if (lead?.adres) klant.adres = String(lead.adres).slice(0, 300);

  const extra = {};
  if (lead?.sourcePage) extra.bron = String(lead.sourcePage).slice(0, 60);
  if (lead?.soort) extra.soort = String(lead.soort).slice(0, 60);
  if (lead?.mailStatus) extra.mail_status = String(lead.mailStatus).slice(0, 40);
  // Begrensd: het hele veld `extra` mag hoogstens 8 KB zijn.
  if (lead?.message) extra.bericht = String(lead.message).slice(0, 2000);

  return {
    klant,
    kanaal: String(config?.features?.centraalKanaal || `${config?.id || "tenant"}-formulier`).slice(0, 60),
    // DE WERKELIJKE STAND, niet een vaste true. Vandaag komt hier alleen een
    // lead mét toestemming langs, want meldLead() houdt de rest tegen -- maar
    // een hardgecodeerde true betekent dat de dag waarop die poort verdwijnt,
    // we de centrale database een toestemming melden die niet is gegeven. Dat
    // is een ernstiger fout dan een ontbrekende lead, en hij zou niemand
    // opvallen.
    toestemming: lead?.toestemming === true,
    toestemming_tekst: String(lead?.toestemmingTekst || ""),
    mailen: false,
    ...(Object.keys(extra).length ? { extra } : {}),
  };
}

/**
 * Meldt een lead bij de centrale database. Gooit nooit.
 *
 * Zonder toestemming gebeurt er niets: dat is geen storing maar een weigering die hier
 * thuishoort, niet bij de gateway. Zo kan deze code ook al draaien terwijl het
 * toestemmingsvinkje nog niet in elk formulier zit -- dan blijft de lead gewoon een
 * mail, zoals voorheen.
 */
export async function meldLead(lead, config) {
  if (!centraalAan()) return { gemeld: false, reden: "centraal_uit" };
  // OOK ZONDER TOESTEMMING MELDEN, sinds 28 oktober 2026.
  //
  // Hier stond een poort: zonder vinkje gebeurde er niets. Die stond er omdat
  // de centrale dienst de lead toch weigerde ("verplicht true: zonder
  // toestemming geen lead"). Het gevolg was dat zo'n lead alleen een mail was
  // en daarna uit beeld verdween -- niet te tellen, niet te matchen met wat de
  // partner meldt.
  //
  // De centrale dienst accepteert hem nu wel, en bewaart hem met
  // `toestemming: false`. Daar bepaalt die vlag vervolgens wat er NIET mag:
  // niet mailen, geen leadpartner. Zie gateway/agent_api.py in
  // ai_adviseur_centraal.
  //
  // Wat er bij toestemming WEL moet zijn is de tekst waarmee die is gegeven;
  // zonder die tekst weten we niet waar iemand ja op zei, en dan is de
  // toestemming niets waard.
  if (lead?.toestemming === true && !String(lead?.toestemmingTekst || "").trim()) {
    return { gemeld: false, reden: "toestemming_zonder_tekst" };
  }
  try {
    const uit = await post("/api/v1/leads", leadPayload(lead, config));
    if (uit.status !== 200 && uit.status !== 201) {
      return { gemeld: false, reden: `lead_${uit.status}`, fouten: uit.json?.fouten || uit.json?.fout || null };
    }
    return { gemeld: true, id: uit.json?.id ?? null };
  } catch (e) {
    return {
      gemeld: false,
      reden: e?.name === "AbortError" ? "timeout" : "onbereikbaar",
      fout: String(e?.message || e).slice(0, 200),
    };
  }
}
