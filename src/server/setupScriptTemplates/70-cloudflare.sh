#!/usr/bin/env bash
# Upsert a Cloudflare DNS record via the API. Put these in ~/.rubato/.env:
#   CF_API_TOKEN=...   (secret; needs Zone:DNS:Edit on the zone)
#   CF_ZONE_ID=...     (the zone id, from the Cloudflare dashboard overview)
#
# Part of the rubato <-> ca "reset from scratch" setup scripts. These live OUTSIDE
# git, under ~/.rubato/setup-scripts/ — edit freely; they are yours to tweak.
# Secrets come from ~/.rubato/.env (KEY=VALUE), never hard-coded here.
set -euo pipefail

say()  { echo "▸ $*"; }
ok()   { echo "✓ $*"; }
warn() { echo "! $*" >&2; }
die()  { echo "✗ $*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

RUBATO_HOME="${RUBATO_HOME:-$HOME/.rubato}"
[ -f "$RUBATO_HOME/.env" ] && { set -a; . "$RUBATO_HOME/.env"; set +a; }

CF_API="https://api.cloudflare.com/client/v4"
CF_RECORD_NAME="${CF_RECORD_NAME:-app.example.com}"     # TODO
CF_RECORD_TYPE="${CF_RECORD_TYPE:-A}"                   # TODO: A | CNAME | TXT
CF_RECORD_CONTENT="${CF_RECORD_CONTENT:-203.0.113.10}"  # TODO: IP / target / value
CF_PROXIED="${CF_PROXIED:-true}"

have curl || die "curl is required"
have jq || die "jq is required (brew install jq)"
[ -n "${CF_API_TOKEN:-}" ] || die "set CF_API_TOKEN in ~/.rubato/.env"
[ -n "${CF_ZONE_ID:-}" ] || die "set CF_ZONE_ID in ~/.rubato/.env"

auth=(-H "Authorization: Bearer $CF_API_TOKEN" -H "Content-Type: application/json")

say "looking up existing $CF_RECORD_TYPE record for $CF_RECORD_NAME…"
rec_id="$(curl -fsS "${auth[@]}" \
  "$CF_API/zones/$CF_ZONE_ID/dns_records?type=$CF_RECORD_TYPE&name=$CF_RECORD_NAME" \
  | jq -r '.result[0].id // empty')"

payload="$(jq -n --arg t "$CF_RECORD_TYPE" --arg n "$CF_RECORD_NAME" \
  --arg c "$CF_RECORD_CONTENT" --argjson p "$CF_PROXIED" \
  '{type: $t, name: $n, content: $c, ttl: 1, proxied: $p}')"

if [ -n "$rec_id" ]; then
  say "updating record $rec_id"
  resp="$(curl -fsS -X PUT "${auth[@]}" "$CF_API/zones/$CF_ZONE_ID/dns_records/$rec_id" --data "$payload")"
else
  say "creating record"
  resp="$(curl -fsS -X POST "${auth[@]}" "$CF_API/zones/$CF_ZONE_ID/dns_records" --data "$payload")"
fi

if [ "$(echo "$resp" | jq -r '.success')" = "true" ]; then
  ok "cloudflare DNS upsert done: $CF_RECORD_NAME → $CF_RECORD_CONTENT"
else
  echo "$resp" | jq -r '.errors' >&2
  die "cloudflare API call failed"
fi
