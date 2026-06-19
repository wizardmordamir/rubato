#!/usr/bin/env bash
# Configure AWS SES for sending mail: verify a domain identity + enable DKIM.
# Needs the AWS CLI and working credentials (AWS_PROFILE, or AWS_ACCESS_KEY_ID /
# AWS_SECRET_ACCESS_KEY in ~/.rubato/.env).
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

AWS_REGION="${AWS_REGION:-us-east-1}"           # TODO: your SES region
SES_DOMAIN="${SES_DOMAIN:-example.com}"         # TODO: the sending domain
SES_FROM="${SES_FROM:-no-reply@$SES_DOMAIN}"    # TODO: a From address

have aws || die "AWS CLI not found — https://docs.aws.amazon.com/cli/ then configure creds"
aws sts get-caller-identity --region "$AWS_REGION" >/dev/null || die "AWS credentials not working"

say "verifying domain identity: $SES_DOMAIN"
aws sesv2 create-email-identity --region "$AWS_REGION" --email-identity "$SES_DOMAIN" 2>/dev/null \
  && ok "created identity $SES_DOMAIN" \
  || ok "identity $SES_DOMAIN already exists"

say "current verification + DKIM status (publish these CNAMEs in DNS):"
aws sesv2 get-email-identity --region "$AWS_REGION" --email-identity "$SES_DOMAIN" \
  --query '{Verified:VerifiedForSendingStatus,DkimTokens:DkimAttributes.Tokens}' \
  --output table || warn "could not read identity status"

cat <<EOF

Next steps (manual, one-time):
  1. Publish the DKIM CNAME records above in DNS (see 70-cloudflare.sh).
  2. If still in the SES sandbox, request production access in the SES console.
  3. Verify the From address if not using a whole-domain identity: $SES_FROM
EOF

ok "SES bootstrap done for $SES_DOMAIN ($AWS_REGION)"
