/* energierekening.js -- GEDEELD, hoort bij de runtime
 *
 * Het blok waarin de bewoner zijn aantal huisgenoten en zijn eigen
 * jaarverbruik invult, met de links naar het verbruiksoverzicht van de
 * leveranciers erbij.
 *
 * WAAROM DIT BESTAAT, EN WAAROM GEDEELD
 * Het aantal bewoners is het enige gegeven dat de verbruiksschatting nodig
 * heeft en dat geen enkele bron over een woning weet. Gas hangt aan de woning,
 * stroom aan het huishouden: over 1 tot 5+ personen loopt stroom +115% en gas
 * +7 tot +55%, terwijl gas bij een gelijk huishouden een factor 2,8 verschilt
 * tussen een appartement en een vrijstaande woning. Daarom staat het hier als
 * veld en het woningtype niet -- dat weten we al.
 *
 * Het eigen jaarverbruik is de enige route naar een getal dat van DEZE bewoner
 * is. Binnen een vergelijkbare groep woningen loopt het gasverbruik een factor
 * twee tot drie uiteen, dus een gemiddelde is een goede schatting en geen
 * uitspraak over een huishouden.
 *
 * Gedeeld, om dezelfde reden als contact_modal.js: anders staat dit in vier
 * kopieen die uit elkaar lopen. De runtime serveert dit bestand op
 * /assets/energierekening.js zodra een tenant geen eigen kopie heeft.
 *
 * DE LINKS, EN WAT ZE EERLIJK BELOVEN
 * Een niet-ingelogde diepe link landt in de praktijk op het inlogscherm of op
 * het dashboard, niet op de verbruikspagina zelf. Daarom staat er een regel
 * bij over WAT de bewoner zoekt: jaarverbruik gas in m3, stroom in kWh,
 * teruglevering in kWh. Zonder die regel is de link een belofte die hij niet
 * nakomt.
 *
 * Zulke links verrotten. Daarom is er per leverancier een terugval op de
 * homepage, en mag een kapotte link nooit een harde fout geven.
 *
 * NOOIT INLOGGEGEVENS IN ONZE TOOL. De link gaat naar de site van de
 * leverancier, in een nieuw tabblad. Dat lijkt vanzelfsprekend, maar het staat
 * hier zodat niemand het later "handiger" maakt.
 */
(function () {
  "use strict";

  // Alfabetisch, met de diepe link waar hij bestaat en anders de homepage.
  // Geen uitputtende lijst: de grootste tien dekken de meeste huishoudens, en
  // de regel eronder zegt wat je zoekt als je leverancier er niet bij staat.
  var LEVERANCIERS = [
    { naam: "Budget Energie", url: "https://www.budgetenergie.nl/mijn-budget-energie" },
    { naam: "Eneco", url: "https://www.eneco.nl/mijn-eneco/" },
    { naam: "Engie", url: "https://www.engie.nl/mijn-engie" },
    { naam: "Essent", url: "https://www.essent.nl/mijnessent" },
    { naam: "Greenchoice", url: "https://www.greenchoice.nl/mijn-greenchoice/" },
    { naam: "NLE", url: "https://www.nle.nl/mijn-nle" },
    { naam: "Oxxio", url: "https://www.oxxio.nl/mijn-oxxio" },
    { naam: "Vandebron", url: "https://vandebron.nl/account" },
    { naam: "Vattenfall", url: "https://www.vattenfall.nl/mijn-vattenfall/" },
    { naam: "Zonneplan", url: "https://www.zonneplan.nl/inloggen" },
  ];

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function nummerveld(veld, label, plaatshouder, waarde, uit) {
    return (
      '<div class="wizardField">' +
      "<label>" + esc(label) + "</label>" +
      '<input data-field="' + veld + '" type="number" min="0" step="1" inputmode="numeric"' +
      ' value="' + esc(waarde == null ? "" : waarde) + '"' + (uit ? " disabled" : "") +
      ' placeholder="' + esc(plaatshouder) + '" />' +
      "</div>"
    );
  }

  /**
   * Het hele blok.
   *
   * @param {object} opties
   * @param {object} opties.waarden     wizardState.confirmed_data
   * @param {boolean} opties.alleenLezen
   * @returns {string} HTML
   */
  function blokHtml(opties) {
    var o = opties || {};
    var d = o.waarden || {};
    var uit = Boolean(o.alleenLezen);

    var lijst = LEVERANCIERS.map(function (l) {
      return (
        '<li><a href="' + esc(l.url) + '" target="_blank" rel="noopener noreferrer">' +
        esc(l.naam) + "</a></li>"
      );
    }).join("");

    return (
      '<section class="wizardSection" data-energierekening>' +
      '<div class="wizardSectionHeader">' +
      '<h3 class="wizardSectionTitle">Uw huishouden en uw energierekening</h3>' +
      '<span class="wizardSectionMeta">Optioneel</span>' +
      "</div>" +
      '<p class="wizardSectionHelp">' +
      "Het aantal huisgenoten maakt de schatting van uw stroomverbruik een stuk scherper. " +
      "Vult u ook uw eigen jaarverbruik in, dan rekenen wij met uw werkelijke rekening in " +
      "plaats van met het gemiddelde van vergelijkbare woningen." +
      "</p>" +
      '<div class="wizardGrid">' +
      nummerveld("aantal_bewoners", "Aantal bewoners", "Bijvoorbeeld 3", d.aantal_bewoners, uit) +
      nummerveld("eigen_gas_m3", "Gasverbruik per jaar (m³)", "Bijvoorbeeld 1100", d.eigen_gas_m3, uit) +
      nummerveld("eigen_stroom_kwh", "Stroomverbruik per jaar (kWh)", "Bijvoorbeeld 2900", d.eigen_stroom_kwh, uit) +
      nummerveld("eigen_teruglevering_kwh", "Teruglevering per jaar (kWh)", "Bijvoorbeeld 2400", d.eigen_teruglevering_kwh, uit) +
      "</div>" +
      // De stijl staat hier en niet in mid_styles.css, om dezelfde reden als
      // de HTML: vier kopieen van een stijlblad lopen uiteen. Het is weinig,
      // en het leunt verder op de bestaande wizard-klassen.
      '<details class="energierekeningHulp" style="margin-top:10px">' +
      '<summary style="cursor:pointer;font-size:14px;color:inherit">Waar vind ik dit?</summary>' +
      '<p class="wizardHelp">' +
      "Op uw jaarafrekening of in de app van uw energieleverancier. U zoekt drie getallen: " +
      "<strong>gas in m³</strong>, <strong>stroom in kWh</strong> en, als u zonnepanelen hebt, " +
      "<strong>teruglevering in kWh</strong>. Hebt u geen gasaansluiting, vul dan 0 in bij gas." +
      "</p>" +
      '<ul class="energierekeningLinks" style="columns:2;column-gap:24px;margin:8px 0;padding-left:18px;font-size:14px;line-height:1.9">' +
      lijst +
      "</ul>" +
      '<p class="wizardHelp">' +
      "Staat uw leverancier er niet bij? Zoek in uw eigen account op &lsquo;jaarverbruik&rsquo;, " +
      "&lsquo;jaarafrekening&rsquo; of &lsquo;verbruiksoverzicht&rsquo;. " +
      "U logt in op de site van uw leverancier, nooit bij ons." +
      "</p>" +
      "</details>" +
      "</section>"
    );
  }

  /** De velden die dit blok beheert. Voor de invoerafhandeling in mid_app.js. */
  var VELDEN = ["aantal_bewoners", "eigen_gas_m3", "eigen_stroom_kwh", "eigen_teruglevering_kwh"];

  window.OVEnergierekening = { blokHtml: blokHtml, VELDEN: VELDEN, LEVERANCIERS: LEVERANCIERS };
})();
