import { API_VERSION } from '@openanalytics/contracts'
import {
  OAUTH_ACCESS_TOKEN_EXPIRES_IN_SECONDS,
  OAUTH_REFRESH_TOKEN_EXPIRES_IN_SECONDS,
  supportedOAuthScopes,
  type Auth,
} from '@openanalytics/auth'
import type { RevenueAdapterRegistry, ServiceEnv } from '@openanalytics/domain'
import {
  assistantConfigSchema,
  readCostConfigSchema,
  readKeyConfigSchema,
  widgetReadConfigSchema,
  type AssistantConfig,
  type ReadKeyConfig,
} from '@openanalytics/domain'
import type { CredentialVault, ObjectStorage, OpenAiChatClient } from '@openanalytics/integrations'
import type { Logger, Metrics, ServiceMetadata } from '@openanalytics/observability'
import { createServiceApp } from '@openanalytics/observability/hono'
import {
  getSiteReportingTimezone,
  markUserEmailVerified,
  resolveOAuthAccessToken,
  type Database,
} from '@openanalytics/postgres'
import type { RealtimeCache } from '@openanalytics/redis'
import { Hono } from 'hono'
import type { AnalyticsService } from './analytics/service.ts'
import type { SiteCardStatsReader } from './analytics/site-cards.ts'
import { createAuthProviderRoutes } from './http/auth-providers.ts'
import { credentialedCors, parseTrustedOrigins } from './http/cors.ts'
import { createBusinessRoutes } from './http/routes.ts'
import { oauthPageUrls } from './auth.ts'
import { createMcpRoutes } from './http/mcp.ts'
import { createDeviceTokenRoutes, createOAuthPageRoutes } from './http/oauth.ts'
import { createOAuthRegistrationRoutes } from './http/oauth-register.ts'
import { createPublicDashboardRoutes } from './http/public-dashboard.ts'
import { createWidgetPublicRoutes } from './http/widget-public.ts'
import { createWidgetEmbedRoutes } from './http/embed.ts'
import { createRevenueWebhookRoutes } from './http/revenue-webhook.ts'
import { createPublicRealtimeRoutes } from './http/realtime.ts'
import { createReadKeyRoutes } from './http/read-key.ts'
import { createCredentialUseRecorder } from './http/credential-events.ts'
import { InProcessRateLimiter, type RateLimiter } from './http/rate-limit.ts'
import type { ApiCloudExtension } from './cloud-extension.ts'

/**
 * Backend API / auth surface.
 *
 * Milestone 2 mounts Better Auth at `/api/auth/*`; the read API arrives in
 * Milestone 7. Each business route authorizes server-side — a frontend route
 * guard is not a security boundary (docs snapshot 02 §19).
 *
 * `auth` is optional so the service still boots with only `/health` when no
 * database is configured (the Milestone 0 startup contract). When present, the
 * whole `/api/auth` subtree is handed to Better Auth, which owns its own
 * cookies, CSRF/origin checks and session lifecycle.
 */

export interface AppDeps {
  readonly service: ServiceMetadata
  readonly logger: Logger
  readonly env: ServiceEnv<'api'>
  /** Combined G-006 sink. When present, the shared middleware meters every
   * request (`http_requests`/`http_errors`); optional so a store-less boot and
   * the contract tests still build a bare app. */
  readonly metrics?: Metrics
  readonly auth?: Auth
  readonly db?: Database
  /**
   * The optional HTTP surfaces this deployment mounts (`cloud-extension.ts`).
   *
   * This is where `billing` used to be: a `StripeClient`, a price map and a
   * webhook secret, threaded from `main.ts` into a `/v1/billing` mount declared
   * below. The dependency is now one object a registered extension supplies for
   * itself, because the surfaces behind it — Stripe billing, the account usage
   * read, the marketing notify form and the billing-transfer flow — are the
   * hosted deployment's, and a self-hosted build should not have their wiring in
   * its startup path to leave `undefined`.
   *
   * Absent means the extension's routes are not mounted at all, which is the
   * `deps.billing`-absent behaviour it replaces.
   */
  readonly cloud?: ApiCloudExtension
  /** Analytics read service over the signed query gateway. Present only when the
   * gateway URL and signing key are configured; the `/analytics` and `/public`
   * surfaces are not mounted otherwise (the optional-until-used rule). */
  readonly analytics?: AnalyticsService
  /** The sites-grid card figures (ADR-0080). Built beside the analytics service,
   * from the same gateway; absent, `GET /v1/sites` answers with `null` figures. */
  readonly siteCards?: SiteCardStatsReader
  /** Public-dashboard read config. Mounted alongside the analytics service. */
  readonly publicDashboard?: {
    readonly rateLimiter: RateLimiter
    /** The G-008-gated city-visitor threshold; `undefined` suppresses all cities. */
    readonly cityMinVisitors: number | undefined
  }
  /**
   * The per-key budget for the bearer-key read surface (ADR-0042, D6). Optional
   * only so a bare test app need not build one — absent, `createApp` builds the
   * decided defaults rather than mounting the surface unlimited.
   */
  readonly readKey?: {
    readonly rateLimiter: RateLimiter
    readonly cost?: { readonly maxRangeDays: number; readonly dailyBudgetMs: number }
  }
  /**
   * The device token endpoint's budget (ADR-0043 D13). Optional for the same
   * reason `readKey` is: a bare test app should not have to build a limiter it
   * does not exercise, and absent it the surface gets the decided default rather
   * than mounting unlimited.
   */
  readonly oauth?: {
    readonly deviceTokenRateLimiter?: RateLimiter
    /** The anonymous registration ceiling (ADR-0047 D6). */
    readonly registrationRateLimiter?: RateLimiter
  }

  /** The first-account ceiling. Injected only by tests; the default is decided below. */
  readonly setupRateLimiter?: RateLimiter
  /** The deployment test-send ceiling. Same arrangement as `setupRateLimiter`. */
  readonly testEmailRateLimiter?: RateLimiter
  /**
   * The anonymous widget read's budget and its two `max-age` values (ADR-0045,
   * D5 and D12). Optional for the reason `readKey` is: a bare test app should
   * not have to build a limiter it does not exercise, and absent it the surface
   * gets the decided defaults rather than mounting unlimited and uncacheable.
   */
  readonly widgetRead?: {
    readonly rateLimiter: RateLimiter
    readonly cacheMaxAgeSeconds: number
    readonly realtimeCacheMaxAgeSeconds: number
  }
  /**
   * Realtime token wiring (docs snapshot 02 §17, 05 D-213). Present only when the
   * realtime cache client is configured; the token endpoints and the revocation
   * bumps mount only when this AND `env.REALTIME_TOKEN_SIGNING_KEY` are present
   * (the optional-until-used rule). The cache is used to seed the access epoch at
   * issuance and to bump it on revocation; the rate limiter guards the public
   * token endpoint per (IP, slug).
   */
  readonly realtime?: {
    readonly cache: RealtimeCache
    readonly rateLimiter: RateLimiter
  }
  /**
   * Object storage (ADR-0032, D1). Present only when the whole
   * `OBJECT_STORAGE_*` block is configured; the `/imports` surface is not
   * mounted otherwise (the optional-until-used rule).
   */
  readonly objectStorage?: ObjectStorage
  /**
   * Revenue credential wiring (ADR-0033, D3). Present only when
   * `OA_CREDENTIAL_KEYRING` parsed into a usable keyring; the site-scoped
   * `/revenue/connection` surface is not mounted otherwise. The provider catalog
   * mounts either way, being a static list.
   */
  readonly revenue?: {
    readonly vault: CredentialVault
    readonly adapters: RevenueAdapterRegistry
  }
  /**
   * The credential keyring on its own (migration 0043).
   *
   * The same object `revenue.vault` holds when revenue is wired, hoisted because
   * the deployment-settings surface encrypts an SMTP password and a provider key
   * with it and has nothing to do with payments. Absent, that surface reports
   * itself closed with `reason: 'no_keyring'` rather than storing a secret it
   * cannot protect.
   */
  readonly vault?: CredentialVault
  /**
   * The assistant (ADR-0046). Optional here and required one layer down, in
   * `defaultReadCost`'s shape: absent, `createApp` parses the same schema
   * `main.ts` parses with an empty environment, so a bare test app gets the
   * *decided* bounds rather than none. The provider client is separate and
   * genuinely optional — no key, no client, and the routes say so (D6).
   */
  readonly assistant?: {
    readonly config?: AssistantConfig
    readonly client?: OpenAiChatClient
  }
}

/**
 * The read-key budget when nothing wired one (ADR-0042, D6).
 *
 * Not a hole and not an invented value: it parses the same schema `main.ts`
 * parses, with an empty environment, so it yields the decided defaults — 60 per
 * minute, burst 120 — rather than "no limit". The read-key subtree mounts
 * unconditionally, so it must never be possible for it to mount unlimited;
 * making the dependency required instead would have made every test that builds
 * a bare app construct a limiter it does not care about.
 */
function defaultReadKeyRateLimiter(): RateLimiter {
  return readSurfaceRateLimiter(readKeyConfigSchema.parse({}))
}

/**
 * The read surface's one limiter, carrying both credential classes' budgets
 * (ADR-0043 D6).
 *
 * One object with a prefix map, not two limiters — D9's "no second rate limiter"
 * met literally rather than in spirit. `key:` draws on ADR-0042 D6's 60/120;
 * `oauth:` draws on its own pair, because an assistant's tool fan-out is not a
 * plugin's poll. `ip:` — the budget an *unresolved* caller charges — deliberately
 * falls through to the constructed default, which is the key's: it is the
 * tightest of the two, and an unauthenticated flood should meet the tighter one.
 */
export function readSurfaceRateLimiter(config: ReadKeyConfig): RateLimiter {
  return new InProcessRateLimiter({
    requestsPerMinute: config.READ_KEY_RATE_LIMIT_PER_MINUTE,
    burst: config.READ_KEY_RATE_LIMIT_BURST,
    limitsByPrefix: {
      'oauth:': {
        requestsPerMinute: config.OAUTH_READ_RATE_LIMIT_PER_MINUTE,
        burst: config.OAUTH_READ_RATE_LIMIT_BURST,
      },
    },
  })
}

/** The cost gate's numbers when nothing wired them (ADR-0043 D7). */
function defaultReadCost(): { maxRangeDays: number; dailyBudgetMs: number } {
  const config = readCostConfigSchema.parse({})
  return {
    maxRangeDays: config.READ_MAX_RANGE_DAYS,
    dailyBudgetMs: config.READ_DAILY_COST_BUDGET_MS,
  }
}

/**
 * The device token endpoint's budget when nothing wired one.
 *
 * Not a measured number and not pretending to be: the device flow's polling
 * interval is five seconds (`OAUTH_DEVICE_POLL_INTERVAL`), so a well-behaved
 * device makes twelve requests a minute and 60/90 is that with room for a retry
 * storm. The per-request `slow_down` in `claimApprovedDeviceCode` is the real
 * pacing mechanism — this only bounds a client that ignores it, before the
 * database is touched.
 *
 * **The default limit is per *device code*, and `device-ip:` is a separate,
 * much wider ceiling.** The two keys measure different things, so one number
 * cannot serve both: the first paces one login, the second bounds a spray of
 * invented codes that gets a fresh per-code window every request (see
 * `createDeviceTokenRoutes`). Ten times the per-code budget, because an address
 * is a NAT rather than a caller — ten simultaneous logins from one office is
 * unremarkable and costs 120 polls a minute, well inside 600, while a sprayer
 * meets 900 in a window and stops costing queries. A limiter injected without
 * the prefix entry falls back to the constructed pair, which is
 * `InProcessRateLimiter`'s documented behaviour and the conservative direction.
 */
/**
 * The widget read's wiring when nothing supplied one (ADR-0045, D5 and D12).
 *
 * `defaultReadKeyRateLimiter`'s shape: the same schema `main.ts` parses, with an
 * empty environment, so it yields the *decided* values — 60/120 and 60/10
 * seconds — rather than "no limit" and "no cache header". The widget subtree
 * mounts unconditionally, so it must never be possible for it to mount
 * unlimited.
 */
function defaultWidgetRead(): {
  rateLimiter: RateLimiter
  cacheMaxAgeSeconds: number
  realtimeCacheMaxAgeSeconds: number
} {
  const config = widgetReadConfigSchema.parse({})
  return {
    rateLimiter: new InProcessRateLimiter({
      requestsPerMinute: config.WIDGET_READ_RATE_LIMIT_PER_MINUTE,
      burst: config.WIDGET_READ_RATE_LIMIT_BURST,
    }),
    cacheMaxAgeSeconds: config.WIDGET_READ_CACHE_MAX_AGE_SECONDS,
    realtimeCacheMaxAgeSeconds: config.WIDGET_REALTIME_CACHE_MAX_AGE_SECONDS,
  }
}

function defaultDeviceTokenLimiter(): RateLimiter {
  return new InProcessRateLimiter({
    requestsPerMinute: 60,
    burst: 90,
    limitsByPrefix: { 'device-ip:': { requestsPerMinute: 600, burst: 900 } },
  })
}

/**
 * The anonymous registration ceiling (ADR-0047 D6): ten a minute per address,
 * burst twenty. An order of magnitude above what a genuine host setup does —
 * one registration, once — and low enough that a spray writes a bounded number
 * of rows before the window refuses it.
 */
function defaultRegistrationLimiter(): RateLimiter {
  return new InProcessRateLimiter({ requestsPerMinute: 10, burst: 20 })
}

/**
 * The first-account ceiling: five a minute per address, burst five.
 *
 * Far tighter than registration, because the genuine action happens **once per
 * deployment, ever**. Anything above a couple of attempts is a typo being
 * retried; anything above five is somebody looking for an install that has
 * booted and not been claimed yet. It does not close the window — only the
 * operator creating the account does that — it makes the window expensive to
 * find by spraying.
 */
function defaultSetupLimiter(): RateLimiter {
  return new InProcessRateLimiter({ requestsPerMinute: 5, burst: 5 })
}

/**
 * The test-send ceiling: five a minute, keyed on the operator's account.
 *
 * The button exists to be pressed after every edit to a mail relay, so the
 * budget has to survive a real debugging session — five is roughly one press
 * every twelve seconds, which is faster than anyone can read an inbox. What it
 * bounds is the one thing the endpoint could otherwise become: a way to put
 * repeated mail in somebody's inbox. That somebody is always the caller's own
 * address, which is most of why this number can be generous at all.
 */
function defaultTestEmailLimiter(): RateLimiter {
  return new InProcessRateLimiter({ requestsPerMinute: 5, burst: 5 })
}

export function createApp(deps: AppDeps) {
  /**
   * The api's own public origin.
   *
   * Hoisted because two surfaces now build internal requests against it — MCP
   * below and the assistant's tool loop through `createBusinessRoutes` — and a
   * second derivation would be a second answer to "where is this api".
   */
  const apiOrigin = (deps.env.AUTH_BASE_URL ?? 'http://localhost:4000').replace(/\/$/u, '')

  /**
   * G-010's credential-event recorder (ADR-0051), built once and shared.
   *
   * Two authenticators hold it: `readAuth` on the read surface and `/mcp`, and
   * `principalAuth` on the business subtree. Both, because a credential that is
   * only ever used to *write* — an agent that creates funnels and never reads —
   * would otherwise never appear in the journal at all. Absent when no source
   * secret is configured, which is the whole feature off (D4).
   */
  const recordCredentialUse = deps.db
    ? createCredentialUseRecorder({
        db: deps.db,
        ...(deps.env.CREDENTIAL_SOURCE_SECRET
          ? {
              key: {
                secret: deps.env.CREDENTIAL_SOURCE_SECRET,
                keyVersion: deps.env.CREDENTIAL_SOURCE_KEY_VERSION,
              },
            }
          : {}),
        logger: deps.logger,
      })
    : undefined

  const app = createServiceApp({
    service: deps.service,
    logger: deps.logger,
    ...(deps.metrics ? { metrics: deps.metrics } : {}),
  })

  if (deps.auth) {
    const auth = deps.auth
    app.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw))

    // Which sign-in methods this deployment offers, and — on an install nobody
    // has signed into yet — the route that creates the first account.
    // Registered here, before the business subtree claims `/${API_VERSION}`
    // behind a blanket session guard: both are asked with no session, one by
    // definition and the other because none can exist yet.
    app.route(
      `/${API_VERSION}`,
      createAuthProviderRoutes({
        env: deps.env,
        logger: deps.logger,
        ...(deps.db ? { db: deps.db } : {}),
        ...(deps.auth ? { auth: deps.auth } : {}),
        ...(deps.db
          ? {
              markVerified: (email: string) => markUserEmailVerified(deps.db as Database, email),
            }
          : {}),
        setupRateLimiter: deps.setupRateLimiter ?? defaultSetupLimiter(),
      }),
    )

    /**
     * The two OAuth browser pages and the device token exchange (ADR-0043 D13,
     * D14).
     *
     * The pages are at the api's root rather than under `/${API_VERSION}`: they
     * are HTML a human is redirected to, not a versioned JSON contract, and
     * Better Auth is handed their absolute URLs as configuration
     * (`oauthPageUrls`). The exchange *is* under `/${API_VERSION}`, and before
     * the business subtree, for the reason the read-key surface is: it
     * authenticates with a device code and would otherwise meet a session guard
     * and answer `401` to a caller holding a perfectly good one.
     *
     * Both need the database; the pages also need the auth instance, whose
     * `deviceApprove`/`deviceDeny`/`oAuthConsent` they call with the browser's
     * own headers so the session check stays Better Auth's.
     */
    if (deps.db) {
      const oauthDeps = {
        db: deps.db,
        auth,
        env: deps.env,
        trustedOrigins: parseTrustedOrigins(deps.env.AUTH_TRUSTED_ORIGINS),
        selfOrigin: new URL(deps.env.AUTH_BASE_URL ?? 'http://localhost:4000').origin,
        loginPage: oauthPageUrls(deps.env).loginPage,
        deviceTokenRateLimiter: deps.oauth?.deviceTokenRateLimiter ?? defaultDeviceTokenLimiter(),
        accessTokenExpiresInSeconds: OAUTH_ACCESS_TOKEN_EXPIRES_IN_SECONDS,
        refreshTokenExpiresInSeconds: OAUTH_REFRESH_TOKEN_EXPIRES_IN_SECONDS,
        logger: deps.logger,
      }
      app.route('/', createOAuthPageRoutes(oauthDeps))
      app.route(`/${API_VERSION}`, createDeviceTokenRoutes(oauthDeps))
      // RFC 7591 registration (ADR-0047): anonymous by design, so it mounts
      // here with the other credential-less OAuth surfaces, under its own
      // address-keyed ceiling.
      app.route(
        `/${API_VERSION}`,
        createOAuthRegistrationRoutes({
          db: deps.db,
          registrationRateLimiter:
            deps.oauth?.registrationRateLimiter ?? defaultRegistrationLimiter(),
          supportedScopes: supportedOAuthScopes(),
          logger: deps.logger,
        }),
      )
    }
  }

  /**
   * The key-authenticated read surface (ADR-0042).
   *
   * **Registered before the business subtree, and outside its `auth` gate.** Two
   * separate points, both deliberate:
   *
   * - *Before*, for the third time in this file and the same reason as the
   *   billing webhook and the public dashboard: the business surface owns
   *   `/${API_VERSION}` behind a blanket session guard, and a `/v1/read/*`
   *   request registered after it would be answered `401` for having no cookie —
   *   precisely the credential it is deliberately not using.
   * - *Outside the auth gate*, because this surface's only dependency is the
   *   database. Requiring an auth instance it never calls would make the "no
   *   session, bearer key only" claim a matter of routing luck rather than of
   *   what the code needs.
   *
   * Mounted whether or not a query gateway is configured, unlike the dashboard's
   * analytics subtree. Without one, the seven analytics reads answer
   * `SERVICE_UNAVAILABLE` — true and actionable — where not mounting them would
   * drop the request through to the session guard below and produce a `401` for
   * a caller holding a perfectly good key.
   */
  if (deps.db) {
    app.route(
      `/${API_VERSION}`,
      createReadKeyRoutes({
        db: deps.db,
        // The session arm (ADR-0046 D4). Passed when there is an auth instance
        // and simply absent otherwise, which keeps this surface's one hard
        // dependency the database: a deployment with no auth still serves keys
        // and tokens, and has no session to resolve.
        ...(deps.auth ? { auth: deps.auth } : {}),
        ...(deps.analytics ? { service: deps.analytics } : {}),
        rateLimiter: deps.readKey?.rateLimiter ?? defaultReadKeyRateLimiter(),
        collectorBaseUrl: deps.env.COLLECTOR_BASE_URL,
        // The expensive-query gate (ADR-0043 D7). Parsed from the same schema
        // `main.ts` parses, with an empty environment when nothing wired it, so
        // a bare test app gets the decided defaults rather than an unbounded
        // surface — the shape `defaultReadKeyRateLimiter` established.
        cost: deps.readKey?.cost ?? defaultReadCost(),
        // `realtime:read`'s surface, gated exactly as the dashboard's own token
        // endpoint is (ADR-0043 D5). Both halves or neither: a signing key with
        // no cache cannot seed an epoch, and a token without its epoch is a
        // credential the gateway fails closed on.
        ...(deps.env.REALTIME_TOKEN_SIGNING_KEY && deps.realtime
          ? {
              realtime: {
                cache: deps.realtime.cache,
                signingKey: deps.env.REALTIME_TOKEN_SIGNING_KEY,
                ttlSeconds: deps.env.REALTIME_TOKEN_TTL_SECONDS,
                epochCheckSeconds: deps.env.REALTIME_EPOCH_CHECK_SECONDS,
              },
            }
          : {}),
        // G-010's credential events (ADR-0051 D5) — the same recorder object the
        // business subtree's `principalAuth` holds.
        ...(recordCredentialUse ? { recordCredentialUse } : {}),
        logger: deps.logger,
      }),
    )

    /**
     * The anonymous widget read (ADR-0045, CP2), on the same pre-session shelf
     * and outside the auth gate, for the read-key surface's two reasons plus one
     * of its own.
     *
     * - *Before* the business subtree, which owns `/${API_VERSION}` behind a
     *   blanket session guard: this route is addressed by an opaque widget id
     *   and must never require a session (§20).
     * - *Outside* the auth gate, because its only hard dependency is the
     *   database. A deployment with no auth instance still serves embeds.
     * - **Mounted whether or not a query gateway is configured**, and this one
     *   is not a preference. ADR-0045 D7 requires *one* answer for an invented
     *   id, a disabled widget and a blocked site — and an unmounted `/v1` path
     *   falls through to the session guard and answers `401`, which is a
     *   different answer and a statement about the deployment. Without a gateway
     *   the seven historical surfaces answer `SERVICE_UNAVAILABLE`, which is
     *   true and actionable; the 404 stays the 404.
     */
    const widgetRead = deps.widgetRead ?? defaultWidgetRead()
    app.route(
      `/${API_VERSION}`,
      createWidgetPublicRoutes({
        db: deps.db,
        ...(deps.analytics ? { service: deps.analytics } : {}),
        // Gated on the cache alone, never on `REALTIME_TOKEN_SIGNING_KEY`: a
        // widget poll is an ordinary cacheable GET and mints no token, so
        // requiring the signing key would leave realtime embeds dead in a
        // deployment that wants nothing but them.
        ...(deps.realtime ? { realtimeCache: deps.realtime.cache } : {}),
        // The same G-008 threshold the share board's geography read applies. A
        // second source for it would be a second privacy policy.
        cityMinVisitors: deps.publicDashboard?.cityMinVisitors,
        ...widgetRead,
      }),
    )

    /**
     * The embed document (ADR-0045, CP3), at the api's **root** beside the OAuth
     * pages rather than under `/${API_VERSION}`.
     *
     * Both halves of that placement are the ADR's. It is the api's rather than
     * `app.getopen.so`'s because the document must answer `frame-ancestors` from
     * the widget's `allowed_origins`, a list that lives only on the widget row
     * and is deliberately absent from the public read (D13) — and it is outside
     * `/v1` because an HTML document does not belong under a versioned JSON
     * contract, the same judgement the OAuth pages made.
     *
     * It needs neither the analytics service nor the presence cache: it renders
     * nothing server-side. Its one read is the widget row, for the gate and for
     * the origin list, and its `max-age` is deliberately `widgetRead`'s own
     * historical value — the document's staleness bound is the policy's, not the
     * data's (D12).
     *
     * **The very same limiter object the JSON read got**, not a second one built
     * from the same numbers (D5, as amended 2026-08-07): the two doors are one
     * (IP, widget id) budget, so a first paint costs two tokens and neither door
     * can be sprayed for free while the other is closed.
     */
    app.route(
      '/',
      createWidgetEmbedRoutes({
        db: deps.db,
        rateLimiter: widgetRead.rateLimiter,
        cacheMaxAgeSeconds: widgetRead.cacheMaxAgeSeconds,
        // Absent, the footer is text rather than a link (see `WidgetEmbedDeps`).
        ...(deps.env.WIDGET_WATERMARK_URL ? { watermarkUrl: deps.env.WIDGET_WATERMARK_URL } : {}),
      }),
    )
  }

  // Versioned business routes. Docs snapshot 02 §18: business endpoints are never
  // silently unversioned. They need both a database and an auth instance; without
  // them the `/v1` surface is empty and only `/health` is served (the Milestone 0
  // startup contract).
  if (deps.auth && deps.db) {
    // The per-site revenue webhook (ADR-0033, D4), on the same pre-session
    // shelf and for exactly the same reason as the billing webhook: it is
    // authenticated by a signature over the RAW body, so it must be matched
    // before the business subtree's blanket session guard — which would 401
    // every delivery — and before anything can consume the request stream.
    //
    // Mounted only with a usable keyring, unlike the connection surface whose
    // read and disconnect verbs mount either way. That split is not
    // inconsistency: those two touch no ciphertext, while every delivery here
    // must decrypt a signing secret before it can decide whether the body is
    // authentic. Without the ring this route could only answer 5xx to signed
    // traffic, and an absent route (404) at least tells the provider's
    // dashboard something true.
    if (deps.revenue) {
      app.route(
        `/${API_VERSION}`,
        createRevenueWebhookRoutes({
          db: deps.db,
          vault: deps.revenue.vault,
          adapters: deps.revenue.adapters,
          logger: deps.logger,
        }),
      )
    }

    /**
     * The optional surfaces a deployment registered (`cloud-extension.ts`), on
     * the pre-session shelf.
     *
     * Here rather than anywhere else because of what used to be here: the Stripe
     * billing mount, whose webhook is authenticated by a signature over the raw
     * body and would be answered `401` by the business subtree's blanket session
     * guard if it were matched after it. Every route the extension contributes
     * inherits that placement, and the extension decides the order *among* its
     * own subtrees — `/billing/usage` before `/billing/*`, as it always was.
     *
     * After the revenue webhook, so that block's own position relative to the
     * business subtree is untouched; the two prefixes do not overlap, so nothing
     * about the ordering between them is load-bearing.
     */
    if (deps.cloud?.preSessionRoutes) {
      const routes = deps.cloud.preSessionRoutes({
        db: deps.db,
        auth: deps.auth,
        env: deps.env,
        logger: deps.logger,
        ...(deps.metrics ? { metrics: deps.metrics } : {}),
        ...(recordCredentialUse ? { recordCredentialUse } : {}),
      })
      for (const route of routes) app.route(route.path, route.router)
    }

    // Public dashboard routes mount BEFORE the business surface for the same
    // reason billing does: the business subtree owns `/${API_VERSION}` behind a
    // blanket session guard, so an unauthenticated `/${API_VERSION}/public/*`
    // request registered after it would be caught by that guard and 401. These
    // are addressed by a share slug and must never require a session (§20).
    if (deps.analytics && deps.publicDashboard) {
      app.route(
        `/${API_VERSION}`,
        createPublicDashboardRoutes({
          db: deps.db,
          service: deps.analytics,
          rateLimiter: deps.publicDashboard.rateLimiter,
          cityMinVisitors: deps.publicDashboard.cityMinVisitors,
        }),
      )
    }

    // Public realtime token endpoint. Unauthenticated, addressed by share slug, so
    // it mounts BEFORE the business session catch-all for the same reason the
    // public dashboard reads do. Mounted only when the signing key and the
    // realtime cache are both configured (the optional-until-used rule).
    if (deps.env.REALTIME_TOKEN_SIGNING_KEY && deps.realtime) {
      app.route(
        `/${API_VERSION}`,
        createPublicRealtimeRoutes({
          db: deps.db,
          rateLimiter: deps.realtime.rateLimiter,
          cache: deps.realtime.cache,
          signingKey: deps.env.REALTIME_TOKEN_SIGNING_KEY,
          ttlSeconds: deps.env.REALTIME_TOKEN_TTL_SECONDS,
          epochCheckSeconds: deps.env.REALTIME_EPOCH_CHECK_SECONDS,
        }),
      )
    }

    app.route(
      `/${API_VERSION}`,
      createBusinessRoutes({
        db: deps.db,
        auth: deps.auth,
        env: deps.env,
        ...(recordCredentialUse ? { recordCredentialUse } : {}),
        ...(deps.analytics ? { analytics: deps.analytics } : {}),
        ...(deps.siteCards ? { siteCards: deps.siteCards } : {}),
        ...(deps.realtime ? { realtime: deps.realtime } : {}),
        ...(deps.objectStorage ? { objectStorage: deps.objectStorage } : {}),
        ...(deps.revenue ? { revenue: deps.revenue } : {}),
        // The deployment-settings surface (migration 0043). The vault is
        // separate from `revenue` on purpose — see `AppDeps.vault` — and its
        // absence closes the surface with a reason rather than removing it.
        ...(deps.vault ? { vault: deps.vault } : {}),
        testEmailRateLimiter: deps.testEmailRateLimiter ?? defaultTestEmailLimiter(),
        // The same extension object; `createBusinessRoutes` reads only its
        // `businessRoutes` half, and mounts it last on the authenticated router.
        ...(deps.cloud ? { cloud: deps.cloud } : {}),
        /**
         * The assistant (ADR-0046, D2), mounted inside the session subtree and
         * dispatching back into this same app.
         *
         * `async (request) => app.fetch(request)` is the identical arrangement
         * MCP has below, and it is safe to hand over here — before the rest of
         * the tree is assembled — because it is evaluated **per request**, not
         * now. That is what lets the assistant sit behind `sessionAuth` (which
         * only exists inside `createBusinessRoutes`) while its tool calls still
         * traverse the fully-assembled router, `/v1/read/*` middleware and all.
         */
        assistant: {
          config: deps.assistant?.config ?? assistantConfigSchema.parse({}),
          dispatch: async (request) => app.fetch(request),
          resourceUrl: apiOrigin,
          ...(deps.assistant?.client ? { client: deps.assistant.client } : {}),
        },
      }),
    )
  } else {
    app.route(`/${API_VERSION}`, new Hono())
  }

  /**
   * Credentialed CORS wraps the whole service.
   *
   * It has to sit *outside* the service app rather than as another `use('*')`
   * inside it: `createServiceApp` registers `/health` before `createApp` gets
   * the app back, and Hono runs matched handlers in registration order — a
   * middleware added afterwards never runs for a route that was already
   * registered and answers without calling `next()`. Delegating through
   * `app.fetch` keeps the service app's routing, error envelope and 404 handler
   * exactly as they are, and gives every response — `/health`, `/api/auth/*`
   * where the session cookie is set, and `/v1/*` — the same origin treatment.
   *
   * It also means a preflight is answered before it can reach the session
   * middleware, which is the production failure this closes: `OPTIONS /v1/sites`
   * carries no cookie and could only ever 401.
   */
  /**
   * MCP, mounted last and dispatching back into the app above (ADR-0043 D10).
   *
   * Registered here rather than beside the other subtrees because of what it
   * needs: `createMcpRoutes` takes a `dispatch` that runs a `Request` through
   * the *assembled* app, which is how a tool call becomes a real `/v1/read`
   * request carrying every middleware that route has. Mounting it earlier would
   * mean handing it a half-built app.
   *
   * Not a separate deployable (D10): a second container would need its own
   * gateway route, its own environment and its own database access to resolve
   * the same principal this api already resolves.
   */
  if (deps.db) {
    const readDb = deps.db
    app.route(
      '/',
      createMcpRoutes({
        dispatch: async (request) => app.fetch(request),
        resourceUrl: apiOrigin,
        // The issuer exactly as Better Auth states it in its metadata, which is
        // its configured `baseURL` — the bare origin, NOT `<origin>/api/auth`.
        // RFC 8414 §3.3 has a client reject metadata whose `issuer` differs from
        // the server this document named, so naming `/api/auth` here failed
        // every MCP sign-in with "issuer mismatch". Read off the auth instance
        // rather than rebuilt from AUTH_BASE_URL, so a trailing slash or a
        // differently-configured instance cannot reopen the gap.
        authorizationServer:
          typeof deps.auth?.options?.baseURL === 'string' ? deps.auth.options.baseURL : apiOrigin,
        // The read arm's own resolver, so "is this token live" has one answer.
        verifyBearer: async (token) => resolveOAuthAccessToken(readDb, token),
        // The default calendar a ranged tool reads on (ADR-0079 D5), scoped to
        // the caller's own membership.
        siteTimezone: async (params) => getSiteReportingTimezone(readDb, params),
        logger: deps.logger,
      }),
    )
  }

  const root = new Hono()
  root.use('*', credentialedCors(parseTrustedOrigins(deps.env.AUTH_TRUSTED_ORIGINS)))
  root.all('*', (c) => app.fetch(c.req.raw))
  return root
}
