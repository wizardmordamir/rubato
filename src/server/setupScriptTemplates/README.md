# rubato / ca — reset-from-scratch setup scripts

These scripts rebuild a machine's full **rubato** + **cursedalchemy (ca)** toolchain
from nothing. They live **outside git**, under `~/.rubato/setup-scripts/`, so they can
hold machine- and account-specific values without ever being committed or shared. The
rubato **Admin → Setup Scripts** panel lists, views, and edits them; each file's
absolute path is shown there so you can open it in your editor instead.

> The repo ships sanitized *templates* (all placeholders, no secrets) that are copied
> here on first view. Your edits are never overwritten — re-seeding only restores files
> you've deleted.

## Secrets

Never hard-code a secret here. Put it in `~/.rubato/.env` (one `KEY=VALUE` per line);
every script sources that file automatically. Keys these scripts read:

| Key(s) | Used by |
| --- | --- |
| `OLLAMA_MODELS` | `10-ollama.sh` |
| `CONDA_ENV`, `PY_VERSION`, `CONDA_DIR` | `20-miniconda.sh` |
| `FOOOCUS_DIR`, `FOOOCUS_ENV`, `FOOOCUS_REPO` | `30-fooocus.sh` |
| `AGENT_WORKSPACE`, `CA_SYNC_URL`, `CA_SYNC_API_KEY` | `40-orchestrator.sh` |
| `AWS_REGION`, `SES_DOMAIN`, `SES_FROM` (+ AWS creds) | `50-aws-ses.sh` |
| `EC2_AMI`, `EC2_TYPE`, `EC2_KEY`, `EC2_SG` (+ AWS creds) | `60-aws-ec2.sh` |
| `CF_API_TOKEN`, `CF_ZONE_ID`, `CF_RECORD_*` | `70-cloudflare.sh` |
| `CODE_DIR`, `RUBATO_REPO` | `80-rubato-setup.sh` |
| `CODE_DIR`, `CA_REPO` | `81-ca-setup.sh` |

AWS scripts use your normal AWS credentials — an `AWS_PROFILE`, or
`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` in `~/.rubato/.env`.

## Order / usage

Run everything, or pick individual stages:

    ./00-reset-all.sh all                 # every stage, in order
    ./00-reset-all.sh ollama conda fooocus
    ./50-aws-ses.sh                        # one stage on its own

Every script is idempotent and safe to re-run. Before the cloud stages
(SES / EC2 / Cloudflare), search each file for `TODO` and fill in the values for your
account. Stages, in order:

1. `10-ollama.sh` — Ollama runtime + your local models
2. `20-miniconda.sh` — Miniconda + a working Python env
3. `30-fooocus.sh` — Fooocus image generator (needs miniconda)
4. `40-orchestrator.sh` — the unattended task-queue workspace + rubato config
5. `50-aws-ses.sh` — AWS SES sending identity + DKIM
6. `60-aws-ec2.sh` — an EC2 host (idempotent by Name tag)
7. `70-cloudflare.sh` — a Cloudflare DNS record (upsert)
8. `80-rubato-setup.sh` — clone + provision rubato
9. `81-ca-setup.sh` — clone + provision cursedalchemy
