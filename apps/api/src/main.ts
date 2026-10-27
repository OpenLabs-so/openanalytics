import { serve } from '@hono/node-server'
import type { Auth } from '@openanalytics/auth'
import {
  createRevenueAdapterRegistry,
  loadAssistantConfig,
  loadPublicDashboardConfig,
  loadReadCostConfig,
  loadReadKeyConfig,
  loadWidgetReadConfig,
} from '@openanalytics/domain'
import {
  CredentialKeyringError,
  createCredentialVault,
  createOpenAiChatClient,
  createDodoRevenueAdapter,
  createS3ObjectStorage,
  createPolarRevenueAdapter,
  createStripeRevenueAdapter,
  type CredentialVault,
  type ObjectStorage,
  type OpenAiChatClient,
} from '@openanalytics/integrations'
import { createServiceMetrics } from '@openanalytics/observability'
import {
  INGEST_PIPELINE_ID,
  createDatabase,
  createPool,
  getWorkerHeartbeat,
  type Database,
} from '@openanalytics/postgres'
import { createRealtimeCache, createRealtimeCacheClient } from '@openanalytics/redis'
import type { Pool } from 'pg'
import { createApiAuth } from './auth.ts'
import { createApp, readSurfaceRateLimiter } from './app.ts'
import { apiCloudExtension } from './cloud-extension.ts'
import { AnalyticsService } from './analytics/service.ts'
import { bootstrapService } from './bootstrap.ts'
import { HttpAnalyticsGateway } from './gateway-client.ts'
import { SiteCardStatsReader } from './analytics/site-cards.ts'
import { InProcessRateLimiter } from './http/rate-limit.ts'

const { env, logger, service } = bootstrapService()

// G-006 remote-write, with the structured-log floor underneath (ADR-0010,
// ADR-0015: every service is long-lived now, so each flushes its own
// counters). Instance is stable per process and hostname-free.
const serviceMetrics = createServiceMetrics({
  env,
  logger,
  service: service.name,
  instance: `${service.name}-${service.commit}`,
})

// The business surface needs both a database and a session secret. When either
// is absent the service still starts with only `/health` (the Milestone 0
// startup contract), rather than crashing a deploy that has not been given a
// database.
let pool: Pool | undefined
let auth: Auth | undefined
let db: Database | undefined
if (env.DATABASE_URL && env.AUTH_SECRET) {
  pool = createPool(env.DATABASE_URL)
  db = createDatabase(pool)
  auth = createApiAuth({ env, db, metrics: serviceMetrics.metrics })
  logger.info('auth_mounted', {})
} else {
  logger.warn('auth_not_mounted', { reason: 'DATABASE_URL or AUTH_SECRET missing' })
}

/**
 * The optional HTTP surfaces this build mounts (`cloud-extension.ts`).
 *
 * This is where the Stripe block used to be — a secret key, a webhook secret and
 * the six price ids, assembled here and threaded into `createApp` as
 * `deps.billing`. A registered extension now builds its own provider client from
 * its own schema, and this file names no provider at all: it reads a registry
 * that is empty unless `main.cloud.ts` was the entry point.
 */
const cloud = apiCloudExtension()
if (cloud) {
  logger.info('cloud_extension_mounted', { extension: cloud.name })
}

// Analytics read mounts only when the signed gateway is fully configured: its
// URL, the Ed25519 signing key and the key id. Without them the /analytics and
// /public surfaces stay off rather than half-wired (the optional-until-used
// rule); the API never reaches ClickHouse except through this signed hop (D-208).
let analytics: AnalyticsService | undefined
let siteCards: SiteCardStatsReader | undefined
if (env.QUERY_GATEWAY_URL && env.QUERY_SIGNING_PRIVATE_KEY && env.QUERY_SIGNING_KEY_ID) {
  const gateway = new HttpAnalyticsGateway({
    gatewayUrl: env.QUERY_GATEWAY_URL,
    privateKeyPem: env.QUERY_SIGNING_PRIVATE_KEY,
    keyId: env.QUERY_SIGNING_KEY_ID,
    audience: env.QUERY_GATEWAY_AUDIENCE ?? `query-gateway:${env.ENVIRONMENT}`,
    signatureLifetimeMs: env.QUERY_SIGNATURE_LIFETIME_MS,
    timeoutMs: env.QUERY_GATEWAY_TIMEOUT_MS,
  })
  // The pipeline heartbeat (ADR-0025) is what lets freshness say "this site had
  // no visitors" instead of "we are behind". Wired only when the database is
  // there; without it the service falls back to the old watermark-age rule,
  // which is conservative rather than wrong in the dangerous direction.
  const heartbeatDb = db
  analytics = new AnalyticsService(gateway, {
    ...(heartbeatDb
      ? { pipelineHeartbeat: () => getWorkerHeartbeat(heartbeatDb, INGEST_PIPELINE_ID) }
      : {}),
  })
  // The sites-grid card figures (ADR-0080), over the same signed gateway. Built
  // only when the database is there too, because the revenue half asks Postgres
  // which sites have a provider connected — and a reader that could answer the
  // traffic half but never the money half would show every owner `revenue: null`
  // on every site, which reads as "nothing connected" rather than "not wired".
  if (heartbeatDb) {
    siteCards = new SiteCardStatsReader(gateway, {
      db: heartbeatDb,
      cacheTtlMs: env.SITES_CARD_CACHE_TTL_MS,
      gatewayTimeoutMs: env.SITES_CARD_GATEWAY_TIMEOUT_MS,
      maxSites: env.SITES_CARD_MAX_SITES,
      logger,
    })
  }
  logger.info('analytics_mounted', {
    pipeline_heartbeat: Boolean(heartbeatDb),
    site_cards: Boolean(siteCards),
  })
} else {
  logger.warn('analytics_not_mounted', { reason: 'query gateway URL or signing key missing' })
}

// Public-dashboard read config. The city-visitor threshold is the G-008 privacy
// gate: unset here (no default), it suppresses every city; an operator sets it
// only once the gate closes. The rate limit is an engineering value on an
// anonymous surface; the in-process limiter is a per-instance best-effort guard,
// with a Redis-backed one the multi-instance answer (see http/rate-limit.ts).
const publicConfig = loadPublicDashboardConfig()
// One per-(IP, slug) limiter shared by every anonymous public surface — the
// historical reads and the public realtime token endpoint — so one noisy client
// draws on a single budget across them. The value is the PUBLIC_READ_RATE_LIMIT
// engineering config, never a new literal invented for realtime.
const publicRateLimiter = new InProcessRateLimiter({
  requestsPerMinute: publicConfig.PUBLIC_READ_RATE_LIMIT_PER_MINUTE,
  burst: publicConfig.PUBLIC_READ_RATE_LIMIT_BURST,
})
// The read surface's budget, keyed by credential inside the middleware
// (ADR-0042 D6; ADR-0043 D6). **One limiter for both credential classes**, with
// a per-prefix ceiling: `key:` gets 60/120 and `oauth:` gets its own pair,
// because an assistant's tool fan-out is not a plugin's poll. Still its own
// instance rather than a share of `publicRateLimiter` — that one governs an
// unrelated surface, and one object across both would make whichever value was
// lower silently govern the other.
const readKeyConfig = loadReadKeyConfig()
const readCostConfig = loadReadCostConfig()
const readKey = {
  rateLimiter: readSurfaceRateLimiter(readKeyConfig),
  // The expensive-query gate's two numbers (ADR-0043 D7), from the environment
  // rather than from a literal in a route — the AGENTS rule the read-key limit
  // was written to honour, applied to the two numbers beside it.
  cost: {
    maxRangeDays: readCostConfig.READ_MAX_RANGE_DAYS,
    dailyBudgetMs: readCostConfig.READ_DAILY_COST_BUDGET_MS,
  },
}

/**
 * The anonymous widget read's own wiring (ADR-0045, D5 and D12).
 *
 * Its own limiter instance rather than a share of `publicRateLimiter`: the two
 * surfaces are keyed differently — per (IP, share slug) there, per (IP, widget
 * id) here — so one object across both would let a board's traffic and an
 * embed's draw on one window, which is precisely what per-object keying exists
 * to prevent. The *numbers* are deliberately identical (D5); the buckets are not.
 */
const widgetConfig = loadWidgetReadConfig()
const widgetRead = {
  rateLimiter: new InProcessRateLimiter({
    requestsPerMinute: widgetConfig.WIDGET_READ_RATE_LIMIT_PER_MINUTE,
    burst: widgetConfig.WIDGET_READ_RATE_LIMIT_BURST,
  }),
  cacheMaxAgeSeconds: widgetConfig.WIDGET_READ_CACHE_MAX_AGE_SECONDS,
  realtimeCacheMaxAgeSeconds: widgetConfig.WIDGET_REALTIME_CACHE_MAX_AGE_SECONDS,
}

/**
 * The assistant (ADR-0046, D6 and D7).
 *
 * Its bounds come from `packages/domain` and its provider from the environment.
 * **The client is the only optional half**: without `OPENAI_API_KEY` the routes
 * still mount and answer `SERVICE_UNAVAILABLE` naming the cause (D2), because an
 * unmounted `/v1` path answers `401` — which a browser renders as "you are
 * signed out" for a feature nobody enabled.
 */
const assistantConfig = loadAssistantConfig()
let assistantClient: OpenAiChatClient | undefined
if (assistantConfig.OPENAI_API_KEY) {
  assistantClient = createOpenAiChatClient({
    apiKey: assistantConfig.OPENAI_API_KEY,
    baseUrl: assistantConfig.OPENAI_BASE_URL,
    model: assistantConfig.ASSISTANT_MODEL,
  })
  // The model and the endpoint, never the key: this is the first third-party
  // credential the api holds whose leak is a bill.
  logger.info('assistant_mounted', {
    model: assistantConfig.ASSISTANT_MODEL,
    base_url: assistantConfig.OPENAI_BASE_URL,
    daily_question_limit: assistantConfig.ASSISTANT_DAILY_QUESTION_LIMIT,
  })
} else {
  logger.warn('assistant_provider_not_configured', { reason: 'OPENAI_API_KEY missing' })
}

/**
 * G-010's credential events (ADR-0051 D4), announced either way.
 *
 * The degradation here is total rather than partial — no secret means no source
 * fingerprint, and first use is decided by the same statement that detects a new
 * source — so a deployment that has quietly lost the variable would otherwise
 * look exactly like one that never had a credential used. One line at startup is
 * what makes the difference visible without failing a boot over a signal.
 */
if (env.CREDENTIAL_SOURCE_SECRET) {
  logger.info('credential_events_enabled', { key_version: env.CREDENTIAL_SOURCE_KEY_VERSION })
} else {
  logger.warn('credential_events_not_journalled', { reason: 'CREDENTIAL_SOURCE_SECRET missing' })
}

const publicDashboard = {
  rateLimiter: publicRateLimiter,
  // Defaults to 1 since G-008 closed (ADR-0017): every city that appears is
  // named; a deployment may still raise the threshold from the environment.
  cityMinVisitors: publicConfig.PUBLIC_CITY_MIN_VISITORS,
}

// Realtime token wiring (docs snapshot 02 §17, 05 D-213). The api seeds the
// access epoch at issuance and bumps it on revocation; both need the realtime
// cache client. The token endpoints additionally require the signing key, and
// app.ts gates the mount on that — here we only build the cache when its URL is
// present (the optional-until-used rule), mirroring the collector's client.
let realtimeCacheClient: ReturnType<typeof createRealtimeCacheClient> | undefined
let realtime:
  | { cache: ReturnType<typeof createRealtimeCache>; rateLimiter: typeof publicRateLimiter }
  | undefined
if (env.REALTIME_CACHE_REDIS_URL) {
  realtimeCacheClient = createRealtimeCacheClient({
    url: env.REALTIME_CACHE_REDIS_URL,
    connectionName: `api-rt-${service.version}`,
    // A hung cache command must not stall a token mint or a revocation bump.
    enableOfflineQueue: false,
    onError: (error) => logger.warn('realtime_cache_socket_error', { err: error, retryable: true }),
  })
  realtime = {
    cache: createRealtimeCache({
      client: realtimeCacheClient,
      eventMaxLatenessHours: env.EVENT_MAX_LATENESS_HOURS,
    }),
    rateLimiter: publicRateLimiter,
  }
  if (env.REALTIME_TOKEN_SIGNING_KEY) {
    logger.info('realtime_mounted', {})
  } else {
    logger.warn('realtime_not_mounted', { reason: 'REALTIME_TOKEN_SIGNING_KEY missing' })
  }
} else {
  logger.warn('realtime_not_mounted', { reason: 'REALTIME_CACHE_REDIS_URL missing' })
}

// Object storage (ADR-0032, D1). All five variables or none: a signature needs
// the endpoint, the region, the bucket and the key pair, so there is no partial
// configuration that could sign anything. Without them the `/imports` surface is
// simply not mounted, rather than mounted and answering failures.
let objectStorage: ObjectStorage | undefined
if (
  env.OBJECT_STORAGE_ENDPOINT &&
  env.OBJECT_STORAGE_REGION &&
  env.OBJECT_STORAGE_BUCKET &&
  env.OBJECT_STORAGE_ACCESS_KEY_ID &&
  env.OBJECT_STORAGE_SECRET_ACCESS_KEY
) {
  objectStorage = createS3ObjectStorage({
    endpoint: env.OBJECT_STORAGE_ENDPOINT,
    region: env.OBJECT_STORAGE_REGION,
    bucket: env.OBJECT_STORAGE_BUCKET,
    accessKeyId: env.OBJECT_STORAGE_ACCESS_KEY_ID,
    secretAccessKey: env.OBJECT_STORAGE_SECRET_ACCESS_KEY,
  })
  logger.info('object_storage_mounted', {})
} else {
  logger.warn('object_storage_not_mounted', {
    reason: 'OBJECT_STORAGE_ENDPOINT/_REGION/_BUCKET/_ACCESS_KEY_ID/_SECRET_ACCESS_KEY missing',
  })
}

// The credential keyring (ADR-0033, D3). Fail-closed on the billing precedent:
// without a *parsable* ring the revenue connection routes are not mounted and
// one warn log says why, rather than a surface that answers failures — a
// disconnect that cannot erase the ciphertext it claims to erase would be worse
// than no disconnect at all. The provider catalog mounts regardless (routes.ts).
//
// The ring itself is kept beside `revenue` rather than only inside it: the
// deployment-settings surface (migration 0043) encrypts an SMTP password and a
// provider key with the same vault and has nothing to do with revenue, so a
// build with a ring and no interest in payments still gets one.
let vault: CredentialVault | undefined
let revenue:
  { vault: CredentialVault; adapters: ReturnType<typeof createRevenueAdapterRegistry> } | undefined
if (env.OA_CREDENTIAL_KEYRING) {
  try {
    vault = createCredentialVault(env.OA_CREDENTIAL_KEYRING)
    revenue = {
      vault,
      adapters: createRevenueAdapterRegistry([
        createStripeRevenueAdapter(),
        // Polar and Dodo. Registered here and in the worker from the same
        // list the catalog advertises — a credential naming a provider with no
        // adapter fails `adapter_unavailable` rather than half-working, so the
        // two must be flipped together.
        createPolarRevenueAdapter(),
        createDodoRevenueAdapter(),
      ]),
    }
    // The active version's *label* — never material. It is what an operator
    // mid-rotation needs to confirm from a startup log.
    logger.info('revenue_mounted', {
      active_key_version: vault.activeKeyVersion,
      key_versions: vault.keyVersions.length,
    })
  } catch (error) {
    if (error instanceof CredentialKeyringError) {
      logger.warn('revenue_not_mounted', { reason: `OA_CREDENTIAL_KEYRING ${error.reason}` })
    } else {
      throw error
    }
  }
} else {
  logger.warn('revenue_not_mounted', { reason: 'OA_CREDENTIAL_KEYRING missing' })
}

const app = createApp({
  env,
  logger,
  service,
  // The already-built combined sink, so the api's request path flows through the
  // same G-006 pipeline as its (future) domain counters.
  metrics: serviceMetrics.metrics,
  ...(auth ? { auth } : {}),
  ...(db ? { db } : {}),
  ...(cloud ? { cloud } : {}),
  ...(analytics ? { analytics } : {}),
  ...(siteCards ? { siteCards } : {}),
  ...(analytics ? { publicDashboard } : {}),
  // Always passed: the read-key surface mounts whether or not a gateway is
  // configured, so its budget is not conditional either (ADR-0042, D5).
  readKey,
  // Always passed, for the same reason: the widget read mounts whether or not a
  // gateway is configured, because an unmounted `/v1` path answers `401` and
  // ADR-0045 D7 requires one answer.
  widgetRead,
  // Always passed, for the reason the two above are: the assistant routes
  // mount unconditionally and report an unconfigured provider themselves.
  assistant: { config: assistantConfig, ...(assistantClient ? { client: assistantClient } : {}) },
  ...(realtime ? { realtime } : {}),
  ...(objectStorage ? { objectStorage } : {}),
  ...(revenue ? { revenue } : {}),
  ...(vault ? { vault } : {}),
})

const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  logger.info('service_started', { port: info.port })
})

function shutdown(signal: string): void {
  logger.info('service_stopping', { signal })
  server.close(() => {
    void Promise.allSettled([
      // First, so the final counters reach the last push before the sockets go.
      serviceMetrics.stop(),
      pool?.end(),
      realtimeCacheClient?.quit(),
    ]).finally(() => process.exit(0))
  })
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
