# Self-hosting OpenAnalytics

Everything needed to run the whole product — tracker, ingest, worker, control
plane, query gateway, realtime stream and dashboard — on your own hardware.

Two ways in:

- **[Docker Compose](#docker-compose)** — the supported path. One generator
  script, one `docker compose up -d`, TLS issued automatically.
- **[From source](#running-from-source)** — for development, or for slotting the
  services into infrastructure you already run.

Requirements for the compose path: a Linux host with Docker and the Compose
plugin, four DNS records pointing at it, about 4 GB of RAM and **25 GB of free
disk**. A release is about 13 GB of images, and an upgrade holds two generations
at once until the old one is cleared, which is where the second figure comes
from. Everything else is built from this repository.

---

## What you are actually running

| Piece           | Job                                                                | Public? |
| --------------- | ------------------------------------------------------------------ | ------- |
| `collector`     | Ingest: validates, sanitizes, rate-limits, enqueues                | yes     |
| `worker`        | Drains the queue into ClickHouse, sessions, rollups, mail, deletes | no      |
| `api`           | Control plane: auth, sites, keys, sharing, MCP                     | yes     |
| `query-gateway` | The only process allowed to read ClickHouse                        | no      |
| `realtime`      | The SSE stream behind the live dashboard                           | yes     |
| `web`           | The dashboard (Next.js)                                            | yes     |
| `oa.js`         | The browser tracker, served as a static file by the proxy          | yes     |

Stores: **Postgres** (control plane), **ClickHouse** (events and rollups),
**Valkey ×2** — one durable queue, one losable cache. They are two instances
rather than two databases on one, because they need opposite eviction policies
and one process cannot have both.

**Postgres: bundled, or on Neon.** The stack runs its own Postgres container by
default. For a managed database we recommend [Neon](https://neon.com), which is
what getopen.so runs on; see [Using Neon](#using-neon) below and the
step-by-step [infra/selfhost/NEON.md](infra/selfhost/NEON.md). ClickHouse and
Valkey stay on the host either way.

### Four names, and why it is four

| Name           | Serves              | Also                                |
| -------------- | ------------------- | ----------------------------------- |
| `app.<domain>` | the dashboard       |                                     |
| `api.<domain>` | the api             | OAuth callbacks, share links        |
| `c.<domain>`   | the collector       | **and `oa.js`**, from the same host |
| `rt.<domain>`  | the realtime stream |                                     |

`oa.js` lives beside the collector because it is what a site owner pastes into
their page: one host to point at, and one fewer certificate to own.

---

## Docker Compose

### 1. DNS first

Point all four names at the host. Certificates are issued by Let's Encrypt on
first start, and issuance fails without the records — Caddy will keep retrying,
but nothing is served on 443 until they resolve.

### 2. Generate the configuration

**Check out a release, not `main`.** `main` is where work lands; a tag is a tree
whose images were built, published and smoke-tested together. The compose file,
the env templates and the migrations all ship with those images, so the tag is
what keeps them the same version.

```sh
git clone https://github.com/OpenLabs-so/openanalytics
cd openanalytics
git checkout "$(git tag -l 'v*' --sort=-v:refname | sed '/-/d' | head -1)"
cd infra/selfhost
./generate-secrets.sh --domain analytics.example --email admin@analytics.example
```

That checkout line resolves the newest **final** release, and the `sed` is the
part doing the work: a candidate publishes images under its own tag and sorts
_above_ the release it is a candidate for, so `git tag --sort=-v:refname` lists
`v0.1.0-rc.1` before `v0.1.0` and `git describe` would hand you the candidate.
Dropping every tag with a `-` in it leaves only releases. To take a specific
one, name it instead: `git checkout v0.8.0`.

Add `--with-geoip` to that last command to download the country and city
database in the same pass — see [GeoIP](#geoip). It is the one thing in the
generator that reaches the network, so it is opt-in; if the download fails, the
generator says so and finishes anyway.

That writes, in one pass so the values that must match actually do:

- `.env` — the four names, the compose network, and which images to run. No
  secrets. The images are read back out of the checkout: stand on a release tag
  and it points at that release's published images, stand anywhere else and it
  writes the defaults that build them here. It prints which it chose.
- `env/*.env` — **one file per service**, with generated passwords.
- `docker-compose.override.yml` — three Ed25519 key pairs as YAML block
  scalars, split across the services entitled to each half.

All three are git-ignored. **Back them up off this machine before going
further** — see [Losing a secret](#losing-a-secret).

### 3. Bring it up

A release publishes **ten images**: `migrate`, `tracker-build`, `api`,
`collector`, `worker`, `query-gateway`, `realtime`, `web`, and the two stores
that carry configuration, `clickhouse` and `valkey`. An install pulls them
instead of compiling them. The generator has already pointed `.env` at them,
because you checked out the tag before running it:

> **New in v0.3.0, and it changes one habit.** `clickhouse` and `valkey` used to
> be upstream's images plus files bind-mounted out of this directory. They are
> now our own images with those files baked in, because a bind mount works in a
> checkout and nowhere else, and the one-click platforms have no checkout. The
> files have not moved: `clickhouse/oa-entrypoint.sh`, its config drop-in and the
> three under `valkey/` are still here and are what the images are built from.
> What changed is that **editing one in place no longer takes effect**. To change
> one, either build instead of pull (`./upgrade.sh --from-source`) or bind-mount
> your version over the baked one, which still wins.

```sh
grep OA_IMAGE .env                 # ghcr.io/openlabs-so/openanalytics, v0.8.0
docker compose pull
docker compose up -d
docker compose logs -f migrate     # schemas, both stores, from empty
docker compose ps                  # everything but migrate/tracker-build healthy
```

If that `grep` says `openanalytics` and `local` instead, the generator did not
find a release tag on `HEAD` — it says so when it runs — and wrote the build
defaults. Either build (below), or edit those two lines by hand: they are the
whole of what this decision touches, and nothing else in `.env` depends on them.
Do **not** re-run the generator to fix it. That needs `--force`, and `--force`
replaces every secret it wrote.

**The image tag and the checkout are one version, which is why the generator
derives one from the other.** Running a release's images from a different
release's tree is not a supported configuration: the migrations and the env
templates belong to the version too.

Images are published for **amd64 only**. On arm64 — a Hetzner CAX box, an Apple
Silicon machine — build them instead, which is what the paragraph below is
about. Everything else is identical.

#### Building instead of pulling

`OA_IMAGE_REPO=openanalytics` and `OA_IMAGE_TAG=local` name images no registry
serves, which is what makes compose build all ten here:

```sh
docker compose up -d --build
```

On a branch or on `main` the generator already wrote those two — building is
what a tree with no published images can do. On a release checkout it wrote the
registry instead, so set them back by hand first, or `./upgrade.sh
--from-source`, which does the same and takes a snapshot before it starts.

**On a 4 GB host, add swap first.** TypeScript and Next both want more memory
than a 4 GB box has spare while the stores are already running. Without it a
build is killed part way through, and the symptom — a container that exits `137`
with no error of its own — points nowhere near the cause.

```sh
fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab   # survive a reboot
```

Swap is needed for the **build**, not to run the product: a 4 GB host serves an
ordinary install comfortably once the images exist. Leaving it on costs a file
and rescues you the next time you build. Building all ten takes about ten
minutes on that box, most of it compiling.

Either way, the order is enforced by the compose file and is not cosmetic:

1. stores start and become healthy;
2. `migrate` runs Postgres migrations, then ClickHouse migrations, then fills
   any rollup history that is missing (a no-op on an empty install), and exits;
3. every application service waits for that exit — a failed migration stops the
   deploy instead of producing a fleet of services against a half-built schema;
4. `tracker-build` compiles `oa.js` into a volume Caddy serves read-only;
5. Caddy starts and requests certificates.

Later, to move to a newer release, use `./upgrade.sh` — it takes a snapshot
first, because that snapshot is the only way back. See
[Upgrades and going back](#upgrades-and-going-back).

### 4. Claim it

Open `https://app.<domain>`. A deployment nobody has signed into yet does not
ask you to sign in — it offers to **create the first account**, with an email
address and a password, and signs you in the moment you do.

**Do this immediately.** The offer is open to whoever asks first, and your four
DNS records are public. It closes permanently the instant one account exists:
from then on the same screen is an ordinary sign-in, and the route behind it
answers `409` forever. There is no flag to turn off afterwards.

The address is recorded as verified, because the account exists precisely
because no mail transport is configured and there is nothing to verify it with.
That is also what makes it the _same_ account later: configure a provider or a
mail transport, sign in with the same address, and you land here rather than on
a second account.

Password sign-in stays available afterwards — `AUTH_PASSWORD_SIGNIN=enabled`,
which `generate-secrets.sh` writes into `env/api.env` for you. It is a normal
door for an install that runs on its owner's hardware, not a bootstrap flag.

**The two other doors, once you want them:**

- **OAuth** — register an app with Google or GitHub, set the callback to
  `https://api.<domain>/api/auth/callback/google` (or `/github`), and put the id
  and secret in `env/api.env`. A provider is offered only when both are present,
  so a deployment with neither pair simply has no buttons.
- **Magic link** — needs a working mail transport, which the next step is about.
  Mail is a worker job: the api only writes the send to an outbox. With no
  transport, nothing is sent, and the log records only that a message existed —
  its subject and the recipient's domain. The link itself is deliberately
  written nowhere, because a sign-in link in a log file is a credential in
  something every operator tails and pastes into issues, so **the log is not a
  way in**.

`docker compose run --rm create-admin --email you@example.com` still exists and
still works. It predates the first-run screen and is now the tool for the case
that screen cannot serve: writing an account on a deployment that already has
one, from the host, with no browser.

### 5. Mail, and the model provider

**Account → Deployment**, in the dashboard. It is where you configure the two
things this install needs from somebody else, and it exists so that neither is
an edit to a file on the host followed by a restart:

- **Email** — a relay's host, port, TLS mode, credential and From address.
  Saved settings win over `env/worker.env`, are stored encrypted under
  `OA_CREDENTIAL_KEYRING`, and take effect on the worker's next drain — a few
  seconds. **Send a test** puts a message in your own inbox and reports back
  what the relay said: `unauthorized` is a wrong username or password,
  `unavailable` is a host or port the container cannot reach, and `invalid` is
  almost always a From address the relay will not send as.
- **Assistant** — an OpenAI key, or any endpoint speaking the same API. It wins
  over `OPENAI_API_KEY` and takes effect on the next question. Without one the
  chat button is drawn disabled rather than offering an error.

Two things worth knowing about the screen:

- **Only the account that claimed the deployment sees it** — the oldest one.
  There is no role above a site membership yet, so this is the rule, and it is
  the same sentence the first-run screen makes.
- **A stored secret is never shown again.** The forms report the last four
  characters and nothing else, and leaving a password field empty keeps what is
  stored.

The env blocks stay, and they stay first-class: `SMTP_HOST` alone activates SMTP
with port 587, STARTTLS, no credential and `EMAIL_FROM` as the sender, and the
worker logs `email_transport_selected` at boot naming what it resolved and where
from. A deployment that would rather keep its configuration in files can set
`DEPLOYMENT_SETTINGS=disabled` on both the api and the worker, and the screen
never appears.

If a stored password ever stops being readable — the keyring was rotated without
keeping the old version, say — the worker logs
`deployment_setting_secret_unreadable` and **falls back to the environment** for
that send rather than trying the relay without a credential. Mail keeps moving;
re-enter the password on the settings screen to go back to the stored relay.

> **Set `DEPLOYMENT_SETTINGS` on both services, and delete the rows before you
> turn it off.** They are two independent variables and nothing reconciles them.
> With it enabled on the api and disabled on the worker, you can save a relay
> that is never delivered through. With it disabled on the api and enabled on
> the worker, the screen disappears but **the worker keeps preferring whatever
> is already stored** — turning the feature off does not remove the row. To go
> back to configuring mail and the assistant from files, clear the settings in
> the dashboard first (which returns the deployment to its environment), then
> set `DEPLOYMENT_SETTINGS=disabled` on both and recreate them.

### 6. Add a site and check the pipeline

Create a site in the dashboard, paste the snippet it gives you, then:

```sh
curl -s https://c.<domain>/oa.js -o /dev/null -w '%{http_code} %{size_download}\n'
curl -s https://api.<domain>/health | head -c 200
docker compose logs --tail=50 worker | grep -i batch
```

An event should reach ClickHouse within a couple of seconds of a page view.

---

## The configuration, in detail

### Why there is no single `.env`

Each service validates its own environment at startup, and **a service handed a
secret it must not hold exits rather than starting**. That is the boundary the
architecture rests on:

- the internet-facing collector holds no ClickHouse credential, no Stripe key
  and no mail credential;
- the query gateway holds the public verify key and never the private one, so it
  cannot forge the requests it exists to authenticate;
- only the worker holds the credential that can delete analytics rows;
- only the collector holds the HMAC that turns a visitor's address into an
  anonymous id, because it is the only service that ever sees an address.

One shared environment would hand every service every secret, and nothing would
boot. Hence `env/api.env`, `env/collector.env`, and so on.

**An empty value is not an absent one.** `FOO=` sets `FOO` to the empty string
and the schema rejects it — an optional variable is optional when it is
_missing_. (`PORT=` coerces to `0` and fails the same way.) Leave what you do not
use commented out. This is the single most common way to get a service that
refuses to boot with a puzzling message.

### Secrets you generate

`generate-secrets.sh` writes all of these. Generate them by hand only if you are
wiring this into something else:

```sh
openssl rand -hex 32     # AUTH_SECRET, ANONYMOUS_IDENTITY_SECRET,
                         # TRIAL_IDENTITY_SECRET, CREDENTIAL_SOURCE_SECRET,
                         # and every store password

# OA_CREDENTIAL_KEYRING — one line of JSON
node -e "console.log(JSON.stringify({active:'k1',keys:{k1:require('node:crypto').randomBytes(32).toString('base64')}}))"
```

Four of them are **independent by design** and must not be derived from one
another: they protect different things, and a derivation would make rotating one
force rotating the other.

Two must be **byte-identical across two files**, and a mismatch does not fail
loudly — it produces joins that match nothing while looking exactly like values
that should:

| Secret                      | Must match between                    |
| --------------------------- | ------------------------------------- |
| `ANONYMOUS_IDENTITY_SECRET` | `env/collector.env`, `env/worker.env` |
| `OA_CREDENTIAL_KEYRING`     | `env/api.env`, `env/worker.env`       |

### The two key pairs, and why they are not in an env file

| Pair            | Private half (api mints) | Public half (verifies only) |
| --------------- | ------------------------ | --------------------------- |
| Query signing   | api                      | query gateway               |
| Realtime tokens | api                      | realtime                    |

```sh
openssl genpkey -algorithm ed25519 -out private.pem
openssl pkey -in private.pem -pubout -out public.pem
```

**A PEM cannot live in an env file.** It is multi-line, and writing it with an
escaped `\n` does not help: Docker passes those through as two literal
characters and `createPrivateKey` rejects the result with
`ERR_OSSL_UNSUPPORTED`. A YAML block scalar is the shape that survives, which is
why the generator writes them into `docker-compose.override.yml` — a filename
`docker compose` merges automatically, so there is no `-f` to forget. Forgetting
it would boot an api with the analytics and realtime surfaces silently unmounted.

**Rotating a pair is one window, not two steps.** Neither side supports a key
_set_, so signer and verifier change together: generate the pair, replace both
halves in the override file, bump `QUERY_SIGNING_KEY_ID` in **both**
`env/api.env` and `env/gateway.env`, then
`docker compose up -d gateway api realtime`. Bumping the id is what turns a stale
signer into `Unknown signing key` rather than a signature failure — the more
diagnosable of the two. Generate keys **on the host**, not on a workstation
whose shell history or agent transcript can see them.

### Or hand the services a file instead

Every variable the services read also accepts a path: set `X_FILE` and the value
is read from the file it names. `QUERY_SIGNING_PRIVATE_KEY_FILE=/keys/query.pem`
is the same thing as `QUERY_SIGNING_PRIVATE_KEY=<the PEM>`, and it sidesteps the
multi-line problem above entirely — a file is already the shape a PEM wants.

This exists for installs that never get a shell: the one-click catalogues can
generate a random string into a variable, but none of them can produce a keypair
whose halves must match across two services, and `./generate-secrets.sh` is not
something they can run. `infra/selfhost/docker-compose.keys.yml` is the worked
example — a one-shot `keygen` step writes the three pairs into four separate
volumes and each service mounts only its own, read-only:

```sh
docker compose -f docker-compose.yml -f docker-compose.keys.yml up -d
```

Four rules worth knowing before you use it:

- **A path is a promise.** An absent variable can mean "this feature is off";
  a path pointing at a missing or empty file is a refusal to start. That is the
  whole point — the alternative is a stack that comes up green with the
  analytics read surface silently unmounted.
- **Not both.** Setting `X` and `X_FILE` together is a startup error rather than
  a silent winner, so nobody ends up running on a key they cannot name.
- **The boundary still holds.** Paths are resolved before the least-privilege
  check, so pointing the gateway at the api's private key fails exactly the way
  pasting that key into the gateway's env has always failed.
- **Ownership.** The services run as uid 1000 (`node`). A key file written by a
  root process on a fresh volume must be `chown`ed to it, or the service cannot
  read its own key. The `keygen` step does this; a hand-rolled equivalent must
  too.

Trailing newlines are stripped, which is what `openssl` writes and what no key
parser wants. A `_FILE` variable whose base name no service declares —
`SSL_CERT_FILE`, say — is left alone.

It has been run on a real host. Keys are generated once and a redeploy does not
rotate them, the modes and the ownership hold on fresh volumes, and a service
started before its key exists refuses to start with the reason on the line and
then recovers on its own rather than wedging.

Expect one thing on the first `up -d`. The services that wait on `keygen` can be
left `Created` rather than started once it finishes, so `docker compose ps` shows
a stack that is half up. Run `docker compose up -d` a second time and they start.
It costs a command, not a reset, and it is worth knowing before you go looking
for the cause in the logs.

**On a platform that owns the proxy** (Coolify, Dokploy, CapRover) the whole
compose file is different rather than overlaid, because the differences are
removals and an overlay cannot remove: `infra/selfhost/docker-compose.coolify.yml`,
with [infra/selfhost/COOLIFY.md](infra/selfhost/COOLIFY.md) for what that install
looks like and what has been verified on it.

### Using Neon

[Neon](https://neon.com) is the managed Postgres we recommend, and the one the
hosted service runs on. Postgres is the control plane only — users, sites, keys,
settings — so moving it is small, and it takes the one store whose loss locks
you out of everything else off your disk. The full walkthrough, including moving
an existing install's data across, is
**[infra/selfhost/NEON.md](infra/selfhost/NEON.md)**. The shape of it:

1. Create a Neon project in the region nearest your server. Neon's default
   Postgres version is fine (the schema was built on its Postgres 18).
2. Copy its connection string **with pooling off** — the host must not contain
   `-pooler`. The migration runner holds a session-level advisory lock, and
   session state does not survive Neon's transaction-mode pooler.
3. Put that string in four places, all the same:

   | File                | Variable                 |
   | ------------------- | ------------------------ |
   | `env/api.env`       | `DATABASE_URL`           |
   | `env/collector.env` | `DATABASE_URL`           |
   | `env/worker.env`    | `DATABASE_URL`           |
   | `env/migrate.env`   | `POSTGRES_MIGRATION_URL` |

   ```sh
   DATABASE_URL=postgresql://neondb_owner:<password>@ep-example-123456.eu-central-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require
   ```

4. Add `docker-compose.neon.yml` to the files compose reads, through `.env`
   (not `-f`, which would drop the key-pair override):

   ```sh
   echo 'COMPOSE_FILE=docker-compose.yml:docker-compose.override.yml:docker-compose.neon.yml' >> .env
   ```

   It moves the `postgres` service behind a profile and stops `migrate` waiting
   for it. `env/postgres.env` is then unused.

5. `docker compose up -d`. The `migrate` container builds the schema on Neon.

Two things change afterwards. The `pg_dump` line under [Backups](#backups) talks
to the local container; with Neon, restore is point-in-time on the branch, and
`pg_dump "$DATABASE_URL"` works from anywhere with a `pg_dump` at least as new
as Neon's Postgres (the NEON.md backups note has the one-liner). And `./upgrade.sh`'s snapshot then
holds ClickHouse only: it prints the instant the stack stopped, and
`./rollback.sh` stops before starting so you can restore the Neon branch to that
instant first.

### The Valkey URLs are IP addresses on purpose

The connection factory refuses a plaintext `redis://` URL whose host it cannot
prove is private, because that hop can hold the only copy of a customer event.
It recognises loopback, `10/8`, `192.168/16`, `172.16-31/12`, and a **single-label
name** such as `valkey-queue`, which has no TLD and so no public resolver that
can answer it. A host with a dot in it that is not one of those ranges is the
public wire and is refused with "this hop crosses the public internet". AUTH is
required on that hop whatever the address.

So the compose network pins `172.28.0.0/16` and gives each Valkey a fixed
address in it, which is what it did before the name rule existed and what it
still does. If that subnet collides with something on your host, change
`OA_SUBNET`, both `ipv4_address` values and the URLs in `env/*.env` together —
any private range works, none of the public ones do.

**A recreate can collide with itself.** Because the address is pinned rather than
allocated, a replacement container sometimes asks for it while the container it
replaces is still holding it, and compose stops with `Address already in use`.
Run the same command again: the old one is gone by then and the new one takes
the address.

To put the queue on a wire you do not control, terminate TLS in Valkey and use
`rediss://` with AUTH. The check accepts that from any host.

### GeoIP

Country and city come from a local City-schema `.mmdb`. Without one every event
carries null geo, which is why a fresh install shows every country as unknown
and an empty globe.

The generator does both steps if you ask it to, which is the easiest time to do
it:

```sh
./generate-secrets.sh --domain analytics.example --email admin@analytics.example --with-geoip
```

It downloads the database and uncomments `GEOIP_DB_PATH` in
`env/collector.env`. **A failed download is not a failed install**: the generator
reports it, leaves the variable commented out, and finishes — null geo is a
degradation, and a half-written set of secrets would be a deployment that cannot
start at all. Retry whenever.

By hand, or later:

```sh
cd infra/selfhost/geoip && ./fetch-dbip.sh
# then in env/collector.env:
GEOIP_DB_PATH=/geoip/dbip-city-lite.mmdb
docker compose up -d --force-recreate collector
```

**DB-IP City Lite is CC BY 4.0** — no account, direct download, and
redistributable with attribution, which is the whole reason a script can fetch
it for you. The attribution is a licence condition rather than a courtesy: keep
**IP Geolocation by DB-IP (https://db-ip.com)** wherever the data is shown. It
is in this repository's README for the same reason.

MaxMind's GeoLite2-City.mmdb works equally well if you already have one — the
schemas are interchangeable, so drop it in the same directory and point
`GEOIP_DB_PATH` at it. Nothing here fetches it: it needs a MaxMind account and
its EULA forbids redistribution.

**Re-run the fetch monthly, and recreate the collector afterwards.** The
database goes stale, and the collector opens it once at boot — a new file on
disk changes nothing until the process restarts.

**On a one-click platform the download is a step of the deploy.** Coolify and
its peers write the rendered compose file and nothing beside it, so there is no
directory to fetch into. `docker-compose.coolify.yml` and the Dokploy blueprint
run a `geoip` one-shot instead: on the first deploy it fetches DB-IP City Lite
into a named volume, and every later deploy leaves the file alone. A failed
download fails that deploy on purpose, because the collector refuses to start
on a path that names no file. To refresh the database, or to use your own
MaxMind file, copy it into the volume and restart the collector:

```sh
docker cp dbip-city-lite.mmdb <collector-container>:/geoip/
docker restart <collector-container>
```

The database is never committed: a 60 MB download that unpacks to about 125 MB,
out of date within a month, and a database in git history is in git history
forever.

City-level detail stays opt-in per site in the dashboard regardless of this.

### Putting your own proxy in front

`infra/selfhost/Caddyfile` is what the compose file uses.
`infra/selfhost/nginx.conf.example` is the same shape for nginx.

**Read the header of whichever you use before changing it.** The
`client_identity_hygiene` block is a security control:

The collector reads the visitor's address from headers a fronting platform is
expected to set from the connection itself — `X-Real-IP`, `CF-Connecting-IP`,
`Fly-Client-IP`, `True-Client-IP` — plus country and city headers of the same
kind. On a platform like Vercel or Cloudflare that is safe, because the platform
overwrites them on every request. **Behind your own proxy nothing overwrites them
unless you do.** A visitor who simply sends `CF-Connecting-IP: 203.0.113.10` then
chooses:

- their own rate-limit bucket — a fresh address per request and the per-IP
  limiter never fires, which is the whole of the ingest flood defence;
- their own anonymous visitor identity, since the daily-rotating hash is derived
  from that address — so one client can appear as any number of visitors;
- their own country and city in your analytics.

The fix is two directives: assert `X-Real-IP` from the real connection, and
**delete every other header in that list**. Both configs do it; keep both parts.

If you add a CDN or load balancer _in front_ of the proxy, the snippet becomes
wrong as written — it would assert that layer's address for every visitor.
Configure the outer layer to set `X-Real-IP` from its own connection, keep the
deletions, and drop the assertion.

### Object storage

Data import and export need an S3-compatible bucket. Any provider works;
[RustFS](https://rustfs.com) ships here so you do not need one:

```sh
docker compose --profile object-storage up -d
```

Then, once, create the bucket and let the dashboard upload into it. The browser
PUTs an import archive straight to the bucket, so the bucket needs a CORS rule
naming your dashboard's origin — without it the upload fails in the browser and
nowhere else:

```sh
S3_KEY="$(grep ^RUSTFS_SECRET_KEY env/rustfs.env | cut -d= -f2)"
aws_cli() {
  docker run --rm --network openanalytics_oa -v "$PWD:/w" -w /w     -e AWS_ACCESS_KEY_ID=openanalytics -e AWS_SECRET_ACCESS_KEY="$S3_KEY"     -e AWS_DEFAULT_REGION=us-east-1 amazon/aws-cli --endpoint-url http://rustfs:9000 "$@"
}
aws_cli s3 mb s3://openanalytics
cat > cors.json <<'JSON'
{"CORSRules":[{"AllowedOrigins":["https://app.example.com"],"AllowedMethods":["PUT","GET"],"AllowedHeaders":["*"],"ExposeHeaders":["ETag"],"MaxAgeSeconds":600}]}
JSON
aws_cli s3api put-bucket-cors --bucket openanalytics --cors-configuration file://cors.json
```

Replace `app.example.com` with your dashboard's name. Then fill in the five
`OBJECT_STORAGE_*` variables in **both** `env/api.env` and `env/worker.env` —
the api mints signed URLs and the worker moves the bytes. The access key is
`openanalytics` and the secret is `RUSTFS_SECRET_KEY` from `env/rustfs.env`. All
five or none: a partial block is treated as "not configured" and the import
surface is simply not mounted.

**Upgrading from a release that shipped MinIO.** MinIO stopped publishing
images, so the `minio` service is gone. Only installs that enabled the
`object-storage` profile are affected: create `env/rustfs.env` from
`env/rustfs.env.example` with a secret of your own, start the profile, and run
the two commands above. The old `minio-data` volume is left where it was and
nothing reads it; import archives and exports are transient by design, so
nothing durable lived there.

---

## What stops working when something is missing

Nothing here refuses to boot. Every one of these degrades a surface and says so
in the log, which is the deliberate shape: a deployment must not fail over a
feature it has not enabled.

| Missing                                                                  | What breaks                                                                                                                                                                                                            |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mail transport (stored settings, `RESEND_API_KEY` or SMTP) on the worker | **Magic-link sign-in cannot complete**; invitations never arrive. Nothing is sent and the link is written nowhere. Sign in with the account the first-run screen made, then configure a relay in Account → Deployment. |
| `AUTH_TRUSTED_ORIGINS` on the api                                        | **Every browser call from the dashboard is refused.** No `Access-Control-Allow-Origin` is emitted at all — fail-closed by design.                                                                                      |
| `APP_BASE_URL` on the api                                                | Human-facing links (invitation acceptance, billing returns) point at pages the api does not serve.                                                                                                                     |
| `GOOGLE_*` / `GITHUB_*`                                                  | No Google/GitHub button. A provider appears only when both its id and secret are present.                                                                                                                              |
| `GEOIP_DB_PATH`                                                          | Every event carries null geo. No country, no city.                                                                                                                                                                     |
| `CLICKHOUSE_MAINTENANCE_*` on the worker                                 | **Site and account deletion queue and retry forever** instead of erasing anything. A wait, not a loss — but a silent one.                                                                                              |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET`                            | Billing surfaces disable themselves. Normally what a self-hosted install wants.                                                                                                                                        |
| `OPENAI_API_KEY` **and** no stored provider                              | The AI assistant answers `503 not configured` — _before_ any question is charged — and the dashboard draws its chat button disabled.                                                                                   |
| `OA_CREDENTIAL_KEYRING`                                                  | Revenue-connection routes that encrypt are not mounted (404); reading and disconnecting still work. Account → Deployment closes with `no_keyring`, because it would be storing secrets it cannot protect.              |
| `CREDENTIAL_SOURCE_SECRET`                                               | No credential events are journalled at all. Reads are untouched.                                                                                                                                                       |
| `OBJECT_STORAGE_*`                                                       | Data import and export are not mounted.                                                                                                                                                                                |
| `REALTIME_CACHE_REDIS_URL` on the gateway                                | Replay defence becomes per-process — correct only with a single gateway instance. It warns.                                                                                                                            |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_NOTIFY_CHAT_ID`                         | Notifications use the log transport.                                                                                                                                                                                   |
| `METRICS_REMOTE_WRITE_*`                                                 | No metrics pipeline; the structured-log metrics floor remains.                                                                                                                                                         |

---

## Backups

There is one backup this repository takes, and it is not a backup strategy:

```sh
cd infra/selfhost
./snapshot.sh create --label before-something-risky
./snapshot.sh list
```

`snapshot.sh` **stops the stack**, archives both data volumes and every secret
that makes them readable, and starts it again. Cold, because a ClickHouse data
directory copied while the server is running is not a backup of anything — the
server merges parts in the background even with no writes, so a live copy can
contain a part that was being replaced, and you find that out during a restore.
`./upgrade.sh` runs it, and `./rollback.sh` restores it; that is what it is for.

**It is downtime, and it is on the same disk.** So it is the right tool for "put
this back the way it was ten minutes ago" and the wrong one for "the host burned
down". For that, everything below still applies.

`apps/worker/src/backup-watch.ts` is a _watcher_, not a backup: given
object-storage credentials it publishes `clickhouse_backup_age_seconds` from the
newest object under `backups/daily/`, so an alert can fire on the **absence** of
a recent backup. It never writes one. A timer that quietly stopped produces no
error to alert on, which is why the signal is age rather than failure.

What needs backing up off this machine, in order of how much it hurts to lose:

1. **`infra/selfhost/env/*.env` and `docker-compose.override.yml`.** Not data,
   but without them the data below is unreadable. Store them somewhere that
   survives losing this host.
2. **Postgres** — every user, site, tracking key, share link and event
   definition. Small, and the thing that makes the ClickHouse data mean
   anything. `pg_dump` on a schedule is enough:
   ```sh
   docker compose exec -T postgres pg_dump -U openanalytics openanalytics | gzip > oa-pg-$(date +%F).sql.gz
   ```
   On [Neon](#using-neon) there is no local container to ask. Neon keeps the
   history and restores to a point in time, and `pg_dump "$DATABASE_URL"` from
   any machine gives you a copy that lives off Neon as well, provided that
   `pg_dump` is at least as new as the server (see
   [NEON.md](infra/selfhost/NEON.md#running-it)).
3. **ClickHouse** — the events. Large and append-mostly. ClickHouse's own
   `BACKUP DATABASE analytics TO S3(...)` writes straight from the server to a
   bucket; run it from a timer on the host and keep the object off this machine.
4. The Valkey queue volume, only if you cannot tolerate losing events that are
   in flight — usually seconds' worth.

Two things worth knowing before you rely on any of it:

- **A backup nobody has restored is a guess.** Restore into a scratch database
  on a schedule and compare row counts. The hosted deployment does this weekly,
  because both a rehearsal that fails every week and one that stopped running
  look identical from outside.
- **If you encrypt backups with a customer-supplied key, losing that key is
  worse than having no backups**, because it looks like being covered. Keep a
  copy somewhere that is not the machine it protects.

---

## Operating it

### Upgrades and going back

```sh
git fetch --tags
git checkout v0.8.0            # the release you are moving to
cd infra/selfhost
./upgrade.sh                   # tells you what it costs, then does it
```

**On a box with less than 25 GB free, clear the previous release first.** The new
images are pulled before the old ones are released, so the upgrade briefly needs
room for two generations of about 13 GB each. Without it the pull fails part-way
through extracting a layer, with `no space left on device` naming a file inside
`node_modules` and nothing naming the disk:

```sh
docker image prune -a -f       # keeps whatever the running containers use
```

Run it from the **new** checkout: the script that performs an upgrade ships with
the version being upgraded to. It works out the target from the tag you are
standing on, takes a snapshot, points `.env` at the new images, pulls them and
brings everything up. On an architecture with no published images,
`./upgrade.sh --from-source` builds instead.

**0.7.0 → 0.8.0 asks nothing else of you either**, and it is short:

- **The hourly rollup tables are dropped.** ClickHouse migration 0029 removes
  the ten `*_1h` tables 0.7.0 stopped writing; nothing had read them since
  0.7.0 moved every chart to the fifteen-minute rollups. Site deletion stops
  naming them in the same release. The `*_1d` tables stay.
- **The history fill checks itself against your raw events.** In 0.7.0 it
  compared its sums with the frozen hourly tables, so an upgrade with the
  worker still running could log one `history fill backfill-15m failed` with
  `additive_mismatch` over history that was complete. It now compares with
  `events_raw`, which every rollup is built from, so that line no longer
  appears for that reason — when it does appear, the filled history really
  disagrees with the raw events, and the report above it says where.
- **Going back from 0.8.0 is a restore, not an image tag.** 0029 deletes the
  hourly tables, so the 0.7.0 images would find tables missing. Use
  `./rollback.sh` to the snapshot `./upgrade.sh` took, as below.

**Skipping 0.7.0 (0.6.0 → 0.8.0) is supported and asks nothing extra.** The
migrate container applies ClickHouse migrations 0025 through 0029 in one run
and fills the fifteen-minute rollups from your raw events afterwards, so
everything 0.7.0 describes below happens too — only the hourly tables are gone
by the time the fill runs. That is safe because the fill reads `events_raw`
and checks itself against `events_raw`; no step of it needs an hourly table.
Read the 0.7.0 notes below for what the fill costs on a large install.

**0.6.0 → 0.7.0 asks nothing else of you either, but it does more while it
runs**, so it is worth knowing what you are watching:

- **Every chart now reads fifteen-minute rollups instead of hourly ones.** That
  is what lets a site report on any IANA timezone, including +05:30 and +05:45,
  which 0.6.0 refused. ClickHouse migrations 0025–0028 add the new tables, stop
  the hourly ones from being written (they stay as frozen history, and a later
  release drops them) and add `backfill_ledger`.
- **The migrate container fills the new tables from your history, by itself.**
  After the migrations it runs three fills — the eight view-backed families,
  the session rollups and the revenue rollups (the worker then re-rolls revenue
  history a month per pass). Each fill writes only what is missing, a site's
  quarter hour that has events and no rollup row, so it is safe on any state
  and the next start writes nothing. It reads every raw event once, so on a
  large install the migrate step takes noticeably longer than usual, once. A
  fill that fails is logged as `oa-migrate: history fill … failed` and does
  **not** stop the stack: the next `docker compose up -d` retries it. Each
  fill that wrote something leaves a row you can read with
  `docker compose run --rm migrate node packages/clickhouse/dist/cli.js ledger`.
- **If the worker keeps running through the upgrade** — a platform redeploy, or
  `docker compose pull && docker compose up -d` without `./upgrade.sh` — one
  quarter hour can come out short: the one in which the new views were created
  counts only the events that arrived after that moment. `./upgrade.sh`
  stops everything first, so it does not have that. (0.7.0 could also log one
  false `additive_mismatch` here; 0.8.0 no longer does.)
- **ClickHouse gets new grants**, for the two rollups the worker writes itself.
  They are rendered when its container is created, and the new image tag is
  what recreates it, so `./upgrade.sh` and a platform redeploy deliver them
  without a step of yours. If you run your own ClickHouse image, see the
  recreate note below.
- **Every site now has a reporting timezone.** Postgres migration 0046 gives
  each site without one its owner's account timezone, or UTC, and makes the
  column required. The dashboard, widgets, the share page and the MCP server
  all read on it; a reader can switch their own view from the header.
- **Disk:** the fifteen-minute tables hold up to four rows for every hourly
  one. Measured on a real install they came to about a tenth of the size of
  the raw events.

Going back is `./rollback.sh` to the snapshot the upgrade took, as for any
release.

**There are no down migrations, and that is a decision rather than an omission.**
A reverse migration is code that runs once, in an emergency, having never been
run before — and the alternative is honest: an upgrade takes a backup first, and
going back is a restore.

```sh
./snapshot.sh list
./rollback.sh --to backups/20260812T140000Z-pre-v0.3.2
```

Three costs, and they belong here rather than in the rollback instructions,
because this is where you can still decide otherwise. `./upgrade.sh` prints them
and waits:

1. **Downtime**, for the length of the snapshot and the restart. Everything
   stops, the collector included, so events browsers try to send during the
   window are refused and lost — the tracker does not retry them. Pick a quiet
   hour.
2. **Going back loses data.** The restore replaces both stores wholesale, so
   every event, account and setting recorded after the snapshot goes with it.
   There is no partial or merged outcome. The cost of deciding to roll back
   therefore grows with every hour the new version runs, which is the argument
   for checking the dashboard right after an upgrade rather than the next
   morning.
3. **Disk.** A snapshot is a compressed copy of both stores and nothing deletes
   it for you. `./snapshot.sh list` shows what has accumulated;
   `--keep <n>` prunes.

Rolling back across versions means going back in the tree too — the compose file
and the migration set are part of the version:

```sh
git checkout v0.3.1
cd infra/selfhost && ./rollback.sh --to backups/20260812T140000Z-pre-v0.3.2
```

`rollback.sh` restores the configuration from the snapshot as well, moving the
current `env/*.env` aside first rather than deleting it, and takes its own
snapshot before it starts — so a rollback is itself reversible. `--keep-config`
and `--no-pre-backup` turn off each of those when you have a reason.

Two orderings the compose file already encodes, worth knowing if you deploy the
services by hand:

- **gateway before api.** The api sends a field on every gateway query that an
  older gateway rejects outright, so an api-first deploy breaks analytics reads
  for the length of the window; gateway-first has no window at all.
- **ClickHouse needs a recreate, not a restart**, whenever its users or grants
  change. `docker compose restart` re-runs the entrypoint with the container's
  _original_ environment, so the new value silently never arrives:
  ```sh
  docker compose up -d --force-recreate clickhouse
  ```
  Every migration that adds a table the worker writes also needs a line in
  `infra/selfhost/clickhouse/oa-entrypoint.sh` and one of these recreates.
  Without it, inserts into the new table fail while ordinary traffic keeps
  flowing — the quiet half of the failure.
- **Schema migrations are fatal, history fills are not.** The `migrate`
  container stops the stack if a migration fails, because nothing may run
  against a schema it was not built for. The history fills that follow them
  only log a failure, because stopping the stack there would stop the
  collector too, and every event sent meanwhile would be lost for the sake of
  a report that the next start completes.

### The tracker

`oa.js` is built once per `up` by the `tracker-build` container into a volume
Caddy serves. It is cached for an hour and never versioned: a fixed filename
means a fix reaches every visitor within an hour without anyone editing a
snippet, and that hour is also the ceiling on how long a broken tracker survives
after you fix it. To publish a change immediately after an upgrade:

```sh
docker compose up -d --force-recreate tracker-build     # pulled images
docker compose up -d --build --force-recreate tracker-build   # built here
```

Both `oa.js` and `oa.js.gz` are written together — a stale `.gz` beside a fresh
`.js` is what almost everyone would be served.

### Health

Every service answers `GET /health` on its own port with a dependency list, and
`503` while a dependency is unavailable. Each image is stamped with the commit
it was built from, published in the same response — so you can ask a running
service which commit it is rather than assuming:

```sh
docker compose exec api node -e "fetch('http://127.0.0.1:8082/health').then(r=>r.json()).then(o=>console.log(o.commit, o.status))"
```

A pulled image already carries the commit its release was built from. When you
build here, set `OA_GIT_COMMIT=$(git rev-parse HEAD)` in `infra/selfhost/.env`
first, or every service answers `unknown` — `./upgrade.sh --from-source` does it
for you.

### Losing a secret

| Lost                        | Consequence                                                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Store passwords             | Locked out of your own volumes. Recoverable only by resetting them inside the containers.                                 |
| `OA_CREDENTIAL_KEYRING`     | **Every stored provider credential is unrecoverable.** Customers must reconnect.                                          |
| `ANONYMOUS_IDENTITY_SECRET` | Visitor identity re-baselines: returning visitors count as new from that day. Not data loss, but a visible discontinuity. |
| `AUTH_SECRET`               | Every session is invalidated. Everyone signs in again.                                                                    |
| A signing private key       | Rotate the whole pair — see above. Nothing is lost.                                                                       |

---

## Running from source

For development, or to run the services under something other than Docker.
**Order matters, and one obvious order does not work**: the migration runners are
compiled output (`packages/*/dist/cli.js`), so they cannot run before the build.

```sh
git clone https://github.com/OpenLabs-so/openanalytics
cd openanalytics
pnpm install --frozen-lockfile

# 1. build FIRST — this is what produces the migration CLIs
pnpm run build

# 2. start the stores (or point the URLs at your own)
cd infra/selfhost && ./generate-secrets.sh --domain localhost --email you@example.com
docker compose up -d postgres clickhouse valkey-queue valkey-realtime
cd ../..

# 3. now the schemas
set -a; . ./infra/selfhost/env/migrate.env; set +a
pnpm run migrate:postgres
pnpm run migrate:clickhouse

# 4. the tracker bundle, budget enforced
pnpm run tracker:build     # -> apps/tracker/bundle/oa.js
```

Each service is then `node apps/<name>/dist/main.js` with **its own** environment
— see [Why there is no single `.env`](#why-there-is-no-single-env). The dashboard
is `pnpm --filter @openanalytics/web dev`.

The test suite, the way CI runs it:

```sh
pnpm run test       # unit + contract + tracker, no infrastructure needed
pnpm run verify     # everything CI checks, including boundaries and the size budget
```

---

## Troubleshooting

**A service exits immediately with a list of environment problems.** Read the
list: it reports every problem at once rather than one per restart. Two causes
cover almost all of it — a variable left blank instead of commented out, or a
secret in the wrong file (each service refuses secrets it must not hold, by
design). The message names the variable and which of the two it is.

**Everything is healthy but the dashboard shows nothing.** Check
`AUTH_TRUSTED_ORIGINS` in `env/api.env` — it must contain the dashboard's exact
origin. Unset or wrong, the api emits no CORS header and every browser call is
refused. The browser console will say so plainly.

**The dashboard talks to the wrong host.** The three `NEXT_PUBLIC_*` origins are
in `env/web.env`. They are compiled into the browser bundle, but the container
substitutes them into it at start, so fixing one is a recreate rather than a
rebuild: `docker compose up -d --force-recreate web`. The container logs the
three origins it started with on its first line — read that before assuming.

**The dashboard container will not start and says a variable is required.** That
is the same mechanism failing closed. All three origins must be set and each must
be a bare origin: scheme, host, optional port, no path and no trailing slash. A
dashboard that starts with the wrong origins looks like a working page and sends
every request somewhere else, which is why this exits instead.

**ClickHouse will not start after an edit.** A line beginning `oa-entrypoint:` is
the entrypoint refusing a value and naming it — fix and recreate. Otherwise the
server has rejected a `config.d` file it cannot parse; the classic cause is a
double hyphen inside an XML comment, which is not legal XML and which the server
refuses to merge rather than ignore.

**Events are accepted but never appear.** The collector answers `202` when the
event is durable in the _queue_; the worker moves it to ClickHouse. Check the
worker's log and the queue depth. If the queue is growing, the worker is not
draining — usually a ClickHouse credential or a missing grant on a new table.

**Site deletion never completes.** The worker needs
`CLICKHOUSE_MAINTENANCE_USER` and `CLICKHOUSE_MAINTENANCE_PASSWORD`, and the
`oa_maintenance` user must exist in ClickHouse — which needs a container
recreate, not a restart.

**Every country is Unknown, with a database loaded.** The collector logs
`geoip_loaded` or `geoip_not_configured` when it starts. If it loaded one and
still stores no country, look at the address it is handed: it looks up whatever
the proxy asserts in `X-Real-IP`, and a private address has no country. The
usual cause is IPv6. Docker forwards an IPv4 connection to a published port
with iptables, which keeps the visitor's address, but an IPv6 connection goes
through Docker's userland proxy and the container sees the bridge gateway
instead (`172.28.0.1` with this compose's default subnet, `172.18.0.1` on
Coolify). Every visitor on an IPv6 network then arrives as that one address.
Either drop the domain's `AAAA` records so everything arrives over IPv4, or
give the Docker network IPv6 as
[Docker's guide](https://docs.docker.com/engine/daemon/ipv6/) describes. A
visit from your own LAN or through a VPN is a private address too, and not a
bug. A proxy or CDN in front of Caddy hands over its own address instead; see
[Putting your own proxy in front](#putting-your-own-proxy-in-front).

---

## License

AGPL-3.0. If you run a modified OpenAnalytics as a network service, the license
requires you to offer your modified source to its users.

One exception: the browser tracker — everything under `apps/tracker/`, and the
`oa.js` it builds — is [MIT](apps/tracker/LICENSE). It is the file your visitors
download and the only part of the product that runs on your pages, so it carries
no copyleft. The bundle says so on its first line.

The "OpenAnalytics" name and the `getopen.so` domain identify the hosted service
run by its operators and are **not** part of the license grant. Self-hosted
instances run the software, not the brand.
