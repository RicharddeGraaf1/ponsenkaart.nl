#!/usr/bin/env bash
# Veilige deploy voor ponsenkaart (Cloudflare Pages, direct upload).
#
# WAAROM DIT SCRIPT BESTAAT:
#   `wrangler pages deploy .` vanuit de repo-root uploadt de HELE map,
#   inclusief .env. Dat heeft op 2026-07-01 de Cloudflare API-token publiek
#   gezet op ponsenkaart.nl/.env. Dit script deployt daarom vanuit een schone
#   tijdelijke map met UITSLUITEND publieke assets.
#
#   >>> Gebruik ALTIJD ./deploy.sh — nooit `wrangler pages deploy .` <<<
set -euo pipefail
cd "$(dirname "$0")"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

# Kopieer alle niet-dot bestanden naar de staging-map. Dotfiles (.env, .git,
# .wrangler, .gitignore, .assetsignore, .DS_Store) worden door `for item in *`
# automatisch overgeslagen. Dit script zelf gaat ook niet mee.
shopt -s nullglob
for item in *; do
  [ "$item" = "deploy.sh" ] && continue
  # CLAUDE.md is een interne doc die de tokennaam (CLOUDFLARE_API_TOKEN)
  # letterlijk documenteert — niet publiceren, en het triggert anders de
  # secret-grep hieronder als false positive.
  [ "$item" = "CLAUDE.md" ] && continue
  # tools/ zijn generatoren (bv. build_oordeel.py); hun uitvoer hoort wel
  # publiek, het script zelf niet.
  [ "$item" = "tools" ] && continue
  cp -r "$item" "$STAGE"/
done

# Vangnet: weiger te deployen als er tóch een token in de staging-map zit.
if grep -rqE "cfut_|CLOUDFLARE_API_TOKEN" "$STAGE"; then
  echo "ABORT: mogelijke secret aangetroffen in staging-map — deploy afgebroken." >&2
  exit 1
fi

export CLOUDFLARE_API_TOKEN="$(grep '^CLOUDFLARE_API_TOKEN=' .env | cut -d= -f2- | tr -d '\r\n" ')"
export CLOUDFLARE_ACCOUNT_ID=03d57417cb436aedb960d69079147d65

echo "Deploying schone staging-map naar ponsenkaart (branch main)…"
npx wrangler pages deploy "$STAGE" --project-name=ponsenkaart --branch=main --commit-dirty=true
