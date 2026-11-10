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
 *
 * EERST DE KEUZE, DAN DE VELDEN (10 november 2026)
 * De drie verbruiksvelden stonden altijd in beeld en leken verplicht, terwijl
 * de meeste mensen die cijfers niet bij de hand hebben. Nu kiest de bewoner
 * eerst: een schatting, of zijn eigen verbruik. Bij een schatting vragen wij
 * alleen het aantal bewoners; bij een eigen opgave de drie getallen van de
 * jaarafrekening.
 *
 * En een waarschuwing die er niet stond: gaat het om een woning die de
 * bezoeker wil KOPEN, dan hoort zijn eigen jaarverbruik bij zijn huidige
 * woning en niet bij deze. Dan is de schatting beter. Zonder die zin vult een
 * koper zijn eigen rekening in en rekent het rapport met het verkeerde huis.
 *
 * DE OMSCHAKELING ZIT IN DIT BESTAND, met een gedelegeerde listener op
 * document. Niet in de vier tenant-apps: die tekenen dit blok als string en
 * zouden elk hun eigen omschakeling krijgen -- vier kopieen die uiteenlopen,
 * precies waarom dit bestand bestaat. Het veld `verbruik_bron` staat in
 * VELDEN, dus de bestaande invoerafhandeling van elke app slaat hem op zonder
 * dat daar iets hoeft te veranderen.
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

  function keuzeveld(waarde, uit) {
    var opties = [
      { waarde: "schatting", label: "Een schatting", hulp: "Op basis van gemeten verbruik van vergelijkbare woningen (CBS)." },
      { waarde: "eigen", label: "Mijn eigen verbruik", hulp: "De drie getallen van uw jaarafrekening." },
    ];
    // Zonder keuze staat "schatting" aan: dat is wat er gebeurt als je niets
    // invult, en een voorselectie die iets anders belooft dan de uitkomst is
    // erger dan geen voorselectie.
    var gekozen = waarde === "eigen" ? "eigen" : "schatting";

    // TWEE STIJLREGELS VAN DE TENANTS BREKEN DIT BLOK, en daarom staan er
    // inline stijlen op de radio en op elke span. Live gezien bij de
    // WoonWijzerWinkel op 10 november 2026:
    //
    //   input, select, textarea { width:100%; height:44px; padding:0 13px;
    //                             border:1px solid ...; border-radius: ... }
    //     -> de radioknop werd een vak van 811 bij 44 pixels, met het rondje
    //        midden op de regel en de tekst ver naar rechts geduwd.
    //
    //   label .req, .wizardField legend span, .wizardField label span
    //                           { color: var(--brand); font-weight:600 }
    //     -> bedoeld voor het sterretje bij een verplicht veld, maar het
    //        kleurde de hele optietekst merkrood en vet.
    //
    // Inline wint van een stylesheetregel zonder !important, dus dit is de
    // kortste weg die in alle vier de tenants werkt. Haal ze niet weg zonder
    // in een echte browser te kijken: in een DOM-shim ziet het er goed uit.
    var RADIO =
      "width:16px;height:16px;flex:none;min-width:0;padding:0;margin:3px 0 0 0;" +
      "border:0;border-radius:0;box-shadow:none";
    return (
      '<div class="wizardField" data-verbruik-keuze style="grid-column:1/-1">' +
      "<label>Rekenen wij met een schatting of met uw eigen verbruik?</label>" +
      opties
        .map(function (o) {
          return (
            '<label style="display:flex;gap:8px;align-items:flex-start;margin:6px 0;font-weight:400;cursor:pointer">' +
            '<input type="radio" name="verbruik_bron" data-field="verbruik_bron" value="' + o.waarde + '"' +
            (o.waarde === gekozen ? " checked" : "") + (uit ? " disabled" : "") +
            ' style="' + RADIO + '" />' +
            '<span style="color:inherit;font-weight:400">' +
            '<strong style="color:inherit;font-weight:600">' + esc(o.label) + "</strong><br/>" +
            '<span class="wizardHelp" style="color:inherit;opacity:.72;font-weight:400">' + esc(o.hulp) + "</span></span>" +
            "</label>"
          );
        })
        .join("") +
      '<p class="wizardHelp" style="margin-top:4px">' +
      "Gaat het om een woning die u wilt <strong>kopen</strong>? Kies dan de schatting: uw eigen " +
      "jaarverbruik hoort bij de woning waar u nu woont, niet bij deze." +
      "</p>" +
      "</div>"
    );
  }

  /** De groepen omschakelen op de gekozen bron. */
  function pasKeuzeToe(sectie) {
    if (!sectie) return;
    var radio = sectie.querySelector('input[name="verbruik_bron"]:checked');
    var eigen = Boolean(radio) && radio.value === "eigen";
    var groepen = sectie.querySelectorAll("[data-verbruik-groep]");
    for (var i = 0; i < groepen.length; i += 1) {
      var hoort = groepen[i].getAttribute("data-verbruik-groep") === (eigen ? "eigen" : "schatting");
      groepen[i].style.display = hoort ? "" : "none";
    }
  }

  // Een gedelegeerde listener, en hij overleeft het hertekenen van het blok.
  // `change` en niet `input`: een radio stuurt beide, en change is de
  // gebeurtenis die ook bij toetsenbordgebruik precies een keer komt.
  if (typeof document !== "undefined" && document.addEventListener) {
    document.addEventListener("change", function (e) {
      var t = e && e.target;
      if (!t || t.name !== "verbruik_bron") return;
      pasKeuzeToe(t.closest ? t.closest("[data-energierekening]") : null);
    });
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
    var eigenGekozen = d.verbruik_bron === "eigen";

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
      "Wij rekenen met een schatting op basis van vergelijkbare woningen, of met uw eigen " +
      "jaarverbruik als u dat bij de hand hebt. Uw eigen cijfers zijn scherper: binnen een " +
      "groep vergelijkbare woningen verschilt het gasverbruik een factor twee tot drie." +
      "</p>" +
      '<div class="wizardGrid">' +
      keuzeveld(d.verbruik_bron, uit) +
      // Het aantal bewoners hoort bij de SCHATTING: het is het enige gegeven
      // dat geen bron over een woning weet, en bij een eigen opgave niet meer
      // nodig. Gas hangt aan de woning, stroom aan het huishouden.
      '<div data-verbruik-groep="schatting"' + (eigenGekozen ? ' style="display:none"' : "") + ">" +
      nummerveld("aantal_bewoners", "Aantal bewoners", "Bijvoorbeeld 3", d.aantal_bewoners, uit) +
      "</div>" +
      '<div data-verbruik-groep="eigen" style="grid-column:1/-1' + (eigenGekozen ? "" : ";display:none") + '">' +
      '<div class="wizardGrid">' +
      nummerveld("eigen_gas_m3", "Gasverbruik per jaar (m³)", "Bijvoorbeeld 1100", d.eigen_gas_m3, uit) +
      nummerveld("eigen_stroom_kwh", "Stroomverbruik per jaar (kWh)", "Bijvoorbeeld 2900", d.eigen_stroom_kwh, uit) +
      nummerveld("eigen_teruglevering_kwh", "Teruglevering per jaar (kWh)", "Bijvoorbeeld 2400", d.eigen_teruglevering_kwh, uit) +
      "</div>" +
      "</div>" +
      "</div>" +
      // De stijl staat hier en niet in mid_styles.css, om dezelfde reden als
      // de HTML: vier kopieen van een stijlblad lopen uiteen. Het is weinig,
      // en het leunt verder op de bestaande wizard-klassen.
      '<div data-verbruik-groep="eigen"' + (eigenGekozen ? "" : ' style="display:none"') + '>' +
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
      "</div>" +
      "</section>"
    );
  }

  /** De velden die dit blok beheert. Voor de invoerafhandeling in mid_app.js. */
  // `verbruik_bron` staat hier bewust bij: elke tenant-app spreidt deze lijst
  // in haar invoerafhandeling, dus zo wordt de keuze opgeslagen zonder dat er
  // in vier apps iets hoeft te veranderen.
  var VELDEN = ["verbruik_bron", "aantal_bewoners", "eigen_gas_m3", "eigen_stroom_kwh", "eigen_teruglevering_kwh"];

  window.OVEnergierekening = { blokHtml: blokHtml, VELDEN: VELDEN, LEVERANCIERS: LEVERANCIERS };
})();
