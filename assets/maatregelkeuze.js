/* maatregelkeuze.js -- GEDEELD, hoort bij de runtime
 *
 * De vraag "Hebt u behoefte aan specifieke maatregelen?" met, alleen bij ja,
 * de maatregelen om er een of meer uit te kiezen (meerkeuze sinds 24 november
 * 2026; daarvoor precies een). Feature van de
 * WoonWijzerWinkel (Dennis, 22 november 2026): het advies is het startpunt,
 * ook voor wie voor een warmtepomp of zonnepanelen komt. Wie er een kiest,
 * krijgt alleen scenario's met die maatregel(en); wie niets kiest het advies
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
 * - voorkeursmaatregel: de keuzes als kommalijst ("warmtepomp,dakisolatie"),
 *   of "geen". De report-api leest alleen dit en kent die kommalijst.
 * maatregel_behoefte is een gewone radio met data-field. De vinkjes van de
 * maatregelen hebben GEEN data-field: de apps lezen een data-field als een
 * enkele waarde. Dit script houdt daarom een onzichtbare radio met
 * data-field="voorkeursmaatregel" bij, met de kommalijst als waarde, en stuurt
 * bij elke wijziging een change-gebeurtenis. Zo slaat de bestaande
 * invoerafhandeling van elke app het op zonder aanpassing. Bij "nee" (of als
 * alle vinkjes uit staan) wordt het "geen", zodat een eerder gekozen
 * maatregel niet onzichtbaar blijft meetellen.
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

  /** "warmtepomp,dakisolatie" of een lijst -> alleen bekende keuzes, in KEUZES-volgorde. */
  function lijst(waarde) {
    var ruw = Array.isArray(waarde) ? waarde : String(waarde == null ? "" : waarde).split(",");
    var gezien = {};
    for (var i = 0; i < ruw.length; i += 1) {
      var w = String(ruw[i] || "").trim();
      if (isKeuze(w)) gezien[w] = true;
    }
    return KEUZES.filter(function (k) { return gezien[k.waarde]; }).map(function (k) { return k.waarde; });
  }

  // Zelfde inline stijlen als in energierekening.js, om dezelfde reden: de
  // tenantstijl `input { width:100%; height:44px }` maakt anders van een
  // radioknop een balk over de hele breedte.
  var RADIO =
    "width:16px;height:16px;flex:none;min-width:0;padding:0;margin:3px 0 0 0;" +
    "border:0;border-radius:0;box-shadow:none";
  var OPTIE =
    "display:flex;gap:8px;align-items:flex-start;margin:6px 0;font-weight:400;cursor:pointer";

  function radio(veld, waarde, label, hulp, gekozen, vink) {
    var invoer = vink
      ? '<input type="checkbox" data-maatregelkeuze-vink value="' + esc(waarde) + '"'
      : '<input type="radio" name="' + veld + '" data-field="' + veld + '" value="' + esc(waarde) + '"';
    return (
      '<label style="' + OPTIE + '">' +
      invoer +
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
    var gekozen = lijst(d.voorkeursmaatregel);
    var behoefte = d.maatregel_behoefte === "ja" || gekozen.length ? "ja" : d.maatregel_behoefte === "nee" ? "nee" : "";
    var waarde = gekozen.length ? gekozen.join(",") : d.voorkeursmaatregel === "geen" ? "geen" : "";

    var opsomming = KEUZES.map(function (k) {
      return radio("voorkeursmaatregel", k.waarde, k.label, k.hulp, gekozen.indexOf(k.waarde) >= 0, true);
    }).join("");

    return (
      '<section class="wizardSection" data-maatregelkeuze>' +
      '<div class="wizardSectionHeader">' +
      '<h3 class="wizardSectionTitle">Hebt u behoefte aan specifieke maatregelen?</h3>' +
      '<span class="wizardSectionMeta">Optioneel</span>' +
      "</div>" +
      '<p class="wizardSectionHelp">' +
      "Komt u voor bepaalde maatregelen, zoals een warmtepomp of zonnepanelen? Dan rekenen wij " +
      "alleen scenario's met die maatregelen door, afgestemd op uw woning. Kiest u niets, dan krijgt u " +
      "ons volledige advies." +
      "</p>" +
      '<div class="wizardGrid"><div class="wizardField wizardFieldFull">' +
      radio("maatregel_behoefte", "ja", "Ja, ik heb interesse in specifieke maatregelen", "", behoefte === "ja") +
      radio("maatregel_behoefte", "nee", "Nee, laat mij alle mogelijkheden zien", "", behoefte === "nee") +
      "</div></div>" +
      '<div data-maatregelkeuze-opties style="margin-top:8px' + (behoefte === "ja" ? "" : ";display:none") + '">' +
      '<div class="wizardField wizardFieldFull">' +
      "<label>Welke maatregelen? Kies er een of meer.</label>" +
      opsomming +
      // Het veld zelf: onzichtbaar, maar wel een echte radio met data-field,
      // zodat de invoerafhandeling van de app de kommalijst (of "geen") opslaat.
      '<input type="radio" name="voorkeursmaatregel" data-field="voorkeursmaatregel" value="' + esc(waarde || "geen") + '" data-maatregelkeuze-veld' +
      (waarde ? " checked" : "") + ' hidden tabindex="-1" aria-hidden="true" />' +
      "</div></div>" +
      "</section>"
    );
  }

  // Gedelegeerd op document, net als energierekening.js: het blok wordt als
  // string getekend en kan op elk moment opnieuw getekend worden.
  if (typeof document !== "undefined" && document.addEventListener) {
    // Zet de onzichtbare radio op de kommalijst van de vinkjes (of "geen") en
    // meld dat aan de app, maar alleen als er echt iets verandert.
    var schrijf = function (sectie, ja) {
      var veld = sectie.querySelector("[data-maatregelkeuze-veld]");
      if (!veld) return;
      var vinkjes = sectie.querySelectorAll("[data-maatregelkeuze-vink]");
      var aan = [];
      for (var i = 0; i < vinkjes.length; i += 1) {
        if (!ja) vinkjes[i].checked = false;
        else if (vinkjes[i].checked) aan.push(vinkjes[i].value);
      }
      var nieuw = aan.length ? lijst(aan).join(",") : "geen";
      if (veld.value === nieuw && veld.checked) return;
      veld.value = nieuw;
      veld.checked = true;
      veld.dispatchEvent(new Event("change", { bubbles: true }));
    };

    document.addEventListener("change", function (e) {
      var t = e && e.target;
      if (!t) return;
      var isVink = t.hasAttribute && t.hasAttribute("data-maatregelkeuze-vink");
      if (t.name !== "maatregel_behoefte" && !isVink) return;
      var sectie = t.closest ? t.closest("[data-maatregelkeuze]") : null;
      if (!sectie) return;
      if (isVink) {
        schrijf(sectie, true);
        return;
      }
      var opties = sectie.querySelector("[data-maatregelkeuze-opties]");
      var ja = t.value === "ja";
      if (opties) opties.style.display = ja ? "" : "none";
      if (!ja) schrijf(sectie, false);
    });
  }

  /** Voor de leadmail en de bestelling: de naam van een keuze, of van meer ("Warmtepomp en Dakisolatie"). */
  function naam(waarde) {
    var namen = lijst(waarde).map(function (w) {
      for (var i = 0; i < KEUZES.length; i += 1) if (KEUZES[i].waarde === w) return KEUZES[i].label;
      return "";
    });
    if (namen.length <= 1) return namen[0] || "";
    return namen.slice(0, -1).join(", ") + " en " + namen[namen.length - 1];
  }

  window.OVMaatregelkeuze = {
    blokHtml: blokHtml,
    KEUZES: KEUZES,
    VELDEN: ["maatregel_behoefte", "voorkeursmaatregel"],
    naam: naam,
    lijst: lijst,
  };
})();
