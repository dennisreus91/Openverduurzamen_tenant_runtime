/* maatregelkeuze.js -- GEDEELD, hoort bij de runtime
 *
 * De vraag "Hebt u behoefte aan een specifieke maatregel?" met, alleen bij ja,
 * de maatregelen om er precies EEN uit te kiezen. Feature van de
 * WoonWijzerWinkel (Dennis, 22 november 2026): het advies is het startpunt,
 * ook voor wie voor een warmtepomp of zonnepanelen komt. Wie er een kiest,
 * krijgt alleen scenario's met die maatregel; wie niets kiest het advies
 * zoals het was.
 *
 * AAN PER TENANT
 * In tenant.config.js: report.maatregelKeuze = true. Die vlag gaat met het
 * rapportprofiel mee naar de report-api (daar zit de rekenregel, in
 * lib/voorkeursmaatregel.js) en staat in /api/tenant als `maatregelKeuze`.
 * Een tenant-app tekent dit blok alleen als die vlag aan staat en dit script
 * geladen is (zie mid_start.html en renderStapDoel in mid_app.js).
 *
 * DE KEUZES EN TEKSTEN volgen VOORKEURSMAATREGELEN in de report-api. Komt
 * daar een keuze bij, dan hier ook; een waarde die de report-api niet kent
 * valt daar weg en het rapport blijft het gewone advies.
 *
 * DE VELDEN
 * - maatregel_behoefte: "ja" of "nee", alleen om het blok terug te tekenen.
 * - voorkeursmaatregel: de keuze, of "geen". De report-api leest alleen dit.
 * Beide zijn gewone radio's met data-field, dus de bestaande
 * invoerafhandeling van elke app slaat ze op zonder aanpassing. Bij "nee"
 * zet dit script zelf "geen" (met een change-gebeurtenis), zodat een eerder
 * gekozen maatregel niet onzichtbaar blijft meetellen.
 */
(function () {
  "use strict";

  var KEUZES = [
    { waarde: "warmtepomp", label: "Warmtepomp", hulp: "Hybride of volledig elektrisch: wij rekenen uit welke past." },
    { waarde: "zonnepanelen", label: "Zonnepanelen", hulp: "Hoeveel panelen er op uw dak passen en wat ze opleveren." },
    { waarde: "dakisolatie", label: "Dakisolatie", hulp: "Isolatie van het dak of de zolder." },
    { waarde: "gevelisolatie", label: "Gevel- of spouwmuurisolatie", hulp: "Isolatie van de buitenmuren." },
    { waarde: "vloerisolatie", label: "Vloerisolatie", hulp: "Isolatie van de vloer of kruipruimte." },
    { waarde: "hr_glas", label: "HR++- of triple glas", hulp: "Beter isolerend glas in de ramen." },
  ];

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function isKeuze(w) {
    for (var i = 0; i < KEUZES.length; i += 1) if (KEUZES[i].waarde === w) return true;
    return false;
  }

  // Zelfde inline stijlen als in energierekening.js, om dezelfde reden: de
  // tenantstijl `input { width:100%; height:44px }` maakt anders van een
  // radioknop een balk over de hele breedte.
  var RADIO =
    "width:16px;height:16px;flex:none;min-width:0;padding:0;margin:3px 0 0 0;" +
    "border:0;border-radius:0;box-shadow:none";
  var OPTIE =
    "display:flex;gap:8px;align-items:flex-start;margin:6px 0;font-weight:400;cursor:pointer";

  function radio(veld, waarde, label, hulp, gekozen) {
    return (
      '<label style="' + OPTIE + '">' +
      '<input type="radio" name="' + veld + '" data-field="' + veld + '" value="' + esc(waarde) + '"' +
      (gekozen ? " checked" : "") + ' style="' + RADIO + '" />' +
      '<span style="color:inherit;font-weight:400">' +
      '<strong style="color:inherit;font-weight:600">' + esc(label) + "</strong>" +
      (hulp ? '<br/><span class="wizardHelp" style="color:inherit;opacity:.72;font-weight:400">' + esc(hulp) + "</span>" : "") +
      "</span></label>"
    );
  }

  /**
   * Het hele blok.
   * @param {object} opties
   * @param {object} opties.waarden  wizardState.confirmed_data
   * @returns {string} HTML
   */
  function blokHtml(opties) {
    var d = (opties && opties.waarden) || {};
    var keuze = isKeuze(d.voorkeursmaatregel) ? d.voorkeursmaatregel : "";
    var behoefte = d.maatregel_behoefte === "ja" || keuze ? "ja" : d.maatregel_behoefte === "nee" ? "nee" : "";

    var opsomming = KEUZES.map(function (k) {
      return radio("voorkeursmaatregel", k.waarde, k.label, k.hulp, k.waarde === keuze);
    }).join("");

    return (
      '<section class="wizardSection" data-maatregelkeuze>' +
      '<div class="wizardSectionHeader">' +
      '<h3 class="wizardSectionTitle">Hebt u behoefte aan een specifieke maatregel?</h3>' +
      '<span class="wizardSectionMeta">Optioneel</span>' +
      "</div>" +
      '<p class="wizardSectionHelp">' +
      "Komt u voor een bepaalde maatregel, zoals een warmtepomp of zonnepanelen? Dan rekenen wij " +
      "alleen scenario's met die maatregel door, afgestemd op uw woning. Kiest u niets, dan krijgt u " +
      "ons volledige advies." +
      "</p>" +
      '<div class="wizardGrid"><div class="wizardField wizardFieldFull">' +
      radio("maatregel_behoefte", "ja", "Ja, ik heb interesse in een specifieke maatregel", "", behoefte === "ja") +
      radio("maatregel_behoefte", "nee", "Nee, laat mij alle mogelijkheden zien", "", behoefte === "nee") +
      "</div></div>" +
      '<div data-maatregelkeuze-opties style="margin-top:8px' + (behoefte === "ja" ? "" : ";display:none") + '">' +
      '<div class="wizardField wizardFieldFull">' +
      "<label>Welke maatregel? Kies er een.</label>" +
      opsomming +
      // De terugval voor "nee": onzichtbaar, maar wel een echte radio met
      // data-field, zodat de invoerafhandeling van de app hem opslaat.
      '<input type="radio" name="voorkeursmaatregel" data-field="voorkeursmaatregel" value="geen" data-maatregelkeuze-geen' +
      (d.voorkeursmaatregel === "geen" ? " checked" : "") + ' hidden tabindex="-1" aria-hidden="true" />' +
      "</div></div>" +
      "</section>"
    );
  }

  // Gedelegeerd op document, net als energierekening.js: het blok wordt als
  // string getekend en kan op elk moment opnieuw getekend worden.
  if (typeof document !== "undefined" && document.addEventListener) {
    document.addEventListener("change", function (e) {
      var t = e && e.target;
      if (!t || t.name !== "maatregel_behoefte") return;
      var sectie = t.closest ? t.closest("[data-maatregelkeuze]") : null;
      if (!sectie) return;
      var opties = sectie.querySelector("[data-maatregelkeuze-opties]");
      var ja = t.value === "ja";
      if (opties) opties.style.display = ja ? "" : "none";
      if (!ja) {
        var geen = sectie.querySelector("[data-maatregelkeuze-geen]");
        if (geen && !geen.checked) {
          geen.checked = true;
          geen.dispatchEvent(new Event("change", { bubbles: true }));
        }
      }
    });
  }

  /** Voor de leadmail en de bestelling: de naam van een keuze. */
  function naam(waarde) {
    for (var i = 0; i < KEUZES.length; i += 1) if (KEUZES[i].waarde === waarde) return KEUZES[i].label;
    return "";
  }

  window.OVMaatregelkeuze = {
    blokHtml: blokHtml,
    KEUZES: KEUZES,
    VELDEN: ["maatregel_behoefte", "voorkeursmaatregel"],
    naam: naam,
  };
})();
