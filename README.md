# @openverduurzamen/tenant-runtime

Shared runtime for OpenVerduurzamen tenant apps. Each tenant runs as its own Render service; they all import this package via a git URL pin in their `package.json`.

## What's in here

- `index.js` — exports `createTenantApp(config)`. Returns a fully configured Express app: tenant-branded pages, Mid → checkout handoff, Mollie payment, PDFBolt PDF, Resend email, recovery loop.
- `lib/` — orders store, prefill store, Mollie client, Resend client, PDFBolt client.
- `scripts/update-all-tenants.sh` — fleet update script.

## How tenant apps consume it

```json
// In each tenant's package.json
{
  "dependencies": {
    "@openverduurzamen/tenant-runtime": "github:OpenVerduurzamen/tenant-runtime#v1.0.0"
  }
}
```

```js
// In each tenant's server.js
import { createTenantApp } from "@openverduurzamen/tenant-runtime";
import config from "./tenant.config.js";

const app = createTenantApp(config);
app.listen(process.env.PORT || 3000);
```

## Releasing a new version

1. Make changes in this repo, commit, push.
2. Tag and push: `git tag v1.0.1 && git push origin v1.0.1`
3. Roll out to every tenant: `./scripts/update-all-tenants.sh v1.0.1`

The script clones each tenant repo, bumps the runtime pin in its `package.json`, commits, pushes. Render auto-deploys each tenant.

## Public API

`createTenantApp(config)` — accepts a config object with this shape:

```js
{
  id: "woonwijzerwinkel",            // stable identifier
  publicDir: "/abs/path/to/public",  // where templates/ and assets/ live
  brand:    { name, legalName, accentColor, accentDark, coverSubtitle, runningHeader, logoPath },
  contact:  { phone, email, address1, address2, coverage, website },
  followUp: { enabled, chapterTitle, chapterIntro, services[], approachSteps[[t,b]], sealLine, ... },
  product:  { name, redirectAfterPaymentPath, termsPath, fullReportUrl },
  mail:     { fromAddress, subjectTemplate, signOff, bodyIntro, contactLine },
  payment:  { priceEur, description },
  prompts:  { systemRoleOverlay, adviceOverlay },
  reportApi:{ renderUrl, lookupUrl },
  report:   { fullReportAccess, midFocus[], labelFloor, labelScenarios[] }  // optioneel
}
```

`report` is het rapportprofiel dat naar de report-api gaat: `fullReportAccess`
(`"paid"` of `"included"`), `midFocus` (waar het snelle rapport over gaat),
`labelFloor` (geen advies onder dit label) en `labelScenarios` (de doellabels
van de scenario's). Laat het weg en de report-api gebruikt zijn defaults —
dan blijft het rapport exact zoals het was.

Voeg je hier een veld toe, voeg het dan óók toe aan `buildBrandPayload()` in
`index.js`. Die functie somt handmatig op wat de report-api meekrijgt: een
veld dat daar ontbreekt bereikt de renderer nooit, zonder dat er iets faalt.
`test/brand_payload.test.js` dekt dit af.

See `tenant-woonwijzerwinkel/tenant.config.js` for a fully-populated example.

## Required env vars (set on each tenant's Render service)

- `APP_BASE_URL` — that tenant's public URL
- `MOLLIE_API_KEY`
- `RESEND_API_KEY`
- `MAIL_BCC_ADDRESSES` (optional)
- `PDFBOLT_API_KEY`
- `FULL_APP_RENDER_URL`
- `FULL_APP_RENDER_API_KEY`
- `FULL_HANDOFF_API_KEY` (optional, required if Mid is doing handoffs)
- `ADMIN_API_KEY`
- `ORDERS_DATA_DIR=/var/data` (mount Render disk here)

### Mails aan een partner die zijn CRM eruit vult (optioneel)

- `BESTEL_MELDING_EMAIL` — komma-gescheiden. Staat die er, dan gaat bij elke opgeleverde
  bestelling een eigen melding naar die adressen, in hetzelfde formaat als de leadmail. Zonder de
  variabele gebeurt er niets.

  Waarom: een partner die zijn CRM uit onze mails vult kreeg bij een rapportkoop alleen een blind
  copy van de mail aan de klant (`MAIL_BCC_ADDRESSES`) -- een brief met een downloadlink, nooit
  ontworpen om geparsed te worden, en juist de tekst die verandert zodra de huisstijl komt. De
  bestelmelding is een koppelvlak in plaats van een toevalligheid; de klantmail blijft vrij. De
  melding bevat bewust geen rapportinhoud en geen downloadlink: wie meeleest met de rapporten
  houdt daarvoor de BCC.

Onder de leadmail en de bestelmelding staat een machineleesbaar blok (de tekstversie van de mail,
`lib/gegevensblok.js`), tussen `--- GEGEVENS (machineleesbaar; deze regels niet wijzigen) ---` en
`--- EINDE GEGEVENS ---`, met altijd dezelfde velden in dezelfde volgorde: `Soort`, `Nummer`,
`Naam`, `E-mail`, `Telefoon`, `Adres`, `Partner`, `Bron`, `Aangemaakt`. Een veld zonder waarde
blijft staan (`Adres:`). De lezer ziet de opgemaakte HTML-versie, een CRM-import leest de
tekstversie, en de opmaak mag dus veranderen zonder die import te breken. `Nummer` is leeg bij een
lead uit deze runtime: die krijgt zijn nummer van de centrale dienst, en dat melden gebeurt na het
mailen zodat een storing daar de bezoeker niet laat wachten. Matchen gaat op het e-mailadres.
Dezelfde velden staan in `gateway/leads.py` van `ai_adviseur_centraal`; verandert er hier iets, dan
daar ook. Tests: `test/gegevensblok.test.js`.

### Overdracht door een partner (optioneel, zie `docs/OVERDRACHT.md`)

- `OVERDRACHT_API_KEY` — partnersleutel(s), komma-gescheiden om te kunnen roteren. Zonder sleutel staat de overdracht uit (503), niet open.
- `OVERDRACHT_WEBHOOK_URL` + `OVERDRACHT_WEBHOOK_SECRET` — waar de meldingen `rapport.besteld|geleverd|mislukt` heen gaan, getekend met het geheim. Zonder beide geen meldingen.
- `OVERDRACHT_TERUG_HOSTS` — hosts waar `terug_url` naartoe mag (bv. `softbee.nl`, subdomeinen tellen mee). Anders `overdracht.terugHosts` uit de tenantconfig; zonder hosts wordt elke `terug_url` geweigerd.
- `OVERDRACHT_PRIJS_EUR` — wat wij de partner per geleverd rapport rekenen (default `payment.priceEur`). De adviseur ziet dit bedrag niet.
- `OVERDRACHT_WEBHOOK_MAX_POGINGEN` (default 30), `OVERDRACHT_WEBHOOK_TIMEOUT_MS` (default 10000).
