#!/usr/bin/env bash
# Cold snapshot and restore of everything this deployment stores.
#
#   ./snapshot.sh create [--label pre-v0.2.0] [--keep 5]
#   ./snapshot.sh restore --from backups/20260812T140000Z-pre-v0.2.0
#   ./snapshot.sh list
#
# This is the mechanism that `./upgrade.sh` and `./rollback.sh` are built on.
# Run it directly when you want a snapshot without upgrading.
#
# ## Why cold, and why that is the honest choice
#
# THE STACK IS STOPPED WHILE THIS RUNS. Not for tidiness: a ClickHouse data
# directory copied while the server is running is not a backup of anything. The
# server merges parts in the background — with no writes at all — so a `tar` of
# a live directory can contain a part that was being replaced, and the failure
# shows up when you restore it, which is the worst possible time to find out.
#
# ClickHouse's own `BACKUP DATABASE ... TO S3(...)` is the online answer and it
# needs a bucket, a configured backup disk and a restore path of its own. For an
# upgrade — where the stack is coming down anyway — stopping is simpler, needs
# nothing external, and produces a snapshot whose restore is `tar x`. The
# Backups section of /SELF-HOSTING.md is about the other job: scheduled,
# off-machine copies of a system that stays up.
#
# ## What is in a snapshot
#
# Both data volumes, the four public names, and EVERY SECRET THIS DEPLOYMENT
# HAS — `env/*.env`, `docker-compose.override.yml` and `.env`. That is
# deliberate: restoring the volumes without the passwords that match them
# produces stores nobody can open. It also means a snapshot directory is exactly
# as sensitive as the install. `backups/` is created 700 and is git-ignored;
# treat a copy of it the way you would treat the server's disk.
#
# Not in a snapshot: the tracker bundle and the Caddy certificate store, both of
# which rebuild themselves, and the Valkey queue — seconds of in-flight events,
# which /SELF-HOSTING.md covers.
#
# ## When Postgres is not in this stack
#
# With a managed Postgres (`docker-compose.neon.yml`, or any external
# DATABASE_URL with the `postgres` service taken out) there is no volume here to
# archive, and this script cannot copy a database it does not host. It then
# snapshots ClickHouse only and records `stack_stopped_at` — the instant the
# stack went down, after which nothing writes to Postgres until it comes back.
# That instant is the point-in-time a provider restore must go back to for the
# two stores to agree again. `restore` never starts the stack in that case:
# ClickHouse from one moment beside Postgres from another is not a rollback.
set -euo pipefail

cd "$(dirname "$0")"

# A snapshot contains every secret this deployment has, so nothing it writes is
# readable by anyone else on the host. Set here rather than per-file: the
# copies of `env/*.env` would otherwise arrive at whatever the caller's umask
# happens to be.
umask 077

BACKUP_ROOT="${OA_BACKUP_DIR:-backups}"
# Only needs `tar`, `gzip`, `du` and `rm`. Pinned like every other image here:
# a floating tag would make a restore depend on when it ran.
HELPER_IMAGE="${OA_SNAPSHOT_IMAGE:-alpine:3.22}"
MANIFEST_VERSION=1

die() {
	echo "snapshot: $*" >&2
	exit 1
}

command -v docker >/dev/null 2>&1 || die "docker is required and was not found on PATH"

compose() { docker compose "$@"; }

# Everything below the `compose stop` in either subcommand runs with the
# deployment down. A failure there — no disk, a volume that will not mount, an
# interrupted archive — must not end with a stopped stack and a stack trace: the
# operator needs to be told, in one line, that their analytics are off.
STACK_STOPPED=0
on_exit() {
	local status=$?
	if [ "$status" -ne 0 ] && [ "$STACK_STOPPED" -eq 1 ]; then
		echo >&2
		echo "snapshot: FAILED, AND THE STACK IS STOPPED. Bring it back with:" >&2
		echo "            docker compose up -d" >&2
	fi
}
trap on_exit EXIT

usage() {
	cat >&2 <<'USAGE'
usage: ./snapshot.sh create  [--label <name>] [--keep <n>] [--start | --no-start]
       ./snapshot.sh restore --from <dir> [--start | --no-start]
       ./snapshot.sh list

  create   stop the stack, archive both data volumes and the configuration,
           then start it again unless --no-start.
    --label   suffix for the directory name. Default: manual
    --keep    after a successful snapshot, delete all but the newest <n>.
              Nothing is deleted unless you ask.

  restore  stop the stack, REPLACE the contents of both data volumes with the
           snapshot's, and start it again unless --no-start.
           Everything written since the snapshot is gone. This does not touch
           env/*.env — ./rollback.sh handles configuration, because whether the
           old configuration is wanted depends on why you are going back.

  list     what is in backups/, oldest first, with sizes.
USAGE
	exit 2
}

# --- volume names, from the containers rather than from a guess --------------
# The compose project name is `openanalytics`, so the volumes are almost always
# `openanalytics_pg-data` and `openanalytics_ch-data` — but `-p` and
# COMPOSE_PROJECT_NAME both change that, and a snapshot that silently archived
# the wrong volume would be indistinguishable from one that worked. Ask Docker
# what is actually mounted.
volume_at() {
	local service="$1" destination="$2" cid name
	cid="$(compose ps -aq "$service" 2>/dev/null | head -1 || true)"
	[ -n "$cid" ] || die "no $service container exists yet — there is nothing to snapshot. Start the stack once first."
	name="$(docker inspect -f "{{range .Mounts}}{{if eq .Destination \"$destination\"}}{{.Name}}{{end}}{{end}}" "$cid")"
	[ -n "$name" ] || die "the $service container has no named volume at $destination"
	echo "$name"
}

# True when this compose project runs its own Postgres. Asked of the resolved
# configuration, so an override that moves `postgres` behind a profile — which
# is what `docker-compose.neon.yml` does — counts as not running it.
#
# The list is captured before it is searched, never piped into `grep -q`: under
# `pipefail`, grep exiting at its first match can SIGPIPE compose while it is
# still writing, and the pipeline then reads as "no postgres" — which would
# silently leave a bundled database out of the snapshot. For the same reason a
# configuration compose cannot resolve is an error here, not an answer.
postgres_in_stack() {
	local services
	services="$(compose config --services)" || die "docker compose could not resolve this stack's configuration, so it cannot tell whether Postgres is part of it"
	grep -qx postgres <<<"$services"
}

# --- helpers that run inside the helper image -------------------------------
volume_bytes() {
	# `printf "%d"` rather than `print`: several awks render a large product in
	# scientific notation, and `$((1.3e+11 + x))` is a syntax error in the
	# arithmetic below rather than a wrong number.
	docker run --rm -v "$1:/src:ro" "$HELPER_IMAGE" du -sk /src |
		awk '{ printf "%d\n", $1 * 1024 }'
}

archive_volume() {
	local volume="$1" out_dir="$2" name="$3"
	# `-C /src .` so the archive is relative and extracts into any directory.
	# Owner and group are preserved inside it: a Postgres data directory owned by
	# the wrong uid is a store that will not start.
	#
	# The container has to run as root to READ a store's data directory, so the
	# archive it writes lands owned by root — and then the caller, who may not be
	# root, cannot chmod its own backup. Measured in CI: `chmod: changing
	# permissions of 'pg-data.tar.gz': Operation not permitted`, with the stack
	# already stopped. So the last thing the container does is hand the file
	# over. When docker is being driven by root anyway this is a no-op.
	docker run --rm \
		-v "$volume:/src:ro" \
		-v "$out_dir:/out" \
		"$HELPER_IMAGE" \
		sh -c "set -e
			tar czf '/out/$name' -C /src .
			chown $(id -u):$(id -g) '/out/$name'
			chmod 600 '/out/$name'"
}

restore_volume() {
	local volume="$1" in_dir="$2" name="$3"
	# Emptied first, and not with `tar --overwrite`: a file the snapshot does not
	# contain has to disappear, or the restored store is the old one with the new
	# one's leftovers in it. The three globs are how `sh` spells "including
	# dotfiles"; `-f` swallows the ones that match nothing.
	docker run --rm \
		-v "$volume:/dst" \
		-v "$in_dir:/in:ro" \
		"$HELPER_IMAGE" \
		sh -c 'set -e; cd /dst; rm -rf ./..?* ./.[!.]* ./*; tar xzf "/in/'"$name"'" -C /dst'
}

# --- create -----------------------------------------------------------------
do_create() {
	local label="manual" keep="" start=1
	while [ $# -gt 0 ]; do
		case "$1" in
		--label)
			label="${2:-}"
			shift 2
			;;
		--keep)
			keep="${2:-}"
			shift 2
			;;
		--start)
			start=1
			shift
			;;
		--no-start)
			start=0
			shift
			;;
		-h | --help) usage ;;
		*) die "unknown argument '$1'" ;;
		esac
	done
	[ -n "$label" ] || die "--label needs a value"
	case "$label" in
	*[!a-zA-Z0-9._-]*) die "--label may only contain letters, digits, dot, underscore and dash" ;;
	esac

	local pg_volume ch_volume pg_mode=volume
	if postgres_in_stack; then
		pg_volume="$(volume_at postgres /var/lib/postgresql/data)"
	else
		pg_mode=external
		pg_volume=external
	fi
	ch_volume="$(volume_at clickhouse /var/lib/clickhouse)"

	local pg_bytes=0 ch_bytes needed available
	[ "$pg_mode" = volume ] && pg_bytes="$(volume_bytes "$pg_volume")"
	ch_bytes="$(volume_bytes "$ch_volume")"
	needed=$((pg_bytes + ch_bytes))

	mkdir -p "$BACKUP_ROOT"
	chmod 700 "$BACKUP_ROOT"

	# The archives are compressed, so this asks for more room than it will use.
	# That is the right direction to be wrong in: the alternative is discovering
	# the disk is full part way through writing a backup of a stopped
	# deployment.
	available="$(df -Pk "$BACKUP_ROOT" | awk 'NR == 2 { printf "%d\n", $4 * 1024 }')"
	if [ "$available" -lt "$needed" ]; then
		die "$(printf 'not enough room in %s: the volumes hold %s and %s is free.\n         Compression will need less than that, but not reliably less. Free some space or set OA_BACKUP_DIR to another filesystem.' \
			"$BACKUP_ROOT" "$(human "$needed")" "$(human "$available")")"
	fi

	local stamp dir
	stamp="$(date -u +%Y%m%dT%H%M%SZ)"
	dir="$BACKUP_ROOT/$stamp-$label"
	[ -e "$dir" ] && die "$dir already exists"
	mkdir -p "$dir"
	chmod 700 "$dir"

	echo "snapshot: stopping the stack — this is downtime, and it is what makes the copy consistent"
	STACK_STOPPED=1
	compose stop
	local stopped_at
	stopped_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

	if [ "$pg_mode" = volume ]; then
		echo "snapshot: archiving $pg_volume ($(human "$pg_bytes"))"
		archive_volume "$pg_volume" "$PWD/$dir" pg-data.tar.gz
	else
		echo "snapshot: Postgres is not part of this stack — it is NOT in this snapshot"
		echo "          nothing writes to it from now until the stack starts again;"
		echo "          to go back, restore your provider's Postgres to $stopped_at"
	fi
	echo "snapshot: archiving $ch_volume ($(human "$ch_bytes"))"
	archive_volume "$ch_volume" "$PWD/$dir" ch-data.tar.gz

	# The configuration, without which the archives above are unreadable.
	mkdir -p "$dir/env"
	cp env/*.env "$dir/env/" 2>/dev/null || die "no rendered env/*.env found — run ./generate-secrets.sh first"
	[ -f docker-compose.override.yml ] && cp docker-compose.override.yml "$dir/"
	[ -f .env ] && cp .env "$dir/dot-env"
	chmod -R go-rwx "$dir"

	{
		echo "oa_snapshot_version=$MANIFEST_VERSION"
		echo "created_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
		echo "label=$label"
		echo "git_commit=$(git -C ../.. rev-parse HEAD 2>/dev/null || echo unknown)"
		echo "git_describe=$(git -C ../.. describe --tags --always --dirty 2>/dev/null || echo unknown)"
		echo "image_repo=$(env_value OA_IMAGE_REPO)"
		echo "image_tag=$(env_value OA_IMAGE_TAG)"
		echo "stack_stopped_at=$stopped_at"
		echo "postgres=$pg_mode"
		echo "pg_volume=$pg_volume"
		echo "ch_volume=$ch_volume"
		echo "pg_bytes=$pg_bytes"
		echo "ch_bytes=$ch_bytes"
	} >"$dir/manifest"
	chmod 600 "$dir/manifest"

	if [ "$start" -eq 1 ]; then
		echo "snapshot: starting the stack again"
		compose up -d
		STACK_STOPPED=0
	fi

	echo
	echo "snapshot: wrote $dir ($(du -sh "$dir" | cut -f1) on disk)"
	echo "          restore it with: ./rollback.sh --to $dir"

	if [ -n "$keep" ]; then
		prune "$keep"
	else
		echo "          backups/ now holds $(du -sh "$BACKUP_ROOT" | cut -f1) across $(count_snapshots) snapshot(s)."
		echo "          Nothing is deleted automatically. ./snapshot.sh create --keep 3 prunes."
	fi
}

# --- restore ----------------------------------------------------------------
do_restore() {
	local from="" start=1
	while [ $# -gt 0 ]; do
		case "$1" in
		--from)
			from="${2:-}"
			shift 2
			;;
		--start)
			start=1
			shift
			;;
		--no-start)
			start=0
			shift
			;;
		-h | --help) usage ;;
		*) die "unknown argument '$1'" ;;
		esac
	done
	[ -n "$from" ] || die "restore needs --from <snapshot directory>"
	[ -f "$from/manifest" ] || die "$from is not a snapshot (no manifest)"
	# A snapshot taken before this field existed held a Postgres volume.
	local pg_mode
	pg_mode="$(manifest_value "$from" postgres)"
	[ "$pg_mode" = unknown ] && pg_mode=volume
	[ "$pg_mode" = external ] || [ -f "$from/pg-data.tar.gz" ] || die "$from/pg-data.tar.gz is missing"
	[ -f "$from/ch-data.tar.gz" ] || die "$from/ch-data.tar.gz is missing"
	if [ "$pg_mode" = volume ] && ! postgres_in_stack; then
		die "$from holds a Postgres volume, but this stack runs no postgres service — restore it into a stack that does, or restore the database by hand"
	fi

	local pg_volume="" ch_volume
	[ "$pg_mode" = volume ] && pg_volume="$(volume_at postgres /var/lib/postgresql/data)"
	ch_volume="$(volume_at clickhouse /var/lib/clickhouse)"

	echo "snapshot: stopping the stack"
	STACK_STOPPED=1
	compose stop

	if [ "$pg_mode" = volume ]; then
		echo "snapshot: replacing the contents of $pg_volume"
		restore_volume "$pg_volume" "$PWD/$from" pg-data.tar.gz
	fi
	echo "snapshot: replacing the contents of $ch_volume"
	restore_volume "$ch_volume" "$PWD/$from" ch-data.tar.gz

	if [ "$pg_mode" = external ]; then
		# Not an error, so the exit trap must not say "FAILED" — the stack is
		# down on purpose and the message below is the instruction.
		STACK_STOPPED=0
		echo
		echo "snapshot: ClickHouse is restored. POSTGRES IS NOT, and the stack is left STOPPED."
		echo "          Restore your provider's Postgres to $(manifest_value "$from" stack_stopped_at)"
		echo "          (Neon: the branch's point-in-time restore), then: docker compose up -d"
		return 0
	fi

	if [ "$start" -eq 1 ]; then
		echo "snapshot: starting the stack"
		compose up -d
		STACK_STOPPED=0
	fi
	echo "snapshot: restored from $from"
}

# --- list -------------------------------------------------------------------
do_list() {
	[ -d "$BACKUP_ROOT" ] || die "no $BACKUP_ROOT directory yet"
	local found=0
	for dir in "$BACKUP_ROOT"/*/; do
		[ -f "$dir/manifest" ] || continue
		found=1
		printf '%s\n' "${dir%/}"
		printf '  taken %s   from %s   images %s:%s   %s\n' \
			"$(manifest_value "${dir%/}" created_at)" \
			"$(manifest_value "${dir%/}" git_describe)" \
			"$(manifest_value "${dir%/}" image_repo)" \
			"$(manifest_value "${dir%/}" image_tag)" \
			"$(du -sh "${dir%/}" | cut -f1)"
	done
	[ "$found" -eq 1 ] || die "no snapshots in $BACKUP_ROOT"
}

# --- shared bits ------------------------------------------------------------
human() {
	awk -v b="$1" 'BEGIN {
    split("B KB MB GB TB", unit, " ")
    i = 1
    while (b >= 1024 && i < 5) { b /= 1024; i++ }
    # Assigned rather than written as a ternary inside printf: awk parses
    # `printf (a ? b : c), x` inconsistently, and this is not the place to find
    # out which awk the host has.
    format = (i == 1) ? "%d %s\n" : "%.1f %s\n"
    printf format, b, unit[i]
  }'
}

count_snapshots() {
	local n=0
	for dir in "$BACKUP_ROOT"/*/; do
		[ -f "$dir/manifest" ] && n=$((n + 1))
	done
	echo "$n"
}

# Reads one variable out of the compose `.env`. Not `source`: that file is
# generated, but sourcing it would also run whatever anybody added to it.
env_value() {
	[ -f .env ] || {
		echo unknown
		return
	}
	local line
	line="$(grep -E "^$1=" .env | tail -1 || true)"
	[ -n "$line" ] && echo "${line#*=}" || echo unknown
}

manifest_value() {
	local line
	line="$(grep -E "^$2=" "$1/manifest" | tail -1 || true)"
	[ -n "$line" ] && echo "${line#*=}" || echo unknown
}

prune() {
	local keep="$1" total dirs=()
	case "$keep" in
	'' | *[!0-9]*) die "--keep needs a number" ;;
	esac
	[ "$keep" -ge 1 ] || die "--keep must be at least 1"
	for dir in "$BACKUP_ROOT"/*/; do
		[ -f "$dir/manifest" ] && dirs+=("${dir%/}")
	done
	total=${#dirs[@]}
	if [ "$total" -le "$keep" ]; then
		echo "          keeping all $total snapshot(s); --keep $keep is not reached yet"
		return
	fi
	# The directory names begin with a UTC timestamp, so the glob above is
	# already oldest-first.
	local remove=$((total - keep)) i=0
	while [ "$i" -lt "$remove" ]; do
		echo "          pruning ${dirs[$i]}"
		rm -rf "${dirs[$i]}"
		i=$((i + 1))
	done
}

# --- dispatch ---------------------------------------------------------------
[ $# -gt 0 ] || usage
subcommand="$1"
shift
case "$subcommand" in
create) do_create "$@" ;;
restore) do_restore "$@" ;;
list) do_list "$@" ;;
-h | --help) usage ;;
*) die "unknown subcommand '$subcommand'" ;;
esac
