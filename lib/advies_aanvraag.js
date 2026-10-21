// lib/advies_aanvraag.js
//
// De aanvraag die een bezoeker onder het snelle rapport doet, als mail naar
// de partner. Met het snelle rapport als bijlage, naar het adres in
// config.adviceRequest.recipient en niet naar LEAD_EMAIL.
//
// TWEE SOORTEN, EN HET VERSCHIL MOET IN DE MAIL STAAN
// Oorspronkelijk was er er een: vrijblijvend advies van een partner die het
// rapport omzet in maatregelen en de uitvoering regelt.
//
// Sinds 16 oktober 2026 vraagt de OpenVerduurzamen-tool iets anders aan: het
// VOLLEDIGE rapport, waarbij de bezoeker in dezelfde stap toestemming geeft
// om het met de partner door te spreken. Die ging als "vrijblijvend advies"
// de deur uit, en dat is onwaar tegenover de partij die opvolgt -- die belt
// dan over een adviesgesprek terwijl de klant op een rapport wacht. Live
// gezien bij de eerste proefaanvraag.
//
// Vandaar `soort`. Zonder die waarde verandert er niets.
//
// Een tenant zonder config.adviceRequest kent deze aanvraag niet: de route
// behandelt hem dan als een gewoon contactverzoek.

const esc = (s) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Ontvanger en teksten van de mail, of null als er niets naar de partner mag.
 *
 * TWEE REDENEN VOOR NULL
 * 1. De tenant kent deze aanvraag niet (geen `adviceRequest.recipient`).
 * 2. De bezoeker gaf geen toestemming (`akkoord` is niet true).
 *
 * Die tweede kwam erbij op 18 oktober 2026. Het toestemmingsvinkje was
 * `required`, dus er wás altijd toestemming en de mail kon er onvoorwaardelijk
 * uit. Maar dat vinkje vraagt om doorgifte aan de partner, niet om het recht
 * het rapport te maken -- en een toestemming die je moet geven om de dienst te
 * krijgen is geen vrije toestemming. Nu het optioneel is, moet de mail eraan
 * hangen, anders gaan naam, e-mailadres, telefoonnummer, adres en het rapport
 * alsnog naar de partner van iemand die nee zei.
 *
 * `akkoord` heeft met opzet GEEN standaardwaarde true. Een permissieve
 * standaard op een toestemmingsvlag is precies hoe dit de eerste keer misging.
 */
export function adviesAanvraagMail({ config, firstName, lastName, adres, soort = "advies", akkoord }) {
  if (akkoord !== true) return null;
  const ontvanger = String(config?.adviceRequest?.recipient || "").trim();
  if (!ontvanger) return null;
  const partner = String(config?.adviceRequest?.partnerName || "de partner").trim();
  const naam = [firstName, lastName].filter(Boolean).join(" ").trim() || "(naam onbekend)";
  const tenant = config?.brand?.name || config?.id || "";

  if (soort === "volledig_rapport") {
    return {
      to: ontvanger,
      subject: `Volledig rapport aangevraagd — ${adres || naam}`,
      heading: "Volledig rapport aangevraagd",
      intro:
        `${naam} heeft via de tool van ${tenant} het volledige verduurzamingsrapport aangevraagd ` +
        `en daarbij toestemming gegeven om het met ${partner} door te spreken. Het rapport gaat ` +
        `apart naar de aanvrager; het snelle rapport zit als bijlage bij deze mail.`,
      partner,
    };
  }

  return {
    to: ontvanger,
    subject: `Aanvraag vrijblijvend advies — ${adres || naam}`,
    heading: "Aanvraag vrijblijvend advies",
    intro: `${naam} vraagt via het snelle verduurzamingsrapport van ${tenant} vrijblijvend advies aan bij ${partner}. Het snelle rapport zit als bijlage bij deze mail.`,
    partner,
  };
}

/**
 * Het snelle rapport als losse HTML-pagina, geschikt om naar pdf om te zetten.
 *
 * LIGGEND, EN WAAROM DAT GEEN SMAAKKWESTIE IS
 * Dit stond op staand A4 met `@page{size:A4}`. Een staande A4 houdt bij een
 * marge van 10 mm 190 mm over, en dat is in CSS-pixels ongeveer 718 -- onder
 * de 768 waarop het rapport zelf naar de mobiele weergave schakelt
 * (mid_renderer.js, `@media (max-width: 767.98px)`). De pdf toonde daardoor
 * de gestapelde telefoonversie: drie maatregelen onder elkaar in plaats van
 * de vergelijkingstabel waar het rapport voor gemaakt is.
 *
 * Ronald Krijgsman zag dat op 21 oktober 2026 bij het downloaden en vroeg om
 * "één A4 in landschap, naast elkaar". Liggend houdt 281 mm over, ruim 1060
 * pixels, en dan staat de tabel er gewoon.
 *
 * TWEE KEER DICHTTIMMEREN
 * De breedte alleen is niet genoeg. PDFBolt rendert met een eigen viewport en
 * `emulateMediaType: "print"`, en we weten niet met welke breedte Chrome de
 * media query beoordeelt. Daarom staat de keuze er ook hard in, met een
 * id-selector ervoor: `#pdfRapport .mid-report .mid-grid` weegt zwaarder dan
 * de `.mid-report .mid-grid` uit de media query, ongeacht de volgorde waarin
 * de twee stylesheets staan. Zonder die id zou het van de volgorde afhangen,
 * en de media query komt na ons blok binnen -- die zou dus winnen.
 *
 * ÉÉN PAGINA WAS HET DOEL EN IS HET NIET GEWORDEN, MET OPZET
 * Gemeten op een hoekwoning uit 1971 met drie scenario's van 2, 3 en 5
 * maatregelen: het rapport is van zichzelf 1139 px hoog en een liggende A4
 * biedt er 734. Het compacte blok hieronder haalt daar 1139 → 893 vanaf,
 * zonder dat de tekst onder de 11 px komt. De laatste 159 px zijn alleen weg
 * te krijgen met een schaal van circa 0,82, en dan staat de tabel op 7 punt.
 * Dat is precies het tegenovergestelde van wat er gevraagd werd: Ronald wilde
 * liggend "zodat het beter leesbaar wordt".
 *
 * In plaats daarvan houdt `break-inside:avoid` op `.mid-grid` de hele
 * vergelijking bij elkaar. Pagina 1 draagt dan de kop plus de volledige
 * tabel (611 px), pagina 2 de toelichting, de kerngegevens en de kleine
 * lettertjes. Een lichtere woning past alsnog op één pagina. Wat niet meer
 * gebeurt, is dat de tabel middenin afbreekt -- en dát was het onoverzichtelijke.
 *
 * Gedeeld met de leadmail: die stuurt hetzelfde bestand als bijlage mee, dus
 * de partner ziet precies wat de bewoner downloadt.
 */
export function losRapportHtml({ adres, rapportHtml, tenantNaam }) {
  const titel = `Snel verduurzamingsrapport${adres ? ` — ${adres}` : ""}`;
  return `<!doctype html><html lang="nl"><head><meta charset="utf-8"><title>${esc(titel)}</title>
<style>
@page{size:A4 landscape;margin:8mm}
body{font-family:Arial,Helvetica,sans-serif;color:#0f172a;line-height:1.5;margin:0;background:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.kop{padding:0 0 4px;margin:0 0 4px;border-bottom:1px solid #e5e7eb;font-size:12px;color:#475569}
#pdfRapport .mid-report .mid-grid{display:grid!important}
#pdfRapport .mid-report .mid-mobile-stack{display:none!important}
#pdfRapport .mid-report{border:0!important;border-radius:0!important;padding:0!important}
.mid-footer-cta,.contactCta,.rapportActies{display:none!important}
#pdfRapport .mid-report .mid-header{gap:12px!important;margin-bottom:0!important}
#pdfRapport .mid-report .mid-headline{font-size:19px!important}
#pdfRapport .mid-report .mid-brand{margin-bottom:8px!important}
#pdfRapport .mid-report .mid-address{margin-bottom:6px!important;padding:3px 9px!important;font-size:11px!important}
#pdfRapport .mid-report .mid-sub{margin-top:4px!important;font-size:11.5px!important}
#pdfRapport .mid-report .mid-label-chip{display:flex!important;align-items:center!important;gap:12px!important;min-width:0!important;padding:8px 12px!important}
#pdfRapport .mid-report .mid-label-chip > div{margin-bottom:0!important;font-size:10.5px!important}
#pdfRapport .mid-report .mid-grid{margin-top:8px!important}
#pdfRapport .mid-report .mid-grid-cell{padding:5px 9px!important;font-size:11px!important;line-height:1.3!important}
#pdfRapport .mid-report .mid-grid-cell *{line-height:1.3!important}
#pdfRapport .mid-report .mid-kerngegevens{margin-top:8px!important;padding:8px 14px!important}
#pdfRapport .mid-report .mid-footer{margin-top:8px!important;padding:10px 14px!important}
#pdfRapport .mid-report .mid-grid{break-inside:avoid;page-break-inside:avoid}
.mid-grid-cell,.mid-kerngegevens,.mid-footer,.mid-toelichting{break-inside:avoid;page-break-inside:avoid}
</style></head><body>
<div class="kop">${esc(tenantNaam || "")}${adres ? ` · ${esc(adres)}` : ""}</div>
<div id="pdfRapport">${String(rapportHtml || "")}</div>
</body></html>`;
}

export default { adviesAanvraagMail, losRapportHtml };
