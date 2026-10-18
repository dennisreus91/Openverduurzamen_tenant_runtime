// lib/overdracht.js
//
// De overdracht: een partner (Softbee) stuurt het .epa-bestand van zijn
// adviseur naar ons, krijgt een link terug, en vanaf die link loopt de
// adviseur bij ons verder -- controle, snel rapport, bestellen, mail.
//
// WAAROM EEN EIGEN INGANG EN NIET /api/full/handoff
// De handoff neemt een al uitgelezen model aan, deelt één sleutel met de
// browserroute en staat open als die sleutel ontbreekt. Hier komt een ruw
// bestand van buiten binnen, dat wij zelf uitlezen, en elke link is een recht
// om op rekening van de partner te bestellen. Dus: zonder sleutel staat de
// ingang dicht, niet open.
//
// WAAROM OP REKENING EN NIET VIA MOLLIE
// Besluit Dennis, 18 oktober 2026: de adviseur betaalt niet bij ons. Wij
// factureren de partner per geleverd rapport, de partner factureert zijn
// adviseur achteraf met de rest van wat die afneemt. Daarom krijgt de partner
// een melding (webhook) per bestelling en per levering: zonder die melding
// weet hij niet wie hij wat moet rekenen.
//
// Deze module bevat alleen wat zonder Express te testen is: de sleutel, de
// controle van de invoer, de terug-URL en de webhook. De routes staan in
// index.js.

import crypto from "crypto";

/** De geldige partnersleutels. Komma-gescheiden, zodat roteren zonder gat kan. */
function sleutels() {
  return String(process.env.OVERDRACHT_API_KEY || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Staat de overdracht aan? Zonder sleutel niet: dan weigert de ingang alles. */
export function overdrachtAan() {
  return sleutels().length > 0;
}

/** De sleutel uit het verzoek: `x-api-key` of `Authorization: Bearer`. */
export function sleutelUitVerzoek(req) {
  const x = String(req.header?.("x-api-key") || "").trim();
  if (x) return x;
  const auth = String(req.header?.("authorization") || "").trim();
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  return m ? m[1].trim() : "";
}

/**
 * Klopt de sleutel? In constante tijd: beide kanten eerst door sha256, zodat
 * ook de lengte niets verraadt.
 */
export function sleutelKlopt(gegeven) {
  if (!gegeven) return false;
  const a = crypto.createHash("sha256").update(String(gegeven)).digest();
  let goed = false;
  for (const s of sleutels()) {
    const b = crypto.createHash("sha256").update(s).digest();
    if (crypto.timingSafeEqual(a, b)) goed = true;
  }
  return goed;
}

// Kenmerken van de partner: alleen tekens die in een URL, een CSV en een log
// geen kwaad kunnen. Geen namen; een kenmerk is een nummer uit zijn systeem.
const KENMERK_RE = /^[A-Za-z0-9._:-]{1,100}$/;
const EMAIL_RE = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/;

/**
 * De hosts waar de terugknop heen mag. Uit OVERDRACHT_TERUG_HOSTS, anders uit
 * de tenantconfig (`overdracht.terugHosts`). Een host telt ook voor zijn
 * subdomeinen: "softbee.nl" laat "app.softbee.nl" toe.
 */
export function terugHosts(config) {
  const uitEnv = String(process.env.OVERDRACHT_TERUG_HOSTS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const lijst = uitEnv.length ? uitEnv : Array.isArray(config?.overdracht?.terugHosts) ? config.overdracht.terugHosts : [];
  return lijst.map((h) => String(h).toLowerCase().replace(/^\.+|\.+$/g, "")).filter(Boolean);
}

/**
 * Mag deze terug-URL? Alleen https en alleen naar een host van de partner.
 * Anders is de link een open doorverwijzing: iemand maakt een overdracht met
 * een terugknop naar een nagemaakte inlogpagina.
 */
export function terugUrlToegestaan(url, hosts) {
  let u;
  try { u = new URL(String(url)); } catch { return false; }
  if (u.protocol !== "https:") return false;
  if (u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  return hosts.some((h) => host === h || host.endsWith(`.${h}`));
}

/**
 * Controleer de body van POST /api/epa/overdracht.
 *
 * @returns {{ velden: object, fouten: object }} `fouten` is leeg als alles klopt.
 */
export function valideerOverdracht(body, { hosts = [] } = {}) {
  const b = body && typeof body === "object" ? body : {};
  const fouten = {};
  const tekst = (v) => (typeof v === "string" ? v.trim() : "");

  const epa = tekst(b.epa_base64);
  if (!epa) fouten.epa_base64 = "Het .epa-bestand (base64) is verplicht.";

  const adviseurId = tekst(b.adviseur_id);
  if (!adviseurId) fouten.adviseur_id = "adviseur_id is verplicht.";
  else if (!KENMERK_RE.test(adviseurId)) fouten.adviseur_id = "adviseur_id: maximaal 100 tekens, alleen letters, cijfers en . _ : -";

  const email = tekst(b.adviseur_email).toLowerCase();
  if (!email) fouten.adviseur_email = "adviseur_email is verplicht.";
  else if (email.length > 254 || !EMAIL_RE.test(email)) fouten.adviseur_email = "adviseur_email is geen geldig e-mailadres.";

  const dossierId = tekst(b.dossier_id);
  if (dossierId && !KENMERK_RE.test(dossierId)) fouten.dossier_id = "dossier_id: maximaal 100 tekens, alleen letters, cijfers en . _ : -";

  const terugUrl = tekst(b.terug_url);
  if (terugUrl && !terugUrlToegestaan(terugUrl, hosts)) {
    fouten.terug_url = hosts.length
      ? `terug_url moet een https-adres zijn op ${hosts.join(", ")}.`
      : "terug_url is voor deze omgeving niet ingesteld.";
  }

  return {
    velden: {
      epa_base64: epa,
      adviseur_id: adviseurId,
      adviseur_email: email,
      dossier_id: dossierId || null,
      terug_url: terugUrl || null,
    },
    fouten,
  };
}

/** "a***@softbee.nl": genoeg om te herkennen, te weinig om te misbruiken. */
export function maskeerEmail(email) {
  const [naam, domein] = String(email || "").split("@");
  if (!naam || !domein) return "";
  return `${naam.slice(0, 1)}***@${domein}`;
}

// ---------------------------------------------------------------------------
// Webhook
// ---------------------------------------------------------------------------

export const MELDINGEN = ["rapport.besteld", "rapport.geleverd", "rapport.mislukt"];

const WEBHOOK_URL = () => String(process.env.OVERDRACHT_WEBHOOK_URL || "").trim();
const WEBHOOK_GEHEIM = () => String(process.env.OVERDRACHT_WEBHOOK_SECRET || "").trim();
const WEBHOOK_TIMEOUT_MS = () => Number(process.env.OVERDRACHT_WEBHOOK_TIMEOUT_MS || 10000);

/** Staat de webhook aan? Alleen met url en geheim: een ongetekende melding sturen we niet. */
export function webhookAan() {
  return Boolean(WEBHOOK_URL() && WEBHOOK_GEHEIM());
}

/**
 * De handtekening: `t=<unix-seconden>,v1=<hex hmac-sha256 van "<t>.<body>">`.
 * De tijd zit in de handtekening, zodat een onderschepte melding niet later
 * opnieuw af te spelen is: de ontvanger weigert een `t` die te oud is.
 */
export function onderteken(body, geheim, tijd = Math.floor(Date.now() / 1000)) {
  const v1 = crypto.createHmac("sha256", geheim).update(`${tijd}.${body}`).digest("hex");
  return `t=${tijd},v1=${v1}`;
}

/**
 * De melding voor een bestelling uit een overdracht.
 *
 * Het id is vast per bestelling en soort: een herhaalde poging draagt
 * hetzelfde id, zodat de partner een dubbele melding kan herkennen en niet
 * twee keer factureert.
 */
export function bouwMelding(type, order, { rapportUrl = "", reden = "" } = {}) {
  const sm = order?.source_meta || {};
  const adres = order?.address || {};
  return {
    id: `${order.id}.${type}`,
    type,
    aangemaakt_op: new Date().toISOString(),
    data: {
      overdracht_id: sm.overdracht_id || null,
      adviseur_id: sm.adviseur_id || null,
      dossier_id: sm.dossier_id || null,
      bestelling_id: order.id,
      adres: {
        postcode: adres.postalcode || null,
        huisnummer: adres.housenumber || null,
        toevoeging: [adres.houseletter, adres.houseaddition].filter(Boolean).join("") || null,
      },
      besteld_op: order.created_at || null,
      ...(type === "rapport.geleverd" ? { geleverd_op: order.mailed_at || null, rapport_url: rapportUrl || null } : {}),
      ...(type === "rapport.mislukt" ? { reden: reden || "Het rapport kon niet worden opgemaakt." } : {}),
    },
  };
}

const wacht = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Verstuur een melding, met een paar korte herhalingen. Gooit niet: het
 * resultaat zegt of het lukte, en de herstelronde in index.js probeert een
 * mislukte melding later opnieuw.
 */
export async function verstuurMelding(melding, { fetchImpl = fetch, pauzes = [0, 2000, 8000] } = {}) {
  if (!webhookAan()) return { gelukt: false, pogingen: 0, fout: "webhook niet ingesteld" };
  const body = JSON.stringify(melding);
  let fout = "";
  let pogingen = 0;
  for (const pauze of pauzes) {
    if (pauze) await wacht(pauze);
    pogingen += 1;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), WEBHOOK_TIMEOUT_MS());
    try {
      const r = await fetchImpl(WEBHOOK_URL(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Overdracht-Event": melding.type,
          "X-Overdracht-Id": melding.id,
          "X-Overdracht-Signature": onderteken(body, WEBHOOK_GEHEIM()),
        },
        body,
        signal: abort.signal,
      });
      if (r.status >= 200 && r.status < 300) return { gelukt: true, pogingen, status: r.status };
      fout = `http ${r.status}`;
      // Een 4xx behalve 408/429 wordt bij herhalen niet beter.
      if (r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429) break;
    } catch (e) {
      fout = e?.name === "AbortError" ? "time-out" : String(e?.message || e).slice(0, 160);
    } finally {
      clearTimeout(timer);
    }
  }
  return { gelukt: false, pogingen, fout };
}
