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

### Twee scripts om te controleren wat er werkelijk draait

```bash
node scripts/lokale-keten.mjs ../tenant_woonwijzerwinkel
bash scripts/controleer-live.sh woonwijzerwinkel.openverduurzamen.nl V3.37.0
```

**`lokale-keten.mjs`** zet de hele keten op je eigen machine: een nagebootste databron en
een nagebootst taalmodel, met daarop de echte report-api en de echte tenant, en de runtime
uit je werkmap in plaats van de gepinde kopie. Nul betaalde aanroepen, altijd dezelfde
voorbeeldwoning, en bij Ctrl+C een telling van de bronaanroepen -- zo is "doet het
volledige rapport de data opnieuw op" te tellen in plaats van te geloven.

Dit script bestaat omdat op 29 oktober 2026 drie fouten achter elkaar aan het licht kwamen
die geen testsuite kon zien: ze zaten geen van drieën in één onderdeel. Een merknaam die
de tenant-assets terugschreven, een belofte in het contactvenster die niet bij het moment
paste, en een cachemarkering die achterliep. Runtime, report-api en tenant deden alle drie
niets verkeerd.

**`controleer-live.sh`** is de tegenhanger na een uitrol: leest `/health`, vergelijkt de
draaiende tag met wat je verwachtte, en controleert of de cachemarkering in de pagina nog
bij het geserveerde bestand hoort. Afsluitcode 1 als er iets niet klopt, dus te hangen
achter een release. Geen betaalde aanroep.

Gebruik voor de lokale keten een venster **zonder** adviseurssessie: een ingelogde browser
slaat de gegevenspoort over, en dan test je hem niet. Dat was een van de drie.

### De gegevenspoort (publieke tenant, optioneel)

`features.gegevensPoort` in de tenantconfiguratie:

| waarde | wat er gebeurt |
|---|---|
| `false` (standaard) | geen poort |
| `"vooraf"` (of `true`) | naam, e-mail en telefoonnummer vóór het adres opzoeken |
| `"bij_download"` | pas bij de download van het snelle rapport of de aanvraag van het volledige |

Waarom het een plaats is en geen ja/nee: `"vooraf"` beschermt de Altum-aanroep van circa
een euro per adres, `"bij_download"` heeft een lagere drempel. Dat is een afweging die met
de prijs van het snelle rapport meebeweegt, en dan hoort het een regel config te zijn.

Een ingelogde adviseur ziet de poort nooit — `/api/tenant` geeft dan `false`. `/health`
noemt de plaats, zodat je van buiten kunt nakijken wat er aanstaat.

De poort is **geen toestemming**. Hij vraagt gegevens om de dienst te kunnen leveren; de
toestemming om die gegevens met de partner te delen is een eigen, expliciete vraag bij elke
rapportaanvraag, en blijft een vrije keuze — wie niet aanvinkt krijgt zijn rapport net zo
goed. Zie `assets/contact_modal.js` voor de twee standen van het venster.

**`POST /api/full/aanvraag`** — het volledige rapport aanvragen zónder adviseurslogin.
Zelfde body als `/api/internal/full/render` (`address`, `confirmed_data`, `request_id`).
Toegang via de poortcookie (`wwwpoort`, 12 uur, HttpOnly, SameSite=None zodat hij ook in
een iframe op de site van de partner meekomt) of een adviseurssessie. Het e-mailadres komt
**uit de cookie**, niet uit de body: anders laat iemand een rapport naar een willekeurig
adres mailen op onze rekening. Het dagplafond geldt, en de route staat in `DURE_ROUTES`
(`TENANT_DURE_AANROEPEN_PER_UUR`, standaard 20 per uur per IP).

Geen tweede bronaanroep: de report-api haalt zijn bronnen uit `lib/bron_cache.js`
(standaard een halfuur), en de bezoeker vraagt het volledige rapport minuten na het
snelle. Zet `BRON_CACHE_TTL_MS` daar hoger als een latere aanvraag ook gratis moet zijn.

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
