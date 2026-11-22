/* kiosk.js -- GEDEELD, hoort bij de runtime
 *
 * Dezelfde advies-app op de website en op een digitale zuil in de winkel.
 * Feature van de WoonWijzerWinkel (Dennis, 22 november 2026): de zuil
 * (crm.woonwijzerwinkel.nl/kiosk) toont het advies als een van de
 * categorieen; na het advies tikt de bezoeker op een maatregel en ziet hij de
 * maatregelpagina van de zuil, zonder op een adviseur te hoeven wachten.
 *
 * AANZETTEN
 * Geen tenantinstelling: de zuil opent de app met ?kanaal=kiosk in de URL.
 * Zonder die parameter doet dit script niets en is alles zoals op de website.
 * Het kanaal gaat met de aanvraag mee naar de report-api (`kanaal`), die de
 * maatregellinks van de zuil kiest (lib/maatregel_links.js daar,
 * report.maatregelLinks.kanalen in tenant.config.js).
 *
 * WAT HET OP DE ZUIL DOET
 * 1. Kanaal onthouden: ?kanaal=kiosk op de eerste pagina, daarna in
 *    sessionStorage, zodat een vervolgpagina van de app het ook weet.
 * 2. Schone start: bij binnenkomst via de zuil en na een tijd zonder aanraking
 *    wist het alles wat deze app in sessionStorage zette (adres, contact-
 *    gegevens) en begint opnieuw. De zuil is een openbaar scherm; de volgende
 *    bezoeker hoort niets van de vorige te zien.
 * 3. Maatregellinks: een tik op een maatregel in het rapport opent de pagina
 *    van de zuil in een venster over de app, met een grote knop "Terug naar uw
 *    advies". Het advies blijft staan. De pagina's van de zuil werken in een
 *    frame (ze zijn ervoor gemaakt), hun eigen knoppen (contact, offerte)
 *    blijven daarbinnen werken.
 *    Wil de zuil de pagina liever zelf tonen, dan opent hij de app met
 *    ?kanaal=kiosk&kioskLinks=ouder; dan stuurt dit script alleen een bericht
 *    naar de zuil: { type: "ov-kiosk-open", url, maatregel }.
 * 4. Andere externe links (bronvermeldingen, nieuw tabblad) doen op de zuil
 *    niets: daar is geen browser om verder te surfen.
 * 5. Aanraakvriendelijk: grotere knoppen, velden en keuzerondjes, en geen
 *    PDF-download (die zou op de schijf van de zuil belanden).
 * 6. Aanraking melden aan de zuil ({ event: "kiosk-pause-timer" }, het bericht
 *    dat de zuil al kent van de woningscan), zodat hij niet midden in het
 *    advies naar het beginscherm springt.
 *
 * Voor de app: window.OVKiosk.kanaal() geeft "kiosk" of "website".
 */
(function () {
  "use strict";

  var SLEUTEL = "ov_kanaal";
  var params;
  try {
    params = new URLSearchParams(window.location.search);
  } catch (_) {
    params = { get: function () { return null; } };
  }

  function bewaard() {
    try {
      return window.sessionStorage.getItem(SLEUTEL);
    } catch (_) {
      return null;
    }
  }

  var uitUrl = String(params.get("kanaal") || "").trim().toLowerCase();
  var KIOSK = uitUrl === "kiosk" || (uitUrl === "" && bewaard() === "kiosk");
  var LINKS_NAAR_OUDER = String(params.get("kioskLinks") || "").toLowerCase() === "ouder";
  var IDLE_SEC = Math.max(30, Math.min(3600, parseInt(params.get("kioskIdle"), 10) || 240));
  var BEGIN_URL = window.location.pathname + window.location.search;

  function wisSessie() {
    try {
      window.sessionStorage.clear();
    } catch (_) {}
  }

  if (KIOSK && uitUrl === "kiosk") {
    // Binnenkomst via de zuil: wat er nog stond is van de vorige bezoeker.
    wisSessie();
  }
  if (KIOSK) {
    try {
      window.sessionStorage.setItem(SLEUTEL, "kiosk");
      window.sessionStorage.setItem("ov_kiosk_begin", BEGIN_URL);
    } catch (_) {}
  }

  window.OVKiosk = {
    kanaal: function () {
      return KIOSK ? "kiosk" : "website";
    },
    actief: KIOSK,
  };

  if (!KIOSK || typeof document === "undefined") return;

  var ingebed = window.parent && window.parent !== window;
  function naarOuder(bericht) {
    if (!ingebed) return;
    try {
      window.parent.postMessage(bericht, "*");
    } catch (_) {}
  }

  // ---- 5. Aanraakvriendelijk ------------------------------------------------
  var CSS =
    "html.ov-kiosk{font-size:18px;-webkit-tap-highlight-color:transparent}" +
    "html.ov-kiosk body{overscroll-behavior:none;-webkit-user-select:none;user-select:none}" +
    "html.ov-kiosk input,html.ov-kiosk textarea{-webkit-user-select:text;user-select:text}" +
    "html.ov-kiosk button,html.ov-kiosk .btn,html.ov-kiosk select," +
    "html.ov-kiosk input:not([type=radio]):not([type=checkbox]):not([type=hidden]){min-height:56px;font-size:18px}" +
    "html.ov-kiosk input[type=radio],html.ov-kiosk input[type=checkbox]{width:26px!important;height:26px!important;margin-top:0!important}" +
    // Alleen een label om een keuzerondje of vinkje: een veldlabel boven een
    // invoerveld zou anders los van zijn veld komen te staan.
    "html.ov-kiosk label:has(> input[type=radio]),html.ov-kiosk label:has(> input[type=checkbox]){min-height:44px}" +
    "html.ov-kiosk .mid-maatregel-link{display:inline-block;padding:8px 0;font-weight:600}" +
    "html.ov-kiosk [data-action=rapport-downloaden]{display:none!important}" +
    ".ov-kiosk-venster{position:fixed;inset:0;z-index:2147483000;background:#fff;display:flex;flex-direction:column}" +
    ".ov-kiosk-venster__balk{flex:none;display:flex;align-items:center;gap:12px;padding:12px 16px;background:#1f2a24;color:#fff}" +
    ".ov-kiosk-venster__terug{min-height:64px;padding:0 28px;font-size:20px;font-weight:700;border:0;border-radius:12px;" +
    "background:#fff;color:#1f2a24;cursor:pointer}" +
    ".ov-kiosk-venster__titel{font-size:18px;opacity:.85}" +
    ".ov-kiosk-venster iframe{flex:1;width:100%;border:0}";

  function zetStijl() {
    document.documentElement.classList.add("ov-kiosk");
    if (document.getElementById("ov-kiosk-stijl")) return;
    var st = document.createElement("style");
    st.id = "ov-kiosk-stijl";
    st.textContent = CSS;
    (document.head || document.documentElement).appendChild(st);
  }
  zetStijl();

  // ---- 3. Het venster met de maatregelpagina -------------------------------
  var venster = null;

  function sluitVenster() {
    if (!venster) return;
    venster.parentNode && venster.parentNode.removeChild(venster);
    venster = null;
    document.documentElement.style.overflow = "";
    aanraking();
  }

  function openVenster(url, titel) {
    sluitVenster();
    venster = document.createElement("div");
    venster.className = "ov-kiosk-venster";
    venster.setAttribute("role", "dialog");
    venster.setAttribute("aria-modal", "true");
    var balk = document.createElement("div");
    balk.className = "ov-kiosk-venster__balk";
    var terug = document.createElement("button");
    terug.type = "button";
    terug.className = "ov-kiosk-venster__terug";
    terug.textContent = "← Terug naar uw advies";
    terug.addEventListener("click", sluitVenster);
    var kop = document.createElement("span");
    kop.className = "ov-kiosk-venster__titel";
    kop.textContent = titel || "";
    balk.appendChild(terug);
    balk.appendChild(kop);
    var frame = document.createElement("iframe");
    frame.src = url;
    frame.title = titel || "Meer over deze maatregel";
    venster.appendChild(balk);
    venster.appendChild(frame);
    document.body.appendChild(venster);
    document.documentElement.style.overflow = "hidden";
    terug.focus();
    aanraking();
  }

  function veiligeUrl(href) {
    try {
      var u = new URL(href, window.location.href);
      return u.protocol === "https:" ? u.toString() : null;
    } catch (_) {
      return null;
    }
  }

  document.addEventListener(
    "click",
    function (e) {
      var a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
      if (!a) return;
      if (a.classList.contains("mid-maatregel-link")) {
        e.preventDefault();
        var url = veiligeUrl(a.getAttribute("href"));
        if (!url) return;
        var titel = (a.textContent || "").replace(/[↗›]/g, "").trim();
        var maatregel = a.getAttribute("data-maatregel") || "";
        if (LINKS_NAAR_OUDER && ingebed) {
          naarOuder({ type: "ov-kiosk-open", url: url, maatregel: maatregel, titel: titel });
        } else {
          openVenster(url, titel);
        }
        return;
      }
      // 4. Elke andere link die de app zou verlaten.
      var doel = veiligeUrl(a.getAttribute("href"));
      var extern = doel && new URL(doel).origin !== window.location.origin;
      if (a.target === "_blank" || extern) e.preventDefault();
    },
    true
  );

  // ---- 2 en 6. Aanraking: de zuil wakker houden, en een schone start na stilte
  var laatsteMelding = 0;
  var stilTimer = null;

  function opnieuwBeginnen() {
    sluitVenster();
    wisSessie();
    var begin = BEGIN_URL;
    window.location.replace(begin.indexOf("kanaal=kiosk") >= 0 ? begin : "/?kanaal=kiosk");
  }

  function aanraking() {
    var nu = Date.now();
    if (nu - laatsteMelding > 10000) {
      laatsteMelding = nu;
      naarOuder({ event: "kiosk-pause-timer" });
    }
    if (stilTimer) clearTimeout(stilTimer);
    // In het venster ziet de app geen scrollen of tikken (andere site), dus daar
    // ruimer: wie een pagina leest, raakt het scherm niet altijd aan.
    stilTimer = setTimeout(opnieuwBeginnen, IDLE_SEC * 1000 * (venster ? 2 : 1));
  }

  ["pointerdown", "keydown", "input", "scroll", "touchstart"].forEach(function (ev) {
    document.addEventListener(ev, aanraking, { passive: true, capture: true });
  });
  aanraking();

  // Uit het venster komt ook aanraking (de zuilpagina meldt zich met
  // kiosk-navigate); die telt mee, anders wist de app zich terwijl iemand leest.
  window.addEventListener("message", function (e) {
    var d = e && e.data;
    if (venster && d && typeof d === "object" && d.type === "kiosk-navigate") aanraking();
  });

  window.OVKiosk.sluitVenster = sluitVenster;
  window.OVKiosk.opnieuwBeginnen = opnieuwBeginnen;
})();
