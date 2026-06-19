#!/usr/bin/env bash
# Launch a single EC2 host (idempotent by Name tag). Needs the AWS CLI + creds.
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

AWS_REGION="${AWS_REGION:-us-east-1}"      # TODO
EC2_NAME="${EC2_NAME:-rubato-host}"        # TODO: instance Name tag
EC2_TYPE="${EC2_TYPE:-t3.small}"           # TODO: instance type
EC2_AMI="${EC2_AMI:-}"                     # TODO: AMI id (region-specific!)
EC2_KEY="${EC2_KEY:-rubato-key}"           # TODO: EC2 key pair name
EC2_SG="${EC2_SG:-}"                       # TODO: security group id (sg-...)

have aws || die "AWS CLI not found"
aws sts get-caller-identity --region "$AWS_REGION" >/dev/null || die "AWS credentials not working"
[ -n "$EC2_AMI" ] || die "set EC2_AMI (a region-specific AMI id) in ~/.rubato/.env"

existing="$(aws ec2 describe-instances --region "$AWS_REGION" \
  --filters "Name=tag:Name,Values=$EC2_NAME" "Name=instance-state-name,Values=pending,running,stopped" \
  --query 'Reservations[].Instances[].InstanceId' --output text)"
if [ -n "$existing" ]; then
  ok "instance '$EC2_NAME' already exists: $existing"
  exit 0
fi

# Ensure a key pair exists; save the private key under ~/.ssh if we create one.
if ! aws ec2 describe-key-pairs --region "$AWS_REGION" --key-names "$EC2_KEY" >/dev/null 2>&1; then
  say "creating key pair '$EC2_KEY'"
  mkdir -p "$HOME/.ssh"
  aws ec2 create-key-pair --region "$AWS_REGION" --key-name "$EC2_KEY" \
    --query 'KeyMaterial' --output text > "$HOME/.ssh/$EC2_KEY.pem"
  chmod 600 "$HOME/.ssh/$EC2_KEY.pem"
  ok "saved private key → ~/.ssh/$EC2_KEY.pem"
fi

say "launching $EC2_TYPE from $EC2_AMI…"
args=(--region "$AWS_REGION" --image-id "$EC2_AMI" --instance-type "$EC2_TYPE"
  --key-name "$EC2_KEY" --count 1
  --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$EC2_NAME}]")
[ -n "$EC2_SG" ] && args+=(--security-group-ids "$EC2_SG")

id="$(aws ec2 run-instances "${args[@]}" --query 'Instances[0].InstanceId' --output text)"
ok "launched $id — waiting for it to enter the running state…"
aws ec2 wait instance-running --region "$AWS_REGION" --instance-ids "$id"
ip="$(aws ec2 describe-instances --region "$AWS_REGION" --instance-ids "$id" \
  --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)"

ok "instance $EC2_NAME ($id) is up at ${ip:-<no public ip>}"
