// test/gegevenspoort_venster.test.js
//
// De twee standen van het contactvenster, echt uitgevoerd.
//
// WAAROM NIET OP TEKST GECONTROLEERD
// contactvenster_teksten.test.js leest de broncode, met de reden erbij: er was geen DOM.
// Voor deze twee standen is dat niet genoeg. `zetStand()` zoekt rijen op via closest()
// en zet display om; een selector die niets raakt is precies de fout die een leescontrole
// doorlaat, en het gevolg is dat de poort niet poort -- de bezoeker komt er zonder zijn
// gegevens langs, of de toestemmingsvraag verschijnt waar niemand om toestemming vraagt.
//
// Daarom een kleine DOM-nabootsing. Geen jsdom: dit bestand gebruikt een handvol
// DOM-functies, en een afhankelijkheid erbij voor een test is duurder dan die paar regels.
// Wat de nabootsing NIET dekt staat onderaan.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const WORTEL = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BRON = fs.readFileSync(path.join(WORTEL, "assets", "contact_modal.js"), "utf-8");

// ── Een DOM, net genoeg ───────────────────────────────────────────────────────

class El {
  constructor(tag, attrs = {}) {
    this.tagName = String(tag).toUpperCase();
    this.attrs = { ...attrs };
    this.kinderen = [];
    this.ouder = null;
    this.style = { cssText: "", display: "" };
    this.listeners = {};
    this.value = attrs.value || "";
    this.checked = false;
    this.textContent = "";
    // De code zet de inleidende zin met innerHTML. Zonder deze koppeling landt die op een
    // losse eigenschap en blijft textContent leeg -- dan meet de test niets en is hij groen
    // om de verkeerde reden.
    Object.defineProperty(this, "innerHTML", {
      get: () => this.textContent,
      set: (v) => { this.textContent = String(v).replace(/<[^>]*>/g, ""); },
      configurable: true,
    });
    this.classes = new Set(String(attrs.class || "").split(/\s+/).filter(Boolean));
    this.classList = {
      add: (c) => this.classes.add(c),
      remove: (c) => this.classes.delete(c),
      contains: (c) => this.classes.has(c),
    };
  }
  get type() { return this.attrs.type || ""; }
  set type(v) { this.attrs.type = v; }
  get hidden() { return "hidden" in this.attrs; }
  get dataset() {
    const uit = {};
    for (const [k, v] of Object.entries(this.attrs)) {
      if (k.startsWith("data-")) {
        uit[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v;
      }
    }
    return uit;
  }
  // offsetParent is wat de echte browser gebruikt om "zichtbaar" te bepalen; hier:
  // zichtbaar zolang niemand in de keten display:none heeft.
  get offsetParent() {
    for (let el = this; el; el = el.ouder) if (el.style.display === "none") return null;
    return this.ouder;
  }
  append(kind) { kind.ouder = this; this.kinderen.push(kind); }
  appendChild(kind) { this.append(kind); }
  insertBefore(kind, voor) {
    kind.ouder = this;
    const i = this.kinderen.indexOf(voor);
    this.kinderen.splice(i < 0 ? this.kinderen.length : i, 0, kind);
  }
  get parentNode() { return this.ouder; }
  get parentElement() { return this.ouder; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  removeAttribute(k) { delete this.attrs[k]; }
  getAttribute(k) { return this.attrs[k] ?? null; }
  addEventListener(soort, fn) { (this.listeners[soort] ||= []).push(fn); }
  focus() { domDoc.activeElement = this; }
  reset() { for (const el of this.alles()) if ("value" in el) el.value = ""; }
  get elements() {
    const uit = {};
    for (const el of this.alles()) if (el.attrs.name) uit[el.attrs.name] = el;
    return new Proxy(uit, { get: (t, k) => t[k] });
  }
  alles() {
    const uit = [];
    for (const k of this.kinderen) { uit.push(k); uit.push(...k.alles()); }
    return uit;
  }
  past(sel) {
    for (const deel of sel.split(",").map((s) => s.trim()).filter(Boolean)) {
      if (deel.startsWith("[") && deel.endsWith("]")) {
        const [k, v] = deel.slice(1, -1).split("=");
        const naam = k.trim();
        if (v === undefined) { if (naam in this.attrs) return true; }
        else if (this.attrs[naam] === v.replace(/^['"]|['"]$/g, "")) return true;
      } else if (deel.startsWith("#")) {
        if (this.attrs.id === deel.slice(1)) return true;
      } else if (deel.startsWith(".")) {
        if (this.classes.has(deel.slice(1))) return true;
      } else if (deel.toUpperCase() === this.tagName) return true;
    }
    return false;
  }
  querySelector(sel) { return this.alles().find((el) => el.past(sel)) || null; }
  querySelectorAll(sel) { return this.alles().filter((el) => el.past(sel)); }
  closest(sel) {
    for (let el = this; el; el = el.ouder) if (el.past(sel)) return el;
    return null;
  }
}

let domDoc;

/** De opbouw van het venster zoals mid_start.html hem heeft. */
function maakPagina() {
  const body = new El("body");
  const modal = new El("div", { "data-contact-modal": "" });
  body.append(modal);
  modal.append(new El("h2", { id: "contactModalTitle" }));
  const form = new El("form", { "data-contact-form": "" });
  modal.append(form);
  form.append(new El("p", { class: "contactModal__lead" }));
  form.append(new El("div", { class: "contactModal__sectionLabel" }));
  const grid = new El("div", { class: "contactModal__grid" });
  form.append(grid);
  for (const naam of ["firstName", "lastName", "email", "phone"]) {
    const rij = new El("div", { class: "contactModal__field" });
    rij.append(new El("input", { name: naam }));
    grid.append(rij);
  }
  const berichtRij = new El("div", { class: "contactModal__field" });
  berichtRij.append(new El("textarea", { name: "message" }));
  form.append(berichtRij);
  form.append(new El("input", { name: "sourcePage", type: "hidden" }));
  form.append(new El("input", { name: "website", type: "hidden" }));
  const acties = new El("div", { class: "contactModal__actions" });
  acties.append(new El("button", { "data-contact-submit": "" }));
  form.append(acties);
  modal.append(new El("div", { "data-contact-success": "", hidden: "" }));
  modal.append(new El("div", { "data-contact-error": "", hidden: "" }));

  // De echte browser laat een veld ook als eigenschap van het formulier opvragen
  // (form.firstName). contact_modal.js leest het zo, dus zonder deze regels zag het
  // overal lege waarden en stopte de verzending op de eigen controle -- met vier rode
  // tests die alle vier "er is niets verstuurd" zeiden en niet waarom.
  for (const el of form.alles()) {
    if (el.attrs.name) Object.defineProperty(form, el.attrs.name, { get: () => el, configurable: true });
  }

  domDoc = {
    body,
    activeElement: null,
    readyState: "complete",
    listeners: {},
    querySelector: (s) => body.querySelector(s),
    querySelectorAll: (s) => body.querySelectorAll(s),
    addEventListener(soort, fn) { (this.listeners[soort] ||= []).push(fn); },
    createElement: (tag) => new El(tag),
    dispatchEvent: () => true,
  };
  return { body, modal, form };
}

/** Laadt contact_modal.js in een eigen context en geeft de haken terug. */
async function laadVenster({ leadTekst = "Ik ga ermee akkoord dat WoonWijzerWinkel mijn gegevens ontvangt." } = {}) {
  const pagina = maakPagina();
  const opslag = new Map();
  const verzonden = [];
  const context = {
    document: domDoc,
    sessionStorage: {
      getItem: (k) => (opslag.has(k) ? opslag.get(k) : null),
      setItem: (k, v) => opslag.set(k, String(v)),
      removeItem: (k) => opslag.delete(k),
    },
    fetch: async (url, opties) => {
      if (String(url) === "/api/tenant") {
        return { json: async () => ({ lead: { tekst: leadTekst }, contact: { email: "info@www.nl" } }) };
      }
      verzonden.push(JSON.parse(opties.body));
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    },
    setTimeout,
    clearTimeout,
    JSON,
    Object,
    URLSearchParams,
    CustomEvent: class { constructor(soort, init) { this.type = soort; this.detail = init?.detail; } },
    console,
    location: { search: "" },
  };
  context.window = context;
  vm.runInNewContext(BRON, context);
  // plaatsToestemming() is async: even de microtasks laten lopen.
  await new Promise((r) => setTimeout(r, 0));
  return {
    ...pagina,
    verzonden,
    opslag,
    open: (bron) => context.openContactModal(bron),
    verstuur: async () => {
      for (const fn of pagina.form.listeners.submit || []) await fn({ preventDefault() {} });
    },
    zichtbaar: (sel) => pagina.modal.querySelector(sel)?.offsetParent !== null,
  };
}

const VELD = (naam) => "[name=" + naam + "]";

function vul(form, waarden) {
  for (const [k, v] of Object.entries(waarden)) form.elements[k].value = v;
}

// ── Stand 1: de poort ─────────────────────────────────────────────────────────

test("de poort vraagt gegevens en géén toestemming", async () => {
  const v = await laadVenster();
  v.open("rapport_toegang");

  assert.ok(v.zichtbaar(VELD("firstName")), "naam hoort gevraagd te worden");
  assert.ok(v.zichtbaar(VELD("phone")), "telefoonnummer hoort gevraagd te worden");
  assert.equal(v.zichtbaar("[data-contact-akkoord-rij]"), false,
    "de poort vraagt geen toestemming: die hoort bij de rapportaanvraag, en een vinkje dat " +
    "je moet zetten om de tool te gebruiken is geen vrije toestemming");
  assert.equal(v.zichtbaar(VELD("message")), false, "de bezoeker heeft nog niets om op te merken");
});

test("de poortaanvraag meldt zichzelf, zodat de runtime hem niet mailt", async () => {
  const v = await laadVenster();
  v.open("rapport_toegang");
  vul(v.form, { firstName: "Jan", lastName: "Jansen", email: "jan@voorbeeld.nl", phone: "0612345678" });
  await v.verstuur();

  assert.equal(v.verzonden.length, 1);
  assert.equal(v.verzonden[0].context?.productType, "rapport_toegang");
  assert.equal(v.verzonden[0].akkoord, false, "geen vinkje in de poort, dus geen toestemming");
  assert.equal(v.verzonden[0].email, "jan@voorbeeld.nl");
});

// ── Stand 2: alleen toestemming ───────────────────────────────────────────────

test("na de poort vraagt het venster alleen nog toestemming", async () => {
  const v = await laadVenster();
  v.open("rapport_toegang");
  vul(v.form, { firstName: "Jan", lastName: "Jansen", email: "jan@voorbeeld.nl", phone: "0612345678" });
  await v.verstuur();

  v.open("mid_report_full_cta");
  assert.equal(v.zichtbaar(VELD("firstName")), false, "de gegevens kennen we al");
  assert.equal(v.zichtbaar(VELD("phone")), false);
  assert.ok(v.zichtbaar("[data-contact-akkoord-rij]"), "dit is de expliciete toestemmingsvraag");
  assert.equal(v.form.elements.email.value, "jan@voorbeeld.nl",
    "de bewaarde gegevens horen mee te gaan, anders hangt de lead aan een lege klant");
});

test("de toestemming blijft een vrije keuze: zonder vinkje gaat de aanvraag door", async () => {
  // Het rapport hangt hier niet aan. Een toestemming die je moet geven om de dienst te
  // krijgen is geen toestemming, en de privacyverklaring van deze runtime belooft het
  // tegendeel: "opvolging -- ALLEEN als u daar toestemming voor geeft".
  const v = await laadVenster();
  v.open("rapport_toegang");
  vul(v.form, { firstName: "Jan", lastName: "Jansen", email: "jan@voorbeeld.nl", phone: "0612345678" });
  await v.verstuur();

  v.open("mid_report_full_cta");
  await v.verstuur();
  assert.equal(v.verzonden.length, 2);
  assert.equal(v.verzonden[1].akkoord, false);
  assert.equal(v.verzonden[1].context?.productType, undefined, "dit is geen poortaanvraag meer");
});

test("mét vinkje gaat de toestemming mee", async () => {
  const v = await laadVenster();
  v.open("rapport_toegang");
  vul(v.form, { firstName: "Jan", lastName: "Jansen", email: "jan@voorbeeld.nl", phone: "0612345678" });
  await v.verstuur();

  v.open("mid_report_full_cta");
  v.modal.querySelector("[data-contact-akkoord]").checked = true;
  await v.verstuur();
  assert.equal(v.verzonden[1].akkoord, true);
});

// ── De teksten ────────────────────────────────────────────────────────────────

test("de poort belooft geen contact, want dat is hier niet aan de orde", async () => {
  // Zonder eigen teksten stond hier het gewone contactvenster: "Wilt u uw rapport
  // bespreken met een adviseur? Laat uw gegevens achter, dan nemen wij contact met u op."
  // De bezoeker heeft op dat moment nog geen rapport gezien, vraagt niet om contact, en
  // wij beloven het hier juist NIET -- dat is de aparte vraag bij het rapport.
  const v = await laadVenster();
  v.open("rapport_toegang");
  const kop = v.modal.querySelector("#contactModalTitle")?.textContent || "";
  const lead = v.modal.querySelector(".contactModal__lead")?.textContent || "";
  const knop = v.modal.querySelector("[data-contact-submit]")?.textContent || "";
  assert.doesNotMatch(kop + " " + lead, /nemen wij zo spoedig mogelijk contact/);
  assert.match(lead, /hier gebeurt dat nog niet/);
  assert.equal(knop, "Doorgaan", "er wordt niets verstuurd naar iemand");
});

test("een gewoon contactverzoek houdt zijn eigen teksten", async () => {
  const v = await laadVenster();
  v.open("rapport_toegang");
  v.open("");
  const lead = v.modal.querySelector(".contactModal__lead")?.textContent || "";
  assert.doesNotMatch(lead, /hier gebeurt dat nog niet/, "de poorttekst mag niet blijven hangen");
});

// ── De stand mag niet blijven hangen ──────────────────────────────────────────

test("een gewoon contactverzoek vraagt alles weer, ook na een poortaanvraag", async () => {
  // Dit is de fout waar deze test voor staat: wat in de ene stand dichtging bleef dicht.
  // Dan vraagt de poort geen naam meer, of het contactformulier geen opmerking.
  const v = await laadVenster();
  v.open("rapport_toegang");
  assert.equal(v.zichtbaar(VELD("message")), false);

  v.open("");
  assert.ok(v.zichtbaar(VELD("message")), "het opmerkingenveld hoort terug te komen");
  assert.ok(v.zichtbaar(VELD("firstName")), "en de naam ook, zolang de poort niet gelopen heeft");
  assert.ok(v.zichtbaar("[data-contact-akkoord-rij]"));
});

// ── WAT DEZE NABOOTSING NIET DEKT ─────────────────────────────────────────────
//
// Geen opmaak, dus niet of een veld werkelijk uit beeld is (display:none wordt hier
// geloofd, niet gerenderd), geen focus-trap, geen echte klikdoelen en geen iframe-hoogte.
// Die horen bij een doorloop in de browser op de tenant zelf. Wat hier staat is het
// gedrag dat stil fout kan gaan: welke vraag er in welke stand wordt gesteld, en wat er
// naar /api/lead gaat.
