import { serve } from '@hono/node-server'
import {
  createClickhouseMaintenance,
  createExportReader,
  createImportedAggregatesMaintenance,
  createImportedAggregatesWriter,
  createRevenueAttributionsStore,
  createRevenueEventsStore,
  createRevenueRollupsStore,
} from '@openanalytics/clickhouse'
import {
  createImportAdapterRegistry,
  createRevenueAdapterRegistry,
  plausibleImportAdapter,
  umamiImportAdapter,
} from '@openanalytics/domain'
import {
  CredentialKeyringError,
  createCredentialVault,
  createDodoRevenueAdapter,
  createS3ObjectStorage,
  createPolarRevenueAdapter,
  createStripeRevenueAdapter,
} from '@openanalytics/integrations'
import { createServiceMetrics } from '@openanalytics/observability'
import { createDatabase, createPool, filterFinalizableSites } from '@openanalytics/postgres'
import { createQueueClient, createRealtimeCache } from '@openanalytics/redis'
import { bootstrapService } from './bootstrap.ts'
import { createApp } from './app.ts'
import { startBackupWatch } from './backup-watch.ts'
import { startEmailDrain } from './email-drain.ts'
import { workerDrains, type WorkerDrain } from './cloud-extension.ts'
import { startJobRunner } from './jobs/runner.ts'
import { startLifecycleSweeper } from './lifecycle/sweeper.ts'
import { startOutboxDispatcher } from './outbox-dispatcher.ts'
import { startRealtimeRevocationDrain } from './realtime-revocation-drain.ts'
import { startCurrencyRates } from './revenue/currency-rates.ts'
import { startRevenueAttribution } from './revenue/attribute.ts'
import { startRevenueProjection } from './revenue/project.ts'
import { startRevenueReconcile } from './revenue/reconcile.ts'
import { consumerNameFor, startIngest } from './ingest/index.ts'

/**
 * Worker entrypoint.
 *
 * Shutdown is deliberately two-phase. Docs snapshot 02 §7.5: an in-flight batch
 * must reach a decided state before the process exits — a batch abandoned
 * mid-flight leaves a manifest that a later reclaim has to reason about. The
 * consumer loop added in Milestone 6 hooks into `onShutdown` to stop claiming
 * new messages and drain what it already holds.
 */

const { env, logger, service } = bootstrapService()
const app = createApp({ env, logger, service })

const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  logger.info('service_started', { port: info.port })
})

const shutdownHooks: (() => Promise<void>)[] = []

export function onShutdown(hook: () => Promise<void>): void {
  shutdownHooks.push(hook)
}

// Email delivery drains the outbox (docs snapshot 02 §5). It needs a database;
// without one the worker still runs its other jobs and serves health.
if (env.DATABASE_URL) {
  const pool = createPool(env.DATABASE_URL)
  const db = createDatabase(pool)
  const drain = startEmailDrain({ env, logger, db })

  /**
   * The loops a registered surface adds (`cloud-extension.ts`).
   *
   * Started here, beside the email drain, because that is where the telegram
   * drain was: its own topic and its own loop, so a Bot API outage cannot slow a
   * magic link (docs snapshot 02 §6 shape). Each is stopped in the shutdown
   * sequence below, which is the reason this registry exists at all.
   */
  const registeredDrains: WorkerDrain[] = []
  for (const registration of workerDrains()) {
    registeredDrains.push(registration.start({ db, env, logger }))
    logger.info('worker_drain_started', { drain: registration.name })
  }

  // Durable realtime revocation drain (docs snapshot 02 §17, 05 D-213): replays
  // the epoch bump the api enqueued in-transaction until the realtime cache acks.
  // Needs that cache; inside the private network it is a native worker-mode
  // connection (like the ingest usage-counter client). Without the cache URL the
  // worker still runs its other jobs — the api's immediate bump remains the
  // best-effort path — so the row simply waits until the worker has a cache again.
  let realtimeCacheClient: ReturnType<typeof createQueueClient> | undefined
  let realtimeCache: ReturnType<typeof createRealtimeCache> | undefined
  let revocationDrain: ReturnType<typeof startRealtimeRevocationDrain> | undefined
  if (env.REALTIME_CACHE_REDIS_URL) {
    realtimeCacheClient = createQueueClient({
      mode: 'worker',
      url: env.REALTIME_CACHE_REDIS_URL,
      connectionName: `worker-revocation-${service.version}`,
      onError: (error) =>
        logger.warn('realtime_cache_socket_error', { err: error, retryable: true }),
    })
    realtimeCache = createRealtimeCache({
      client: realtimeCacheClient,
      eventMaxLatenessHours: env.EVENT_MAX_LATENESS_HOURS,
    })
    revocationDrain = startRealtimeRevocationDrain({
      db,
      cache: realtimeCache,
      logger,
    })
    logger.info('realtime_revocation_drain_started', {})
  } else {
    logger.warn('realtime_revocation_drain_not_started', {
      reason: 'REALTIME_CACHE_REDIS_URL missing',
    })
  }

  // One metrics pipeline for the whole process, so the jobs below report under
  // the same instance label rather than one series per subsystem. The label is
  // the ingest consumer identity, which is already unique per process.
  const consumerName = consumerNameFor(env)
  const serviceMetrics = createServiceMetrics({
    env,
    logger,
    service: 'worker',
    instance: consumerName,
  })

  // The generic outbox dispatcher (docs snapshot 02 §5). Postgres-only, so it
  // runs wherever the email drain does — and it is what stops the three topics
  // nobody consumed from accumulating for good.
  // The same cache instance the revocation drain uses: the block handler bumps
  // the site-level epoch (ADR-0030, decision 5) through it. Undefined without
  // REALTIME_CACHE_REDIS_URL, in which case the handler logs and continues —
  // the read closure holds without it, only the immediate stream cut is missed.
  const outbox = startOutboxDispatcher({
    db,
    logger,
    metrics: serviceMetrics.metrics,
    policy: { productName: env.PRODUCT_NAME },
    realtimeCache,
  })

  // The stores the site-deletion executor purges (ADR-0030, decision 4).
  //
  // Each is wired only when its credential is present, and the executor treats
  // an absent one as "come back later" rather than as a failure. That is what
  // lets the worker boot on a host where the ClickHouse `oa_maintenance` user
  // has not been provisioned yet — a queued deletion simply waits for the
  // container recreate instead of taking email delivery and ingest down with it.
  //
  // The queue instance is a SECOND connection rather than the ingest loop's: the
  // consumer client is inside a blocking `XREADGROUP` most of the time, and
  // issuing a purge's `LRANGE`/`XDEL` on it would either queue behind the block
  // or interleave with the consumer's own protocol state. D-205 already keeps
  // the queue and the realtime cache on separate instances, so the purge needs
  // one client per instance regardless.
  let deletionQueueClient: ReturnType<typeof createQueueClient> | undefined
  if (env.EVENT_STREAM_REDIS_URL) {
    deletionQueueClient = createQueueClient({
      mode: 'worker',
      url: env.EVENT_STREAM_REDIS_URL,
      connectionName: `worker-deletion-${service.version}`,
      onError: (error) =>
        logger.warn('deletion_queue_socket_error', { err: error, retryable: true }),
    })
  }

  const clickhouseMaintenance =
    env.CLICKHOUSE_URL && env.CLICKHOUSE_MAINTENANCE_USER && env.CLICKHOUSE_MAINTENANCE_PASSWORD
      ? createClickhouseMaintenance({
          url: env.CLICKHOUSE_URL,
          database: env.CLICKHOUSE_DB,
          username: env.CLICKHOUSE_MAINTENANCE_USER,
          password: env.CLICKHOUSE_MAINTENANCE_PASSWORD,
        })
      : undefined
  if (!clickhouseMaintenance) {
    logger.warn('clickhouse_maintenance_not_configured', {
      reason: 'CLICKHOUSE_URL/CLICKHOUSE_MAINTENANCE_USER/CLICKHOUSE_MAINTENANCE_PASSWORD missing',
    })
  }

  // The object storage bucket (ADR-0032, D1). All five variables or none: a
  // partial block cannot address anything, and building a client from it would
  // turn a configuration mistake into a runtime error inside a purge phase.
  // Absent it, `object_purge` waits for a site that actually has objects and
  // completes trivially for one that does not, and the import sweep fails an
  // expired run without deleting its archive — the bucket's own lifecycle rule
  // reaps that one.
  const objectStorage =
    env.OBJECT_STORAGE_ENDPOINT &&
    env.OBJECT_STORAGE_REGION &&
    env.OBJECT_STORAGE_BUCKET &&
    env.OBJECT_STORAGE_ACCESS_KEY_ID &&
    env.OBJECT_STORAGE_SECRET_ACCESS_KEY
      ? createS3ObjectStorage({
          endpoint: env.OBJECT_STORAGE_ENDPOINT,
          region: env.OBJECT_STORAGE_REGION,
          bucket: env.OBJECT_STORAGE_BUCKET,
          accessKeyId: env.OBJECT_STORAGE_ACCESS_KEY_ID,
          secretAccessKey: env.OBJECT_STORAGE_SECRET_ACCESS_KEY,
        })
      : undefined
  if (!objectStorage) {
    logger.warn('object_storage_not_configured', {
      reason: 'OBJECT_STORAGE_ENDPOINT/_REGION/_BUCKET/_ACCESS_KEY_ID/_SECRET_ACCESS_KEY missing',
    })
  }

  // The import staging path (ADR-0032, D2/D7). Two clients, because two
  // credentials: `oa_ingest` inserts and cannot delete, `oa_maintenance` deletes
  // and cannot insert. One object holding both would be one object that can
  // rewrite a customer's analytics history.
  //
  // Deploy note: `oa_ingest` was narrowed to an exact table list, so the eight
  // `imported_*` tables of ClickHouse migration 0015 must be added to its grant
  // before staging can write. A missing grant surfaces as an infrastructure
  // retry, not as a failed run — the import waits for the grant rather than
  // telling a customer their archive is broken.
  const importedAggregatesWriter =
    env.CLICKHOUSE_URL && env.CLICKHOUSE_INGEST_USER && env.CLICKHOUSE_INGEST_PASSWORD
      ? createImportedAggregatesWriter({
          url: env.CLICKHOUSE_URL,
          database: env.CLICKHOUSE_DB,
          username: env.CLICKHOUSE_INGEST_USER,
          password: env.CLICKHOUSE_INGEST_PASSWORD,
        })
      : undefined
  const importedAggregatesMaintenance =
    env.CLICKHOUSE_URL && env.CLICKHOUSE_MAINTENANCE_USER && env.CLICKHOUSE_MAINTENANCE_PASSWORD
      ? createImportedAggregatesMaintenance({
          url: env.CLICKHOUSE_URL,
          database: env.CLICKHOUSE_DB,
          username: env.CLICKHOUSE_MAINTENANCE_USER,
          password: env.CLICKHOUSE_MAINTENANCE_PASSWORD,
        })
      : undefined

  // The export read path (ADR-0032, D8). A third ClickHouse client on the
  // *maintenance* credential, which already holds `SELECT` on `analytics.*` --
  // so this adds no environment variable and no grant. It is a separate client
  // rather than a method on the maintenance one because it streams with a
  // five-minute request timeout and two output-format settings a mutation poll
  // must not inherit.
  const exportReader =
    env.CLICKHOUSE_URL && env.CLICKHOUSE_MAINTENANCE_USER && env.CLICKHOUSE_MAINTENANCE_PASSWORD
      ? createExportReader({
          url: env.CLICKHOUSE_URL,
          database: env.CLICKHOUSE_DB,
          username: env.CLICKHOUSE_MAINTENANCE_USER,
          password: env.CLICKHOUSE_MAINTENANCE_PASSWORD,
        })
      : undefined

  // The two production adapters (ADR-0032 D11: the four remaining catalog
  // entries are follow-up sub-parts behind the same framework, and the catalog
  // reports them `available: false`). A run naming any of them still fails
  // `adapter_unavailable`, which is the honest answer for a build with no parser
  // rather than a half-import.
  //
  // **This list and the catalog's `available` flags must ship together.** The
  // api serves the catalog, so an api ahead of a worker lets a customer create a
  // run that then fails `adapter_unavailable`; a worker ahead of an api is
  // harmless, because the catalog still says the provider is unavailable and
  // nothing creates the run. That is the deploy order for every future adapter.
  //
  // The registry is composed at startup rather than read from a module singleton
  // so that a test drives the pipeline with exactly the adapter it means to
  // exercise.
  const importAdapters = createImportAdapterRegistry([plausibleImportAdapter, umamiImportAdapter])

  /**
   * The revenue sync wiring (ADR-0033, D3/D4).
   *
   * Fail-closed on the keyring, the billing precedent: no usable secret, no
   * surface, one warn log. A malformed ring is a *warning rather than a boot
   * failure* for the reason every other credential here is optional — the worker
   * also delivers email, ingests events and runs deletions, and refusing to
   * start over a revenue secret would take all of that down with it. The
   * backfill job returns a counting retry without it and the two loops below
   * simply do not start.
   *
   * The parse is caught rather than propagated because `createCredentialVault`
   * throws a *typed* error whose reason names the problem without naming any key
   * material — which is the whole point of it being typed, and is the one line
   * an operator reads to fix a mis-set variable.
   */
  const revenue = (():
    | {
        vault: ReturnType<typeof createCredentialVault>
        adapters: ReturnType<typeof createRevenueAdapterRegistry>
      }
    | undefined => {
    if (!env.OA_CREDENTIAL_KEYRING) {
      logger.warn('revenue_sync_not_started', { reason: 'OA_CREDENTIAL_KEYRING missing' })
      return undefined
    }
    try {
      return {
        vault: createCredentialVault(env.OA_CREDENTIAL_KEYRING),
        // Composed at startup rather than read from a module singleton, so a
        // test drives the pipeline with exactly the adapter it means to exercise
        // and production has one place where a real adapter is switched on.
        adapters: createRevenueAdapterRegistry([
          createStripeRevenueAdapter(),
          createPolarRevenueAdapter(),
          createDodoRevenueAdapter(),
        ]),
      }
    } catch (error) {
      logger.error('revenue_sync_not_started', {
        reason: error instanceof CredentialKeyringError ? error.reason : 'keyring_unusable',
        retryable: false,
      })
      return undefined
    }
  })()

  const revenueResources = revenue
    ? {
        vault: revenue.vault,
        adapters: revenue.adapters,
        policy: {
          backfillDays: env.REVENUE_BACKFILL_DAYS,
          pageSize: env.REVENUE_SYNC_PAGE_SIZE,
          reconcileWindowHours: env.REVENUE_RECONCILE_WINDOW_HOURS,
        },
      }
    : undefined

  // The job runner (ADR-0030, decision 3). `claimed_by` is the ingest consumer
  // identity, which is already unique per process — a lease has to name a holder
  // that another process cannot be mistaken for, and inventing a second identity
  // would mean two names for one worker in the operator's logs.
  const jobs = startJobRunner({
    db,
    logger,
    metrics: serviceMetrics.metrics,
    claimedBy: consumerName,
    policy: {
      leaseTtlMs: env.WORKER_LEASE_TTL_MS,
      maxAttempts: env.JOB_MAX_ATTEMPTS,
      retryBaseMs: env.WORKER_RETRY_BASE_MS,
      retryMaxMs: env.WORKER_RETRY_MAX_MS,
    },
    resources: {
      queue: deletionQueueClient,
      // The same connection the revocation drain uses. Both only ever issue
      // short commands on it, and a third client for the same instance would be
      // one more socket to operate for no isolation gain.
      realtime: realtimeCacheClient,
      clickhouse: clickhouseMaintenance,
      objectStorage,
      deletionPolicy: {
        siteQueueIndexTtlDays: env.SITE_QUEUE_INDEX_TTL_DAYS,
        ingestConfigCacheTtlSeconds: env.INGEST_CONFIG_CACHE_TTL_SECONDS,
        deletionAcceptanceMarginMs: env.DELETION_ACCEPTANCE_MARGIN_MS,
        ceilingAlertConsecutiveDays: env.SITE_CEILING_ALERT_CONSECUTIVE_DAYS,
        leaseTtlMs: env.WORKER_LEASE_TTL_MS,
      },
      importedAggregatesWriter,
      importedAggregatesMaintenance,
      importAdapters,
      importPolicy: {
        maxArchiveBytes: env.IMPORT_MAX_ARCHIVE_BYTES,
        maxEntries: env.IMPORT_MAX_ENTRIES,
        maxEntryBytes: env.IMPORT_MAX_ENTRY_BYTES,
        maxTotalUncompressedBytes: env.IMPORT_MAX_TOTAL_UNCOMPRESSED_BYTES,
        maxRowBytes: env.IMPORT_MAX_ROW_BYTES,
        stagingChunkBytes: env.IMPORT_STAGING_CHUNK_BYTES,
        uploadTtlDays: env.IMPORT_UPLOAD_TTL_DAYS,
      },
      exportReader,
      exportPolicy: {
        maxChunkBytes: env.EXPORT_MAX_CHUNK_BYTES,
        objectTtlDays: env.EXPORT_OBJECT_TTL_DAYS,
        // The same value the runner's own policy above holds. The export's lease
        // heartbeat is measured against it, so the two must not be able to drift.
        leaseTtlMs: env.WORKER_LEASE_TTL_MS,
      },
      revenue: revenueResources,
    },
  })

  // The revenue reconcile sweep and the ECB rate loop (ADR-0033, D2c/D4). Both
  // start only with a usable keyring — the sweep because it decrypts a
  // customer's provider key on every pass, and the rate loop for a different
  // reason worth stating: it needs no secret at all, but rates with no revenue
  // facts to convert are a daily request to a public web server for nobody. It
  // starts with the rest of the revenue surface so the table is warm the moment
  // CP3 needs it.
  const revenueReconcile = revenueResources
    ? startRevenueReconcile({
        db,
        logger,
        metrics: serviceMetrics.metrics,
        revenue: revenueResources,
        staleMinutes: env.REVENUE_RECONCILE_STALE_MINUTES,
        batchSize: env.REVENUE_RECONCILE_BATCH,
      })
    : undefined
  const currencyRates = revenueResources
    ? startCurrencyRates({
        db,
        logger,
        metrics: serviceMetrics.metrics,
        intervalMs: env.REVENUE_CURRENCY_REFRESH_HOURS * 3_600_000,
      })
    : undefined

  /**
   * The revenue projection loop (ADR-0033, D5; ClickHouse migration 0016). CP3.
   *
   * Two credentials and no keyring. It reads object heads out of Postgres and
   * writes facts to ClickHouse on `oa_ingest`, so it needs neither the vault nor
   * an adapter — which is why it is wired independently of `revenueResources`
   * rather than beside the sweep. A deployment whose keyring is missing still
   * projects whatever heads it already holds, which is the right behaviour: the
   * facts are already ours, the keyring only fetches more.
   *
   * `ANONYMOUS_IDENTITY_SECRET` is the new requirement and the reason this can
   * be absent (D6 amendment). Without it `external_user_hash` could not be the
   * `identify()` derivation byte for byte, and a fact carrying a *different*
   * hash would be worse than no fact at all — it would join against nothing
   * while looking exactly like a value that should. So the loop does not start,
   * one warning is logged, and the heads wait: `projected_version` is a durable
   * marker, so nothing is lost by starting a day later.
   *
   * Deploy note: `oa_ingest` was narrowed to an exact table list (ADR-0013), so
   * `revenue_events` must be added to its grant through the ClickHouse
   * entrypoint XML and a container **recreate** before this loop can write.
   * Until then every tick counts `worker_revenue_projection_failed{reason=insert}`
   * and marks nothing — an infrastructure wait, not data loss.
   */
  const revenueEventsStore =
    env.CLICKHOUSE_URL && env.CLICKHOUSE_INGEST_USER && env.CLICKHOUSE_INGEST_PASSWORD
      ? createRevenueEventsStore({
          url: env.CLICKHOUSE_URL,
          database: env.CLICKHOUSE_DB,
          username: env.CLICKHOUSE_INGEST_USER,
          password: env.CLICKHOUSE_INGEST_PASSWORD,
        })
      : undefined

  const revenueProjection =
    revenueEventsStore && env.ANONYMOUS_IDENTITY_SECRET
      ? startRevenueProjection({
          db,
          logger,
          metrics: serviceMetrics.metrics,
          store: revenueEventsStore,
          identityKey: {
            secret: env.ANONYMOUS_IDENTITY_SECRET,
            keyVersion: env.ANONYMOUS_IDENTITY_KEY_VERSION,
          },
        })
      : undefined
  /**
   * The attribution job (ADR-0033, D6; ClickHouse 0017, Postgres 0036). CP4.
   *
   * Gated on exactly what the projection is gated on, and for the identical
   * reason: it needs the `oa_ingest` ClickHouse credential and it needs
   * `ANONYMOUS_IDENTITY_SECRET`, because a checkout hint's
   * `client_reference_id` has to be hashed with the `identify()` derivation byte
   * for byte or the join against `session_facts_versions.user_id` matches
   * nothing while looking entirely reasonable. Without either, the loop does not
   * start and one warning is logged — the charges wait, and `computed_through`
   * being a durable watermark means nothing is lost by starting a day later.
   *
   * Deploy note: `oa_ingest` needs INSERT and SELECT on `revenue_attributions`
   * through the ClickHouse entrypoint XML and a container **recreate**, exactly
   * as `revenue_events` did in CP3.
   */
  const revenueAttributionsStore =
    env.CLICKHOUSE_URL && env.CLICKHOUSE_INGEST_USER && env.CLICKHOUSE_INGEST_PASSWORD
      ? createRevenueAttributionsStore({
          url: env.CLICKHOUSE_URL,
          database: env.CLICKHOUSE_DB,
          username: env.CLICKHOUSE_INGEST_USER,
          password: env.CLICKHOUSE_INGEST_PASSWORD,
        })
      : undefined

  /**
   * The revenue rollup swap targets (ADR-0033, D7; ClickHouse 0018). CP5.
   *
   * Gated with the attribution job rather than on its own, because the rollup is
   * a STEP of that job (`apps/worker/src/revenue/rollup.ts` gives the four
   * reasons). Deploy note: `oa_ingest` needs INSERT and SELECT on `revenue_15m`
   * and `revenue_1d` through the ClickHouse entrypoint XML and a container
   * **recreate**, exactly as `revenue_events` and `revenue_attributions` did.
   */
  const revenueRollupsStore =
    env.CLICKHOUSE_URL && env.CLICKHOUSE_INGEST_USER && env.CLICKHOUSE_INGEST_PASSWORD
      ? createRevenueRollupsStore({
          url: env.CLICKHOUSE_URL,
          database: env.CLICKHOUSE_DB,
          username: env.CLICKHOUSE_INGEST_USER,
          password: env.CLICKHOUSE_INGEST_PASSWORD,
        })
      : undefined

  const revenueAttribution =
    revenueAttributionsStore &&
    revenueEventsStore &&
    revenueRollupsStore &&
    env.ANONYMOUS_IDENTITY_SECRET
      ? startRevenueAttribution({
          db,
          logger,
          metrics: serviceMetrics.metrics,
          store: revenueAttributionsStore,
          facts: revenueEventsStore,
          rollups: revenueRollupsStore,
          identityKey: {
            secret: env.ANONYMOUS_IDENTITY_SECRET,
            keyVersion: env.ANONYMOUS_IDENTITY_KEY_VERSION,
          },
          // The same lifecycle fence the session finalizer uses: a site being
          // deleted still has revenue objects right up until `postgres_purge`,
          // and attributing it would write rows into a table
          // `clickhouse_purge` has already verified as empty.
          filterAttributable: (siteIds) => filterFinalizableSites(db, siteIds),
          claimedBy: consumerName,
          latenessMs: env.EVENT_MAX_LATENESS_HOURS * 60 * 60 * 1000,
        })
      : undefined
  if (!revenueAttribution) {
    logger.warn('revenue_attribution_not_started', {
      reason: revenueAttributionsStore
        ? 'ANONYMOUS_IDENTITY_SECRET missing'
        : 'CLICKHOUSE_URL/CLICKHOUSE_INGEST_USER/CLICKHOUSE_INGEST_PASSWORD missing',
    })
  }

  if (!revenueProjection) {
    logger.warn('revenue_projection_not_started', {
      reason: revenueEventsStore
        ? 'ANONYMOUS_IDENTITY_SECRET missing'
        : 'CLICKHOUSE_URL/CLICKHOUSE_INGEST_USER/CLICKHOUSE_INGEST_PASSWORD missing',
    })
  }

  // The lifecycle sweeper (ADR-0030, decision 2): the deadlines no event
  // announces. It writes through the same paths the webhook and the API do, so
  // it needs nothing but the database.
  const lifecycle = startLifecycleSweeper({
    db,
    logger,
    metrics: serviceMetrics.metrics,
    pageSize: env.LIFECYCLE_SWEEP_PAGE_SIZE,
    intervalMs: env.LIFECYCLE_SWEEP_INTERVAL_MS,
    // The abandoned-upload duty (ADR-0032, D7). The TTL is always present — it
    // is a policy value with a default — so this duty is always on; the bucket
    // is not, and without it the sweep still frees the site's import slot.
    importUploadTtlDays: env.IMPORT_UPLOAD_TTL_DAYS,
    ...(objectStorage ? { objectStorage } : {}),
    // The terminal-run cleanup backstop (ADR-0032, D7). Without the credential
    // the duty defers rather than skips — a run marked clean whose rows are
    // still there would be a leak with a note saying it was handled.
    ...(importedAggregatesMaintenance ? { importedAggregatesMaintenance } : {}),
  })

  // The off-host backup watcher (ADR-0052, D10). It runs here because the
  // ClickHouse VM has no metrics pipeline and this process already has both the
  // bucket credentials and the push to Grafana Cloud. Without the bucket it
  // does not start — and says so, because a silent absence is exactly the
  // failure shape this alert exists to rule out.
  const backupWatch = objectStorage
    ? startBackupWatch({ storage: objectStorage, logger, metrics: serviceMetrics.metrics })
    : null
  if (!backupWatch) {
    logger.warn('backup_watch_not_started', { reason: 'OBJECT_STORAGE_* missing' })
  }

  // Batch ingest is the worker's other half (docs snapshot 02 §7.5). It needs
  // the queue and ClickHouse as well as the database, and returns null without
  // them rather than starting a consumer that could take delivery of events it
  // has no way to store.
  const ingest = startIngest({
    env,
    logger,
    db,
    metrics: serviceMetrics.metrics,
    consumerName,
  })

  onShutdown(async () => {
    // Ingest first: it is the path with in-flight work that has to reach a
    // decided state, and it needs the pool to do it.
    await ingest?.stop()
    // The sweeper before the runner: it only ever *enqueues*, so stopping it
    // first means no new job arrives while the runner is draining the ones it
    // holds. The runner next, because a job mid-execution owns a lease and must
    // reach a settled state — otherwise it waits out the whole TTL before any
    // worker can pick it up again.
    await lifecycle.stop()
    // Before the runner, for the sweeper's reason: the sweep is the other
    // producer of revenue writes, and stopping it first means the runner drains
    // a set of jobs nothing is still adding provider traffic beside.
    await revenueReconcile?.stop()
    await currencyRates?.stop()
    // After the sweep, for the sweep's own reason one level down: the sweep is
    // what produces new object heads, so stopping it first means the projection
    // drains a set nothing is still adding to.
    await revenueProjection?.stop()
    // After the projection, one level further down the same chain: the
    // projection is what produces the facts attribution reads, so stopping it
    // first means attribution drains a set nothing is still adding to.
    await revenueAttribution?.stop()
    await jobs.stop()
    await drain.stop()
    for (const registered of registeredDrains) await registered.stop()
    await outbox.stop()
    await revocationDrain?.stop()
    // Observes only; nothing waits on it, so it stops wherever it is.
    await backupWatch?.stop()
    // After every job, so the last tick's counters make the final push.
    await serviceMetrics.stop()
    await clickhouseMaintenance?.close()
    await importedAggregatesWriter?.close()
    await importedAggregatesMaintenance?.close()
    await exportReader?.close()
    await revenueEventsStore?.close()
    await revenueAttributionsStore?.close()
    await revenueRollupsStore?.close()
    await deletionQueueClient?.quit()
    await realtimeCacheClient?.quit()
    await pool.end()
  })
  logger.info('email_drain_started', {})
  logger.info('outbox_dispatcher_started', {})
  logger.info('job_runner_started', {})
  logger.info('lifecycle_sweeper_started', { interval_ms: env.LIFECYCLE_SWEEP_INTERVAL_MS })
  if (revenueResources) {
    logger.info('revenue_sync_started', {
      backfill_days: env.REVENUE_BACKFILL_DAYS,
      reconcile_window_hours: env.REVENUE_RECONCILE_WINDOW_HOURS,
      stale_minutes: env.REVENUE_RECONCILE_STALE_MINUTES,
    })
  }
} else {
  logger.warn('email_drain_not_started', { reason: 'DATABASE_URL missing' })
}

let shuttingDown = false

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  logger.info('service_stopping', { signal })

  // Stop accepting probes first, then drain in-flight work.
  server.close()

  for (const hook of shutdownHooks) {
    try {
      await hook()
    } catch (err) {
      logger.error('shutdown_hook_failed', { err, retryable: false })
    }
  }

  process.exit(0)
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
