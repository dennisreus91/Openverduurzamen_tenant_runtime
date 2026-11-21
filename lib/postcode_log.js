// lib/postcode_log.js
//
// Elke ingevulde postcode, in onze eigen opslag, zodat te zien is welke postcodes
// uiteindelijk converteren (wens Dennis, 20 november 2026).
//
// WAT ER WORDT VASTGELEGD
// Per gebeurtenis een regel: tijdstip, postcode, de soort gebeurtenis en de tenant. Geen
// huisnummer, geen naam, geen e-mailadres: een postcode met zes tekens wijst gemiddeld
// zo'n twintig adressen aan en is daarmee geen persoonsgegeven op zichzelf. Voor de
// conversievraag is meer niet nodig.
//
//   opgezocht             het adres is opgezocht (/api/mid/lookup); de tool is gebruikt
//   rapport_gedownload    het snelle rapport is gedownload, met contactgegevens
//   volledig_aangevraagd  het volledige rapport is aangevraagd
//
// De conversie per postcode is dan het aantal downloads en aanvragen gedeeld door het
// aantal keer opgezocht.
//
// WAAROM EEN JSONL-BESTAND
// Zelfde schijf als de bestellingen (ORDERS_DATA_DIR). Toevoegen is één appendFileSync,
// zonder het hele bestand te herschrijven zoals feedback_store dat doet: dit groeit met
// elke bezoeker. Een regel van ~100 bytes; honderdduizend opzoekingen is 10 MB.
//
// Vastleggen mag de bezoeker nooit raken: elke fout hier wordt gelogd en ingeslikt.

import fs from "fs";
import path from "path";

export const GEBEURTENISSEN = ["opgezocht", "rapport_gedownload", "volledig_aangevraagd"];

function bestand() {
  const dir = process.env.ORDERS_DATA_DIR || "/var/data";
  return { dir, pad: path.join(dir, "postcode_log.jsonl") };
}

/** "3131 kz" -> "3131KZ"; null als het geen Nederlandse postcode is. */
export function normaliseerPostcode(ruw) {
  const pc = String(ruw ?? "").replace(/\s+/g, "").toUpperCase();
  return /^[1-9][0-9]{3}[A-Z]{2}$/.test(pc) ? pc : null;
}

/** Een regel toevoegen. Geeft true als het gelukt is; gooit nooit. */
export function legPostcodeVast({ postcode, gebeurtenis, tenant }) {
  try {
    const pc = normaliseerPostcode(postcode);
    if (!pc || !GEBEURTENISSEN.includes(gebeurtenis)) return false;
    const { dir, pad } = bestand();
    fs.mkdirSync(dir, { recursive: true });
    const regel = JSON.stringify({ ts: new Date().toISOString(), postcode: pc, gebeurtenis, tenant: String(tenant || "") });
    fs.appendFileSync(pad, regel + "\n", "utf-8");
    return true;
  } catch (e) {
    console.warn("[postcode_log] vastleggen mislukt:", e?.message || e);
    return false;
  }
}

/** Alle regels, eventueel vanaf een datum. Kapotte regels worden overgeslagen. */
export function leesPostcodes({ vanaf } = {}) {
  const { pad } = bestand();
  if (!fs.existsSync(pad)) return [];
  const grens = vanaf ? Date.parse(vanaf) : NaN;
  const uit = [];
  for (const regel of fs.readFileSync(pad, "utf-8").split("\n")) {
    if (!regel.trim()) continue;
    try {
      const r = JSON.parse(regel);
      if (Number.isFinite(grens) && !(Date.parse(r.ts) >= grens)) continue;
      uit.push(r);
    } catch (_) { /* half geschreven regel na een herstart */ }
  }
  return uit;
}

/**
 * Per postcode (of per PC4 bij niveau "pc4"): aantallen per gebeurtenis en de conversie.
 * Gesorteerd op aantal keer opgezocht, hoogste eerst.
 */
export function postcodeOverzicht(regels, { niveau = "postcode" } = {}) {
  const per = new Map();
  for (const r of regels) {
    const sleutel = niveau === "pc4" ? String(r.postcode).slice(0, 4) : r.postcode;
    if (!per.has(sleutel)) per.set(sleutel, { postcode: sleutel, opgezocht: 0, rapport_gedownload: 0, volledig_aangevraagd: 0, eerst: r.ts, laatst: r.ts });
    const rij = per.get(sleutel);
    if (r.gebeurtenis in rij) rij[r.gebeurtenis] += 1;
    if (r.ts < rij.eerst) rij.eerst = r.ts;
    if (r.ts > rij.laatst) rij.laatst = r.ts;
  }
  return [...per.values()]
    .map((rij) => ({
      ...rij,
      conversie: rij.opgezocht
        ? Math.round(((rij.rapport_gedownload + rij.volledig_aangevraagd) / rij.opgezocht) * 1000) / 1000
        : null,
    }))
    .sort((a, b) => b.opgezocht - a.opgezocht || a.postcode.localeCompare(b.postcode));
}

/** Het overzicht als CSV (puntkomma, zodat Excel in het Nederlands het meteen opent). */
export function alsCsv(rijen) {
  const kop = ["postcode", "opgezocht", "rapport_gedownload", "volledig_aangevraagd", "conversie", "eerst", "laatst"];
  const regels = [kop.join(";")];
  for (const r of rijen) regels.push(kop.map((k) => (r[k] ?? "")).join(";"));
  return regels.join("\n") + "\n";
}
