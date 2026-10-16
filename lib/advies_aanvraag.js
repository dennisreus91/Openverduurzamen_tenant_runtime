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
 * Ontvanger en teksten van de mail, of null als de tenant geen adviesaanvraag
 * kent.
 */
export function adviesAanvraagMail({ config, firstName, lastName, adres, soort = "advies" }) {
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

/** Het snelle rapport als losse HTML-pagina, geschikt om naar pdf om te zetten. */
export function losRapportHtml({ adres, rapportHtml, tenantNaam }) {
  const titel = `Snel verduurzamingsrapport${adres ? ` — ${adres}` : ""}`;
  return `<!doctype html><html lang="nl"><head><meta charset="utf-8"><title>${esc(titel)}</title>
<style>
@page{size:A4;margin:10mm}
body{font-family:Arial,Helvetica,sans-serif;color:#0f172a;line-height:1.5;margin:0;background:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.kop{padding:0 0 8px;margin:0 0 8px;border-bottom:1px solid #e5e7eb;font-size:12px;color:#475569}
.mid-mobile-stack,.mid-footer-cta,.contactCta,.rapportActies{display:none!important}
.mid-grid-cell,.mid-kerngegevens,.mid-footer,.mid-toelichting{break-inside:avoid;page-break-inside:avoid}
</style></head><body>
<div class="kop">${esc(tenantNaam || "")}${adres ? ` · ${esc(adres)}` : ""}</div>
${String(rapportHtml || "")}
</body></html>`;
}

export default { adviesAanvraagMail, losRapportHtml };
