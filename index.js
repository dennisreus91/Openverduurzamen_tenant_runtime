// @openverduurzamen/tenant-runtime — entrypoint
//
// Usage from a tenant app:
//
//   import { createTenantApp } from "@openverduurzamen/tenant-runtime";
//   import config from "./tenant.config.js";
//
//   const app = createTenantApp(config);
//   app.listen(process.env.PORT || 3000);
//
// One Render service = one tenant. No host-based routing, no per-tenant
// env-var suffixing. The tenant identity is implicit: it's whichever
// service this code is running inside.

import express from "express";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { Agent, fetch as undiciFetch } from "undici";

import {
  initOrdersStore,
  createOrder,
  getOrderById,
  getOrderByPaymentId,
  updateOrder,
  mergeOrder,
  buildOrderPublicView,
  newOrderId,
  newOrderToken,
  listOrders,
} from "./lib/orders_store.js";
import { createMolliePayment, getMolliePayment, mollieTestmodus, refundMolliePayment } from "./lib/mollie_client.js";
import { htmlToPdfBuffer } from "./lib/pdfbolt_client.js";
import { runtimeVersie } from "./lib/runtime_versie.js";
import { adviesAanvraagMail, losRapportHtml } from "./lib/advies_aanvraag.js";
import { sendReportEmail, sendLeadEmail, sendOrderAlertEmail, orderAlertsEnabled, sendMislukteOrderEmail } from "./lib/mail_client.js";
import { initPrefillStore, createPrefillSession, getPrefillSession } from "./lib/prefill_store.js";
import { initFeedbackStore, appendFeedback, listFeedback, feedbackStats } from "./lib/feedback_store.js";
import { centraalAan, kiesTeMelden, meldBestelling, meldLead } from "./lib/centraal.js";
import { rapportprofiel } from "./lib/rapportprofiel.js";
import {
  getCurrentMonthUsage,
  incrementInternalQuota,
  readQuotaState,
  getQuotaMax,
  getDagGebruik,
  verhoogDagteller,
} from "./lib/internal_quota.js";

// ---------------------------------------------------------------------------
// Long-running fetch dispatcher for the report-api render call.
// ---------------------------------------------------------------------------
const LONG_FETCH_HARD_CAP_MS = Number(process.env.FULL_APP_RENDER_TIMEOUT_MS || 1500000);

// Hoeveel bestellingen de herstelronde per keer bij de centrale database
// meldt. Drie aanroepen per bestelling, dus bij een achterstand loopt een
// ronde anders vol; de volgende ronde pakt de rest.
const CENTRAAL_PER_RONDE = Number(process.env.CENTRAAL_PER_RONDE || 25);
const longFetchAgent = new Agent({
  connect: { timeout: 20000 },
  headersTimeout: 0,
  bodyTimeout: 0,
  keepAliveTimeout: 60000,
  keepAliveMaxTimeout: LONG_FETCH_HARD_CAP_MS,
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// De map van de runtime zelf. Hieronder staat `templates/`, met de sjablonen
// die ELKE tenant krijgt zolang hij er geen eigen versie van meelevert -- nu
// alleen de privacyverklaring. Zie de toelichting bij `templates.privacy`.
const RUNTIME_DIR = path.dirname(fileURLToPath(import.meta.url));

function nowIso() { return new Date().toISOString(); }

function fillTemplate(text, vars = {}) {
  let out = String(text || "");
  for (const [k, v] of Object.entries(vars)) {
    out = out.split(`{{${k}}}`).join(String(v ?? ""));
  }
  return out;
}

/**
 * De partij die de bezoeker opvolgt, als dat een ANDER is dan de tenant zelf.
 *
 * Bij OpenVerduurzamen is dat WoonWijzerWinkel: de bezoeker geeft toestemming
 * om zijn gegevens met hen te delen. Bij een tenant zonder `adviesPartner`
 * gaat er niets naar buiten, en dan hoort de privacyverklaring dat ook niet te
 * beweren. Vandaar null in plaats van "val terug op de merknaam": die
 * terugval is goed voor een zin in het contactvenster, maar fout in een
 * verklaring over doorgifte.
 */
function opvolgPartner(config) {
  const partner = String(config?.report?.adviesPartner || "").trim();
  if (!partner) return null;
  if (partner.toLowerCase() === String(config?.brand?.name || "").trim().toLowerCase()) return null;
  return partner;
}

function htmlVeilig(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function privacyVars(config) {
  const partner = opvolgPartner(config);
  const p = htmlVeilig(partner || "");
  // Mollie staat er alleen als deze tenant ook werkelijk kan innen. De
  // Energie Raadgever factureert achteraf en heeft geen Mollie-sleutel; daar
  // zou de regel een verwerking noemen die niet plaatsvindt.
  const mollie = Boolean(String(process.env.MOLLIE_API_KEY || "").trim());
  return {
    PRIVACY_PARTNER_ROW: partner
      ? `<tr><td>${p}</td><td>uw naam, e-mailadres, telefoonnummer, het adres en het snelle rapport</td>` +
        `<td>opvolging — <strong>alleen</strong> als u daar toestemming voor geeft</td></tr>`
      : "",
    PRIVACY_PARTNER_BULLET: partner
      ? `<li><strong>Het rapport met onze partner bespreken.</strong> Als u daar bij de aanvraag ` +
        `toestemming voor geeft, ontvangt ${p} uw gegevens en neemt contact met u op. ` +
        `Grondslag: uw toestemming, die u altijd kunt intrekken.</li>`
      : `<li><strong>Niet doorgeven aan derden voor opvolging.</strong> Uw contactgegevens gaan ` +
        `niet naar een andere partij om u te benaderen.</li>`,
    PRIVACY_MOLLIE_ROW: mollie
      ? `<tr><td>Mollie</td><td>uw betaalgegevens en het bedrag</td><td>de betaling van het ` +
        `volledige rapport afhandelen</td></tr>`
      : "",
  };
}

function templateVars(config, extra = {}) {
  return {
    TENANT_ID: config?.id || "",
    TENANT_NAME: config?.brand?.name || "",
    TENANT_LEGAL_NAME: config?.brand?.legalName || config?.brand?.name || "",
    TENANT_ACCENT: config?.brand?.accentColor || "",
    TENANT_LOGO: config?.brand?.logoPath ? `/assets/${String(config.brand.logoPath).replace(/^\/+/, "")}` : "",
    TENANT_PHONE: config?.contact?.phone || "",
    TENANT_EMAIL: config?.contact?.email || "",
    TENANT_WEBSITE: config?.contact?.website || "",
    TENANT_ADDRESS: [config?.contact?.address1, config?.contact?.address2]
      .map((s) => String(s || "").trim()).filter(Boolean).join(", "),
    // De drie plekken in de gedeelde privacyverklaring die per tenant
    // verschillen. fillTemplate() kent geen "als", dus wat voorwaardelijk is
    // wordt hier uitgerekend en als kant-en-klaar stukje html doorgegeven.
    //
    // Ze staan hier en niet in de sjabloon omdat een privacyverklaring geen
    // dingen mag beweren die voor deze tenant niet gebeuren: een tenant die
    // niet doorgeeft aan een opvolgpartij hoort die regel niet te hebben, en
    // een tenant zonder Mollie-sleutel int geen betalingen.
    ...privacyVars(config),
    // Mag deze tenant een energielabel als PDF laten uploaden? Leeg betekent
    // nee. Hiermee kan het formulier het uploadvak verbergen in plaats van het
    // te tonen en daarna een 403 te vangen.
    //
    // Dit is NIET de afscherming: die zit in de report-api, die zonder de vlag
    // weigert. Dit is alleen de nette vorm -- een knop die niet werkt hoort er
    // niet te staan.
    LABEL_PDF_UPLOAD: extra.labelPdfUpload === true ? "1" : "",
    // Idem voor het .epa-bestand van een adviseur (de 0-meting). Zelfde vorm,
    // zelfde bedoeling: het vak verbergen in plaats van het te tonen en
    // daarna te laten mislukken.
    EPA_UPLOAD: extra.epaUpload === true ? "1" : "",
    PRODUCT_NAME: config?.product?.name || "Volledig Verduurzamingsinzicht",
    TERMS_PATH: config?.product?.termsPath || "/algemene-voorwaarden.html",
    ...extra,
  };
}

function safeAssetPath(assetsDir, requestedPath) {
  if (!assetsDir) return null;
  const cleaned = String(requestedPath || "").replace(/^\/+/, "");
  if (!cleaned) return null;
  const abs = path.normalize(path.join(assetsDir, cleaned));
  if (!abs.startsWith(path.normalize(assetsDir + path.sep))) return null;
  return fs.existsSync(abs) ? abs : null;
}

function readFileIfExists(p) {
  if (!p) return null;
  try { return fs.existsSync(p) ? fs.readFileSync(p, "utf-8") : null; } catch { return null; }
}

function logOrderPhase(orderId, phase, meta = {}) {
  const safeMeta = Object.fromEntries(Object.entries(meta).filter(([, v]) => v !== undefined));
  console.log(`[tenant-runtime][${orderId}] ${phase}${Object.keys(safeMeta).length ? ` ${JSON.stringify(safeMeta)}` : ''}`);
}

function normalizeAddressInput(input = {}) {
  return {
    postalcode: String(input.postalcode || "").toUpperCase().replace(/\s+/g, ""),
    housenumber: String(input.housenumber || "").trim(),
    houseaddition: String(input.houseaddition || "").trim(),
  };
}

function validateEmail(email) { return /^.+@.+\..+$/.test(String(email || "").trim()); }

function validateConfirmedDataBasic(data = {}) {
  const errors = {};
  const soort = String(data.soort_woning || "").trim();
  const label = String(data.energy_label || "").trim();
  const buildYear = Number(data.build_year);
  const floorArea = Number(data.floor_area_m2);
  const currentYear = new Date().getFullYear();
  if (!soort) errors.soort_woning = "Kies het soort woning.";
  if (!Number.isInteger(buildYear) || buildYear < 1800 || buildYear > currentYear) {
    errors.build_year = `Vul een geldig bouwjaar in tussen 1800 en ${currentYear}.`;
  }
  if (!Number.isFinite(floorArea) || floorArea < 10 || floorArea > 1000) {
    errors.floor_area_m2 = "Vul een geldig woonoppervlak in tussen 10 en 1000 m².";
  }
  if (!label) errors.energy_label = "Kies het huidige energielabel.";
  return errors;
}

// Grenzen op publiek bereikbare invoer. confirmed_data komt uit een formulier
// en belandt ook op de order, dus het mag niet onbeperkt groeien. Ruim boven
// wat het formulier stuurt (elf velden), zodat een nieuw veld er vanzelf
// doorheen komt.
const MAX_CONFIRMED_VELDEN = 40;
const MAX_CONFIRMED_TEKST = 200;
const MAX_CONFIRMED_LIJST = 50;

/**
 * confirmed_data klaarmaken voor de report-api en voor de order.
 *
 * WAAROM HIER GEEN EIGEN LIJST MEER STAAT
 * Dit was een handmatige witte lijst, en de kop van
 * test/confirmed_data_doorgifte.test.js legt uit waarom dat misging: wat er
 * niet in stond viel stil weg. Het snelle rapport geeft de body ongewijzigd
 * door, het volledige loopt langs deze functie -- dus kreeg dezelfde woning
 * twee rapporten die van elkaar verschilden. Twee keer gerepareerd door een
 * veld toe te voegen, ligging_appartement en verduurzamingsdoel, en beide
 * keren pas nadat het verschil al in rapporten zat.
 *
 * Een tweede lijst bijhouden is de fout; de beste manier om twee lijsten
 * synchroon te houden is er één hebben. De report-api bepaalt welke velden
 * bestaan en welke waarden mogen: validateConfirmedData() toetst tegen
 * lib/allowed.js, normaliseert bouwjaar en oppervlak, ontdubbelt de
 * maatregelen, en wijst af met veldfouten. Een veld dat daar bij komt
 * bereikt het volledige rapport nu vanzelf, en een onbekend veld geeft een
 * 400 in plaats van stilte.
 *
 * Wat hier overblijft is wat déze kant nodig heeft en de report-api niet kan
 * weten: het is publiek bereikbare invoer die ook bewaard wordt, dus begrensd
 * in aantal en omvang. Verder niets interpreteren.
 */
function normalizeConfirmedDataInput(data = {}) {
  const uit = {};
  let velden = 0;
  for (const [sleutel, waarde] of Object.entries(data || {})) {
    if (waarde === null || waarde === undefined || waarde === "") continue;
    if (++velden > MAX_CONFIRMED_VELDEN) break;
    if (Array.isArray(waarde)) {
      const lijst = Array.from(
        new Set(waarde.filter((x) => typeof x === "string" || typeof x === "number").map((x) => String(x).trim().slice(0, MAX_CONFIRMED_TEKST))),
      ).filter(Boolean);
      if (lijst.length) uit[sleutel] = lijst.slice(0, MAX_CONFIRMED_LIJST);
      continue;
    }
    if (typeof waarde === "object") continue;
    if (typeof waarde === "number" || typeof waarde === "boolean") {
      uit[sleutel] = waarde;
      continue;
    }
    const tekst = String(waarde).trim().slice(0, MAX_CONFIRMED_TEKST);
    if (!tekst) continue;
    // Een formulier levert getallen als tekst aan ("10"). Dat als getal
    // bewaren houdt de order leesbaar, en het is typewerk zonder kennis van
    // veldnamen -- precies wat hier wél thuishoort. Alleen als de tekst
    // exact terugkomt, zodat "007" een string blijft en geen 7 wordt.
    uit[sleutel] = String(Number(tekst)) === tekst ? Number(tekst) : tekst;
  }
  return uit;
}

// ---------------------------------------------------------------------------
// The factory: build a full Express app from a tenant config object.
// ---------------------------------------------------------------------------
/**
 * Het antwoord van POST /api/full/render uitlezen.
 *
 * Sinds de report-api het rapport ook bewaart, staan er twee velden bij:
 * `rapport_url` (de blijvende downloadlink) en `pdf_base64` (de pdf, zodat
 * deze tenant hem als bijlage kan versturen zonder zelf PDFBolt te bellen).
 * Een oudere report-api, of een sleutel zonder partnernaam, stuurt ze niet
 * mee -- dan blijven ze leeg en valt de verwerking terug op het oude pad.
 */
export function leesRenderAntwoord(json) {
  return {
    html: json?.html || json?.html_document || "",
    meta: json?.meta || null,
    rapportUrl: typeof json?.rapport_url === "string" ? json.rapport_url : "",
    pdfBytes: typeof json?.pdf_base64 === "string" && json.pdf_base64
      ? Buffer.from(json.pdf_base64, "base64")
      : null,
    pdfBestandsnaam: typeof json?.pdf_bestandsnaam === "string" ? json.pdf_bestandsnaam : "",
  };
}

/**
 * Welke downloadlink in de mail komt.
 *
 * De link van de report-api gaat voor: die overleeft het opschorten of
 * hernoemen van deze tenant, en de eigen /r/-link niet -- bij twee tenants is
 * dat al gebeurd. Is er geen centrale link, dan de eigen, zodat de klant
 * altijd iets krijgt. Is er geen van beide, dan een lege string; het
 * mailsjabloon laat het blok dan weg.
 */
export function kiesDownloadLink({ rapportUrl, basisUrl, orderId, downloadToken }) {
  const centraal = String(rapportUrl || "").trim();
  if (/^https:\/\//.test(centraal)) return centraal;
  const basis = String(basisUrl || "").trim().replace(/\/+$/, "");
  if (!basis || !orderId || !downloadToken) return "";
  return `${basis}/r/${orderId}?t=${downloadToken}`;
}

/**
 * De bestandsnaam van het rapport in de mail: verduurzamingsrapport-<adres>.pdf
 *
 * WAAROM DIT HET ADRES IS
 * Dit heette `<ordernummer>-<productnaam>.pdf`, bijvoorbeeld
 * "ord_8f2c1a-volledig-verduurzamingsrapport.pdf". Een ordernummer zegt de
 * bewoner niets, en wie twee woningen laat doorrekenen houdt twee bestanden
 * over die hij niet uit elkaar kan houden. De WoonWijzerWinkel-adviseur
 * noemde zijn pdf al naar het adres; dit trekt de ingangen gelijk
 * (opmerking Dennis, 15 oktober 2026).
 *
 * Het volledige adres komt uit meta.address_line van de report-api ("De
 * Savornin Lohmanplantsoen 29, 2253VM Voorschoten"). Ontbreekt dat, dan
 * postcode plus huisnummer uit de bestelling -- genoeg om de woning te
 * herkennen. Is er helemaal niets, dan "woning": een bestand zonder naam is
 * erger dan een vage naam.
 */
export function rapportBestandsnaam(order, renderMeta = null) {
  const nummer = [order?.address?.housenumber, order?.address?.houseaddition]
    .filter(Boolean).map((x) => String(x).trim()).join("");
  const adres = String(
    renderMeta?.address_line
    || order?.address?.addr_line
    || [order?.address?.postalcode, nummer].filter(Boolean).join(" ")
    || ""
  );
  const slug = adres
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return `verduurzamingsrapport-${slug || "woning"}.pdf`;
}

export function createTenantApp(config) {
  if (!config || typeof config !== "object") throw new Error("createTenantApp: config object required");
  if (!config.id) throw new Error("createTenantApp: config.id is required");

  // The "publicDir" is where the tenant repo keeps its templates and
  // assets. Tenant repos pass an absolute path; if absent we look for a
  // ./public next to the tenant repo's server.js.
  const publicDir = config.publicDir || path.join(process.cwd(), "public");
  const templatesDir = path.join(publicDir, "templates");
  const assetsDir = path.join(publicDir, "assets");

  // Pre-load templates once at boot. Tenants change templates rarely;
  // re-reading on every request would be wasteful.
  const templates = {
    fullStart:    readFileIfExists(path.join(templatesDir, "full_start.html")),
    fullDone:     readFileIfExists(path.join(templatesDir, "full_done.html")),
    terms:        readFileIfExists(path.join(templatesDir, "algemene-voorwaarden.html")),
    // De privacyverklaring is het ENIGE sjabloon met een gedeelde terugval.
    //
    // Waarom: het toestemmingsvinkje zegt "zie de privacyverklaring", en op
    // 17 oktober 2026 had geen van de vier tenants die pagina. De bezoeker gaf
    // naam, e-mailadres en telefoonnummer af onder een akkoord dat naar een
    // document verwees dat niet bestond. Met een terugval kan dat niet meer
    // gebeuren bij een tenant die er niet aan denkt -- en de keten die de
    // verklaring beschrijft is voor alle tenants dezelfde.
    //
    // Wat per tenant verschilt (merknaam, adres, opvolgpartner, Mollie) vult
    // privacyVars() in. Een tenant die een eigen tekst nodig heeft zet die
    // gewoon in zijn eigen templates-map; die gaat voor.
    privacy:      readFileIfExists(path.join(templatesDir, "privacyverklaring.html"))
                  || readFileIfExists(path.join(RUNTIME_DIR, "templates", "privacyverklaring.html")),
    email:        readFileIfExists(path.join(templatesDir, "email.html")),
    // Mid landing page — the free short report. When present, becomes
    // the default landing route at "/". Tenants who don't want a Mid
    // funnel just don't ship this template; "/" then falls through to
    // /full_start.html as before.
    midStart:     readFileIfExists(path.join(templatesDir, "mid_start.html")),
    // Onepager landing page — the single-A4-summary flow. When present,
    // takes precedence over Mid/Full at "/". This is what the
    // Energiepresatie tenant ships. The page POSTs to
    // /api/onepager/render and renders the returned html_fragment
    // inline (see the runtime's onepager proxy further down).
    onepagerStart: readFileIfExists(path.join(templatesDir, "onepager_start.html")),
    // Internal-flow templates (WoonWijzerWinkel staff-only, served at
    // /intern and /intern/full_start.html). Optional per tenant — if
    // absent, the /intern routes return 404 and the internal endpoints
    // do nothing useful. WWW ships both; other tenants won't.
    internLogin:     readFileIfExists(path.join(templatesDir, "intern_login.html")),
    internFullStart: readFileIfExists(path.join(templatesDir, "intern_full_start.html")),
  };

  // Storage paths
  const dataDir = process.env.ORDERS_DATA_DIR || "/var/data";
  const pdfDir = path.join(dataDir, "pdfs");
  fs.mkdirSync(pdfDir, { recursive: true });

  initOrdersStore();
  initPrefillStore();
  initFeedbackStore();

  const app = express();
  app.set("trust proxy", true);
  // EPA-carrying routes accept larger bodies: a base64 .epa inflates ~33% and
  // zipped 0-metingen can be several MB. Path-scoped parsers run BEFORE the
  // global 5mb parser; body-parser skips already-parsed bodies, so every other
  // endpoint keeps the tighter limit.
  app.use("/api/epa/ingest", express.json({ limit: "20mb" }));
  // Het energielabelrapport als PDF. Gemeten op drie echte labels: 600 kB tot
  // 940 kB, en base64 maakt dat ~33% groter. Ruim onder de 20mb, maar de
  // globale 5mb-parser zou een label met veel afbeeldingen alsnog kunnen
  // weigeren -- en dat zou eruitzien als een kapot bestand in plaats van een
  // te strakke limiet.
  app.use("/api/label-pdf/ingest", express.json({ limit: "20mb" }));
  app.use("/api/mid/stream", express.json({ limit: "20mb" }));
  app.use("/api/mid/full-report-handoff", express.json({ limit: "20mb" }));
  app.use("/api/full/handoff", express.json({ limit: "20mb" }));
  // Een geparste opname is groter dan het gewone formulier; met de standaard
  // van 5 MB zou een .epa met veel bouwdelen hier op een 413 stuiten.
  app.use("/api/internal/full/render", express.json({ limit: "20mb" }));
  app.use(express.json({ limit: "5mb" }));
  app.use(express.urlencoded({ extended: false }));

  // -------------------------------------------------------------------------
  // Internal helpers that close over `config`
  // -------------------------------------------------------------------------
  function getBaseUrl(req) {
    const configured = String(process.env.APP_BASE_URL || "").trim();
    if (configured) return configured.replace(/\/$/, "");
    const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
    const host = req.headers["x-forwarded-host"] || req.get("host") || "localhost:3000";
    return `${proto}://${host}`;
  }

  function requireHandoffKey(req, res, next) {
    const key = String(process.env.FULL_HANDOFF_API_KEY || "").trim();
    if (!key) return next();
    if (String(req.header("x-api-key") || "").trim() !== key) return res.status(401).json({ error: "Unauthorized" });
    next();
  }

  function requireAdminKey(req, res, next) {
    const key = String(process.env.ADMIN_API_KEY || "").trim();
    if (!key) return next();
    if (String(req.header("x-api-key") || "").trim() !== key) return res.status(401).json({ error: "Unauthorized" });
    next();
  }

  // ---------------------------------------------------------------------
  // Internal-flow auth (WoonWijzerWinkel staff use)
  //
  // Plain email + password from env, HMAC-signed cookie. Cookie expires
  // after 7 days. The session secret rotates the signing key — rotate
  // it to invalidate all sessions at once.
  // ---------------------------------------------------------------------
  const INTERNAL_COOKIE_NAME = "wwwintern";
  const INTERNAL_COOKIE_TTL_MS = 1000 * 60 * 60 * 24 * 7;

  function getInternalSecret() {
    const s = String(process.env.WWW_INTERNAL_SESSION_SECRET || "").trim();
    // Don't fall back to an empty secret — that would let anyone forge
    // cookies. If the secret isn't set we deliberately produce signatures
    // that will never verify.
    return s || crypto.randomBytes(48).toString("hex");
  }

  function signInternalCookie(payload) {
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const sig = crypto.createHmac("sha256", getInternalSecret()).update(body).digest("base64url");
    return `${body}.${sig}`;
  }

  function verifyInternalCookie(cookieValue) {
    if (!cookieValue || typeof cookieValue !== "string") return null;
    const parts = cookieValue.split(".");
    if (parts.length !== 2) return null;
    const [body, sig] = parts;
    const expected = crypto.createHmac("sha256", getInternalSecret()).update(body).digest("base64url");
    // Constant-time compare to avoid leaking bytes via timing.
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    let payload;
    try { payload = JSON.parse(Buffer.from(body, "base64url").toString("utf-8")); }
    catch { return null; }
    if (!payload || typeof payload !== "object") return null;
    if (!Number.isFinite(payload.exp) || payload.exp < Date.now()) return null;
    return payload;
  }

  function parseCookies(cookieHeader) {
    const out = {};
    if (!cookieHeader) return out;
    for (const part of String(cookieHeader).split(";")) {
      const [k, ...rest] = part.split("=");
      if (!k) continue;
      out[k.trim()] = decodeURIComponent((rest.join("=") || "").trim());
    }
    return out;
  }

  function readInternalSession(req) {
    const cookies = parseCookies(req.headers.cookie || "");
    return verifyInternalCookie(cookies[INTERNAL_COOKIE_NAME]);
  }

  function requireInternalSession(req, res, next) {
    const session = readInternalSession(req);
    if (!session) {
      // For HTML page requests, redirect to login. For JSON / API
      // requests, return 401 so the front-end can react cleanly.
      const wantsHtml = String(req.headers.accept || "").includes("text/html");
      if (wantsHtml) return res.redirect("/intern");
      return res.status(401).json({ error: "Niet ingelogd.", code: "internal_session_missing" });
    }
    req.internalSession = session;
    next();
  }

  function checkInternalCredentials(email, password) {
    const expectedEmail = String(process.env.WWW_INTERNAL_EMAIL || "").trim().toLowerCase();
    const expectedPassword = String(process.env.WWW_INTERNAL_PASSWORD || "");
    if (!expectedEmail || !expectedPassword) return false;
    const inputEmail = String(email || "").trim().toLowerCase();
    const inputPassword = String(password || "");
    // Constant-time comparison on bytes — convert to Buffers of equal
    // length first (we pad/truncate the shorter to match). A direct
    // !== check would leak length, so we accept some extra ceremony.
    const ea = Buffer.from(inputEmail);
    const eb = Buffer.from(expectedEmail);
    const pa = Buffer.from(inputPassword);
    const pb = Buffer.from(expectedPassword);
    const emailOk = ea.length === eb.length && crypto.timingSafeEqual(ea, eb);
    const passwordOk = pa.length === pb.length && crypto.timingSafeEqual(pa, pb);
    return emailOk && passwordOk;
  }

  function getReportRenderUrl() {
    return String(process.env.FULL_APP_RENDER_URL || config.reportApi?.renderUrl || "").trim();
  }

  function getReportLookupUrl() {
    const explicit = String(process.env.FULL_APP_LOOKUP_URL || config.reportApi?.lookupUrl || "").trim();
    if (explicit) return explicit;
    const renderUrl = getReportRenderUrl();
    if (!renderUrl) return "";
    return renderUrl.replace(/\/api\/full\/render$/i, "/api/mid/lookup");
  }

  function buildReportApiHeaders() {
    const headers = { "Content-Type": "application/json" };
    const key = String(process.env.FULL_APP_RENDER_API_KEY || "").trim();
    if (key) headers["x-api-key"] = key;
    return headers;
  }

  /**
   * Build the brand-payload sent to report-api on every render call.
   * report-api is stateless: this is everything it needs to theme the
   * output. Keep keys flat and stable so changes to the runtime don't
   * silently break the renderer.
   */
  /**
   * Mag deze tenant een energielabel als PDF laten uploaden?
   *
   * Twee plekken kunnen het zeggen, en de omgeving wint:
   *
   *   LABEL_PDF_UPLOAD=1   aan,  ongeacht de config
   *   LABEL_PDF_UPLOAD=0   uit,  ongeacht de config
   *   niet gezet           dan telt `report.labelPdfUpload` uit tenant.config.js
   *
   * Waarom de omgeving voorgaat: een env-variabele is in het Render-dashboard
   * om te zetten zonder commit en zonder uitrol. Dat is precies wat je wil bij
   * een functie die je per tenant wilt kunnen aan- en uitzetten, en zeker bij
   * uitzetten -- als er iets mis is met de upload wil je hem binnen een minuut
   * weg hebben, niet na een deploy.
   *
   * Expliciet uit moet daarom ook kunnen, niet alleen aan. Zou alleen "1"
   * iets doen, dan kon je een tenant die het in zijn config heeft staan niet
   * meer stilleggen zonder code te wijzigen.
   *
   * Deze ene functie voedt beide kanten: het `report`-blok dat naar de
   * report-api gaat (die de route afschermt) en de placeholder waarmee het
   * formulier het uploadvak toont of verbergt. Twee bronnen zouden hier
   * betekenen dat het vak zichtbaar is terwijl de route weigert.
   */
  function labelPdfAan() {
    const env = String(process.env.LABEL_PDF_UPLOAD ?? "").trim().toLowerCase();
    if (["1", "true", "ja", "aan", "on", "yes"].includes(env)) return true;
    if (["0", "false", "nee", "uit", "off", "no"].includes(env)) return false;
    // Via het opgeloste profiel, niet rechtstreeks uit de config: sinds
    // 14 oktober 2026 staat `labelPdfUpload` in het gedeelde profiel en niet
    // meer in elke tenantconfig. Deze regel las het veld letterlijk en gaf
    // daardoor false, waarmee het uploadvak stilletjes verdween.
    return rapportprofiel(config).labelPdfUpload === true;
  }

  /**
   * Of het uploadvak voor een .epa-bestand (de 0-meting van een adviseur) aan
   * staat. Zelfde vorm als labelPdfAan(), met dezelfde reden: een
   * omgevingsvariabele die de config overstemt, zodat een ingang binnen een
   * minuut dicht kan zonder deploy.
   *
   * NIET in het gedeelde rapportprofiel. De report-api schermt deze route
   * niet per tenant af -- Softbee gebruikt haar al zonder vlag -- dus dit is
   * puur de vraag welk invoervak de tenant toont. Een tenant die hem wil, zet
   * `report.epaUpload: true` in zijn eigen config.
   */
  function epaUploadAan() {
    const env = String(process.env.EPA_UPLOAD ?? "").trim().toLowerCase();
    if (["1", "true", "ja", "aan", "on", "yes"].includes(env)) return true;
    if (["0", "false", "nee", "uit", "off", "no"].includes(env)) return false;
    return rapportprofiel(config).epaUpload === true;
  }

  /**
   * Hoeveel volledige rapporten deze tenant op een dag intern mag maken.
   *
   * 0 of niet gezet betekent geen plafond -- dan verandert er niets voor de
   * tenants die dit nooit gevraagd hebben. De maandteller die er al was telt
   * alleen; hij houdt niets tegen.
   */
  /**
   * Wat een volledig rapport ongeveer kost, in euro's.
   *
   * WAAROM DIT HIER STAAT
   * Het dagplafond houdt een ontsporing tegen, maar zegt niets over geld. Je
   * zag het verbruik pas op de rekening. Een teller zonder bedrag is een
   * waarschuwing die je niet kunt wegen: 40 rapporten op een dag kan prima
   * zijn of een ramp, en dat hangt van de prijs af.
   *
   * HET IS EEN SCHATTING EN DAT HOORT ZO TE STAAN
   * Een adresrapport kost vijf betaalde adresaanroepen (circa EUR 0,20 per
   * stuk) plus het taalmodel (circa EUR 0,35). Een rapport uit een opname
   * slaat de meeste van die aanroepen over en kost dus veel minder, maar de
   * bestelling weet hier niet welke route het was. We rekenen daarom met de
   * DUURSTE route: liever een bedrag dat te hoog is dan een dat gerust stelt.
   *
   * Te verzetten met INTERN_KOSTEN_PER_RAPPORT zodra de werkelijke tarieven
   * veranderen; dat hoeft geen release te zijn.
   */
  function kostenPerRapport() {
    const env = Number(process.env.INTERN_KOSTEN_PER_RAPPORT);
    return Number.isFinite(env) && env >= 0 ? env : 1.35;
  }

  function dagplafond() {
    const env = Number(process.env.INTERN_DAGPLAFOND);
    if (Number.isFinite(env) && env >= 0) return Math.floor(env);
    const uit = Number(config.features?.dagplafond);
    return Number.isFinite(uit) && uit > 0 ? Math.floor(uit) : 0;
  }

  function buildBrandPayload() {
    return {
      id: config.id,
      brand: config.brand || {},
      contact: config.contact || {},
      followUp: config.followUp || { enabled: false },
      product: { name: config.product?.name || "Volledig Verduurzamingsinzicht", fullReportUrl: config.product?.fullReportUrl || "" },
      prompts: config.prompts || {},
      // Rapportregels van de tenant (doellabels, focus, of het volledige
      // rapport in de dienstverlening zit). Zonder dit veld leest de
      // report-api zijn eigen defaults en blijft een tenant-specifiek
      // rapportprofiel onzichtbaar: de config stond dan wel in de tenant,
      // maar bereikte de renderer nooit. Tenants zonder `report` sturen een
      // leeg object en houden exact het oude gedrag.
      // De effectieve waarde van de upload-vlag, met twee eisen die elkaar
      // bijten als je er een vergeet:
      //
      // 1. Staat de upload UIT, dan moet de sleutel WEG -- niet op false. Een
      //    tenant zonder rapportprofiel hoort `{}` te sturen, want dat lege
      //    object is het signaal "geen profiel" waar de report-api zijn eigen
      //    defaults overheen legt. Een bestaande test bewaakt dat en viel hier
      //    terecht om.
      // 2. Maar hem alleen TOEVOEGEN volstaat niet: staat `labelPdfUpload:
      //    true` in de config en zet de omgeving hem op 0, dan kopieert de
      //    spread die true gewoon mee en doet het uitzetten niets. Daarom
      //    expliciet verwijderen.
      report: (() => {
        const r = { ...(config.report || {}) };
        if (labelPdfAan()) r.labelPdfUpload = true;
        else delete r.labelPdfUpload;
        return r;
      })(),
    };
  }

  async function fetchLookupFromReportApi(address) {
    const url = getReportLookupUrl();
    if (!url) throw new Error("FULL_APP_LOOKUP_URL ontbreekt.");
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), Number(process.env.FULL_APP_LOOKUP_TIMEOUT_MS || 45000));
    try {
      const res = await undiciFetch(url, {
        method: "POST",
        headers: buildReportApiHeaders(),
        body: JSON.stringify({ ...address, tenant: buildBrandPayload() }),
        signal: ac.signal,
        dispatcher: longFetchAgent,
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(json?.error || `Lookup mislukt (${res.status})`);
      return json;
    } finally {
      clearTimeout(t);
    }
  }

  async function fetchFullReportHtml({ order }) {
    const url = getReportRenderUrl();
    if (!url) throw new Error("FULL_APP_RENDER_URL ontbreekt.");

    const reqBody = {
      address: order.address,
      confirmed_data: order.confirmed_data,
      response_mode: "json",
      tenant: buildBrandPayload(),
      generation_options: { enable_photo_analysis: false, enable_web_search: true },
      // De report-api bewaart het rapport en geeft er een link bij. Op het
      // bestelnummer, zodat een herpoging na een storing dezelfde link geeft
      // en er niet opnieuw gerekend wordt.
      //
      // Waarom daar en niet hier: een link die aan de hostnaam van deze tenant
      // hangt sterft zodra de tenant wordt opgeschort of hernoemd, en dat is
      // bij twee tenants al gebeurd. De report-api is gedeeld en blijft staan.
      bewaar_rapport: order.id,
    };
    // EPA-driven orders (e.g. Softbee): send the parsed 0-meting so report-api
    // builds the full report from the measured assessment instead of an
    // EP-Online/BAG lookup.
    if (order.epa_model) reqBody.epa_model = order.epa_model;

    const t0 = Date.now();
    const ac = new AbortController();
    const hardCap = setTimeout(() => ac.abort(), LONG_FETCH_HARD_CAP_MS);

    let lastProgressLogAt = 0;
    const progressInterval = setInterval(() => {
      const elapsed = Date.now() - t0;
      if (elapsed - lastProgressLogAt >= 30000) {
        logOrderPhase(order.id, "render_html_waiting", { elapsed_ms: elapsed });
        lastProgressLogAt = elapsed;
      }
    }, 30000);
    try { progressInterval.unref?.(); } catch {}

    let res, rawText = "";
    try {
      logOrderPhase(order.id, "render_html_fetch_start", { url });
      res = await undiciFetch(url, {
        method: "POST",
        headers: buildReportApiHeaders(),
        body: JSON.stringify(reqBody),
        signal: ac.signal,
        dispatcher: longFetchAgent,
      });
      rawText = await res.text();
      logOrderPhase(order.id, "render_html_body_received", { status: res.status, bytes: rawText.length, elapsed_ms: Date.now() - t0 });
    } catch (fetchErr) {
      const elapsed = Date.now() - t0;
      const cause = fetchErr?.cause?.code || fetchErr?.code || fetchErr?.cause?.name || fetchErr?.name;
      const err = new Error(`Fetch naar report-api mislukt na ${Math.round(elapsed / 1000)}s: ${fetchErr?.message || String(fetchErr)}${cause ? ` (${cause})` : ""}`);
      err.context = { step: "render_html_fetch", url, elapsed_ms: elapsed, cause, original_message: fetchErr?.message || String(fetchErr), aborted: ac.signal.aborted };
      throw err;
    } finally {
      clearTimeout(hardCap);
      clearInterval(progressInterval);
    }

    let json = null;
    try { json = rawText ? JSON.parse(rawText) : null; } catch {}

    if (!res.ok) {
      const err = new Error(json?.error || rawText || `Full report render mislukt (${res.status})`);
      err.context = { step: "render_html", http_status: res.status, response_json: json, response_text_preview: String(rawText || "").slice(0, 1200), request_preview: reqBody };
      throw err;
    }

    const html = json?.html || json?.html_document || "";
    if (!html) {
      const err = new Error("Report-api gaf geen HTML terug.");
      err.context = { step: "render_html", http_status: res.status, response_json: json, response_text_preview: String(rawText || "").slice(0, 1200), request_preview: reqBody };
      throw err;
    }
    return leesRenderAntwoord(json);
  }

  function appendStep(orderId, step, extra = {}) {
    return mergeOrder(orderId, (current) => ({
      ...current,
      last_step: step,
      step_log: [...(Array.isArray(current.step_log) ? current.step_log : []), { at: nowIso(), step, ...extra }],
    }));
  }

  async function createPaymentOrder({ req, email, address, confirmedData, sourceMeta = null, epaModel = null }) {
    const baseUrl = getBaseUrl(req);
    const orderId = newOrderId();
    const downloadToken = newOrderToken();
    const amount = Number(config?.payment?.priceEur || 30);
    const productName = config?.product?.name || "Volledig Verduurzamingsinzicht";
    const description = fillTemplate(
      config?.payment?.description || "{{PRODUCT_NAME}} {{ORDER_ID}}",
      { PRODUCT_NAME: productName, ORDER_ID: orderId }
    );
    const redirectPath = config?.product?.redirectAfterPaymentPath || "/full_done.html";

    const payment = await createMolliePayment({
      amountEur: amount,
      description,
      redirectUrl: `${baseUrl}${redirectPath}?order_id=${encodeURIComponent(orderId)}`,
      webhookUrl: `${baseUrl}/api/full/webhook/mollie`,
      metadata: { order_id: orderId, tenant_id: config.id },
    });

    createOrder({
      id: orderId,
      tenant_id: config.id,
      download_token: downloadToken,
      status: "payment_created",
      created_at: nowIso(),
      updated_at: nowIso(),
      amount_eur: amount,
      email,
      address,
      confirmed_data: confirmedData,
      epa_model: epaModel || null,
      payment: { id: payment.id, status: payment.status, checkout_url: payment.checkout_url },
      report_html: "",
      pdf_filename: "",
      download_path: "",
      paid_at: null,
      mailed_at: null,
      processing_lock: false,
      error: "",
      source_meta: { ...(sourceMeta || {}), invoer: invoerSoort(sourceMeta?.source, epaModel) },
    });

    return {
      order_id: orderId,
      checkout_url: payment.checkout_url,
      done_url: `${baseUrl}${redirectPath}?order_id=${encodeURIComponent(orderId)}`,
      status_url: `${baseUrl}/api/full/order/${encodeURIComponent(orderId)}`,
    };
  }

  /**
   * Waar de woninggegevens van deze bestelling vandaan komen.
   *
   * Sinds oktober 2026 zijn dat er drie: een adres (openbare bronnen), een
   * geupload energielabelrapport en een .epa-opname. Aan de bestelling zelf
   * was dat niet te zien, en dat is precies wat je wilt weten als een rapport
   * er vreemd uitziet -- de drie routes voeden de rekenkern verschillend.
   *
   * De `source` komt uit de handoff (de frontend zet hem); het model zegt of
   * er werkelijk een opname bij zat.
   */
  function invoerSoort(source, epaModel) {
    if (!epaModel) return "adres";
    return String(source || "").trim().toLowerCase() === "label_pdf" ? "label_pdf" : "epa";
  }

  /**
   * Internal-flow order creation — same as createPaymentOrder but skips
   * Mollie entirely. The order is born with status "paid" so the
   * existing processOrderById flow immediately runs render → PDF →
   * mail. Used by /api/internal/full/render for WoonWijzerWinkel staff.
   */
  async function createInternalOrder({ req, email, address, confirmedData, epaModel = null, sourceMeta = null }) {
    const baseUrl = getBaseUrl(req);
    const orderId = newOrderId();
    const downloadToken = newOrderToken();
    const redirectPath = config?.product?.redirectAfterPaymentPath || "/full_done.html";
    const monthUsage = incrementInternalQuota(dataDir);
    const dagGebruik = verhoogDagteller(dataDir);

    createOrder({
      id: orderId,
      tenant_id: config.id,
      download_token: downloadToken,
      // We mark it "paid" so the existing recovery sweep + processing
      // pipeline treats it identically to a Mollie-paid order. The
      // payment block stays empty so it's clear in audit logs that
      // this was an internal render.
      status: "paid",
      created_at: nowIso(),
      updated_at: nowIso(),
      amount_eur: 0,
      email,
      address,
      confirmed_data: confirmedData,
      // De opname, wanneer de adviseur een .epa of een energielabelrapport
      // heeft geupload. fetchFullReportHtml() stuurt hem mee naar de
      // report-api, die dan met de gemeten schil rekent in plaats van met
      // schattingen uit openbare bronnen.
      epa_model: epaModel || null,
      payment: { id: null, status: "internal", checkout_url: null },
      report_html: "",
      pdf_filename: "",
      download_path: "",
      paid_at: nowIso(),
      mailed_at: null,
      processing_lock: false,
      error: "",
      source_meta: {
        ...(sourceMeta || {}),
        source: "internal_full_start",
        invoer: invoerSoort(sourceMeta?.invoer, epaModel),
        internal_user: req?.internalSession?.email || null,
        month_usage_after: monthUsage,
        dag_gebruik_na: dagGebruik,
      },
    });

    // Zonder betaalstap is dit het enige moment waarop iemand kan zien dat
    // er een aanvraag loopt. Opt-in via ORDER_ALERT_ADDRESSES.
    if (orderAlertsEnabled()) {
      sendOrderAlertEmail({
        kind: "requested",
        order: getOrderById(orderId) || { id: orderId, address, email },
        config,
      }).catch(() => {});
    }

    triggerBackgroundProcessing(orderId);

    return {
      order_id: orderId,
      done_url: `${baseUrl}${redirectPath}?order_id=${encodeURIComponent(orderId)}`,
      status_url: `${baseUrl}/api/full/order/${encodeURIComponent(orderId)}`,
      month_usage: monthUsage,
      month_max: getQuotaMax(),
    };
  }

  /**
   * Een bestelling die definitief niet geleverd kan worden: de klant bericht
   * en zijn geld terug.
   *
   * WAAROM ALLEEN BIJ "error"
   * isRecoverableStatus() hieronder pakt paid, processing, report_generated,
   * pdf_created en mail_failed opnieuw op -- de herstelronde probeert die
   * gewoon nog eens. Alleen "error" is een eindstand. Zou je bij een
   * herstelbare stand al terugbetalen, dan betaal je terug terwijl het rapport
   * even later alsnog aankomt.
   *
   * EEN KEER, EN NIET VAKER
   * `refund` op de order is de afscherming. Staat er al een poging in, dan
   * doet deze functie niets meer. De herstelronde kan dezelfde order immers
   * meerdere keren langs de foutafhandeling sturen, en dan zou een klant twee
   * keer terugbetaald worden.
   *
   * DE MAIL GAAT ALTIJD, OOK ALS DE TERUGBETALING MISLUKT
   * Dat is de kern: wie de afrondpagina sloot, hoort anders niets. Mislukt de
   * terugbetaling, dan belooft de mail niets maar vraagt hij de klant contact
   * op te nemen -- en de operationele alert vertelt ons dat er met de hand
   * iets moet gebeuren.
   */
  async function meldMislukkingEnBetaalTerug(orderId) {
    const order = getOrderById(orderId);
    if (!order) return;
    if (order.status !== "error") return;
    if (order.refund) return; // al afgehandeld

    const betaald = order?.payment?.id && String(order?.mollie_status || order?.payment?.status) === "paid";
    let terugbetaling = { gepoogd: false, gelukt: false };

    if (betaald) {
      terugbetaling.gepoogd = true;
      try {
        const r = await refundMolliePayment({
          paymentId: order.payment.id,
          amountEur: Number(order.amount_eur),
          description: `Rapport niet geleverd (order ${orderId})`,
        });
        terugbetaling = { gepoogd: true, gelukt: true, id: r.id, status: r.status, bedrag_eur: r.bedrag_eur };
        logOrderPhase(orderId, "terugbetaald", { refund_id: r.id, bedrag_eur: r.bedrag_eur });
      } catch (e) {
        terugbetaling.error = String(e?.message || e).slice(0, 200);
        logOrderPhase(orderId, "terugbetaling_mislukt", { error: terugbetaling.error });
      }
    }

    // Eerst vastleggen, dan mailen: zo kan een mislukte mail niet leiden tot
    // een tweede terugbetaling bij de volgende herstelronde.
    updateOrder(orderId, { refund: { ...terugbetaling, at: nowIso() } });
    appendStep(orderId, terugbetaling.gelukt ? "refunded" : "refund_skipped", {
      betaald,
      error: terugbetaling.error || null,
    });

    try {
      await sendMislukteOrderEmail({ order: getOrderById(orderId), config, terugbetaling });
      appendStep(orderId, "failure_mail_sent", { to: order.email });
      logOrderPhase(orderId, "mislukking_gemeld", { to: order.email });
    } catch (e) {
      appendStep(orderId, "failure_mail_failed", { message: String(e?.message || e).slice(0, 200) });
      logOrderPhase(orderId, "mislukking_melden_faalde", { error: String(e?.message || e).slice(0, 160) });
    }
  }

  function isRecoverableStatus(status) {
    return ["paid", "processing", "report_generated", "pdf_created", "mail_failed"].includes(String(status || ""));
  }

  function triggerBackgroundProcessing(orderId) {
    setTimeout(async () => { try { await processOrderById(orderId); } catch {} }, 50);
  }

  /**
   * De bestelling melden bij de centrale database, na de oplevering.
   *
   * Gooit niet en blokkeert niets: de administratie mag de klant niet raken.
   * Lukt het niet, dan blijft centraal_gemeld_at leeg en pikt de herstelronde
   * hem later op -- dezelfde ronde die ook een vastgelopen render oppakt.
   */
  async function meldAanCentraal(order) {
    if (!centraalAan() || !order?.id || order.centraal_gemeld_at) return;
    const uit = await meldBestelling(order, config);
    if (uit.gemeld) {
      updateOrder(order.id, { centraal_gemeld_at: nowIso(), centraal_id: uit.id ?? null, centraal_fout: "" });
      appendStep(order.id, "centraal_gemeld", {
        id: uit.id ?? null,
        status_bijgewerkt: uit.status_bijgewerkt !== false,
        // Staat de bestelling er wel in maar liep een overgang vast, dan is
        // dat hier te zien. Zonder dit blijft "gemeld" een half verhaal.
        ...(uit.geweigerd_bij ? { geweigerd_bij: uit.geweigerd_bij, stand: uit.stand ?? null } : {}),
      });
      return;
    }
    // Wel vastleggen waarom, want de gateway noemt in zijn afwijzing de
    // toegestane waarden -- dat is de snelste weg naar een juiste koppeling.
    updateOrder(order.id, { centraal_fout: `${uit.reden}${uit.fouten ? `: ${JSON.stringify(uit.fouten).slice(0, 300)}` : ""}` });
    appendStep(order.id, "centraal_mislukt", { reden: uit.reden });
    console.warn(`[tenant-runtime] centraal: melden mislukt (${uit.reden}) voor bestelling ${order.id}`);
  }

  // Of de eerste ronde al een regel in het log heeft gezet.
  let centraalGemeld = false;

  async function recoverPendingOrders() {
    const candidates = listOrders(200).filter((o) => isRecoverableStatus(o.status) && !o.processing_lock);
    for (const order of candidates) triggerBackgroundProcessing(order.id);
    // Opgeleverde bestellingen die de centrale database nog niet kent. Dit is
    // de wachtrij die het doorsturen losmaakt van het bestelpad: een storing
    // bij de administratie kost hooguit vertraging, geen bestelling.
    if (!centraalAan()) return;
    // Hier een ruime schijf, net als bij het opruimen van pdf's, en niet de
    // 200 nieuwste van hierboven. Die grens hoort bij een vastgelopen render:
    // dat is altijd iets van vandaag. Een bestelling die de centrale database
    // nog niet kent kan juist oud zijn -- bij het eerste aanzetten is dat de
    // hele geschiedenis -- en zou voorbij plek 200 nooit meer aan de beurt
    // komen. Niet stil overslaan dus, maar per ronde een hap, zodat een
    // achterstand geleidelijk wegloopt en één ronde niet minutenlang duurt.
    const alle = listOrders(10000);
    const teMelden = kiesTeMelden(alle, CENTRAAL_PER_RONDE);

    // Eén regel in het log, want van buiten is niet te zien of er historie
    // wacht. "Er kwam niets binnen bij de centrale database" kan twee dingen
    // betekenen -- er was niets, of het melden klemt -- en zonder dit
    // onderscheid staar je naar een leeg overzicht zonder te weten waarom.
    // De eerste ronde na het starten meldt zich altijd, ook bij nul; daarna
    // alleen als er werkelijk iets te doen is. Een aantal, geen gegevens: dit
    // hoort in het log van de tenant, niet in een openbaar /health.
    const wachtrij = kiesTeMelden(alle, Number.MAX_SAFE_INTEGER).length;
    if (!centraalGemeld || wachtrij > 0) {
      console.log(`[tenant-runtime] centraal: ${wachtrij} bestelling(en) te melden, ${teMelden.length} deze ronde`);
    }
    centraalGemeld = true;

    for (const order of teMelden) await meldAanCentraal(order);
  }

  // PDF retention cleanup. Walks every order, deletes the PDF file
  // for any order whose mailed_at is older than PDF_RETENTION_DAYS
  // (default 365), and marks the order so the download route can
  // explain "this report has expired" instead of returning a bare
  // 404. The order JSON itself is kept indefinitely — it's tiny and
  // useful for support/debugging.
  function cleanupExpiredPdfs() {
    const retentionDays = Number(process.env.PDF_RETENTION_DAYS || 365);
    if (!Number.isFinite(retentionDays) || retentionDays <= 0) return;
    const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

    // Pull a generous slice — at WWW volume (a handful of orders per
    // day) we'd hit 10,000 only after ~10 years, well past any
    // retention window.
    const orders = listOrders(10000);
    let removed = 0;
    let errors = 0;
    for (const order of orders) {
      if (order.pdf_deleted_at) continue;
      if (!order.download_path) continue;
      // We use mailed_at as the anchor — that's when the customer
      // received the link. If for some reason mailed_at is missing,
      // fall back to created_at so we still clean up eventually.
      const anchor = order.mailed_at || order.created_at;
      if (!anchor) continue;
      const anchorMs = Date.parse(anchor);
      if (!Number.isFinite(anchorMs) || anchorMs > cutoffMs) continue;

      try {
        if (fs.existsSync(order.download_path)) {
          fs.unlinkSync(order.download_path);
        }
        updateOrder(order.id, {
          pdf_deleted_at: nowIso(),
          // We deliberately leave download_path / pdf_filename in
          // place — they're useful as an audit trail of what the
          // file was named when it existed.
        });
        removed++;
      } catch (err) {
        errors++;
        console.error(`PDF retention cleanup failed for order ${order.id}:`, err?.message || err);
      }
    }
    if (removed > 0 || errors > 0) {
      console.log(`PDF retention cleanup: removed=${removed} errors=${errors} retention=${retentionDays}d`);
    }
  }

  // Run cleanup once on boot, then every 24h. Render restarts the
  // service occasionally, so on-boot guarantees we don't drift past
  // retention even if the 24h timer never fires.
  function scheduleCleanup() {
    try { cleanupExpiredPdfs(); } catch (err) { console.error("cleanup error", err); }
    // unref(): in een draaiende tenant houdt de luisterende HTTP-server het
    // proces in leven, dus deze opruiming loopt gewoon door. Zonder unref
    // houdt de timer het event-loop óók bezig als er geen server luistert —
    // dan eindigt een proces dat alleen createTenantApp() aanroept nooit,
    // en blijft een testrun na de laatste assertie hangen.
    setInterval(() => {
      try { cleanupExpiredPdfs(); } catch (err) { console.error("cleanup error", err); }
    }, 24 * 60 * 60 * 1000).unref();
  }

  async function processOrderById(orderId) {
    let order = getOrderById(orderId);
    if (!order) throw new Error("Order niet gevonden.");
    if (["mailed", "done"].includes(order.status)) return order;
    if (order.processing_lock) return order;

    order = mergeOrder(orderId, (current) => ({
      ...current,
      processing_lock: true,
      status: isRecoverableStatus(current.status) ? "processing" : current.status,
      last_step: "processing_started",
      error: "",
      field_errors: null,
      render_debug: null,
    }));
    appendStep(orderId, "processing_started");

    try {
      appendStep(orderId, "render_html_started");
      const renderResult = order.report_html
        ? { html: order.report_html, meta: order.full_app_meta || null,
            rapportUrl: order.rapport_url || "", pdfBytes: null }
        : await fetchFullReportHtml({ order });
      const html = renderResult.html;
      order = updateOrder(orderId, {
        status: "report_generated",
        report_html: html,
        full_app_meta: renderResult.meta || null,
        // De link van de report-api bewaren, anders raakt een herpoging hem
        // kwijt: die hergebruikt de opgeslagen html en doet geen render meer.
        rapport_url: renderResult.rapportUrl || order.rapport_url || "",
        last_step: "render_html_done",
      });
      appendStep(orderId, "render_html_done", { html_chars: String(html || "").length });

      let pdfPath = order.download_path;
      let filename = order.pdf_filename;
      let pdfBuffer;

      if (pdfPath && fs.existsSync(pdfPath)) {
        pdfBuffer = fs.readFileSync(pdfPath);
      } else {
        appendStep(orderId, "pdf_started");
        // De report-api maakt de pdf nu zelf en stuurt hem mee. Lukt dat niet
        // -- een oudere report-api, of een sleutel zonder partnernaam -- dan
        // valt deze tenant terug op zijn eigen PDFBolt, zodat een betaalde
        // bestelling nooit blijft hangen op een configuratiefout. Die terugval
        // logt wel, anders blijft zo'n fout onzichtbaar.
        if (renderResult.pdfBytes) {
          pdfBuffer = renderResult.pdfBytes;
        } else {
          console.warn(
            `[tenant-runtime] order ${orderId}: geen pdf van de report-api, terugval op eigen PDFBolt. ` +
            "Controleer FULL_APP_RENDER_API_KEY en EPA_API_KEYS (zie /api/wie-ben-ik)."
          );
          pdfBuffer = await htmlToPdfBuffer(html);
        }
        // De report-api benoemt het bestand; zo heet de bijlage hetzelfde als
        // wat er achter de downloadlink vandaan komt. Geeft hij geen naam,
        // dan bepaalt deze tenant hem zelf, met dezelfde regel.
        filename = renderResult.pdfBestandsnaam || rapportBestandsnaam(order, renderResult.meta);
        pdfPath = path.join(pdfDir, filename);
        fs.writeFileSync(pdfPath, pdfBuffer);
        order = updateOrder(orderId, { status: "pdf_created", pdf_filename: filename, download_path: pdfPath, last_step: "pdf_done" });
        appendStep(orderId, "pdf_done", { filename });
      }

      try {
        appendStep(orderId, "mail_started", { to: order.email });
        // Build the public download URL using APP_BASE_URL. When it's
        // not configured we pass an empty string and the email template
        // omits the "view online" line. The link points at the short
        // /r/:id alias, which validates the token and streams the PDF.
        const baseUrlConfigured = String(process.env.APP_BASE_URL || "").trim().replace(/\/$/, "");
        // De link van de report-api gaat voor: die overleeft het opschorten of
        // hernoemen van deze tenant, en de eigen /r/-link niet. Heeft de
        // report-api er geen gegeven, dan de eigen link, zodat de klant altijd
        // iets krijgt.
        const downloadUrl = kiesDownloadLink({
          rapportUrl: renderResult.rapportUrl,
          basisUrl: baseUrlConfigured,
          orderId: order.id,
          downloadToken: order.download_token,
        });
        // Build a human-readable address line from whatever fields are
        // present. Tenants can use {{ADDRESS}} in their email template
        // and subject template. Format: "<postcode> <huisnummer><toevoeging>"
        // — toevoeging is concatenated to the housenumber without a space
        // (Dutch convention: "11A", not "11 A"). Falls back to addr_line
        // if a future caller stores the resolved BAG street/city line.
        const numberWithAddition = [order.address?.housenumber, order.address?.houseaddition]
          .filter(Boolean)
          .map((s) => String(s).trim())
          .join("");
        // De volledige adresregel komt uit de report-api ("Langekamp 9, 3848DX
        // Harderwijk"); de bestelling kent alleen postcode en huisnummer.
        // Daardoor stond er in de mail "Adres: 3848DX 9" terwijl het volledige
        // adres gewoon beschikbaar was -- en de bestandsnaam van de bijlage
        // gebruikte die bron al wel (eerste echte bestelling, 15 oktober 2026).
        const addressLine = renderResult.meta?.address_line
          || order.address?.addr_line
          || [order.address?.postalcode, numberWithAddition]
              .filter(Boolean).join(" ").trim()
          || "";
        await sendReportEmail({
          to: order.email,
          orderId: order.id,
          pdfBuffer,
          filename,
          config,
          emailTemplate: templates.email,
          downloadUrl,
          addressLine,
        });
      } catch (mailErr) {
        order = updateOrder(orderId, { status: "mail_failed", processing_lock: false, last_step: "mail_failed", render_debug: mailErr?.context || null, error: mailErr?.message || String(mailErr) });
        appendStep(orderId, "mail_failed", { message: mailErr?.message || String(mailErr) });
        throw mailErr;
      }

      order = updateOrder(orderId, { status: "mailed", mailed_at: nowIso(), processing_lock: false, last_step: "mail_done", error: "" });
      appendStep(orderId, "mail_done", { to: order.email });
      await meldAanCentraal(order);
      return order;
    } catch (e) {
      const current = getOrderById(orderId);
      const keepStatus = current?.status === "mail_failed" ? "mail_failed"
        : current?.status === "pdf_created" ? "pdf_created"
        : current?.status === "report_generated" ? "report_generated"
        : "error";
      logOrderPhase(orderId, "failed", { status: keepStatus, message: e?.message || String(e), step: e?.context?.step || current?.last_step || "error" });
      updateOrder(orderId, {
        status: keepStatus, processing_lock: false,
        last_step: e?.context?.step || current?.last_step || "error",
        field_errors: e?.context?.response_json?.field_errors || null,
        render_debug: e?.context || null,
        error: e?.message || String(e),
      });
      appendStep(orderId, e?.context?.step ? `${e.context.step}_failed` : "error", { message: e?.message || String(e) });
      // Operationele alert (opt-in via ORDER_ALERT_ADDRESSES). Bewust
      // fire-and-forget: een mislukte alert mag de foutafhandeling niet
      // overschrijven, en de order is hierboven al bijgewerkt.
      if (orderAlertsEnabled()) {
        sendOrderAlertEmail({
          kind: "failed",
          order: getOrderById(orderId) || { id: orderId },
          config,
          extra: { error: e?.message || String(e), step: e?.context?.step || current?.last_step || "error" },
        }).catch(() => {});
      }
      // Alleen bij de eindstand: de klant bericht en zijn geld terug. Bij een
      // herstelbare stand doet deze functie zelf niets, want de herstelronde
      // gaat het nog eens proberen. Fire-and-forget, zoals de alert: een
      // mislukte melding mag de foutafhandeling niet overschrijven.
      meldMislukkingEnBetaalTerug(orderId).catch(() => {});
      throw e;
    }
  }

  // -------------------------------------------------------------------------
  // Pages — read from this tenant's public/templates/ folder.
  // -------------------------------------------------------------------------
  function serveTemplatedPage(req, res, key, fallback) {
    const tpl = templates[key];
    if (!tpl) return res.status(404).type("text/plain").send(fallback);
    const html = fillTemplate(tpl, templateVars(config, {
      BASE_URL: getBaseUrl(req),
      HANDOFF_TOKEN: String(req.query.handoff || ""),
      ORDER_ID: String(req.query.order_id || ""),
      // Via `extra`, omdat templateVars() buiten createTenantApp staat en de
      // omgevingsoverride daar niet kan zien. Zo blijft er EEN plek die
      // bepaalt of de upload aan staat.
      labelPdfUpload: labelPdfAan(),
      epaUpload: epaUploadAan(),
    }));
    res.type("text/html; charset=utf-8").send(html);
  }

  // -------------------------------------------------------------------------
  // Toegangspoort: de hele tenant achter de adviseurslogin
  //
  // Aan te zetten per tenant met `features.toegang: true`. Bedoeld voor een
  // tenant die nog niet publiek is: De Energie Raadgever wordt voorlopig
  // alleen door adviseurs bediend, samen met de bewoner.
  //
  // HERGEBRUIKT DE BESTAANDE SESSIE
  // Dezelfde cookie en dezelfde WWW_INTERNAL_*-gegevens als de interne flow.
  // Een tweede inlogmechanisme ernaast zou twee keer onderhouden moeten
  // worden en twee keer fout kunnen gaan, voor dezelfde groep mensen.
  //
  // FAALT DICHT
  // Ontbreekt WWW_INTERNAL_SESSION_SECRET, dan tekent getInternalSecret() met
  // een willekeurige sleutel en verifieert geen enkele cookie. De site staat
  // dan op slot in plaats van open. Daarom hieronder een waarschuwing bij het
  // starten: dichtstaan zonder dat iemand kan inloggen is ook stuk.
  //
  // WAT OPEN BLIJFT, EN WAAROM
  // Standaard gaat alles dicht, zodat een nieuwe pagina niet per ongeluk
  // buiten de poort valt. De uitzonderingen zijn stuk voor stuk dingen die
  // hun eigen slot hebben of die van buiten moeten blijven werken:
  //   - /health            toezicht
  //   - /intern…           de inlogpagina zelf, anders kun je niet naar binnen
  //   - /assets/…          de loginpagina heeft zijn stijl en logo nodig
  //   - /api/tenant        merkgegevens die diezelfde pagina ophaalt
  //   - /api/full/webhook/ Mollie meldt zich server-naar-server, zonder cookie
  //   - /r/… en /api/full/order/…  de downloadlink van 365 dagen; wie al
  //                        betaald heeft moet bij zijn rapport kunnen,
  //                        ook lang nadat de poort dichtging
  //   - /api/full/handoff…, /api/mid/full-report-handoff, /api/full/prefill/…
  //                        overdracht van een partner, met een eigen sleutel
  //                        of een token in het pad
  //   - /api/epa/, /api/label-pdf/, /api/admin/  eigen sleutel
  //
  // LET OP: met de poort aan kan een bezoeker die via een partneroverdracht
  // binnenkomt de bestelpagina niet laden -- die staat achter de login. Voor
  // een tenant mét overdrachtspartners (Softbee) hoort deze schakelaar dus
  // uit te staan.
  // -------------------------------------------------------------------------
  const TOEGANG_OPEN = [
    "/health",
    // Je leest een privacyverklaring VOORDAT je gegevens achterlaat, en een
    // bezoeker die het vinkje aanklikt heeft geen inlog. Achter de poort zou
    // de link in het toestemmingsvinkje op een inlogscherm uitkomen.
    "/privacyverklaring.html",
    "/algemene-voorwaarden.html",
    "/api/tenant",
    "/api/internal/login",
    "/api/internal/logout",
  ];
  const TOEGANG_OPEN_PREFIX = [
    "/intern",
    "/assets/",
    "/r/",
    "/api/full/webhook/",
    "/api/full/order/",
    "/api/full/handoff",
    "/api/full/prefill/",
    "/api/mid/full-report-handoff",
    "/api/mid/full-handoff-config",
    "/api/epa/",
    "/api/label-pdf/",
    "/api/admin/",
  ];

  function toegangAan() {
    return Boolean(config.features?.toegang);
  }

  if (toegangAan() && !String(process.env.WWW_INTERNAL_SESSION_SECRET || "").trim()) {
    console.warn(
      `[tenant-runtime] LET OP: features.toegang staat aan voor '${config.id}' maar ` +
      "WWW_INTERNAL_SESSION_SECRET ontbreekt. De site staat dan volledig op slot: " +
      "inloggen lukt niemand."
    );
  }

  app.use((req, res, next) => {
    if (!toegangAan()) return next();
    const pad = req.path || "";
    if (TOEGANG_OPEN.includes(pad)) return next();
    if (TOEGANG_OPEN_PREFIX.some((p) => pad.startsWith(p))) return next();
    if (readInternalSession(req)) return next();
    const wilHtml = String(req.headers.accept || "").includes("text/html");
    if (wilHtml) return res.redirect("/intern");
    return res.status(401).json({ error: "Niet ingelogd.", code: "toegang_vereist" });
  });

  // Root route: precedence is onepagerStart → midStart → fullStart. The
  // first template the tenant ships becomes the landing page.
  app.get("/", (req, res) => {
    if (templates.onepagerStart) return serveTemplatedPage(req, res, "onepagerStart", "Pagina niet beschikbaar.");
    if (templates.midStart) return serveTemplatedPage(req, res, "midStart", "Pagina niet beschikbaar.");
    return res.redirect("/full_start.html");
  });
  app.get("/onepager_start.html", (req, res) => serveTemplatedPage(req, res, "onepagerStart", "Onepager niet beschikbaar voor deze tenant."));
  app.get("/mid_start.html", (req, res) => serveTemplatedPage(req, res, "midStart", "Mid-rapport niet beschikbaar voor deze tenant."));
  app.get("/full_start.html", (req, res) => serveTemplatedPage(req, res, "fullStart", "Pagina niet beschikbaar."));
  app.get("/full_done.html",  (req, res) => serveTemplatedPage(req, res, "fullDone",  "Pagina niet beschikbaar."));
  app.get("/algemene-voorwaarden.html", (req, res) => serveTemplatedPage(req, res, "terms", "Algemene voorwaarden niet beschikbaar."));
  // De privacyverklaring waar het toestemmingsvinkje naar verwijst. Zonder
  // deze pagina stond er in dat vinkje "zie de privacyverklaring" zonder link
  // -- een akkoord dat verwijst naar een document dat er niet is.
  app.get("/privacyverklaring.html", (req, res) => serveTemplatedPage(req, res, "privacy", "Privacyverklaring niet beschikbaar."));

  // -------------------------------------------------------------------------
  // Internal flow (WoonWijzerWinkel staff)
  // -------------------------------------------------------------------------
  // /intern                       → login page (or redirect to /intern/full_start.html if signed in)
  // /intern/full_start.html       → cookie-protected full-report intake page
  // POST /api/internal/login      → email + password → set cookie
  // POST /api/internal/logout     → clear cookie
  // POST /api/internal/full/render → cookie-protected, skip Mollie, render+mail
  // GET  /api/internal/quota      → returns { used, max, month, remaining }

  /**
   * Een tenant met EEN tool in plaats van twee ingangen.
   *
   * De interne flow had een eigen intakepagina (/intern/full_start.html) naast
   * de publieke tool op /. Twee formulieren voor dezelfde woning, die uit
   * elkaar liepen: de publieke kreeg de upload van een energielabel, het
   * aantal zonnepanelen en de advertentie erbij, de interne niet.
   *
   * Staat deze schakelaar aan, dan is / de enige tool en is /intern nog
   * uitsluitend de inlogpagina. WoonWijzerWinkel houdt de oude indeling: daar
   * IS de interne pagina de werkplek van de adviseur, los van de publieke.
   */
  function eenToolAan() {
    return Boolean(config.features?.eenTool);
  }

  /** Waar een ingelogde adviseur hoort uit te komen. */
  function naLogin() {
    return eenToolAan() ? "/" : "/intern/full_start.html";
  }

  app.get("/intern", (req, res) => {
    // If already signed in, skip the login page and go straight to the
    // intake form. The intake page is itself cookie-protected so an
    // expired session bounces back here.
    if (readInternalSession(req)) return res.redirect(naLogin());
    return serveTemplatedPage(req, res, "internLogin", "Interne login niet beschikbaar voor deze tenant.");
  });

  // Common-typo aliases — different staff members try slightly different
  // URLs on first login, so we fold them all back to /intern. No magic
  // logic, just redirects.
  app.get("/intern/", (req, res) => res.redirect("/intern"));
  app.get("/intern.html", (req, res) => res.redirect("/intern"));
  app.get("/intern-login", (req, res) => res.redirect("/intern"));
  app.get("/intern-login.html", (req, res) => res.redirect("/intern"));
  app.get("/intern/login", (req, res) => res.redirect("/intern"));
  app.get("/intern/login.html", (req, res) => res.redirect("/intern"));

  app.get("/intern/full_start.html", requireInternalSession, (req, res) => {
    // Met een tool bestaat deze pagina niet meer. Een adviseur met een oude
    // bladwijzer hoort geen 404 te krijgen maar de tool.
    if (eenToolAan()) return res.redirect("/");
    return serveTemplatedPage(req, res, "internFullStart", "Interne pagina niet beschikbaar voor deze tenant.");
  });

  app.post("/api/internal/login", (req, res) => {
    const email = String(req.body?.email || "");
    const password = String(req.body?.password || "");
    if (!checkInternalCredentials(email, password)) {
      return res.status(401).json({ error: "Onjuiste e-mail of wachtwoord." });
    }
    const exp = Date.now() + INTERNAL_COOKIE_TTL_MS;
    const cookieValue = signInternalCookie({ email: email.trim().toLowerCase(), exp });
    // Cookie attributes:
    //   HttpOnly  — JS can't read it, so an XSS hole can't steal the
    //               session even if one exists.
    //   Secure    — only sent over HTTPS, which Render always provides.
    //   SameSite=Lax — sent on top-level navigations + GETs, blocks the
    //               cookie on cross-site POSTs (mild CSRF protection).
    //   Path=/    — the cookie is needed for both /intern* pages and
    //               /api/internal/* requests.
    res.setHeader("Set-Cookie",
      `${INTERNAL_COOKIE_NAME}=${encodeURIComponent(cookieValue)}; ` +
      `Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.floor(INTERNAL_COOKIE_TTL_MS / 1000)}`
    );
    return res.json({ ok: true, redirect: naLogin() });
  });

  app.post("/api/internal/logout", (req, res) => {
    res.setHeader("Set-Cookie", `${INTERNAL_COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
    return res.json({ ok: true });
  });

  app.post("/api/internal/full/render", requireInternalSession, async (req, res) => {
    try {
      const epaModel = req.body?.epa_model && typeof req.body.epa_model === "object" ? req.body.epa_model : null;
      // Met een opname is het adres van de opname leidend en zijn de
      // formuliervelden aanvullend -- dezelfde regel als op de publieke
      // handoff (handleMidHandoff). Zonder deze gelijkschakeling kon een
      // adviseur een .epa wel in het snelle rapport gebruiken maar niet in
      // het volledige.
      const address = normalizeAddressInput(req.body?.address || (epaModel ? epaModel.address : null) || req.body || {});
      const email = String(req.body?.email || "").trim();
      const confirmedData = normalizeConfirmedDataInput(req.body?.confirmed_data || {});
      const errors = {};
      if (!validateEmail(email)) errors.email = "Geldig e-mailadres is verplicht.";
      if (!epaModel) {
        if (!address.postalcode) errors.postalcode = "Postcode is verplicht.";
        if (!address.housenumber) errors.housenumber = "Huisnummer is verplicht.";
        Object.assign(errors, validateConfirmedDataBasic(confirmedData));
      }
      if (Object.keys(errors).length) return res.status(400).json({ error: "Ongeldige invoer.", field_errors: errors });

      // Het dagplafond. Pas hier, na de veldcontrole: een afgekeurd formulier
      // hoort geen plek van vandaag op te maken.
      const plafond = dagplafond();
      if (plafond > 0 && getDagGebruik(dataDir) >= plafond) {
        return res.status(429).json({
          error: `Er zijn vandaag al ${plafond} rapporten aangevraagd. Probeer het morgen opnieuw.`,
          code: "dagplafond_bereikt",
          dagplafond: plafond,
        });
      }

      const payload = await createInternalOrder({
        req, email, address, confirmedData, epaModel,
        sourceMeta: {
          tenant_id: config.id,
          request_id: String(req.body?.request_id || "").trim(),
          invoer: String(req.body?.source || "").trim(),
        },
      });
      return res.json(payload);
    } catch (e) {
      return res.status(500).json({ error: e?.message || String(e) });
    }
  });

  // GET /api/internal/quota — returns the current month's usage. Two
  // ways to authenticate: either the same cookie used by the staff
  // intake page (so the staff can refresh-and-see), or a token query
  // param matching ADMIN_API_KEY (so a CLI / monitor can poll it).
  app.get("/api/internal/quota", (req, res) => {
    const adminKey = String(process.env.ADMIN_API_KEY || "").trim();
    const tokenOk = adminKey && String(req.query?.token || "").trim() === adminKey;
    const sessionOk = !!readInternalSession(req);
    if (!tokenOk && !sessionOk) return res.status(401).json({ error: "Unauthorized" });
    const state = readQuotaState(dataDir);
    const max = getQuotaMax();
    const plafond = dagplafond();
    return res.json({
      used: state.current_count,
      max,
      remaining: Math.max(0, max - state.current_count),
      month: state.current_month,
      history: state.history,
      // Het dagplafond is het enige dat werkelijk iets tegenhoudt; zonder
      // deze regels is dat nergens af te lezen.
      dag: new Date().toISOString().slice(0, 10),
      dag_gebruik: getDagGebruik(dataDir),
      dagplafond: plafond,
      dag_resterend: plafond > 0 ? Math.max(0, plafond - getDagGebruik(dataDir)) : null,
      // Een SCHATTING, met de duurste route als uitgangspunt. Zie
      // kostenPerRapport(): zonder bedrag is een teller niet te wegen.
      kosten_schatting: {
        per_rapport_eur: kostenPerRapport(),
        vandaag_eur: Math.round(getDagGebruik(dataDir) * kostenPerRapport() * 100) / 100,
        deze_maand_eur: Math.round(state.current_count * kostenPerRapport() * 100) / 100,
        ...(plafond > 0 ? { bij_vol_dagplafond_eur: Math.round(plafond * kostenPerRapport() * 100) / 100 } : {}),
        toelichting: "schatting op basis van de duurste route (adres); een rapport uit een opname kost minder",
      },
    });
  });

  // De map met middelen van de runtime zelf, voor bestanden die elke tenant
  // hetzelfde hoort te hebben. Zie assets/contact_modal.js: dat stond in vier
  // kopieen die uit elkaar liepen.
  const gedeeldeAssetsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "assets");

  app.get("/assets/:filename(*)", (req, res) => {
    // De eigen kopie van de tenant wint. Zo verandert er niets voor een tenant
    // die zijn bestand nog heeft, en kan de overstap er een voor een.
    const abs =
      safeAssetPath(assetsDir, req.params.filename) ||
      safeAssetPath(gedeeldeAssetsDir, req.params.filename);
    if (!abs) return res.status(404).send("Asset not found");
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.sendFile(abs);
  });

  // -------------------------------------------------------------------------
  // API surface
  // -------------------------------------------------------------------------
  // Het `runtime`-blok zegt WELKE runtime hier draait. Dat was van buiten niet
  // vast te stellen, en precies dat maakte het lead-BCC-incident (2 sep 2026)
  // zo lang onzichtbaar: de deploy leek te slagen terwijl de oude runtime
  // bleef draaien. `tag` komt uit de werkelijk geïnstalleerde pin, niet uit
  // het `version`-veld -- zie lib/runtime_versie.js voor waarom dat verschil
  // uitmaakt.
  // `centraal` zegt alleen of de koppeling met de centrale database aan staat
  // (url én sleutel gezet), niet welke. Zonder dit is van buitenaf niet te zien
  // of een tenant zijn bestellingen doorgeeft: het verschil tussen "meldt
  // niets want er was niets" en "meldt niets want hij staat uit" is anders pas
  // zichtbaar als er een bestelling misgaat.
  app.get("/health", (_req, res) =>
    res.json({ ok: true, tenant: config.id, ts: nowIso(), runtime: runtimeVersie(), centraal: centraalAan(), toegang: toegangAan() })
  );

  // Public brand info — useful for frontends that want to render the
  // current tenant's name/colors without hardcoding them.
  // De tekst waarmee een bezoeker instemt voordat zijn gegevens als lead naar de
  // partner gaan. Overgenomen van de WoonWijzerWinkel-adviseur, met de partnernaam
  // per tenant (keuze Dennis, 14 oktober 2026) -- zo staat er niet bij elke ingang
  // een eigen formulering.
  //
  // `privacyUrl` wijst standaard naar de pagina die deze runtime zelf bedient.
  // Hij stond leeg zolang elke tenant zijn eigen verklaring moest meeleveren --
  // en dat deed er geen een, dus had het vinkje nergens een link. Nu is er een
  // gedeelde pagina, en een tenant die hem op zijn eigen website wil hebben
  // zet `contact.privacyUrl` en overschrijft dit.
  function leadToestemming() {
    // De partij die opvolgt, niet per se de tenant zelf. Bij
    // OpenVerduurzamen is dat WoonWijzerWinkel: de bezoeker geeft
    // toestemming om het rapport met HEN door te spreken, en dan hoort die
    // naam in de zin te staan en niet die van het merk op de pagina.
    const partner = String(config.report?.adviesPartner || config.brand?.name || "deze partner").trim();
    return {
      tekst:
        `Ik ga ermee akkoord dat ${partner} mijn gegevens en mijn verduurzamingsadvies ` +
        `ontvangt en contact met mij opneemt over het advies. ${partner} gaat zorgvuldig ` +
        `met je gegevens om, zie de privacyverklaring.`,
      privacyUrl: String(config.contact?.privacyUrl || "").trim()
        || (templates.privacy ? "/privacyverklaring.html" : ""),
    };
  }

  app.get("/api/tenant", (_req, res) => res.json({
    id: config.id,
    brand: config.brand,
    contact: config.contact,
    // Het contactvenster leest de toestemmingstekst hier op, zodat hij niet in vier
    // kopieen van contact_modal.js staat.
    lead: leadToestemming(),
    // De naam waarmee het contactvenster de adviesaanvraag aankondigt. Stond
    // hardgecodeerd in de kopie van De Energie Raadgever.
    adviesPartner: String(config.report?.adviesPartner || config.brand?.name || "").trim(),
    product: { name: config.product?.name || "", priceEur: Number(config.payment?.priceEur || 30) },
  }));

  app.post("/api/full/lookup-address", async (req, res) => {
    try {
      const address = normalizeAddressInput(req.body || {});
      if (!address.postalcode || !address.housenumber) return res.status(400).json({ error: "postalcode en housenumber zijn verplicht." });
      const lookup = await fetchLookupFromReportApi(address);
      return res.json(lookup);
    } catch (e) { return res.status(500).json({ error: e?.message || String(e) }); }
  });

  // -------------------------------------------------------------------------
  // Mid: free short report flow
  //
  // The user-facing pages live at /mid_start.html (and / when present).
  // The frontend (mid_app.js) POSTs to these three endpoints. Each one
  // proxies through to the report-api so the tenant brand and shared
  // x-api-key stay consistent and the user's browser never talks to
  // report-api directly.
  // -------------------------------------------------------------------------

  // EPA ingest proxy. The browser uploads a base64 .epa; we forward it to
  // report-api's /api/epa/ingest and return the parsed model + labelsprongen.
  // Used by EPA-driven tenants (Softbee) whose intake is a file upload rather
  // than a postcode lookup.
  const EPA_INGEST_TIMEOUT_MS = Number(process.env.EPA_INGEST_TIMEOUT_MS || 120000);

  /**
   * De doorgifte voor een bestandsupload naar de report-api.
   *
   * Twee ingangen komen hierop uit: het .epa-bestand van de adviseur en het
   * officiele energielabelrapport (PDF) van de koper. De report-api leest
   * beide tot hetzelfde model, dus alles hier -- tenant meesturen, time-out,
   * foutafhandeling -- hoort identiek te zijn. Vandaar een gedeelde functie en
   * geen tweede kopie: twee kopieen lopen uiteen, en dan gedraagt dezelfde
   * woning zich anders afhankelijk van welk bestand iemand heeft.
   *
   * @param {string} pad        het pad op de report-api
   * @param {string} foutcode   prefix voor de foutcodes naar de browser
   * @param {string} traagheid  wat er in de time-outmelding aan de klant staat
   */
  const maakIngestProxy = (pad, foutcode, traagheid) => async (req, res) => {
    try {
      const renderUrl = getReportRenderUrl();
      if (!renderUrl) return res.status(500).json({ error: "FULL_APP_RENDER_URL ontbreekt." });
      const upstream = renderUrl.replace(/\/api\/full\/render$/i, pad);
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), EPA_INGEST_TIMEOUT_MS);
      let r;
      try {
        r = await undiciFetch(upstream, {
          // De tenant hoort erbij, net als op /api/mid/stream. Zonder dit
          // weet de report-api niet met welk rapportprofiel ze rekent, en
          // krijgt de pagina de lichtere labelsprongen terug in plaats van
          // dezelfde doorrekening als het rapport dat erop volgt. Het veld
          // `doel` uit de browser gaat mee in de spread.
          method: "POST",
          headers: buildReportApiHeaders(),
          body: JSON.stringify({ ...(req.body || {}), tenant: buildBrandPayload() }),
          dispatcher: longFetchAgent,
          signal: abort.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      const text = await r.text();
      res.status(r.status);
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      return res.send(text);
    } catch (e) {
      const timedOut = e?.name === "AbortError";
      return res.status(502).json({
        error: timedOut
          ? `${traagheid} duurde te lang. Probeer het opnieuw of neem contact op als het probleem blijft.`
          : e?.message || String(e),
        code: timedOut ? `${foutcode}_timeout` : `${foutcode}_error`,
      });
    }
  };

  app.post("/api/epa/ingest", maakIngestProxy("/api/epa/ingest", "epa_proxy", "De EPA-verwerking"));

  // Het officiele energielabelrapport (PDF). Dit is de route voor kopers: de
  // meesten hebben geen .epa -- dat is het werkbestand van de adviseur -- maar
  // wel de label-PDF. De report-api leest hem tot hetzelfde model, en geeft in
  // het veld `label_pdf` terug of de isolatiewaarden uit het label zelf komen
  // of geschat zijn. Het formulier hoort die melding te tonen.
  app.post(
    "/api/label-pdf/ingest",
    maakIngestProxy("/api/label-pdf/ingest", "label_pdf_proxy", "Het verwerken van het energielabel")
  );

  // Address lookup. Identical contract to /api/full/lookup-address — the
  // old Mid frontend just calls a different path. Kept as a separate
  // route so no frontend changes are needed.
  app.post("/api/mid/lookup", async (req, res) => {
    try {
      const address = normalizeAddressInput(req.body || {});
      if (!address.postalcode || !address.housenumber) {
        return res.status(400).json({ error: "postalcode en housenumber zijn verplicht." });
      }
      const lookup = await fetchLookupFromReportApi(address);
      return res.json(lookup);
    } catch (e) { return res.status(500).json({ error: e?.message || String(e) }); }
  });

  // Mid streaming (SSE). The report-api takes ~30-90s to write the short
  // report and emits incremental events along the way. We forward the
  // raw byte stream so the browser's EventSource sees the same events.
  // Auth and tenant branding are added on the way out; everything coming
  // back is just piped.
  app.post("/api/mid/stream", async (req, res) => {
    const renderUrl = getReportRenderUrl();
    if (!renderUrl) return res.status(500).json({ error: "FULL_APP_RENDER_URL ontbreekt." });
    const upstream = renderUrl.replace(/\/api\/full\/render$/i, "/api/mid/stream");
    const upstreamBody = JSON.stringify({ ...(req.body || {}), tenant: buildBrandPayload() });

    // SSE response headers. Note: we do NOT set Connection: keep-alive
    // here — it's an HTTP/1.1 directive that's invalid in HTTP/2 (which
    // is what Render+Cloudflare actually use), and adding it can cause
    // the proxy layer to behave unpredictably. Cache-Control: no-cache
    // already prevents intermediary buffering.
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("X-Accel-Buffering", "no");

    // We DON'T flushHeaders() here. It seemed like a good idea but on
    // Render's HTTP/2 proxy stack, flushing headers before any body byte
    // has been generated triggers a premature client-close event under
    // some conditions. Express will flush automatically when we write
    // the first chunk, which is fine for SSE.

    const ac = new AbortController();
    let upstreamStarted = false;

    // Wire client-disconnect abort, but ONLY after we've successfully
    // received headers from upstream and started piping. The earlier
    // version registered this handler before the upstream fetch even
    // started, which on some Node versions caused the abort to fire as
    // soon as any header-flush happened on the response — within 4ms,
    // before any real data could arrive.
    const onClientClose = () => { if (upstreamStarted) { try { ac.abort(); } catch {} } };
    res.on("close", onClientClose);

    try {
      const upstreamRes = await undiciFetch(upstream, {
        method: "POST",
        headers: { ...buildReportApiHeaders(), Accept: "text/event-stream" },
        body: upstreamBody,
        signal: ac.signal,
        dispatcher: longFetchAgent,
      });

      if (!upstreamRes.ok || !upstreamRes.body) {
        const text = await upstreamRes.text().catch(() => "");
        res.write(`event: error\ndata: ${JSON.stringify({ status: upstreamRes.status, message: text || "stream upstream error" })}\n\n`);
        return res.end();
      }

      // Now that upstream is connected, allow client-disconnect to
      // propagate as an abort (so we don't keep the OpenAI generation
      // running uselessly when the user navigates away).
      upstreamStarted = true;

      for await (const chunk of upstreamRes.body) {
        if (res.writableEnded) break;
        res.write(chunk);
      }
      res.end();
    } catch (e) {
      // Don't surface "operation aborted" as a user-facing error if it
      // was caused by the client itself disconnecting cleanly.
      const msg = e?.message || String(e);
      const isClientAbort = ac.signal.aborted && upstreamStarted;
      if (!isClientAbort) {
        try { res.write(`event: error\ndata: ${JSON.stringify({ message: msg })}\n\n`); } catch {}
      }
      try { res.end(); } catch {}
    } finally {
      res.off("close", onClientClose);
    }
  });

  // Onepager render proxy. The report-api does an enriched lookup + a
  // small (~5-10s) Anthropic call to produce a single-page summary.
  // We forward the body, attach the tenant brand payload, and pass the
  // upstream JSON response back unchanged. No streaming — a normal
  // POST/JSON round-trip with a generous timeout to cover the LLM call.
  app.post("/api/onepager/render", async (req, res) => {
    const renderUrl = getReportRenderUrl();
    if (!renderUrl) return res.status(500).json({ error: "FULL_APP_RENDER_URL ontbreekt." });
    const upstream = renderUrl.replace(/\/api\/full\/render$/i, "/api/onepager/render");

    const reqBody = {
      ...(req.body || {}),
      tenant: buildBrandPayload(),
    };

    const ac = new AbortController();
    const timeoutMs = Number(process.env.ONEPAGER_PROXY_TIMEOUT_MS || 60000);
    const timer = setTimeout(() => ac.abort(), timeoutMs);

    try {
      const upstreamRes = await undiciFetch(upstream, {
        method: "POST",
        headers: buildReportApiHeaders(),
        body: JSON.stringify(reqBody),
        signal: ac.signal,
        dispatcher: longFetchAgent,
      });

      const text = await upstreamRes.text();
      // Pass status code through so the tenant page can react to 404
      // (address not found), 400 (validation), etc. directly.
      res.status(upstreamRes.status);
      res.setHeader("Content-Type", upstreamRes.headers.get("content-type") || "application/json; charset=utf-8");
      return res.send(text);
    } catch (e) {
      const aborted = ac.signal.aborted;
      const message = aborted
        ? `Onepager render timeout na ${Math.round(timeoutMs / 1000)}s`
        : e?.message || String(e);
      return res.status(aborted ? 504 : 502).json({ error: message, code: aborted ? "onepager_timeout" : "onepager_proxy_error" });
    } finally {
      clearTimeout(timer);
    }
  });

  // Mid → Full handoff. Internal alias: same logic as /api/full/handoff,
  // but exposed under the path the legacy Mid frontend hardcoded. Skips
  // requireHandoffKey because this route is called by the user's browser
  // (same-origin), not by a server.
  app.post("/api/mid/full-report-handoff", handleMidHandoff);

  // Advertentietekst uitlezen. De adviseur plakt de tekst van een
  // woningadvertentie; de report-api haalt er maatregelen, installaties en het
  // aantal zonnepanelen uit. De runtime geeft alleen door, met de tenant erbij:
  // de report-api beslist of deze tenant dit mag (rapportprofiel).
  app.post("/api/mid/listing-extract", async (req, res) => {
    const renderUrl = getReportRenderUrl();
    if (!renderUrl) return res.status(500).json({ error: "FULL_APP_RENDER_URL ontbreekt." });
    const upstream = renderUrl.replace(/\/api\/full\/render$/i, "/api/mid/listing-extract");
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), Number(process.env.FULL_APP_LISTING_TIMEOUT_MS || 90000));
    try {
      const r = await undiciFetch(upstream, {
        method: "POST",
        headers: buildReportApiHeaders(),
        body: JSON.stringify({ tekst: String(req.body?.tekst ?? ""), tenant: buildBrandPayload() }),
        signal: ac.signal,
        dispatcher: longFetchAgent,
      });
      const json = await r.json().catch(() => null);
      return res.status(r.status).json(json || { error: "Onverwacht antwoord bij het lezen van de advertentie." });
    } catch {
      return res.status(502).json({ error: "De advertentietekst kon niet worden verwerkt. Probeer het opnieuw." });
    } finally {
      clearTimeout(t);
    }
  });

  // Mid handoff config — old Mid frontend hits this on init to learn
  // where to send the user. In the merged tenant world, the answer is
  // always "this very server", so we return self-referential URLs.
  app.get("/api/mid/full-handoff-config", (req, res) => {
    const baseUrl = getBaseUrl(req);
    return res.json({
      public_url: baseUrl,
      handoff_candidates: [`${baseUrl}/api/mid/full-report-handoff`],
      has_api_key: false, // browser-side calls don't need a key
    });
  });

  // Mid → tenant handoff. The Mid frontend POSTs confirmed_data here;
  // we mint a prefill token and return a start_url.
  async function handleMidHandoff(req, res) {
    try {
      const epaModel = req.body?.epa_model && typeof req.body.epa_model === "object" ? req.body.epa_model : null;
      // For EPA (0-meting) handoffs the measured assessment is authoritative, so
      // the address comes from the EPA and confirmed_data is optional.
      const address = normalizeAddressInput(
        req.body?.address || (epaModel ? epaModel.address : null) || req.body || {}
      );
      const confirmedData = normalizeConfirmedDataInput(req.body?.confirmed_data || {});
      const errors = {};
      if (!epaModel) {
        if (!address.postalcode) errors.postalcode = "Postcode is verplicht.";
        if (!address.housenumber) errors.housenumber = "Huisnummer is verplicht.";
        Object.assign(errors, validateConfirmedDataBasic(confirmedData));
      }
      if (Object.keys(errors).length) return res.status(400).json({ error: "Ongeldige handoff payload.", field_errors: errors });

      const baseUrl = getBaseUrl(req);
      const session = createPrefillSession({
        source: String(req.body?.source || (epaModel ? "epa" : "mid")).trim() || "mid",
        tenant_id: config.id,
        request_id: String(req.body?.request_id || "").trim(),
        cta_source: String(req.body?.cta_source || "").trim(),
        address,
        validated_address: req.body?.validated_address && typeof req.body.validated_address === "object" ? req.body.validated_address : null,
        confirmed_data: confirmedData,
        source_facts: req.body?.source_facts && typeof req.body.source_facts === "object" ? req.body.source_facts : null,
        epa_model: epaModel,
      });
      return res.json({ handoff_token: session.token, start_url: `${baseUrl}/full_start.html?handoff=${encodeURIComponent(session.token)}` });
    } catch (e) { return res.status(500).json({ error: e?.message || String(e) }); }
  }

  app.post("/api/full/handoff", requireHandoffKey, handleMidHandoff);
  app.post("/api/full/handoff-from-mid", requireHandoffKey, handleMidHandoff);

  app.get("/api/full/handoff/:token", (req, res) => {
    const session = getPrefillSession(String(req.params.token || ""));
    if (!session) return res.status(404).json({ error: "Handoff niet gevonden of verlopen." });
    return res.json({
      token: session.token,
      tenant_id: session.tenant_id || null,
      source: session.source,
      request_id: session.request_id || "",
      cta_source: session.cta_source || "",
      address: session.address,
      validated_address: session.validated_address || null,
      confirmed_data: session.confirmed_data,
      source_facts: session.source_facts || null,
      created_at: session.created_at,
    });
  });
  app.get("/api/full/prefill/:token", (req, res) => {
    // Legacy alias.
    const session = getPrefillSession(String(req.params.token || ""));
    if (!session) return res.status(404).json({ error: "Handoff niet gevonden of verlopen." });
    return res.json({
      token: session.token,
      tenant_id: session.tenant_id || null,
      source: session.source,
      request_id: session.request_id || "",
      cta_source: session.cta_source || "",
      address: session.address,
      validated_address: session.validated_address || null,
      confirmed_data: session.confirmed_data,
      source_facts: session.source_facts || null,
      created_at: session.created_at,
    });
  });

  app.post("/api/full/create-payment-from-handoff", async (req, res) => {
    try {
      const token = String(req.body?.handoff_token || req.body?.prefill_token || "").trim();
      const email = String(req.body?.email || "").trim();
      if (!token) return res.status(400).json({ error: "handoff_token is verplicht." });
      if (!validateEmail(email)) return res.status(400).json({ error: "Geldig e-mailadres is verplicht.", field_errors: { email: "Geldig e-mailadres is verplicht." } });
      const session = getPrefillSession(token);
      if (!session) return res.status(404).json({ error: "Handoff niet gevonden of verlopen." });
      const acceptTerms = req.body?.accept_terms === true || String(req.body?.accept_terms || "").toLowerCase() === "true";
      if (!acceptTerms) return res.status(400).json({ error: "Akkoord met de algemene voorwaarden is verplicht.", field_errors: { accept_terms: "Akkoord met de algemene voorwaarden is verplicht." } });
      // EPA handoffs carry the authoritative measured model; confirmed_data is
      // optional and therefore not re-validated.
      if (!session.epa_model) {
        const errors = validateConfirmedDataBasic(session.confirmed_data || {});
        if (Object.keys(errors).length) return res.status(400).json({ error: "Handoff bevat ongeldige woninggegevens.", field_errors: errors });
      }

      const payload = await createPaymentOrder({
        req, email,
        address: session.address,
        confirmedData: normalizeConfirmedDataInput(session.confirmed_data || {}),
        epaModel: session.epa_model || null,
        sourceMeta: { source: session.source || "mid", tenant_id: config.id, request_id: session.request_id || "", cta_source: session.cta_source || "", handoff_token: session.token, validated_address: session.validated_address || null, source_facts: session.source_facts || null },
      });
      return res.json(payload);
    } catch (e) { return res.status(500).json({ error: e?.message || String(e) }); }
  });

  app.post("/api/full/create-payment", async (req, res) => {
    try {
      const address = normalizeAddressInput(req.body?.address || req.body || {});
      const email = String(req.body?.email || "").trim();
      const confirmedData = normalizeConfirmedDataInput(req.body?.confirmed_data || {});
      const acceptTerms = req.body?.accept_terms === true || String(req.body?.accept_terms || "").toLowerCase() === "true";
      const errors = {};
      if (!validateEmail(email)) errors.email = "Geldig e-mailadres is verplicht.";
      if (!address.postalcode) errors.postalcode = "Postcode is verplicht.";
      if (!address.housenumber) errors.housenumber = "Huisnummer is verplicht.";
      if (!acceptTerms) errors.accept_terms = "Akkoord met de algemene voorwaarden is verplicht.";
      Object.assign(errors, validateConfirmedDataBasic(confirmedData));
      if (Object.keys(errors).length) return res.status(400).json({ error: "Ongeldige invoer.", field_errors: errors });

      const payload = await createPaymentOrder({
        req, email, address, confirmedData,
        sourceMeta: { source: "manual_full_start", tenant_id: config.id, request_id: String(req.body?.request_id || "").trim() },
      });
      return res.json(payload);
    } catch (e) { return res.status(500).json({ error: e?.message || String(e) }); }
  });

  app.post("/api/full/webhook/mollie", async (req, res) => {
    try {
      const paymentId = String(req.body?.id || req.query?.id || "").trim();
      if (!paymentId) return res.status(200).send("ok");
      const payment = await getMolliePayment(paymentId);
      const orderId = String(payment?.metadata?.order_id || "").trim();
      if (!orderId) return res.status(200).send("ok");
      const order = getOrderById(orderId);
      if (!order) return res.status(200).send("ok");
      mergeOrder(order.id, (current) => ({
        ...current,
        payment: { ...(current.payment || {}), id: payment.id, status: payment.status, paid_at: payment.paidAt || current.payment?.paid_at || null },
        status:
          payment.status === "paid" ? "paid"
          : payment.status === "authorized" ? "paid"
          : payment.status === "failed" ? "failed"
          : payment.status === "canceled" ? "canceled"
          : current.status,
        paid_at: payment.paidAt || current.paid_at || null,
      }));
      if (["paid", "authorized"].includes(payment.status)) triggerBackgroundProcessing(order.id);
      return res.status(200).send("ok");
    } catch { return res.status(200).send("ok"); }
  });

  app.post("/api/full/process-order/:id", requireAdminKey, async (req, res) => {
    try { return res.json(buildOrderPublicView(await processOrderById(String(req.params.id || "")))); }
    catch (e) { return res.status(500).json({ error: e?.message || String(e) }); }
  });

  app.get("/api/full/order/:id", (req, res) => {
    const order = getOrderById(String(req.params.id || ""));
    if (!order) return res.status(404).json({ error: "Order niet gevonden." });
    return res.json(buildOrderPublicView(order));
  });

  // Public download — the long form. Kept for backwards compatibility with
  // any link that's already in the wild. New links use the /r/:id short
  // alias below.
  app.get("/api/full/order/:id/download", (req, res) => {
    return serveOrderDownload(req, res, String(req.query?.token || "").trim());
  });

  // Short public download URL — what we put in emails now. Same auth
  // (token via ?t=...) and same file streaming as the long form.
  app.get("/r/:id", (req, res) => {
    return serveOrderDownload(req, res, String(req.query?.t || "").trim());
  });

  function serveOrderDownload(req, res, token) {
    const order = getOrderById(String(req.params.id || ""));
    if (!order) return res.status(404).send("Order niet gevonden.");
    if (!token || token !== order.download_token) return res.status(401).send("Unauthorized");
    // After retention cleanup the file is gone but the order row stays
    // (with pdf_deleted_at set) so we can give a meaningful response
    // instead of a bare 404.
    if (order.pdf_deleted_at) {
      const days = Number(process.env.PDF_RETENTION_DAYS || 365);
      // order.id is a hex string from crypto.randomBytes — safe to
      // interpolate without HTML-escaping.
      return res.status(410).type("text/html").send(
        `<!doctype html><html lang="nl"><meta charset="utf-8"><title>Rapport verlopen</title>` +
        `<body style="font-family:system-ui,sans-serif;max-width:560px;margin:60px auto;padding:0 18px;color:#0f172a;line-height:1.5;">` +
        `<h1 style="font-size:22px;margin:0 0 10px;">Dit rapport is niet meer beschikbaar</h1>` +
        `<p>Rapporten worden ${days} dagen bewaard en zijn daarna automatisch van onze servers verwijderd. Wel staat de PDF nog in de oorspronkelijke e-mail die u heeft ontvangen.</p>` +
        `<p style="color:#64748b;font-size:13px;">Order: ${order.id}</p>` +
        `</body></html>`
      );
    }
    if (!order.download_path || !fs.existsSync(order.download_path)) return res.status(404).send("PDF niet gevonden.");
    return res.download(order.download_path, order.pdf_filename || `${order.id}.pdf`);
  }

  app.get("/api/admin/orders", requireAdminKey, (_req, res) => {
    return res.json({ orders: listOrders(200).map(buildOrderPublicView).slice(0, 100) });
  });

  // -------------------------------------------------------------------------
  // EPA-preview feedback ("klopt / klopt niet" + free text). This is the
  // correctness loop for the EPA parser: a file can parse successfully while
  // still surfacing wrong data, and only the viewer (resident or
  // EP-adviseur) can tell. Entries are stored (epa_feedback.json) and
  // readable below so acceptance can actually be measured over time.
  // -------------------------------------------------------------------------
  const FEEDBACK_MAX_PER_HOUR = Number(process.env.FEEDBACK_MAX_PER_HOUR || 10);
  const feedbackRateLimit = new Map(); // ip -> array of epoch_ms timestamps

  function feedbackCheckRate(ip) {
    if (!ip) return true;
    const now = Date.now();
    const cutoff = now - 60 * 60 * 1000;
    const list = (feedbackRateLimit.get(ip) || []).filter((t) => t > cutoff);
    if (list.length >= FEEDBACK_MAX_PER_HOUR) {
      feedbackRateLimit.set(ip, list);
      return false;
    }
    list.push(now);
    feedbackRateLimit.set(ip, list);
    if (feedbackRateLimit.size > 500) {
      for (const [k, ts] of feedbackRateLimit) {
        if (!ts.some((t) => t > cutoff)) feedbackRateLimit.delete(k);
      }
    }
    return true;
  }

  app.post("/api/epa/feedback", (req, res) => {
    try {
      const body = req.body || {};

      // Honeypot, same idea as the lead form.
      if (typeof body.website === "string" && body.website.trim() !== "") {
        return res.json({ ok: true });
      }

      if (!feedbackCheckRate(getClientIp(req))) {
        return res.status(429).json({ ok: false, error: "Te veel verzoeken. Probeer het later opnieuw." });
      }

      const rating = body.rating;
      if (rating !== "correct" && rating !== "incorrect") {
        return res.status(400).json({ ok: false, error: 'rating moet "correct" of "incorrect" zijn.' });
      }
      const message = String(body.message || "").trim().slice(0, 2000);
      if (rating === "incorrect" && !message) {
        return res.status(400).json({
          ok: false,
          error: "Vertel kort wat er niet klopt, dan kunnen wij het verbeteren.",
        });
      }

      const entry = appendFeedback({
        tenant_id: config.id,
        rating,
        message,
        context: body.context && typeof body.context === "object" ? body.context : {},
      });
      console.log(
        `[feedback] tenant=${config.id} rating=${rating} registratienummer=${entry.context?.registratienummer || "-"} has_message=${Boolean(message)}`
      );
      return res.json({ ok: true, id: entry.id });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.get("/api/admin/feedback", requireAdminKey, (req, res) => {
    const limit = Number(req.query.limit || 200);
    return res.json({ stats: feedbackStats(), feedback: listFeedback(limit) });
  });

  app.post("/api/admin/recover-orders", requireAdminKey, async (_req, res) => {
    await recoverPendingOrders();
    return res.json({ ok: true });
  });

  // -------------------------------------------------------------------------
  // Lead form
  //
  // Visitors can leave their contact details via a modal on the mid_start
  // (in-iframe), full_start, and full_done pages. We email the lead to
  // LEAD_EMAIL (env), with replyTo set to the visitor so the team can hit
  // reply directly. Light per-IP rate limiting prevents trivial spam; the
  // form also carries a honeypot field that bots typically fill.
  // -------------------------------------------------------------------------
  const LEAD_MAX_PER_HOUR = Number(process.env.LEAD_MAX_PER_HOUR || 5);
  const leadRateLimit = new Map(); // ip -> array of epoch_ms timestamps

  function leadCheckRate(ip) {
    if (!ip) return true; // can't rate-limit without an ip; allow.
    const now = Date.now();
    const cutoff = now - 60 * 60 * 1000;
    const list = (leadRateLimit.get(ip) || []).filter((t) => t > cutoff);
    if (list.length >= LEAD_MAX_PER_HOUR) {
      leadRateLimit.set(ip, list);
      return false;
    }
    list.push(now);
    leadRateLimit.set(ip, list);
    // Occasional GC so the map doesn't grow unbounded on a long-running process.
    if (leadRateLimit.size > 500) {
      for (const [k, ts] of leadRateLimit) {
        if (!ts.some((t) => t > cutoff)) leadRateLimit.delete(k);
      }
    }
    return true;
  }

  function getClientIp(req) {
    const fwd = req.headers["x-forwarded-for"];
    if (typeof fwd === "string" && fwd.length) return fwd.split(",")[0].trim();
    return req.ip || req.connection?.remoteAddress || "";
  }

  app.post("/api/lead", async (req, res) => {
    try {
      const body = req.body || {};

      // Honeypot. Bots fill every field; real users never see this one.
      if (typeof body.website === "string" && body.website.trim() !== "") {
        // Lie about success so bots don't retry. No email is sent.
        return res.json({ ok: true });
      }

      const firstName = String(body.firstName || "").trim().slice(0, 80);
      const lastName  = String(body.lastName  || "").trim().slice(0, 80);
      const email     = String(body.email     || "").trim().slice(0, 200);
      const phone     = String(body.phone     || "").trim().slice(0, 40);
      const message   = String(body.message   || "").slice(0, 2000);
      const sourcePage = String(body.sourcePage || "").trim().slice(0, 60);

      const errors = [];
      if (!firstName) errors.push("Voornaam is verplicht.");
      if (!lastName)  errors.push("Achternaam is verplicht.");
      if (!email || !/^\S+@\S+\.\S+$/.test(email)) errors.push("Geldig e-mailadres is verplicht.");
      if (!phone || phone.replace(/\D/g, "").length < 6) errors.push("Geldig telefoonnummer is verplicht.");
      if (errors.length) {
        return res.status(400).json({ ok: false, error: errors.join(" ") });
      }

      const ip = getClientIp(req);
      if (!leadCheckRate(ip)) {
        return res.status(429).json({ ok: false, error: "Te veel aanvragen. Probeer het later opnieuw." });
      }

      // -----------------------------------------------------------
      // Build the optional report-context section + attachments
      // depending on where the lead came from. mid_report attaches
      // the rendered HTML; full_done attaches the saved PDF and
      // includes a 365-day download link.
      // -----------------------------------------------------------
      const ctxIn = (body.context && typeof body.context === "object") ? body.context : {};
      let reportContext = null;
      const attachments = [];
      // Ontvanger en teksten voor een adviesaanvraag (zie lib/advies_aanvraag.js).
      let mailOverrides = null;

      // Localisation maps for confirmed_data values (same source-of-truth as
      // full_start.html's OPTIONS so the email is readable for WWW staff).
      const LABEL_MAP = {
        soort_woning: { tussenwoning:"Tussenwoning", hoekwoning:"Hoekwoning", twee_onder_een_kap:"2-onder-1-kap", vrijstaand:"Vrijstaand", appartement:"Appartement" },
        energy_label: { "a++++":"A++++","a+++":"A+++","a++":"A++","a+":"A+","a":"A","b":"B","c":"C","d":"D","e":"E","f":"F","g":"G","unknown":"Onbekend" },
        ventilation_type: { natuurlijk:"Natuurlijk", mechanisch:"Mechanisch", unknown:"Onbekend" },
        heating_supply: { cv_ketel:"CV-ketel", warmtepomp:"Warmtepomp", pelletkachel:"Pelletkachel", warmtenet:"Warmtenet", unknown:"Onbekend" },
        heat_distribution: { radiatoren_convectoren:"Radiatoren/convectoren", elektrische_radiatoren_convectoren:"Elektrische radiatoren/convectoren", vloerverwarming_water:"Vloerverwarming (water)", vloerverwarming_elektrisch:"Vloerverwarming (elektrisch)", infraroodpanelen:"Infrarood panelen", unknown:"Onbekend" },
        existing_measures: { vloerisolatie:"Vloerisolatie", muurisolatie:"Muurisolatie", dakisolatie:"Dakisolatie", glasisolatie:"Glasisolatie", zonnepanelen:"Zonnepanelen", thuisbatterij:"Thuisbatterij", warmtepomp:"Warmtepomp", zonneboiler:"Zonneboiler", elektrische_tapwaterverwarming:"Elektrische tapwaterverwarming" },
      };
      const FIELD_LABELS = {
        soort_woning: "Soort woning", build_year: "Bouwjaar", floor_area_m2: "Woonoppervlakte (m²)", energy_label: "Huidig energielabel",
        ventilation_type: "Ventilatie", heating_supply: "Warmtevoorziening", heat_distribution: "Warmtesysteem", existing_measures: "Reeds aanwezig",
      };
      function humanizeConfirmed(cd) {
        if (!cd || typeof cd !== "object") return [];
        const out = [];
        for (const key of Object.keys(FIELD_LABELS)) {
          const v = cd[key];
          if (v === undefined || v === null || v === "") continue;
          if (Array.isArray(v)) {
            const labels = v.map((x) => LABEL_MAP[key]?.[x] || x).filter(Boolean);
            if (labels.length) out.push([FIELD_LABELS[key], labels.join(", ")]);
          } else {
            const label = LABEL_MAP[key]?.[String(v).toLowerCase()] || String(v);
            out.push([FIELD_LABELS[key], label]);
          }
        }
        return out;
      }
      function formatAddress(addr) {
        if (!addr || typeof addr !== "object") return "";
        if (addr.addr_line) return String(addr.addr_line);
        const num = [addr.housenumber, addr.houseaddition].filter(Boolean).map(String).map((s) => s.trim()).join("");
        return [addr.postalcode, num].filter(Boolean).join(" ").trim();
      }

      // ----- mid_report path -----
      // Client sends: { productType:"mid_report", address, confirmedData,
      //                 reportHtml (capped at ~1MB) }
      // ----- advies_aanvraag path -----
      // Vrijblijvend advies van de partner vanuit het snelle rapport. Zelfde
      // context als mid_report; het rapport gaat als pdf mee (of als html
      // als de pdf niet lukt) naar config.adviceRequest.recipient.
      if (ctxIn.productType === "advies_aanvraag") {
        const addr = formatAddress(ctxIn.address);
        // `soort` zegt WAT er gevraagd is. De tool van OpenVerduurzamen stuurt
        // "volledig_rapport" mee; zonder die waarde blijft het de
        // adviesaanvraag die het altijd was.
        const mail = adviesAanvraagMail({
          config, firstName, lastName, adres: addr,
          soort: String(ctxIn.soort || "").trim() || "advies",
        });
        if (mail) {
          mailOverrides = mail;
          const rows = [];
          if (addr) rows.push(["Adres", addr]);
          rows.push(...humanizeConfirmed(ctxIn.confirmedData));
          reportContext = { title: "Gegevens uit het snelle rapport", rows };

          const rawHtml = typeof ctxIn.reportHtml === "string" ? ctxIn.reportHtml : "";
          if (rawHtml && rawHtml.length < 1_500_000) {
            const fnameSafe = (addr || "rapport").replace(/[^a-z0-9]+/gi, "_").slice(0, 60) || "rapport";
            const los = losRapportHtml({ adres: addr, rapportHtml: rawHtml, tenantNaam: config?.brand?.name });
            try {
              const pdf = await htmlToPdfBuffer(los);
              attachments.push({ filename: `snel_rapport_${fnameSafe}.pdf`, content: pdf });
            } catch (e) {
              // eslint-disable-next-line no-console
              console.warn("[lead] pdf van snel rapport mislukt, html als bijlage:", e?.message || e);
              attachments.push({ filename: `snel_rapport_${fnameSafe}.html`, content: Buffer.from(los, "utf8") });
            }
          }
        }
      }

      if (ctxIn.productType === "mid_report") {
        const rows = [];
        const addr = formatAddress(ctxIn.address);
        if (addr) rows.push(["Adres", addr]);
        rows.push(...humanizeConfirmed(ctxIn.confirmedData));

        // Cap and attach the report so WWW sees what the user saw.
        // WWW asked for the attachment as PDF, so we render the
        // standalone HTML through PDFBolt (same engine as the paid
        // full report). If PDF generation fails we fall back to the
        // HTML attachment — a lead mail with an .html attachment
        // still beats no attachment at all.
        const rawHtml = typeof ctxIn.reportHtml === "string" ? ctxIn.reportHtml : "";
        if (rawHtml && rawHtml.length < 1_500_000) {
          const fnameSafe = (addr || "rapport").replace(/[^a-z0-9]+/gi, "_").slice(0, 60) || "rapport";
          // Print-CSS: het rapport-HTML uit de engine is self-contained
          // (inline styles + eigen <style>) en toont op de site de desktop-
          // tabel. De PDF-wrapper herstylt dus NIET, maar schaalt het
          // 920px-webontwerp alleen uniform (zoom 0.78) naar A4-content-
          // breedte — look, fonts en verhoudingen blijven 1-op-1 staan.
          // Belangrijk: de print-viewport volgt de papierbreedte (~726px),
          // waaronder de eigen <768px media query van het rapport naar de
          // hoge mobiele stapel schakelt. De .rapport .mid-report ...-
          // regels hieronder forceren de desktop-variant met hogere
          // specificiteit (0.3.0), ongeacht viewport van de renderer.
          // Full-bleed: op de site is het rapport een kaart-op-grijze-
          // pagina; in de PDF IS de pagina het rapport — de eigen
          // achtergrondkleur (uit het rapport-HTML gelezen, tenant-
          // onafhankelijk) loopt door tot de paginarand, het kaart-
          // omhulsel (radius/rand/schaduw) vervalt en de padding wordt
          // de paginamarge. Binnenkaarten behouden alles.
          // Kalibratie: volledig rapport op één A4 (echt 6223AX-24
          // rapport via lokale Chromium-print, sep 2026).
          const pageBgMatch = rawHtml.match(/class="mid-report"[^>]*style="[^"]*background:\s*(#[0-9a-fA-F]{3,8})/);
          const pageBg = pageBgMatch ? pageBgMatch[1] : "#fafbfc";
          const standalone = `<!doctype html><html lang="nl"><head><meta charset="utf-8"><title>Mid-rapport — ${escapeHtmlSimple(addr || "")}</title>
<style>
@page { size: A4; margin: 0; }
html, body { margin: 0; padding: 0; background: ${pageBg}; }
.rapport .mid-report .mid-grid { display: grid !important; }
.rapport .mid-report .mid-mobile-stack { display: none !important; }
.rapport .mid-report .mid-header { flex-direction: row !important; }
.rapport .mid-report .mid-label-chip { min-width: 200px !important; display: block !important; }
/* Rapport vult exact de A4-breedte (794/920 = 0.863): volledige bleed,
   geen achtergrondstrook naast het rapport (gaf een zichtbare naad
   met schaduwcascade van de kaarten). Hoogte blijft ruim op één A4. */
.rapport { width: 920px; zoom: 0.863; }
.rapport .mid-report > * { max-width: 100% !important; }
.rapport .mid-report {
  border-radius: 0 !important;
  border: 0 !important;
  padding: 26px 30px !important;
  box-shadow: none !important;
  box-sizing: border-box;
}
/* Schaduw van de grote sectie-kaarten uit in print: de gradient loopt
   de paginarand in en mengt daar met de achtergrondkleur (de
   "overlappende grijze vlakken"). Rand + radius blijven staan. */
.rapport .mid-report .mid-grid,
.rapport .mid-report .mid-kerngegevens,
.rapport .mid-report .mid-footer,
.rapport .mid-report .mid-label-chip { box-shadow: none !important; }
/* CTA/bestelblok ("Bestel volledig rapport €30") hoort op de site,
   niet in de lead-PDF naar de Woonwijzerwinkel. Bron- en disclaimer-
   regels eronder blijven staan. */
.rapport .mid-report .mid-footer { display: none !important; }
.rapport .mid-header, .rapport .mid-grid, .rapport .mid-kerngegevens { break-inside: avoid; }
.rapport h1, .rapport h2, .rapport h3 { break-after: avoid; }
</style>
</head><body><div class="rapport">${rawHtml}</div></body></html>`;
          try {
            const pdfBuffer = await htmlToPdfBuffer(standalone);
            attachments.push({ filename: `mid_rapport_${fnameSafe}.pdf`, content: pdfBuffer });
          } catch (e) {
            // eslint-disable-next-line no-console
            console.warn("[lead] kon mid-rapport PDF niet genereren, val terug op HTML-bijlage:", e?.message || e);
            attachments.push({ filename: `mid_rapport_${fnameSafe}.html`, content: Buffer.from(standalone, "utf8") });
          }
        }

        reportContext = { title: "Mid-rapport gegevens", rows };
      }

      // ----- full_start path -----
      // Client sends whatever the visitor has typed so far. No order
      // exists yet (they haven't paid), so no PDF / link.
      if (ctxIn.productType === "full_start") {
        const rows = [];
        const addr = formatAddress(ctxIn.address);
        if (addr) rows.push(["Adres", addr]);
        if (ctxIn.customerEmail) rows.push(["Opgegeven e-mail", String(ctxIn.customerEmail).slice(0, 200)]);
        rows.push(...humanizeConfirmed(ctxIn.confirmedData));
        if (rows.length) reportContext = { title: "Bezoeker was bezig met bestelling", rows };
      }

      // ----- full_done path -----
      // Client sends just the order_id. We look up the saved order to
      // build address, summary, the 365-day download URL, and attach
      // the PDF (same one the customer received).
      if (ctxIn.productType === "full_done" && ctxIn.orderId) {
        try {
          const order = getOrderById(String(ctxIn.orderId));
          if (order) {
            const rows = [];
            rows.push(["Ordernummer", order.id]);
            const addr = formatAddress(order.address);
            if (addr) rows.push(["Adres", addr]);
            rows.push(...humanizeConfirmed(order.confirmed_data));
            rows.push(["Status", String(order.status || "")]);
            if (order.email) rows.push(["E-mail van bestelling", order.email]);

            const baseUrl = String(process.env.APP_BASE_URL || "").trim().replace(/\/$/, "");
            const downloadUrl = baseUrl && order.download_token
              ? `${baseUrl}/r/${order.id}?t=${order.download_token}`
              : "";

            // Attach the PDF if it's still on disk (within the 365-day
            // retention window). If it has been cleaned up, the email
            // gracefully degrades to "link only".
            if (order.download_path && !order.pdf_deleted_at && fs.existsSync(order.download_path)) {
              try {
                const pdfBuffer = fs.readFileSync(order.download_path);
                const filename = order.pdf_filename || `rapport_${order.id}.pdf`;
                attachments.push({ filename, content: pdfBuffer });
              } catch (e) {
                // eslint-disable-next-line no-console
                console.warn("[lead] kon PDF niet lezen voor order", order.id, e?.message || e);
              }
            }

            reportContext = { title: "Bestelling: Volledig Rapport", rows, downloadUrl };
          }
        } catch (e) {
          // eslint-disable-next-line no-console
          console.warn("[lead] kon order niet ophalen:", e?.message || e);
        }
      }

      await sendLeadEmail({
        firstName,
        lastName,
        email,
        phone,
        message,
        sourcePage,
        config,
        reportContext,
        attachments,
        ...(mailOverrides
          ? { to: mailOverrides.to, subject: mailOverrides.subject, heading: mailOverrides.heading, intro: mailOverrides.intro }
          : {}),
        meta: {
          ip,
          userAgent: String(req.headers["user-agent"] || "").slice(0, 200),
          tenant: config.id,
        },
      });

      // En naar de centrale database, maar alleen met toestemming.
      //
      // Het formulier stuurt `akkoord: true` zodra het vinkje erin zit. Zolang dat
      // er niet is blijft de lead gewoon een mail, precies zoals voorheen -- deze
      // code mag nooit de reden zijn dat er geen lead meer binnenkomt. De melding
      // gooit niet en blokkeert het antwoord aan de bezoeker niet.
      const toestemming = leadToestemming();
      meldLead(
        {
          email, firstName, lastName, phone, message, sourcePage,
          soort: mailOverrides ? "advies_aanvraag" : "contact",
          // Geen adres: het contactformulier vraagt er niet om, en reportContext
          // draagt alleen een titel met rijen. Een veld dat altijd leeg is, is
          // misleidender dan geen veld.
          mailStatus: "verstuurd",
          toestemming: body.akkoord === true,
          toestemmingTekst: toestemming.tekst,
        },
        config,
      )
        .then((uit) => {
          if (uit.gemeld) {
            console.log(`[lead] centraal opgeslagen id=${uit.id ?? "?"}`);
          } else if (uit.reden !== "centraal_uit" && uit.reden !== "geen_toestemming") {
            console.warn(`[lead] centraal mislukt (${uit.reden})`);
          }
        })
        .catch(() => {});

      return res.json({ ok: true });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("[lead] verzenden mislukt:", e?.message || e);
      return res.status(500).json({ ok: false, error: "Versturen mislukt. Probeer het later opnieuw." });
    }
  });

  // Tiny escape helper used by the inline standalone HTML wrapper above.
  // Kept inside createTenantApp so it shares the closure.
  function escapeHtmlSimple(s) {
    return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  // Boot-time: run a recovery sweep + schedule periodic sweeps for any
  // orders that got stuck mid-flight (Render restart, network blip, etc.).
  // unref() op beide, om dezelfde reden als bij scheduleCleanup(): de sweeps
  // blijven in productie lopen zolang de server luistert, maar houden een
  // proces zonder server niet kunstmatig in leven.
  setTimeout(() => recoverPendingOrders().catch(() => {}), 1000).unref();
  const intervalMs = Number(process.env.RETRY_INTERVAL_MS || 60000);
  setInterval(() => { recoverPendingOrders().catch(() => {}); }, intervalMs).unref();

  // PDF retention cleanup runs daily (and once on boot). Set
  // PDF_RETENTION_DAYS=0 to disable. Default 365.
  scheduleCleanup();

  console.log(`[tenant-runtime] Tenant '${config.id}' (${config.brand?.name || ""}) ready.`);
  // Luid, niet stil: een tenant die per ongeluk in testmodus staat levert
  // rapporten uit zonder dat er betaald is.
  if (mollieTestmodus()) {
    console.log(`[tenant-runtime] LET OP: betalingen staan in TESTMODUS (MOLLIE_TESTMODE=1) voor '${config.id}'. Er komt geen geld binnen.`);
  }
  return app;
}

// Re-export so tenant repos can compose if they ever need to (rare).
// normalizeConfirmedDataInput is een witte lijst: wat er niet in staat, valt
// weg op weg naar het volledige rapport. Geexporteerd zodat een test die lijst
// kan vastleggen -- zie test/confirmed_data_doorgifte.test.js en de
// vergelijkbare les in test/brand_payload.test.js.
export { fillTemplate, templateVars, normalizeConfirmedDataInput };
