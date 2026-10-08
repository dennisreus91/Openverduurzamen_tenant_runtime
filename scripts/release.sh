#!/usr/bin/env bash
#
# release.sh — bump het version-veld EN zet de tag, in één handeling.
#
# WAAROM DIT BESTAAT
# Het `version`-veld in package.json stond op 1.6.0 terwijl de tags V3.0.0,
# V3.1.0, V3.2.0 en V3.3.0 langskwamen. Vier releases, nul bumps. Dat lag niet
# aan slordigheid maar aan de werkwijze: taggen en bumpen waren twee losse
# handelingen, en de ene is zichtbaar (de tag, want daar hangt de pin aan) en
# de andere niet. Zo'n paar drijft altijd uit elkaar.
#
# Dit script maakt er één handeling van, zodat het niet meer kan.
#
# De versie in package.json is overigens niet meer wat /health rapporteert --
# dat is de tag uit de werkelijk geïnstalleerde pin (lib/runtime_versie.js).
# Het veld blijft toch de moeite waard: het is wat je ziet in node_modules en
# in `npm ls`, en een veld dat liegt is daar net zo misleidend.
#
# Gebruik:
#   bash scripts/release.sh V3.4.0
#
# Daarna de tenants bijzetten:
#   bash scripts/update-all-tenants.sh V3.4.0

set -euo pipefail

TAG="${1:-}"
if [ -z "$TAG" ]; then
  echo "Gebruik: $0 <tag>   bijvoorbeeld: $0 V3.4.0" >&2
  exit 2
fi

# GitHub-refs zijn case-sensitive en dit project heeft een historische
# kleine-v-lijn (v2.0.11) náást de hoofdletterlijn (V3.3.0). Nieuwe releases
# gaan op de hoofdletterlijn; een kleine v zou een tag naast de bestaande
# lijn maken die er bijna identiek uitziet.
if ! printf '%s' "$TAG" | grep -qE '^V[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "Tag '$TAG' heeft niet de vorm V<major>.<minor>.<patch>, bijvoorbeeld V3.4.0." >&2
  echo "Een kleine v maakt een aparte taglijn aan -- zie de notitie hierboven." >&2
  exit 2
fi

VERSIE="${TAG#V}"

# --- Voorwaarden ----------------------------------------------------------

TAK="$(git rev-parse --abbrev-ref HEAD)"
if [ "$TAK" != "main" ]; then
  echo "Je staat op '$TAK'. Een release hoort vanaf main te gaan: de tenants pinnen die lijn." >&2
  exit 3
fi

if [ -n "$(git status --porcelain)" ]; then
  echo "De werkmap is niet schoon. Commit of stash eerst, anders tag je iets anders dan je denkt." >&2
  git status --short >&2
  exit 3
fi

if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  echo "Tag $TAG bestaat al lokaal." >&2
  exit 3
fi
if git ls-remote --tags origin 2>/dev/null | grep -q "refs/tags/${TAG}$"; then
  echo "Tag $TAG bestaat al op origin. Een tag verplaatsen levert een stille" >&2
  echo "mismatch op: tenants hebben de oude bytes al in hun lockfile-hash." >&2
  exit 3
fi

git fetch -q origin main
if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
  echo "Lokale main en origin/main lopen uiteen. Pull of push eerst." >&2
  exit 3
fi

# --- Toetsen vóór het bumpen ---------------------------------------------
# In deze volgorde, zodat de controle die version tegen de nieuwste tag
# afzet nog op het oude, consistente paar kijkt.

echo "Tests draaien..."
npm test

# --- Bumpen, committen, taggen -------------------------------------------

node --input-type=module -e "
import fs from 'fs';
const p = 'package.json';
const s = fs.readFileSync(p, 'utf8');
const vervangen = s.replace(/(\"version\":\s*\")[^\"]*(\")/, '\$1${VERSIE}\$2');
if (vervangen === s) { console.error('version-veld niet gevonden of al gelijk'); process.exit(1); }
fs.writeFileSync(p, vervangen);
"

git add package.json
git commit -q -m "Release ${TAG}

Het version-veld gaat mee met de tag, in één handeling via
scripts/release.sh. Zie dat script voor waarom dat nodig is."

git tag -a "$TAG" -m "Release ${TAG}"

echo
echo "Gemaakt: commit + tag $TAG (version nu ${VERSIE})."
echo "Nog niets gepusht. Nalopen met:  git show $TAG --stat"
echo
read -r -p "Pushen naar origin (commit + tag)? [j/N] " akkoord
case "$akkoord" in
  j|J|ja|Ja) ;;
  *)
    echo "Niet gepusht. Terugdraaien kan met:"
    echo "  git tag -d $TAG && git reset --hard HEAD~1"
    exit 0
    ;;
esac

git push origin main
git push origin "$TAG"

echo
echo "Gepusht. Tenants bijzetten met:"
echo "  bash scripts/update-all-tenants.sh $TAG"
