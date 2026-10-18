# Overdracht: een .epa doorzetten naar het verduurzamingsrapport

Voor partners (zoals Softbee) die hun adviseurs vanuit de eigen software een
verduurzamingsrapport willen laten bestellen. De partner bouwt alleen twee
dingen: **het .epa-bestand naar ons sturen** en **de adviseur doorsturen naar
de link** die terugkomt. Wij doen de rest: het controlescherm, het snelle
rapport, de bestelling, de PDF en de mail.

```
Partnersoftware                    OpenVerduurzamen                     Adviseur
───────────────                    ────────────────                     ────────
POST /api/epa/overdracht  ───────▶ .epa uitlezen
                          ◀─────── { overdracht_id, url }
link openen  ──────────────────────────────────────────────────────────▶ controleert gegevens
                                                                          bekijkt snel rapport
                                   bestelling (op rekening)  ◀────────── "Rapport bestellen"
webhook rapport.besteld   ◀─────── 
                                   rapport + PDF, mail naar adviseur ───▶ ontvangt PDF
webhook rapport.geleverd  ◀─────── 
```

## Afspraken

- **Betalen:** de adviseur rekent niet bij ons af. Wij factureren de partner
  per **geleverd** rapport; de partner factureert zijn adviseur. Op het scherm
  staat geen bedrag, alleen dat het rapport via de partner gefactureerd wordt.
- **Mail:** het rapport (PDF en downloadlink, 365 dagen geldig) gaat naar
  `adviseur_email`. De adviseur deelt het zelf met zijn klant.
- **Het .epa is leidend.** De adviseur kan op ons scherm niets corrigeren.
  Klopt er iets niet in het bestand, dan past de adviseur het aan in zijn
  EPA-software en start opnieuw vanuit de partnersoftware. Leest ons systeem
  iets verkeerd uit, dan meldt de adviseur dat via "Klopt er iets niet?" en
  lossen wij het op in het uitlezen.
- **Eén bestelling per link.** Een tweede klik, of een doorgestuurde link,
  levert geen tweede bestelling op.
- **Geldigheid:** een link is 7 dagen geldig. Daarna: opnieuw overdragen.

## Basis-URL en sleutel

```
Basis-URL:  https://<omgeving>          (krijgt u apart, test en productie)
Sleutel:    x-api-key: <sleutel>        of  Authorization: Bearer <sleutel>
```

Alle aanroepen hieronder zijn server-naar-server. Zet de sleutel nooit in de
browser of in de link.

## 1. Overdragen: `POST /api/epa/overdracht`

```json
{
  "epa_base64": "<het .epa-bestand, base64>",
  "adviseur_id": "ADV-1042",
  "adviseur_email": "adviseur@voorbeeld.nl",
  "dossier_id": "DOS-2026-0077",
  "terug_url": "https://app.softbee.nl/dossiers/77"
}
```

| Veld | Verplicht | Betekenis |
|---|---|---|
| `epa_base64` | ja | Het geregistreerde .epa-bestand (NTA 8800 0-meting), base64. Maximaal ca. 14 MB. |
| `adviseur_id` | ja | Uw kenmerk van de adviseur, waarop u factureert. Max. 100 tekens: letters, cijfers, `. _ : -`. Geen naam. |
| `adviseur_email` | ja | Waar het rapport heen gaat. |
| `dossier_id` | nee | Uw kenmerk van het dossier of de opname, voor support. Zelfde tekens als `adviseur_id`. |
| `terug_url` | nee | Waar de knop "Terug naar Softbee" heen gaat. Alleen `https` op uw eigen domein. |

**Antwoord `201`:**

```json
{
  "overdracht_id": "od_3f9a1c0b7e2d4a5b6c",
  "url": "https://<omgeving>/mid_start.html?overdracht=<token>",
  "verloopt_op": "2026-10-25T09:00:00.000Z",
  "samenvatting": {
    "adres": "Teststraat 9, 2625ZD Delft",
    "label": "C",
    "registratienummer": "123456",
    "geregistreerd": true
  }
}
```

Stuur de adviseur naar `url` (nieuw tabblad of doorverwijzing). Bewaar
`overdracht_id`: daarmee vraagt u de stand op en die staat in elke melding.
De `url` bevat een geheim token: behandel hem als een wachtwoord en zet hem
niet in logs.

Het bestand wordt meteen uitgelezen. Een bestand dat niet bruikbaar is, krijgt
u hier dus direct terug, niet pas wanneer de adviseur de link opent.

## 2. Stand opvragen: `GET /api/epa/overdracht/{overdracht_id}`

```json
{
  "overdracht_id": "od_3f9a1c0b7e2d4a5b6c",
  "status": "geleverd",
  "adviseur_id": "ADV-1042",
  "dossier_id": "DOS-2026-0077",
  "aangemaakt_op": "2026-10-18T09:00:00.000Z",
  "verloopt_op": "2026-10-25T09:00:00.000Z",
  "bestelling": {
    "bestelling_id": "cf97432ba6970d5b3cd18811",
    "besteld_op": "2026-10-18T09:05:00.000Z",
    "geleverd_op": "2026-10-18T09:09:00.000Z"
  }
}
```

`status`: `open` (nog niet besteld), `besteld` (rapport wordt gemaakt),
`geleverd` (gemaild, factureerbaar) of `mislukt` (niet geleverd, niet
factureerbaar). Een verlopen link zonder bestelling geeft `404`.

## 3. Meldingen (webhook)

Wij sturen een `POST` naar uw webhook-URL bij elke stap:

| `type` | Wanneer | Factureerbaar |
|---|---|---|
| `rapport.besteld` | De adviseur heeft besteld. | nee |
| `rapport.geleverd` | Het rapport is gemaild. | **ja** |
| `rapport.mislukt` | Het rapport kon niet worden gemaakt. De adviseur krijgt bericht. | nee |

```json
{
  "id": "cf97432ba6970d5b3cd18811.rapport.geleverd",
  "type": "rapport.geleverd",
  "aangemaakt_op": "2026-10-18T09:09:01.000Z",
  "data": {
    "overdracht_id": "od_3f9a1c0b7e2d4a5b6c",
    "adviseur_id": "ADV-1042",
    "dossier_id": "DOS-2026-0077",
    "bestelling_id": "cf97432ba6970d5b3cd18811",
    "adres": { "postcode": "2625ZD", "huisnummer": "9", "toevoeging": null },
    "besteld_op": "2026-10-18T09:05:00.000Z",
    "geleverd_op": "2026-10-18T09:09:00.000Z",
    "rapport_url": "https://<omgeving>/r/cf97432ba6970d5b3cd18811?t=..."
  }
}
```

- Antwoord met een `2xx` als u de melding hebt ontvangen. Bij een time-out,
  `408`, `429` of `5xx` proberen we het opnieuw, eerst binnen een halve minuut
  en daarna bij elke herstelronde.
- **Dubbele meldingen kunnen voorkomen.** Het `id` is vast per bestelling en
  type: verwerk elk `id` één keer.
- **De volgorde is niet gegarandeerd.** Een `geleverd` kan aankomen vóór een
  `besteld` die opnieuw geprobeerd wordt. Ga uit van het `type`, niet van de
  volgorde.
- `rapport_url` is de downloadlink van de PDF (365 dagen geldig). U kunt hem
  bij het dossier opslaan.

### Handtekening controleren

Elke melding heeft de header
`X-Overdracht-Signature: t=<unix-seconden>,v1=<hex>`. `v1` is de
HMAC-SHA256 van `"<t>.<ruwe body>"` met het gedeelde webhookgeheim. Weiger een
melding als de handtekening niet klopt of als `t` meer dan 5 minuten afwijkt.

```js
import crypto from "node:crypto";

function meldingKlopt(rauweBody, header, geheim) {
  const delen = Object.fromEntries(header.split(",").map((d) => d.split("=")));
  if (Math.abs(Date.now() / 1000 - Number(delen.t)) > 300) return false;
  const verwacht = crypto.createHmac("sha256", geheim).update(`${delen.t}.${rauweBody}`).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(verwacht), Buffer.from(delen.v1 || ""));
}
```

Gebruik de **ruwe** body, zoals die binnenkwam, niet opnieuw geserialiseerde
JSON.

```csharp
// C#
static bool MeldingKlopt(string rauweBody, string header, string geheim) {
    var delen = header.Split(',').Select(d => d.Split('=', 2)).ToDictionary(d => d[0], d => d[1]);
    var t = long.Parse(delen["t"]);
    if (Math.Abs(DateTimeOffset.UtcNow.ToUnixTimeSeconds() - t) > 300) return false;
    using var hmac = new HMACSHA256(Encoding.UTF8.GetBytes(geheim));
    var verwacht = Convert.ToHexString(hmac.ComputeHash(Encoding.UTF8.GetBytes($"{t}.{rauweBody}"))).ToLowerInvariant();
    return CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(verwacht), Encoding.UTF8.GetBytes(delen["v1"]));
}
```

## 4. Maandoverzicht: `GET /api/epa/overdrachten?maand=2026-10`

Alle **geleverde** rapporten in die maand (op `geleverd_op`). Dit is ook onze
factuurbasis. Met `&formaat=csv` krijgt u een CSV (scheidingsteken `;`).

```json
{
  "maand": "2026-10",
  "aantal": 1,
  "rapporten": [
    {
      "bestelling_id": "cf97432ba6970d5b3cd18811",
      "overdracht_id": "od_3f9a1c0b7e2d4a5b6c",
      "adviseur_id": "ADV-1042",
      "dossier_id": "DOS-2026-0077",
      "postcode": "2625ZD",
      "huisnummer": "9",
      "besteld_op": "2026-10-18T09:05:00.000Z",
      "geleverd_op": "2026-10-18T09:09:00.000Z",
      "bedrag_eur": "30.00"
    }
  ]
}
```

## Foutcodes

Foutantwoorden zien er zo uit: `{ "error": "<tekst>", "code": "<code>", "field_errors"?: {...} }`.

| HTTP | `code` | Betekenis en wat u doet |
|---|---|---|
| 400 | `ongeldige_invoer` | Een veld ontbreekt of klopt niet; zie `field_errors`. |
| 401 | `sleutel_ongeldig` | Sleutel ontbreekt of klopt niet. |
| 404 | `overdracht_onbekend` | Onbekende of verlopen overdracht. |
| 422 | `epa_not_registered` | Het bestand bevat geen geregistreerd label (geen EP2). Stuur de geregistreerde 0-meting. |
| 422 | `zip_encrypted` | Het bestand is met een wachtwoord beveiligd. Opslaan zonder beveiliging. |
| 422 | `epa_legacy_format` | Oud bestand van vóór NTA 8800. |
| 422 | `not_zip_or_xml`, `no_xml_entry`, `xml_parse_error`, `xml_unrecognized_schema`, `unknown_zip_method`, `invalid_base64` | Geen bruikbaar .epa-bestand. |
| 422 | `epa_onleesbaar` | Het bestand kon niet worden uitgelezen (overig). |
| 502/504 | `rapportdienst_onbereikbaar`, `rapportdienst_fout`, `epa_timeout` | Storing bij ons. Probeer het later opnieuw. |
| 503 | `overdracht_uit` | De overdracht staat in deze omgeving (nog) niet aan. |

Toon bij een `422` de `error`-tekst aan de adviseur: die is in het Nederlands
en zegt wat er met het bestand moet gebeuren.

## Testen

In de testomgeving loopt de hele keten echt: uitlezen, snel rapport,
bestellen, rapport, mail en webhook. Er wordt niets gefactureerd. Gebruik een
eigen e-mailadres als `adviseur_email`.

```bash
curl -sS https://<testomgeving>/api/epa/overdracht \
  -H "x-api-key: $SLEUTEL" -H "content-type: application/json" \
  -d "{\"epa_base64\":\"$(base64 -w0 opname.epa)\",\"adviseur_id\":\"TEST-1\",\"adviseur_email\":\"u@softbee.nl\",\"dossier_id\":\"TEST-DOS-1\"}"
```
