#!/usr/bin/env bash
#
# controleer-live.sh — na een uitrol: draait daar wat je denkt dat er draait?
#
# WAAROM DIT BESTAAT
# Op 29 oktober 2026 rolde Render de pin-bump uit en de configcommit die er seconden later
# op stond niet. De tenant draaide dus de nieuwe runtime met de OUDE instellingen, en daar
# was van buiten niets aan te zien -- behalve door /health te lezen, wat niemand doet.
# Diezelfde ochtend bleek ook de cachemarkering achter te lopen, met als gevolg dat
# terugkerende bezoekers de app zonder gegevenspoort kregen.
#
# Allebei binnen tien seconden vast te stellen, en allebei alleen als je kijkt. Daarom dit
# script: geen betaalde aanroep, geen rapport, alleen de vragen die na een uitrol tellen.
#
# GEBRUIK
#   bash scripts/controleer-live.sh woonwijzerwinkel.openverduurzamen.nl
#   bash scripts/controleer-live.sh woonwijzerwinkel.openverduurzamen.nl V3.37.0
#
# Met een tag erbij controleert hij ook of die versie werkelijk draait. Afsluitcode 1 als
# er iets niet klopt, zodat je hem achter een release kunt hangen.

set -uo pipefail

HOST="${1:-}"
VERWACHTE_TAG="${2:-}"
if [ -z "$HOST" ]; then
  echo "Gebruik: $0 <hostnaam> [verwachte-tag]" >&2
  exit 2
fi
BASIS="https://${HOST#https://}"
FOUTEN=0

zeg() { printf '  %-28s %s\n' "$1" "$2"; }
fout() { printf '  %-28s %s\n' "$1" "FOUT: $2"; FOUTEN=$((FOUTEN + 1)); }

GEZONDHEID="$(curl -s --max-time 20 "$BASIS/health" || true)"
if ! printf '%s' "$GEZONDHEID" | grep -q '"ok":true'; then
  fout "/health" "geen antwoord of niet ok -- $(printf '%s' "$GEZONDHEID" | head -c 120)"
  echo; echo "  $FOUTEN probleem(en)."; exit 1
fi

veld() { printf '%s' "$GEZONDHEID" | grep -oE "\"$1\":(\"[^\"]*\"|true|false|null|[0-9]+)" | head -1 | cut -d: -f2- | tr -d '"'; }

TAG="$(veld tag)"
zeg "runtime" "$TAG"
if [ -n "$VERWACHTE_TAG" ] && [ "$TAG" != "$VERWACHTE_TAG" ]; then
  fout "runtime" "verwacht $VERWACHTE_TAG, draait $TAG -- de uitrol is niet aangekomen"
fi

for v in toegang gegevens_poort een_tool dagplafond centraal pdf; do
  zeg "$v" "$(veld "$v")"
done

# Onder welke partner de report-api onze sleutel kent. Staat daar niets, dan kan het
# VOLLEDIGE rapport niet geleverd worden -- het snelle wel, want dat bewaart niets. Zo zag
# de WoonWijzerWinkel-tenant er wekenlang gezond uit terwijl zijn betaalde product niet
# werkte, en kwam het pas uit bij de eerste bestelling.
PARTNER="$(veld rapport_partner)"
KAN="$(veld rapport_kan_bewaren)"
if [ "$KAN" = "true" ]; then
  zeg "rapport_partner" "$PARTNER"
elif [ -z "$KAN" ]; then
  zeg "rapport_partner" "niet gemeld (oude runtime?)"
else
  fout "rapport_partner" "geen partnernaam ($(veld rapport_partner_reden)) -- het volledige rapport kan niet geleverd worden; staat FULL_APP_RENDER_API_KEY op de gedeelde sleutel?"
fi

# De cachemarkering: die hoort de inhoud van het bestand te volgen. Loopt hij achter, dan
# houdt een terugkerende bezoeker de oude app -- en dat is precies hoe de gegevenspoort
# een ochtend lang voor de helft van de bezoekers niet bestond.
PAGINA="$(curl -s --max-time 20 "$BASIS/" || true)"
if printf '%s' "$PAGINA" | grep -q "mid_app.js"; then
  for NAAM in mid_app.js contact_modal.js; do
    MARKERING="$(printf '%s' "$PAGINA" | grep -oE "$NAAM\?v=[A-Za-z0-9._-]+" | head -1 | cut -d= -f2)"
    if [ -z "$MARKERING" ]; then
      zeg "$NAAM" "geen markering in de pagina"
      continue
    fi
    # RECHTSTREEKS DOORPIJPEN, niet via een variabele. Een $(...) knipt afsluitende
    # regelovergangen weg, en dan hash je iets anders dan het bestand -- waarop dit script
    # bij zijn eerste echte gebruik twee fouten meldde die er niet waren.
    EIGEN="$(curl -s --max-time 20 "$BASIS/assets/$NAAM" | sha256sum | cut -c1-10)"
    if [ "$MARKERING" = "$EIGEN" ]; then
      zeg "$NAAM" "markering volgt het bestand ($MARKERING)"
    else
      fout "$NAAM" "markering $MARKERING hoort $EIGEN te zijn -- een terugkerende bezoeker krijgt de oude versie"
    fi
  done
else
  zeg "assets" "geen verwijzing gevonden (pagina achter een poort?)"
fi

echo
if [ "$FOUTEN" -eq 0 ]; then
  echo "  Alles zoals verwacht."
else
  echo "  $FOUTEN probleem(en)."
  exit 1
fi
