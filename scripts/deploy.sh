#!/usr/bin/env bash
# One-shot deploy of the MMX SMS Router to Cloudflare Workers + D1.
#
# Runs fully headless (no browser login) using a Cloudflare API token, so it can
# be executed on a server. Requires two environment variables:
#
#   CLOUDFLARE_API_TOKEN   API token with Workers Scripts:Edit, D1:Edit,
#                          Workers KV/Account:Read permissions.
#   CLOUDFLARE_ACCOUNT_ID  Your Cloudflare account id.
#
# Usage:
#   CLOUDFLARE_API_TOKEN=xxx CLOUDFLARE_ACCOUNT_ID=yyy ADMIN_TOKEN=strongtoken ./scripts/deploy.sh
#
set -euo pipefail
cd "$(dirname "$0")/.."

: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN}"
: "${CLOUDFLARE_ACCOUNT_ID:?set CLOUDFLARE_ACCOUNT_ID}"
ADMIN_TOKEN="${ADMIN_TOKEN:-$(openssl rand -hex 24)}"

echo "==> Installing dependencies"
npm install --no-audit --no-fund

# Create the D1 database if it does not exist yet, capturing its id.
echo "==> Ensuring D1 database 'mmx_router' exists"
if ! npx wrangler d1 info mmx_router >/dev/null 2>&1; then
  CREATE_OUT=$(npx wrangler d1 create mmx_router)
  echo "$CREATE_OUT"
fi
# Resolve the database_id from wrangler and write it into wrangler.toml.
DB_ID=$(npx wrangler d1 info mmx_router --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).uuid||JSON.parse(s).database_id||"")}catch{console.log("")}})')
if [ -n "$DB_ID" ]; then
  echo "==> Writing database_id $DB_ID into wrangler.toml"
  sed -i.bak "s/database_id = \".*\"/database_id = \"$DB_ID\"/" wrangler.toml && rm -f wrangler.toml.bak
fi

echo "==> Applying schema to the remote database"
npx wrangler d1 execute mmx_router --remote --file=./schema.sql

echo "==> Setting ADMIN_TOKEN secret"
printf '%s' "$ADMIN_TOKEN" | npx wrangler secret put ADMIN_TOKEN

echo "==> Deploying Worker"
npx wrangler deploy

echo
echo "==================================================================="
echo " Deployed. Admin token: $ADMIN_TOKEN"
echo " Dashboard:  https://mmx-sms-router.<your-subdomain>.workers.dev/dashboard"
echo " Give MMX each customer's callback URLs from the dashboard."
echo "==================================================================="
