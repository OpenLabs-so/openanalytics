#!/usr/bin/env bash
# One-shot configuration generator for a self-hosted OpenAnalytics install.
#
#   ./generate-secrets.sh --domain analytics.example --email admin@analytics.example
#
# Writes, all from one run so the values that must match actually do:
#
#   .env                          the four public names, the compose network,
#                                 and which images to run — read back from the
#                                 checkout, so a release tag pulls that
#                                 release's and anything else builds here
#   env/*.env                     one file per service, from the *.example
#                                 templates, with generated secrets filled in
#   docker-compose.override.yml   the three Ed25519 pairs as YAML block scalars
#
# With `--with-geoip` it also downloads the DB-IP City Lite database and points
# env/collector.env at it. That is the ONLY thing in here that touches the
# network — everything else is local computation — which is why it is opt-in,
# and why its failure is a warning rather than an exit.
#
# WHY THE KEYS ARE NOT IN AN ENV FILE. They are PEMs, and a PEM is multi-line.
# An env file cannot carry a multi-line value, and writing one with an escaped
# "\n" does not help: Docker passes those through as two literal characters and
# the key parser rejects the result. A YAML block scalar is the only shape that
# survives, so the three private halves and the three public halves are split
# across the services entitled to each in a compose OVERRIDE file — which
# `docker compose` merges automatically, with no extra `-f` to forget.
#
# WHY SO MANY FILES. Each service validates its own environment at startup and
# REFUSES TO BOOT if handed a secret it must not hold. That boundary is the one
# the architecture rests on — the internet-facing collector cannot reach
# ClickHouse, the gateway cannot mint the signatures it verifies, only the
# worker can delete analytics rows — so there is no such thing as one shared
# environment here.
#
# Nothing this writes is ever committed: every output path is in .gitignore.
set -euo pipefail

cd "$(dirname "$0")"

DOMAIN=""
EMAIL=""
FORCE=0
WITH_GEOIP=0

usage() {
	cat >&2 <<'USAGE'
usage: ./generate-secrets.sh --domain <example.com> --email <you@example.com>
                            [--with-geoip] [--force]

  --domain      the base domain. Four names are derived from it and must resolve
                to this host before the first start:
                  app.<domain>  api.<domain>  c.<domain>  rt.<domain>
  --email       contact address for the Let's Encrypt account
  --with-geoip  also download the DB-IP City Lite database (~60 MB, CC BY 4.0)
                and point env/collector.env at it. Off by default: everything
                else here is local computation, and a generator that reaches
                out to a third-party host whether or not you asked is a
                generator you cannot run on a machine that has no route out.
                A failed download is not fatal — see below.
  --force       overwrite files that already exist. THIS REPLACES LIVE SECRETS:
                the new database passwords will not match the ones already
                inside your Postgres and ClickHouse volumes, so an existing
                install stops working. Use it on a fresh install, or to start
                over.
USAGE
	exit 2
}

while [ $# -gt 0 ]; do
	case "$1" in
	--domain)
		DOMAIN="${2:-}"
		shift 2
		;;
	--email)
		EMAIL="${2:-}"
		shift 2
		;;
	--with-geoip)
		WITH_GEOIP=1
		shift
		;;
	--force)
		FORCE=1
		shift
		;;
	-h | --help) usage ;;
	*)
		echo "generate-secrets: unknown argument '$1'" >&2
		usage
		;;
	esac
done

[ -n "$DOMAIN" ] || {
	echo "generate-secrets: --domain is required" >&2
	usage
}
[ -n "$EMAIL" ] || {
	echo "generate-secrets: --email is required" >&2
	usage
}

command -v openssl >/dev/null 2>&1 || {
	echo "generate-secrets: openssl is required and was not found on PATH" >&2
	exit 1
}

# Refuse to clobber. A second run without --force would hand the services new
# passwords while the stores keep the old ones — an install that was working a
# minute ago and now fails to authenticate, with nothing obviously changed.
OUTPUTS=(.env docker-compose.override.yml)
for template in env/*.env.example; do
	OUTPUTS+=("${template%.example}")
done
if [ "$FORCE" -eq 0 ]; then
	existing=()
	for out in "${OUTPUTS[@]}"; do
		[ -e "$out" ] && existing+=("$out")
	done
	if [ ${#existing[@]} -gt 0 ]; then
		echo "generate-secrets: refusing to overwrite existing files:" >&2
		printf '  %s\n' "${existing[@]}" >&2
		echo "Re-run with --force only if you mean to replace the secrets a running install is using." >&2
		exit 1
	fi
fi

umask 077

# --- the values -------------------------------------------------------------
# 32 bytes of hex each. The schema's floor is 16 characters; this is well past
# it and is the same shape the hosted deployment uses.
hex32() { openssl rand -hex 32; }

export OA_SUB_POSTGRES_PASSWORD="$(hex32)"
export OA_SUB_CLICKHOUSE_INGEST_PASSWORD="$(hex32)"
export OA_SUB_CLICKHOUSE_READ_PASSWORD="$(hex32)"
export OA_SUB_CLICKHOUSE_MAINTENANCE_PASSWORD="$(hex32)"
export OA_SUB_CLICKHOUSE_MIGRATION_PASSWORD="$(hex32)"
export OA_SUB_VALKEY_QUEUE_PASSWORD="$(hex32)"
export OA_SUB_VALKEY_REALTIME_PASSWORD="$(hex32)"
export OA_SUB_RUSTFS_SECRET_KEY="$(hex32)"

# Four independent secrets, none derived from another. They protect different
# things, and a derivation would make rotating one force rotating the other.
export OA_SUB_AUTH_SECRET="$(hex32)"
export OA_SUB_ANONYMOUS_IDENTITY_SECRET="$(hex32)"
export OA_SUB_TRIAL_IDENTITY_SECRET="$(hex32)"
export OA_SUB_CREDENTIAL_SOURCE_SECRET="$(hex32)"

# The versioned keyring that encrypts customers' own provider credentials.
# A single line of JSON: {"active":"k1","keys":{"k1":"<base64 32 bytes>"}}.
# Rotation is additive — add k2 to `keys` and restart everywhere BEFORE moving
# `active`, or the service that has not restarted yet cannot read what the other
# has started writing.
export OA_SUB_OA_CREDENTIAL_KEYRING="{\"active\":\"k1\",\"keys\":{\"k1\":\"$(openssl rand -base64 32)\"}}"

# Network. Must agree with .env below and with the compose file's defaults.
export OA_SUB_VALKEY_QUEUE_IP="${OA_VALKEY_QUEUE_IP:-172.28.0.10}"
export OA_SUB_VALKEY_REALTIME_IP="${OA_VALKEY_REALTIME_IP:-172.28.0.11}"

export OA_SUB_APP_BASE_URL="https://app.${DOMAIN}"
export OA_SUB_AUTH_BASE_URL="https://api.${DOMAIN}"
export OA_SUB_COLLECTOR_BASE_URL="https://c.${DOMAIN}"
export OA_SUB_REALTIME_BASE_URL="https://rt.${DOMAIN}"

# --- render the templates ---------------------------------------------------
# Literal `{{NAME}}` substitution, and an unknown placeholder is an error rather
# than an empty string: a blank value in an env file is a startup failure, not
# an unset variable, so silently rendering one would produce a service that
# refuses to boot for a reason nothing here reported.
render() {
	awk '
    {
      line = $0
      while (match(line, /\{\{[A-Z_0-9]+\}\}/)) {
        name = substr(line, RSTART + 2, RLENGTH - 4)
        key = "OA_SUB_" name
        if (!(key in ENVIRON)) {
          printf("generate-secrets: %s: no value for placeholder {{%s}}\n", FILENAME, name) > "/dev/stderr"
          exit 1
        }
        line = substr(line, 1, RSTART - 1) ENVIRON[key] substr(line, RSTART + RLENGTH)
      }
      print line
    }
  ' "$1"
}

for template in env/*.env.example; do
	out="${template%.example}"
	render "$template" >"$out"
	chmod 600 "$out"
	echo "wrote $out"
done

# Two files carry the same address-derived identity secret on purpose (the
# collector derives it, the worker re-derives it over provider identifiers), and
# two carry the same credential keyring. Prove it rather than trust the loop.
check_same() {
	local var="$1" a="$2" b="$3"
	local va vb
	va="$(grep -E "^${var}=" "$a" | head -1 || true)"
	vb="$(grep -E "^${var}=" "$b" | head -1 || true)"
	if [ -z "$va" ] || [ "$va" != "$vb" ]; then
		echo "generate-secrets: ${var} does not match between ${a} and ${b}" >&2
		exit 1
	fi
}
check_same ANONYMOUS_IDENTITY_SECRET env/collector.env env/worker.env
check_same OA_CREDENTIAL_KEYRING env/api.env env/worker.env

# --- which images this install will run --------------------------------------
# Not a question to answer twice. The operator already chose a version when they
# checked one out, so read it back from there: a tree standing exactly on a
# release tag runs that release's published images, and anything else — a
# branch, main, a tarball with no git in it — builds here, which is the only
# thing that can work for a commit no release was cut from.
#
# `--exact-match`, like ./upgrade.sh: a checkout that is merely NEAR v0.1.0 is
# not v0.1.0, and the images for the commits in between were never published.
# The `v[0-9]*` guard is the same one, for the same reason — some other tag
# (`nightly`, a fork's own) publishes nothing.
RELEASE_REPO="ghcr.io/openlabs-so/openanalytics"

IMAGE_REPO="openanalytics"
IMAGE_TAG="local"
HEAD_TAG="$(git -C ../.. describe --tags --exact-match HEAD 2>/dev/null || true)"

case "$HEAD_TAG" in
v[0-9]*)
	IMAGE_REPO="$RELEASE_REPO"
	IMAGE_TAG="$HEAD_TAG"
	IMAGE_MODE="pulled from ${IMAGE_REPO} at ${IMAGE_TAG} — this checkout is standing on that release tag"
	;;
"")
	IMAGE_MODE="built here (${IMAGE_REPO}/*:${IMAGE_TAG}) — this checkout is not standing on a release tag"
	;;
*)
	IMAGE_MODE="built here (${IMAGE_REPO}/*:${IMAGE_TAG}) — HEAD is tagged '${HEAD_TAG}', which is not a release tag (vX.Y.Z)"
	;;
esac

# --- compose-level values ---------------------------------------------------
cat >.env <<ENV
# Generated by ./generate-secrets.sh for ${DOMAIN}.
# No secrets here — these are only the values docker compose interpolates.

OA_APP_HOST=app.${DOMAIN}
OA_API_HOST=api.${DOMAIN}
OA_COLLECTOR_HOST=c.${DOMAIN}
OA_REALTIME_HOST=rt.${DOMAIN}
OA_ACME_EMAIL=${EMAIL}

# The three origins the dashboard's browser code calls are in env/web.env, not
# here: the image substitutes them at start rather than compiling them in.

OA_SUBNET=${OA_SUBNET:-172.28.0.0/16}
OA_VALKEY_QUEUE_IP=${OA_SUB_VALKEY_QUEUE_IP}
OA_VALKEY_REALTIME_IP=${OA_SUB_VALKEY_REALTIME_IP}

# Every image is \`\${OA_IMAGE_REPO}/name:\${OA_IMAGE_TAG}\`. Chosen from the
# checkout this ran in: ${IMAGE_MODE}.
# Edit them to change your mind, or run ./upgrade.sh to move between releases.
OA_IMAGE_REPO=${IMAGE_REPO}
OA_IMAGE_TAG=${IMAGE_TAG}
OA_GIT_COMMIT=unknown
ENV
chmod 600 .env
echo "wrote .env"
echo "images: ${IMAGE_MODE}"

# --- the two signing pairs --------------------------------------------------
# Query signing   api -> query gateway   (private on api, public on gateway)
# Realtime tokens api -> realtime        (private on api, public on realtime)
#
# In every pair the api holds the private half and the verifying service holds
# only the public one, so a compromised verifier can never mint what it checks.
KEYDIR="$(mktemp -d)"
trap 'rm -rf "$KEYDIR"' EXIT

for pair in query realtime; do
	openssl genpkey -algorithm ed25519 -out "$KEYDIR/$pair.private.pem" 2>/dev/null
	openssl pkey -in "$KEYDIR/$pair.private.pem" -pubout -out "$KEYDIR/$pair.public.pem" 2>/dev/null
done

# A block scalar's content must be indented further than its key. `sed` supplies
# the eight spaces; the key sits at six, under `environment:` at four.
emit_key() {
	printf '      %s: |\n' "$1"
	sed 's/^/        /' "$2"
}

{
	cat <<'HEADER'
# GENERATED — DO NOT COMMIT. Written by ./generate-secrets.sh.
#
# The two Ed25519 pairs, split across the services entitled to each half.
# `docker compose` merges this file automatically because of its name, so there
# is no extra `-f` to forget — and forgetting it would boot an api with the
# analytics and realtime surfaces silently unmounted.
#
# A PEM cannot live in an env file: it is multi-line, and an escaped "\n" is
# passed through as two literal characters that the key parser rejects. A YAML
# block scalar is the shape that survives.
#
# ROTATING A PAIR IS ONE WINDOW, NOT TWO STEPS. Neither side supports a key
# set — the gateway holds one public key, the realtime service one verify key —
# so the signer and its verifier must change together:
#   1. generate a new pair, 2. replace BOTH halves here, 3. bump
#   QUERY_SIGNING_KEY_ID in env/api.env AND env/gateway.env, 4.
#   `docker compose up -d gateway api realtime`.
# Bumping the id is what turns a stale signer into "Unknown signing key"
# instead of a signature failure — the more diagnosable of the two.

services:
  api:
    environment:
HEADER
	emit_key QUERY_SIGNING_PRIVATE_KEY "$KEYDIR/query.private.pem"
	emit_key REALTIME_TOKEN_SIGNING_KEY "$KEYDIR/realtime.private.pem"

	printf '\n  gateway:\n    environment:\n'
	emit_key QUERY_SIGNING_PUBLIC_KEY "$KEYDIR/query.public.pem"

	printf '\n  realtime:\n    environment:\n'
	emit_key REALTIME_TOKEN_VERIFY_KEY "$KEYDIR/realtime.public.pem"
} >docker-compose.override.yml
chmod 600 docker-compose.override.yml
echo "wrote docker-compose.override.yml"

# --- optional: the GeoIP database -------------------------------------------
# `umask 077` above is right for everything else here and wrong for this
# directory: the collector mounts it read-only and reads it as the unprivileged
# `node` user inside the container, which cannot traverse a 700 directory owned
# by the root that ran this script. The database is public data — the secrecy
# that protects the env files protects nothing here and costs null geo.
mkdir -p geoip
chmod 755 geoip

GEOIP_LINE='GEOIP_DB_PATH=/geoip/dbip-city-lite.mmdb'
GEOIP_STATUS='not requested'

if [ "$WITH_GEOIP" -eq 1 ]; then
	echo
	echo "Fetching the GeoIP database (DB-IP City Lite, ~60 MB)…"

	# A FAILED DOWNLOAD IS NOT A FAILED INSTALL. Null geo is a degradation the
	# product is built to tolerate — every event just carries no country — while
	# a generator that dies here leaves half-written secrets and a deployment
	# that cannot start at all. So the failure is caught, reported, and the
	# variable stays commented out.
	#
	# `bash …` rather than `./…`: this must not depend on a mode bit surviving
	# however the tree got onto this host.
	if bash geoip/fetch-dbip.sh; then
		# Uncomment the one line the template ships commented. Anchored to the
		# exact text, so a template edit is caught rather than silently ignored
		# — tests/unit/selfhost-templates.test.ts pins the same string.
		if grep -qxF "# ${GEOIP_LINE}" env/collector.env; then
			# awk into a temp file, not `sed -i`: GNU sed and BSD sed disagree
			# about whether -i takes an argument, so there is no spelling that
			# works on both. `cat >` rather than `mv` keeps the 600 mode and
			# ownership the rendered file already has.
			tmp="$(mktemp)"
			awk -v line="$GEOIP_LINE" '$0 == "# " line { print line; next } { print }' \
				env/collector.env >"$tmp"
			cat "$tmp" >env/collector.env
			rm -f "$tmp"
			GEOIP_STATUS='enabled'
		else
			GEOIP_STATUS='template drift'
			echo "generate-secrets: env/collector.env has no commented GEOIP_DB_PATH line to enable." >&2
			echo "                  The database downloaded fine. Add this line yourself:" >&2
			echo "                    ${GEOIP_LINE}" >&2
		fi
	else
		GEOIP_STATUS='download failed — left disabled'
		echo >&2
		echo "generate-secrets: the GeoIP download failed. CARRYING ON: every event will" >&2
		echo "                  carry null geo until you fix it, which is a degradation and" >&2
		echo "                  not a broken install. Everything else here is written." >&2
		echo "                  Retry any time:" >&2
		echo "                    cd geoip && ./fetch-dbip.sh" >&2
		echo "                  then uncomment ${GEOIP_LINE} in env/collector.env" >&2
		echo "                  and: docker compose up -d --force-recreate collector" >&2
	fi
fi

cat <<DONE

Done. Four DNS records must point at this host before the first start:

  app.${DOMAIN}   api.${DOMAIN}   c.${DOMAIN}   rt.${DOMAIN}

GeoIP: ${GEOIP_STATUS}

Then:

  docker compose up -d

Read /SELF-HOSTING.md for what comes next — signing in the first time, the
GeoIP database, and what stops working when an optional key is missing.

Back up env/*.env and docker-compose.override.yml somewhere off this machine.
Losing OA_CREDENTIAL_KEYRING makes every stored provider credential
unrecoverable; losing the database passwords locks you out of your own volumes.
DONE
