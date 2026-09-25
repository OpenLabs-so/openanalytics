# Changelog

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the numbers mean what [RELEASING.md](RELEASING.md) says they mean: while
the major is `0`, a minor is anything you might have to read this file before
taking.

Releases before 0.6.0 have their notes on the
[GitHub releases page](https://github.com/OpenLabs-so/openanalytics/releases).

## [Unreleased]

**Upgrade notes: only if you enabled the `object-storage` profile.** Create
`env/rustfs.env` from `env/rustfs.env.example`, start the profile, and create
the bucket and its CORS rule as `SELF-HOSTING.md`, "Object storage", shows.
Everyone else has nothing to do.

### Added

- **Postgres on Neon.** `infra/selfhost/NEON.md` walks a new install, and
  moving an existing one, onto [Neon](https://neon.com);
  `docker-compose.neon.yml` takes the bundled `postgres` service out of the
  stack. `snapshot.sh` and `rollback.sh` now handle a Postgres that is not on
  the host: the snapshot holds ClickHouse only and records the instant the
  stack stopped, and a restore stops with the stack down so Postgres can be
  restored to that instant first.

### Changed

- **The optional object storage is RustFS, not MinIO.** MinIO stopped
  publishing images — Docker Hub on 2026-09-16, then Quay on 2026-09-25 —
  so `docker compose --profile object-storage up` could no longer pull it.
  RustFS (`rustfs/rustfs:1.0.0`) passes the same object-storage suite CI runs.
  Unlike MinIO it does not open CORS to every origin, which is why the setup
  now includes a bucket CORS rule. The old `minio-data` volume is left in
  place and nothing reads it.

## [0.8.0] - 2026-09-19

**Upgrade notes: nothing by hand — and going back is a restore.**
`./upgrade.sh` as always. ClickHouse migration 0029 drops the ten hourly
rollup tables 0.7.0 stopped writing, so **returning to 0.7.0 is not a matter
of changing the image tag**: the older images would find those tables gone.
Go back with `./rollback.sh` to the snapshot the upgrade took. Skipping 0.7.0
(0.6.0 → 0.8.0) is supported: migrations 0025–0029 run in one pass and the
migrate container fills the fifteen-minute rollups from your raw events
afterwards, exactly as in 0.7.0. Details in `SELF-HOSTING.md`, "Upgrades and
going back".

### Fixed

- **No more false "history fill failed".** The fill that builds the
  fifteen-minute rollups from history now checks its result against the raw
  events instead of the frozen hourly tables. In 0.7.0, an event the worker
  delivered from its queue after the switch — with a timestamp inside the
  filled history — reached the new tables and the raw events but not the
  hourly ones, and the first start logged `history fill backfill-15m failed`
  with `additive_mismatch` over data that was correct. The check now fails
  only when the filled history disagrees with the raw events, and still
  allows the one quarter hour per site that the views had already started
  writing when the fill ran. The session rollups are checked against the
  session facts in the same way.
- **A site deletion started before an upgrade finishes after it.** A deletion
  records its list of tables when it starts; a table dropped by a later
  migration is now settled as empty instead of being retried forever.

### Removed

- **The hourly rollup tables.** `metrics_1h`, `pages_1h`, `sources_1h`,
  `geography_1h`, `devices_1h`, `custom_events_1h`, `performance_1h`,
  `custom_event_samples_1h`, `session_rollups_1h` and `revenue_1h`
  (ClickHouse migration 0029), with their ClickHouse grants and their entries
  in site deletion. Nothing has read them since 0.7.0; the daily tables stay.

## [0.7.0] - 2026-09-18

**Upgrade notes: nothing by hand, but the first start takes longer.**
`./upgrade.sh` as always. The migrate container then fills the new
fifteen-minute rollups from your history by itself — once, reading every raw
event, so on a large install the migrate step runs noticeably longer than
usual. A fill that fails is logged as `oa-migrate: history fill … failed`,
does not stop the stack, and is retried on the next `docker compose up -d`.
If the worker keeps running through the switch (a platform redeploy, or
`pull` and `up -d` without `./upgrade.sh`), the quarter hour in which the new
views are created counts only the events that arrived after that moment, and
the first start can log one `history fill backfill-15m failed` with
`additive_mismatch` (late events reach the new tables but not the frozen
hourly ones the fill checks against; the history is complete and the line
does not repeat; fixed in 0.8.0). The new rollups take up to four rows for
every hourly one.
The new ClickHouse grants arrive with the new image. Details in `SELF-HOSTING.md`, "Upgrades and
going back".

### Added

- **Every timezone.** Reports are assembled from fifteen-minute rollups
  instead of hourly ones, so a site can report on any IANA timezone,
  including those whose offset is not a whole hour — India (+05:30), Nepal
  (+05:45), Chatham (+12:45) — with local days, hours and daylight-saving days
  cut exactly. 0.6.0 refused those zones.
- **Every site has a reporting timezone.** It is set under Settings, General,
  and the dashboard, widgets, the share page, the MCP server and the assistant
  all read on it, so "today" means the same day to everyone on the team. A
  reader switches their own view from a timezone button in the dashboard
  header, which changes nothing for anybody else. Existing sites get their
  owner's account timezone, or UTC.
- **Site cards carry numbers.** The sites grid shows each site's all-time
  visitors, pageviews and, for an owner with a provider connected, revenue,
  with a line of weekly visitors. `GET /v1/sites` carries them, from one
  gateway query for all listed sites, cached for five minutes; three optional
  variables tune it (`SITES_CARD_*`).
- **A tag that cannot count says so.** A tag loaded on a host the site's
  allowed domains refuse — localhost, a preview or staging deployment — writes
  one line in the browser console naming the host, and the dashboard's waiting
  screens name the host it was seen on, with "Allow this domain" for a preview
  or staging host. `GET /v1/sites/{id}` carries `tag_sightings`.
- **Waiting for events.** A site that has never received an event says so: a
  badge beside the overview's heading opens the install itself, and Funnels
  and Realtime show the same state instead of zeros.

- **Five share posters.** The share button's poster is no longer only the
  overview: sources, countries, the people on the site right now and the top
  pages each have one, picked at the top of the preview, on the same card and
  in the same two themes. Each card hands the poster the rows it is showing,
  so the picture never disagrees with the screen. The site's name and its icon
  are separate switches; a list can drop its figures, its summary line or, on
  pages, its rank numbers.
- **Sharing from the poster.** Share copies the image and turns into X,
  Bluesky and LinkedIn, each opening a composer with a sentence about the
  poster; on a phone the system share sheet carries the image itself. `S`
  opens the share dialog from the overview.
- **AI referrals.** A card on the overview for the visits AI assistants
  send: ChatGPT, Claude, Perplexity, Gemini, Copilot and the rest, one row
  each, with their share of all visitors beside the title and the total in
  See all. A visit counts when the assistant is its referrer, or, when it
  arrived with no referrer at all, when the utm tag the assistant added names
  it, which is how a click from the ChatGPT apps is counted rather than
  filed under Direct. The public share board has the same card.
- **Devices, Browsers and OS in one card.** The three cuts of the devices
  read share one card with a picker in its header; it opens on Devices, which
  keeps its filter door. The freed slot is where AI referrals sits.

### Changed

- **`PATCH /v1/sites/{id}` refuses `reporting_timezone: null`** with a 400.
  Every site has a zone now, so there is no unset state to return to.
- The reporting timezone moved from the Widgets tab to Settings, General.
- The hourly rollup tables are no longer written. They stay as frozen
  history; a later release drops them.
- **Every service's log has a ceiling**: 3 files of 100 MB, in all three
  compose files. Docker's default never rotates.
- **Fewer metric lines.** Without a remote-write backend, an unchanged gauge
  is logged at most once a minute rather than on every tick; with one, the
  exporter is the only sink. The tracker's gzip budget is 10,240 B (+454 B for
  the host check).
- **The tracker is MIT.** `apps/tracker/` and the `oa.js` it builds now carry
  the MIT licence ([`apps/tracker/LICENSE`](apps/tracker/LICENSE)); the rest of
  the product stays AGPL-3.0. It is the one file that runs on your visitors'
  browsers rather than on the server, so embedding it should never have raised
  a copyleft question. The served bundle opens with a `/*! … MIT licensed … */`
  line saying so; +69 bytes gzipped.
- The poster's chart is drawn on a smooth curve with the dashboard's own glow,
  and the two brands no longer share one line: the site is the headline, the
  period sits in the corner, and Open Analytics signs on a small tab at the
  bottom edge. The dark poster is the tab bar's charcoal rather than black.
- The public share board folds Browsers and OS into one card with a picker,
  keeps Devices as its own card, and wears the dashboard's own live badge
  beside its heading.

### Fixed

- **The ClickHouse migration CLI reads `*_FILE` variables.** It parsed the
  environment itself, so `CLICKHOUSE_MIGRATION_PASSWORD_FILE` read as no
  password at all.
- **MinIO is pulled from Quay.** The `minio/minio` repository stopped
  resolving on Docker Hub, so `docker compose --profile object-storage up`
  failed with "pull access denied". The compose file now names
  `quay.io/minio/minio` at the same pinned tag. Only installs that enable the
  optional object-storage profile were affected; on 0.6.0 you can change the
  `image:` line in `infra/selfhost/docker-compose.yml` yourself.
- The add-site dialog no longer grows a beat after opening.
- **Sources rows are ranked by the number they show.** Referrers and the utm
  cuts were ordered by pageviews underneath while printing visitors, so a
  list could read 27, 2, 27, 18. They are ordered by visitors now, on the
  card, in See all, on the public board and on the poster.
- **Top pages reads in order.** The pages read ranks by views and the card
  shows visitors; when the gateway returns the whole set, the card now orders
  it by visitors. A capped set keeps the server's order until the server can
  rank by visitors.
- **The Coolify and Dokploy blueprints pin `v0.6.0`.** Both went out with the
  0.6.0 release still pinning the `v0.5.0` images, so a platform install of
  this release ran the previous one. `RELEASING.md` now lists every pin a
  release has to move.
- **Why every country can be Unknown, written down.** `SELF-HOSTING.md` still
  said the Coolify geo volume stays empty until you fill it, which stopped
  being true in 0.4.2. And no guide said that a visitor arriving over IPv6
  reaches the collector as the Docker bridge gateway and so gets no country;
  the troubleshooting section and both platform guides now do.
  ([#6](https://github.com/OpenLabs-so/openanalytics/issues/6))

### Coming later

The hourly rollup tables this release stops writing are dropped in a later
release; its notes will say what it asks of an install that skipped 0.7.0.

## [0.6.0] - 2026-09-05

**Upgrade notes: none.** `./upgrade.sh` and nothing else. The two ClickHouse
migrations in this release only add columns, and the migrate container applies
them while the upgrade runs.

### Added

- **Filters.** Clicking a row in Sources, Locations or the device cards keeps
  only the sessions that match it, and the overview re-reads with that filter
  applied. Four dimensions — source, country, city, device — combined with
  `and` across dimensions and `or` within one. What you picked shows as marks
  on the tab bar, each clearing on its own. A filtered view is rebuilt from raw
  events rather than read off a rollup, so it covers at most 92 days; past that
  the cards offer to shorten the range or drop the filters. The same grammar
  serves the dashboard, `/v1/read` and MCP, so they cannot drift.
- **Entries and exits.** Top Pages carries entrances, exits and a bounce rate
  per path, and can be ranked by any of them. The ranking is a question put to
  the server rather than a re-sort of the rows on screen.
- **Click ids as sources.** `gclid`, `fbclid`, `msclkid` and their companions
  name the ad network a visit came from when the referrer does not.
- **`?ref=` names a source.** A link you control can carry `?ref=twitter` or
  `?ref=newsletter`, and visits that would have read as Direct get that name
  instead. Known names fold onto the site they mean; anything else is kept as
  written. A referrer the browser did send always wins.
- **Polar as a revenue provider.** A second provider a site can connect
  alongside Stripe, with Standard Webhooks signature verification.
- **Umami import.** An adapter for Umami exports, and one archive entry may now
  fill several reports.
- **Overview poster.** A share button turns the numbers on screen into an
  image — the site's mark, the period, the headline figures and the traffic
  curve — as a PNG or on the clipboard. It draws from what the board already
  has, so it cannot disagree with the screen it was made from.
- **Realtime names who is here.** The overview's realtime card lists the
  visitors present rather than the paths that are busy, and a live badge sits
  beside the Overview and Realtime titles.
- **MCP hints.** Every tool spells out its hints, native-app redirect URIs are
  accepted, and a root `.mcp.json` points at the hosted server.
- **Dokploy.** The blueprint ships with an import config and a copyable raw
  link beside it.
- Documentation for the dashboard: what each headline metric counts, what each
  breakdown is a cut of, how filters behave, and how to tag your own links.

### Changed

- **The tracker stands down for a site that is gone.** A `404` from the config
  read is a gone-marker, and `collection_paused` carries a body and an ETag;
  the tracker obeys both and stops asking.
- Squircle cards fall back to rounder corners on engines without
  `corner-shape`, and to a plain radius where even that is unsupported.

### Fixed

- **Email.** A rate limit is retryable and a bad address is not, so a `429` no
  longer burns an address; a stranger's typo no longer becomes a page. A
  terminal failure is recorded as `failed`.
- **Ingest.** The finalizer window is bounded, the outbox is leased and
  reclaimed rather than raced, the backlog carries an `available_at`, and the
  queue publishes its own metrics.
- **Realtime.** A refusal is believed only once a fresh token has been refused
  too, so an expired token no longer reads as a revoked one.
- **Shared reports.** Percentages are shares of the total rather than of the
  biggest row.

### Coming in 0.7.0

Fifteen-minute rollups, which serve every timezone including the half- and
quarter-hour ones (+05:30, +05:45), with a one-time backfill the upgrader runs
for you.
