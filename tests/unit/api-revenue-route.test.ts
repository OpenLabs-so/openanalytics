import { randomBytes } from 'node:crypto'
import type { Auth, SiteRole } from '@openanalytics/auth'
import {
  createRevenueAdapterRegistry,
  loadServiceEnv,
  type RevenueAdapter,
} from '@openanalytics/domain'
import { createCredentialVault } from '@openanalytics/integrations'
import type { Database, RevenueCredentialRow } from '@openanalytics/postgres'
import type * as PostgresModule from '@openanalytics/postgres'
import { createServiceMetadata } from '@openanalytics/observability'
import { createCapturedLogger, testEnv } from '@openanalytics/testkit'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeRevenueAdapter } from '../support/revenue-fixtures.ts'

/**
 * The revenue connection door (ADR-0033, D1/D3/D7).
 *
 * The repository has its own Postgres suite; what lives only at the route is:
 *
 * - **verify before storing** — an unauthorized probe is a 422 and an
 *   unreachable provider a 503, and neither writes a row. Reporting an outage as
 *   a bad credential is the failure mode this milestone is named after;
 * - **the secret never comes back** — not in a create response, not in a status
 *   read, not in an error detail;
 * - the AAD binding the api actually applies, since the ciphertext is
 *   undecryptable on any other row if it gets this wrong;
 * - the capability map: `credentials:manage` is owner and admin, and a viewer is
 *   refused on every verb including the read, because the read carries the
 *   webhook address;
 * - the catalog being reachable with no keyring configured, which is what lets
 *   the frontend retire its hardcoded provider list without a redeploy — while
 *   the connection routes are absent on the same deployment;
 * - a disconnected site reading back as `disabled` rather than `not_connected`,
 *   which are different sentences on the empty-state screen.
 */

const SITE = '3f2a1c64-9a1a-4e2f-9c1e-2a0f1d3b5c77'
const OWNER = 'u-owner'
const ADMIN = 'u-admin'
const VIEWER = 'u-viewer'
const STRANGER = 'u-stranger'
const CREDENTIAL = '7c9e2f10-0000-4000-8000-0000000c0ffe'

const API_KEY = 'rk_test_restricted_abcdef1234'
const WEBHOOK_SECRET = 'whsec_test_abcdef1234567890'

const memberships = new Map<string, { role: SiteRole; isBillingOwner: boolean }>([
  [OWNER, { role: 'owner', isBillingOwner: true }],
  [ADMIN, { role: 'admin', isBillingOwner: false }],
  [VIEWER, { role: 'viewer', isBillingOwner: false }],
])

function credential(overrides: Partial<RevenueCredentialRow> = {}): RevenueCredentialRow {
  return {
    id: CREDENTIAL,
    siteId: SITE,
    provider: 'stripe',
    encryptedApiKey: 'k1.nonce.payload',
    encryptedWebhookSecret: 'k1.nonce.payload',
    keyVersion: 'k1',
    apiKeyLast4: '1234',
    webhookToken: 'tok_opaque_abcdef',
    status: 'active',
    createdByUserId: OWNER,
    connectedAt: new Date('2026-07-31T00:00:00.000Z'),
    lastVerifiedAt: new Date('2026-07-31T00:00:00.000Z'),
    lastSyncedAt: null,
    lastWebhookAt: null,
    lastError: null,
    disabledAt: null,
    backfillGeneration: 0,
    createdAt: new Date('2026-07-31T00:00:00.000Z'),
    updatedAt: new Date('2026-07-31T00:00:00.000Z'),
    ...overrides,
  }
}

/** What the repository and the provider answer, per test. */
const world = {
  stored: null as RevenueCredentialRow | null,
  live: null as RevenueCredentialRow | null,
  createConflict: false,
  rotateMoves: true,
  webhookSecretMoves: true,
  disconnectMoves: true,
  probe: 'ok' as 'ok' | 'unauthorized' | 'unavailable',
  siteStatus: 'active' as 'active' | 'suspended' | 'deleting' | 'deleted',
}

const calls = {
  created: [] as Record<string, unknown>[],
  rotated: [] as Record<string, unknown>[],
  webhookSecretsSet: [] as Record<string, unknown>[],
  disconnected: [] as Record<string, unknown>[],
  audits: [] as Record<string, unknown>[],
  probed: [] as string[],
}

vi.mock('@openanalytics/postgres', async (importOriginal) => {
  const actual = await importOriginal<typeof PostgresModule>()
  return {
    ...actual,
    getMembership: async (_db: unknown, params: { siteId: string; userId: string }) =>
      memberships.get(params.userId) ?? null,
    getSiteBasics: async (_db: unknown, siteId: string) => ({
      siteId,
      slug: 's',
      name: 'S',
      status: world.siteStatus,
      configVersion: 1,
      publishedImportRunId: null,
      importCutoverDate: null,
    }),
    readRevenueCredential: async () => world.stored,
    readLiveRevenueCredential: async () => world.live,
    createRevenueCredential: async (_db: unknown, input: Record<string, unknown>) => {
      calls.created.push(input)
      if (world.createConflict) return { ok: false, conflict: 'already_connected' }
      return {
        ok: true,
        credential: credential({
          id: input['id'] as string,
          // Echoed rather than defaulted: the response's webhook address is
          // built from the stored row's provider, so a mock that hardcoded one
          // would have reported a Stripe URL for a Polar connection.
          provider: input['provider'] as string,
          webhookToken: input['webhookToken'] as string,
          apiKeyLast4: input['apiKeyLast4'] as string,
          // Null when the connect carried no signing secret — step one of two.
          encryptedWebhookSecret: input['encryptedWebhookSecret'] as string | null,
        }),
      }
    },
    rotateRevenueCredential: async (_db: unknown, input: Record<string, unknown>) => {
      calls.rotated.push(input)
      return world.rotateMoves
        ? credential({ apiKeyLast4: input['apiKeyLast4'] as string, status: 'active' })
        : null
    },
    setRevenueWebhookSecret: async (_db: unknown, input: Record<string, unknown>) => {
      calls.webhookSecretsSet.push(input)
      return world.webhookSecretMoves
        ? credential({
            encryptedWebhookSecret: input['encryptedWebhookSecret'] as string,
            keyVersion: input['keyVersion'] as string,
          })
        : null
    },
    disconnectRevenueCredential: async (_db: unknown, input: Record<string, unknown>) => {
      calls.disconnected.push(input)
      return world.disconnectMoves
    },
    writeAudit: async (_db: unknown, entry: Record<string, unknown>) => {
      calls.audits.push(entry)
    },
  }
})

const { createApp } = await import('../../apps/api/src/app.ts')

const adapter: RevenueAdapter = fakeRevenueAdapter({
  verifyCredential: async (secretKey) => {
    calls.probed.push(secretKey)
    await Promise.resolve()
    if (world.probe === 'ok') return { outcome: 'ok' }
    return { outcome: world.probe, detail: `stripe responded ${world.probe}` }
  },
})

/** The second available provider, so the connect path is exercised for a
 * provider whose id is not the one every other assertion here uses. */
const polarAdapter: RevenueAdapter = fakeRevenueAdapter({
  providerId: 'polar',
  verifyCredential: async (secretKey) => {
    calls.probed.push(secretKey)
    await Promise.resolve()
    if (world.probe === 'ok') return { outcome: 'ok' }
    return { outcome: world.probe, detail: `polar responded ${world.probe}` }
  },
})

const vault = createCredentialVault(
  JSON.stringify({ active: 'k1', keys: { k1: randomBytes(32).toString('base64') } }),
)

const auth = {
  api: {
    getSession: async ({ headers }: { headers: Headers }) => {
      const id = headers.get('x-test-user')
      if (id === null) return null
      return {
        user: {
          id,
          email: `${id}@example.test`,
          emailVerified: true,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
        },
        session: { createdAt: new Date() },
      }
    },
  },
  handler: async () => new Response(null),
} as unknown as Auth

const db = {
  transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => await fn(db),
} as unknown as Database

const { logger } = createCapturedLogger()
const env = loadServiceEnv('api', testEnv({ AUTH_BASE_URL: 'https://api.example.test' }))
const service = createServiceMetadata({ name: 'api', version: '0.0.0-test', environment: 'test' })

const app = createApp({
  service,
  logger,
  env,
  auth,
  db,
  revenue: { vault, adapters: createRevenueAdapterRegistry([adapter, polarAdapter]) },
})

/** A second app with no keyring: the fail-closed mount. */
const keyringlessApp = createApp({ service, logger, env, auth, db })

/**
 * A third app whose `AUTH_BASE_URL` carries a trailing slash, and a fourth with
 * none set at all — the two shapes an operator can actually produce.
 */
const slashedApp = createApp({
  service,
  logger,
  env: loadServiceEnv('api', testEnv({ AUTH_BASE_URL: 'https://api.example.test/' })),
  auth,
  db,
  revenue: { vault, adapters: createRevenueAdapterRegistry([adapter, polarAdapter]) },
})

const fallbackCapture = createCapturedLogger()
const fallbackApp = createApp({
  service,
  logger: fallbackCapture.logger,
  env: loadServiceEnv('api', testEnv()),
  auth,
  db,
  revenue: { vault, adapters: createRevenueAdapterRegistry([adapter, polarAdapter]) },
})

const call = (
  method: string,
  path: string,
  user: string | null,
  body?: unknown,
  target = app,
): Promise<Response> =>
  Promise.resolve(
    target.fetch(
      new Request(`http://api.test${path}`, {
        method,
        headers: {
          ...(user === null ? {} : { 'x-test-user': user }),
          'content-type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    ),
  )

const CONNECTION = `/v1/sites/${SITE}/revenue/connection`
const errorCode = async (res: Response): Promise<string> =>
  ((await res.json()) as { error: { code: string } }).error.code

beforeEach(() => {
  world.stored = null
  world.live = null
  world.createConflict = false
  world.rotateMoves = true
  world.webhookSecretMoves = true
  world.disconnectMoves = true
  world.probe = 'ok'
  world.siteStatus = 'active'
  calls.created.length = 0
  calls.rotated.length = 0
  calls.webhookSecretsSet.length = 0
  calls.disconnected.length = 0
  calls.audits.length = 0
  calls.probed.length = 0
})

describe('GET /v1/revenue/providers', () => {
  it('needs a session and nothing else', async () => {
    expect(await errorCode(await call('GET', '/v1/revenue/providers', null))).toBe(
      'UNAUTHENTICATED',
    )

    // A stranger to every site can still read it: it is a property of the build,
    // and the picker renders before a site is chosen.
    const res = await call('GET', '/v1/revenue/providers', STRANGER)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: { id: string; available: boolean }[] }
    expect(body.items.map((item) => item.id)).toEqual([
      'stripe',
      'polar',
      'dodo',
      'paddle',
      'lemonsqueezy',
      'creem',
    ])
    expect(body.items.filter((item) => item.available).map((item) => item.id)).toEqual([
      'stripe',
      'polar',
      'dodo',
    ])
    expect(body.items[0]).toEqual({ id: 'stripe', display_name: 'Stripe', available: true })
  })

  it('is reachable on a deployment with no keyring', async () => {
    // The whole reason the catalog mounts unconditionally: behind the keyring it
    // would 404 mid-configuration, the frontend cannot tell that from "this
    // build is too old", and it would keep rendering the mock list.
    expect(
      (await call('GET', '/v1/revenue/providers', OWNER, undefined, keyringlessApp)).status,
    ).toBe(200)
  })
})

describe('the fail-closed mount', () => {
  it('takes down only the two verbs that encrypt', async () => {
    // The rule is about *writing* a secret, not about the surface. `POST` and
    // `PATCH` need the vault and are simply not registered without it.
    world.stored = credential()
    world.live = credential()

    expect(
      (
        await call(
          'POST',
          CONNECTION,
          OWNER,
          { provider: 'stripe', api_key: API_KEY, webhook_secret: WEBHOOK_SECRET },
          keyringlessApp,
        )
      ).status,
    ).toBe(404)
    expect(
      (await call('PATCH', CONNECTION, OWNER, { api_key: API_KEY }, keyringlessApp)).status,
    ).toBe(404)
    expect(calls.created).toHaveLength(0)
    expect(calls.rotated).toHaveLength(0)
  })

  it('keeps the status read and, above all, the disconnect', async () => {
    // Neither touches the vault — the read renders columns and disconnect *nulls*
    // the ciphertext columns rather than decrypting them — and losing the ability
    // to cut a live provider link because a secret went missing would be exactly
    // backwards.
    world.stored = credential()
    world.live = credential()

    const read = await call('GET', CONNECTION, OWNER, undefined, keyringlessApp)
    expect(read.status).toBe(200)
    expect(((await read.json()) as Record<string, unknown>)['status']).toBe('active')

    expect((await call('DELETE', CONNECTION, OWNER, undefined, keyringlessApp)).status).toBe(204)
    expect(calls.disconnected).toHaveLength(1)
  })
})

describe('authorization', () => {
  it('refuses a viewer on every verb, including the read', async () => {
    // `credentials:manage` is owner and admin. The read is gated too, because it
    // carries `webhook_url` — the address a signed provider payload lands on.
    world.stored = credential()
    world.live = credential()
    for (const [method, body] of [
      ['GET', undefined],
      ['POST', { provider: 'stripe', api_key: API_KEY, webhook_secret: WEBHOOK_SECRET }],
      ['PATCH', { api_key: API_KEY }],
      ['DELETE', undefined],
    ] as const) {
      const res = await call(method, CONNECTION, VIEWER, body)
      expect(res.status, method).toBe(403)
      expect(await errorCode(res), method).toBe('FORBIDDEN')
    }
    expect(calls.created).toHaveLength(0)
    expect(calls.disconnected).toHaveLength(0)
  })

  it('admits an admin, because managing a credential is not reading revenue', async () => {
    world.stored = credential()
    expect((await call('GET', CONNECTION, ADMIN)).status).toBe(200)
  })

  it('answers SITE_NOT_FOUND to a non-member rather than revealing the site', async () => {
    const res = await call('GET', CONNECTION, STRANGER)
    expect(res.status).toBe(404)
    expect(await errorCode(res)).toBe('SITE_NOT_FOUND')
  })

  it('needs a session', async () => {
    expect(await errorCode(await call('GET', CONNECTION, null))).toBe('UNAUTHENTICATED')
  })
})

describe('GET the connection', () => {
  it('distinguishes never-connected from disconnected', async () => {
    world.stored = null
    expect(await (await call('GET', CONNECTION, OWNER)).json()).toEqual({ status: 'not_connected' })

    world.stored = credential({ status: 'disabled', disabledAt: new Date(), lastError: null })
    const body = (await (await call('GET', CONNECTION, OWNER)).json()) as Record<string, unknown>
    expect(body['status']).toBe('disabled')
    // The token still exists on the row so a late provider POST is acked rather
    // than retried, but it is not published beside a dead connection.
    expect(body['webhook_url']).toBeNull()
  })

  it('reports a degraded connection with its last successful sync intact', async () => {
    // The milestone's whole point: an outage is a status carrying when the data
    // was last actually correct, never a revenue of zero.
    world.stored = credential({
      status: 'degraded',
      lastError: 'provider_unauthorized',
      lastSyncedAt: new Date('2026-07-30T12:00:00.000Z'),
    })
    const body = (await (await call('GET', CONNECTION, OWNER)).json()) as Record<string, unknown>
    expect(body['status']).toBe('degraded')
    expect(body['last_error']).toBe('provider_unauthorized')
    expect(body['last_synced_at']).toBe('2026-07-30T12:00:00.000Z')
  })

  it('builds the webhook URL on the api origin, not the frontend one', async () => {
    // ADR-0019: APP_BASE_URL is the dashboard; the webhook is delivered here.
    world.stored = credential({ webhookToken: 'tok_opaque_abcdef' })
    const body = (await (await call('GET', CONNECTION, OWNER)).json()) as Record<string, unknown>
    expect(body['webhook_url']).toBe(
      'https://api.example.test/v1/revenue/webhooks/stripe/tok_opaque_abcdef',
    )
  })

  it('survives a trailing slash on the configured base', async () => {
    // A human is about to paste this into Stripe. String concatenation would
    // give them a doubled separator; `new URL(path, base)` cannot.
    world.stored = credential({ webhookToken: 'tok_opaque_abcdef' })
    const body = (await (
      await call('GET', CONNECTION, OWNER, undefined, slashedApp)
    ).json()) as Record<string, unknown>
    expect(body['webhook_url']).toBe(
      'https://api.example.test/v1/revenue/webhooks/stripe/tok_opaque_abcdef',
    )
  })

  it('warns when it has only the localhost fallback to build from', async () => {
    // Silence here would mean handing a customer a URL pointing at our own
    // loopback interface inside a perfectly successful-looking 200.
    world.stored = credential({ webhookToken: 'tok_opaque_abcdef' })
    const body = (await (
      await call('GET', CONNECTION, OWNER, undefined, fallbackApp)
    ).json()) as Record<string, unknown>
    expect(body['webhook_url']).toBe(
      'http://localhost:3000/v1/revenue/webhooks/stripe/tok_opaque_abcdef',
    )
    expect(fallbackCapture.find('revenue_webhook_url_uses_fallback_base')).not.toHaveLength(0)
  })
})

describe('POST — connect', () => {
  const connect = (body: unknown, user = OWNER) => call('POST', CONNECTION, user, body)
  const validBody = { provider: 'stripe', api_key: API_KEY, webhook_secret: WEBHOOK_SECRET }

  it('probes, encrypts under the row-bound AAD, and stores', async () => {
    const res = await connect(validBody)
    expect(res.status).toBe(201)
    expect(calls.probed).toEqual([API_KEY])
    expect(calls.created).toHaveLength(1)

    const input = calls.created[0] as Record<string, string>
    expect(input['keyVersion']).toBe('k1')
    expect(input['apiKeyLast4']).toBe('1234')
    // 32 random bytes, base64url — one address per site, so a leaked signing
    // secret has a blast radius of one site rather than of the platform.
    expect(input['webhookToken']).toMatch(/^[A-Za-z0-9_-]{43}$/u)

    // The AAD is what stops a ciphertext being replayed onto another row, so the
    // route must bind the id it is about to insert under.
    const aad = `revenue_credential:${input['id']}:${SITE}`
    expect(vault.decrypt(input['encryptedApiKey'] as string, aad)).toEqual({
      ok: true,
      plaintext: API_KEY,
    })
    expect(vault.decrypt(input['encryptedWebhookSecret'] as string, aad)).toEqual({
      ok: true,
      plaintext: WEBHOOK_SECRET,
    })
    // ...and it does not decrypt under any other row's binding.
    expect(
      vault.decrypt(input['encryptedApiKey'] as string, `revenue_credential:other:${SITE}`).ok,
    ).toBe(false)
  })

  it('never returns either secret, in any response field', async () => {
    const res = await connect(validBody)
    const text = await res.text()
    expect(text).not.toContain(API_KEY)
    expect(text).not.toContain(WEBHOOK_SECRET)
    // Only the display tail, which is four characters of a key that is long
    // enough for four characters to be a tail.
    expect(JSON.parse(text)['api_key_last4']).toBe('1234')
  })

  it('connects the SECOND provider, which is the whole claim of the flip', async () => {
    // Polar moved from `available: false` to `available: true` in the catalog
    // and gained an adapter in both composition roots. Nothing else about this
    // route changed — the same probe, the same AAD, the same stored shape — and
    // that is the point: a second provider is a descriptor and an adapter.
    const res = await connect({ ...validBody, provider: 'polar' })
    expect(res.status).toBe(201)
    expect(calls.probed).toEqual([API_KEY])
    expect(calls.created[0]).toMatchObject({ provider: 'polar' })

    // The webhook address is per provider, so a customer pasting it into Polar
    // cannot land on the Stripe adapter.
    const body = (await res.json()) as Record<string, unknown>
    expect(body['webhook_url']).toContain('/v1/revenue/webhooks/polar/')
  })

  it.each([
    ['an unknown provider', { ...validBody, provider: 'not-a-provider' }, 'unknown'],
    ['a provider with no adapter yet', { ...validBody, provider: 'paddle' }, 'unavailable'],
  ])('refuses %s before it can reach a provider', async (_label, body, code) => {
    const res = await connect(body)
    expect(res.status).toBe(400)
    expect(await errorCode(res)).toBe('VALIDATION_FAILED')
    // Nothing was probed and nothing was stored: an unavailable provider means
    // this build has no adapter, so a stored credential would fail forever.
    expect(calls.probed).toHaveLength(0)
    expect(calls.created).toHaveLength(0)
    void code
  })

  it.each(['api_key', 'webhook_secret'])('requires a non-empty %s', async (field) => {
    const res = await connect({ ...validBody, [field]: '   ' })
    expect(res.status).toBe(400)
    expect(await errorCode(res)).toBe('VALIDATION_FAILED')
    expect(calls.probed).toHaveLength(0)
  })

  it('answers 422 and stores nothing when the provider rejects the key', async () => {
    world.probe = 'unauthorized'
    const res = await connect(validBody)
    expect(res.status).toBe(422)
    expect(await errorCode(res)).toBe('REVENUE_CREDENTIAL_REJECTED')
    expect(calls.created).toHaveLength(0)
    // Audited, because a repeated verify failure is the one part of this flow
    // that would otherwise leave no row behind to notice it by.
    expect(calls.audits.map((a) => a['action'])).toContain('site.revenue.verify_failed')
    // ...and the audit trail never carries the key either.
    expect(JSON.stringify(calls.audits)).not.toContain(API_KEY)
  })

  it('answers a retryable 503 and stores nothing when the provider is unreachable', async () => {
    // Emphatically not a rejected credential: reporting an outage as the
    // customer's mistake is the failure mode snapshot 01 §12.3 records.
    world.probe = 'unavailable'
    const res = await connect(validBody)
    expect(res.status).toBe(503)
    expect(await errorCode(res)).toBe('PROVIDER_UNAVAILABLE')
    expect(calls.created).toHaveLength(0)
  })

  it('surfaces a second connection as its own conflict code', async () => {
    // Decided by the partial unique inside the repository, not by a read here:
    // two concurrent connects would otherwise each find nothing and both insert.
    world.createConflict = true
    const res = await connect(validBody)
    expect(res.status).toBe(409)
    expect(await errorCode(res)).toBe('REVENUE_ALREADY_CONNECTED')
  })
})

describe('the two-step connect (CP6)', () => {
  beforeEach(() => {
    world.live = credential()
  })

  it('connects with the API key alone and hands back the URL to finish with', async () => {
    // The ordering knot CP6 closed: a signing secret is readable only AFTER an
    // endpoint exists at `webhook_url`, and that URL is minted by this call.
    world.live = null
    const response = await call('POST', CONNECTION, OWNER, {
      provider: 'stripe',
      api_key: 'rk_live_probe_me',
    })
    expect(response.status).toBe(201)
    const body = (await response.json()) as Record<string, unknown>

    // The probe still gates the connect — nothing about this is a relaxation of
    // "a key that does not work is never written".
    expect(calls.probed).toEqual(['rk_live_probe_me'])
    expect(calls.created).toHaveLength(1)
    // Stored with a null ciphertext rather than a ciphertext of nothing.
    expect(calls.created[0]?.['encryptedWebhookSecret']).toBeNull()

    expect(body['webhook_secret_set']).toBe(false)
    expect(body['webhook_url']).toContain('/v1/revenue/webhooks/stripe/')
    // Active and ingesting: backfill and reconcile run on the API key alone.
    expect(body['status']).toBe('active')
    expect(body['last_webhook_at']).toBeNull()
  })

  it('still refuses a key the provider rejects, secret or no secret', async () => {
    world.live = null
    world.probe = 'unauthorized'
    const response = await call('POST', CONNECTION, OWNER, {
      provider: 'stripe',
      api_key: 'rk_bad',
    })
    expect(response.status).toBe(422)
    expect(calls.created).toHaveLength(0)
  })

  it('refuses a present-but-blank secret rather than storing the ciphertext of nothing', async () => {
    world.live = null
    const response = await call('POST', CONNECTION, OWNER, {
      provider: 'stripe',
      api_key: 'rk_live',
      webhook_secret: '   ',
    })
    expect(response.status).toBe(400)
    expect(calls.created).toHaveLength(0)
  })

  it('accepts a secret on connect when the customer already has one', async () => {
    // Re-connecting a site whose provider endpoint still exists.
    world.live = null
    const response = await call('POST', CONNECTION, OWNER, {
      provider: 'stripe',
      api_key: 'rk_live',
      webhook_secret: 'whsec_existing',
    })
    expect(response.status).toBe(201)
    expect(calls.created[0]?.['encryptedWebhookSecret']).not.toBeNull()
    expect((await response.json())['webhook_secret_set']).toBe(true)
  })

  it('sets the signing secret through PATCH, without re-probing or re-walking', async () => {
    const response = await call('PATCH', CONNECTION, OWNER, {
      webhook_secret: 'whsec_from_stripe',
    })
    expect(response.status).toBe(200)
    expect((await response.json())['webhook_secret_set']).toBe(true)

    expect(calls.webhookSecretsSet).toHaveLength(1)
    expect(calls.webhookSecretsSet[0]?.['siteId']).toBe(SITE)
    // Pasting a signing secret says nothing about whether the API key works, so
    // no probe — and no rotation, which is what would re-enqueue ninety days of
    // provider history for nothing.
    expect(calls.probed).toEqual([])
    expect(calls.rotated).toHaveLength(0)
  })

  it('does both halves when both are sent, rotating first', async () => {
    const response = await call('PATCH', CONNECTION, OWNER, {
      api_key: 'rk_new',
      webhook_secret: 'whsec_new',
    })
    expect(response.status).toBe(200)
    expect(calls.probed).toEqual(['rk_new'])
    expect(calls.rotated).toHaveLength(1)
    expect(calls.webhookSecretsSet).toHaveLength(1)
  })

  it('writes nothing at all when the probe refuses the key half', async () => {
    // The rotation is the half a provider can refuse, so it runs first: a failed
    // probe must leave the row untouched rather than having already written a
    // new signing secret onto it.
    world.probe = 'unauthorized'
    const response = await call('PATCH', CONNECTION, OWNER, {
      api_key: 'rk_bad',
      webhook_secret: 'whsec_new',
    })
    expect(response.status).toBe(422)
    expect(calls.rotated).toHaveLength(0)
    expect(calls.webhookSecretsSet).toHaveLength(0)
  })

  it('refuses an empty PATCH rather than accepting it as a no-op', async () => {
    const response = await call('PATCH', CONNECTION, OWNER, {})
    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe('VALIDATION_FAILED')
    expect(calls.rotated).toHaveLength(0)
    expect(calls.webhookSecretsSet).toHaveLength(0)
  })

  it('reports a disconnect that won the race as a 404, not a resurrection', async () => {
    world.webhookSecretMoves = false
    const response = await call('PATCH', CONNECTION, OWNER, {
      webhook_secret: 'whsec_new',
    })
    expect(response.status).toBe(404)
  })

  it('never returns the signing secret, only whether one is set', async () => {
    const response = await call('PATCH', CONNECTION, OWNER, {
      webhook_secret: 'whsec_super_secret_value',
    })
    const text = await response.text()
    expect(text).not.toContain('whsec_super_secret_value')
    expect(text).toContain('webhook_secret_set')
  })

  it('reports webhook_secret_set on the GET, both ways', async () => {
    world.stored = credential({ encryptedWebhookSecret: null })
    const unset = await call('GET', CONNECTION, OWNER)
    expect((await unset.json())['webhook_secret_set']).toBe(false)

    world.stored = credential({ encryptedWebhookSecret: 'k1.nonce.payload' })
    const set = await call('GET', CONNECTION, OWNER)
    expect((await set.json())['webhook_secret_set']).toBe(true)
  })
})

describe('the site id the AAD is built from', () => {
  const validBody = { provider: 'stripe', api_key: API_KEY, webhook_secret: WEBHOOK_SECRET }

  it('is canonical whatever spelling the URL used', async () => {
    // Postgres's `uuid` type accepts uppercase, brace-wrapped and hyphen-free
    // spellings and normalizes them, so an uppercase URL resolves the same row.
    // Harmless — until something derives a *string* from the path spelling, which
    // is exactly what the credential AAD does. A credential encrypted through an
    // uppercase URL would be bound to an AAD no later request reproduces, and the
    // ciphertext would be permanently undecryptable.
    const res = await call(
      'POST',
      `/v1/sites/${SITE.toUpperCase()}/revenue/connection`,
      OWNER,
      validBody,
    )
    expect(res.status).toBe(201)

    const input = calls.created[0] as Record<string, string>
    expect(input['siteId']).toBe(SITE)
    expect(
      vault.decrypt(
        input['encryptedApiKey'] as string,
        `revenue_credential:${input['id']}:${SITE}`,
      ),
    ).toEqual({ ok: true, plaintext: API_KEY })
  })

  it('answers SITE_NOT_FOUND to a path segment that is not a site id', async () => {
    // The same answer a site the caller cannot see gets: "that is not a uuid" and
    // "you cannot see it" are one answer to a caller holding an id, and a 400
    // would distinguish them.
    const res = await call('GET', '/v1/sites/not-a-uuid/revenue/connection', OWNER)
    expect(res.status).toBe(404)
    expect(await errorCode(res)).toBe('SITE_NOT_FOUND')
  })
})

describe('a site on its way out', () => {
  const validBody = { provider: 'stripe', api_key: API_KEY, webhook_secret: WEBHOOK_SECRET }

  it.each(['deleting', 'deleted'] as const)(
    'refuses a connect and a rotate on a %s site',
    async (status) => {
      // A credential stored after `startSiteDeletion` erased the ones the site
      // had would sit decryptable for the whole length of the purge and then be
      // removed by a target that had already been verified.
      world.siteStatus = status
      world.live = credential()

      const connected = await call('POST', CONNECTION, OWNER, validBody)
      expect(connected.status).toBe(404)
      expect(await errorCode(connected)).toBe('SITE_NOT_FOUND')

      const rotated = await call('PATCH', CONNECTION, OWNER, { api_key: API_KEY })
      expect(rotated.status).toBe(404)
      expect(await errorCode(rotated)).toBe('SITE_NOT_FOUND')

      // Refused before the provider is ever contacted.
      expect(calls.probed).toHaveLength(0)
      expect(calls.created).toHaveLength(0)
      expect(calls.rotated).toHaveLength(0)
    },
  )

  it('still lets a billing-blocked site connect, rotate and disconnect', async () => {
    // The refusal is `requireAnalyticsAccess` WITHOUT its `suspended`
    // branch: managing a credential is not a read of revenue, and severing a
    // provider link must never be something a customer has to pay to do.
    world.siteStatus = 'suspended'
    world.live = credential()

    expect((await call('POST', CONNECTION, OWNER, validBody)).status).toBe(201)
    expect((await call('PATCH', CONNECTION, OWNER, { api_key: API_KEY })).status).toBe(200)
    expect((await call('DELETE', CONNECTION, OWNER)).status).toBe(204)
  })

  it('lets a deleting site still disconnect', async () => {
    // No guard on DELETE, and the same argument: a site being erased is one
    // whose credentials should stop working sooner rather than later.
    world.siteStatus = 'deleting'
    world.live = credential()
    expect((await call('DELETE', CONNECTION, OWNER)).status).toBe(204)
  })
})

describe('PATCH — rotate', () => {
  const NEW_KEY = 'rk_test_rotated_zzzz9876'

  it('probes the new key, swaps the ciphertext and leaves the webhook alone', async () => {
    world.live = credential()
    const res = await call('PATCH', CONNECTION, OWNER, { api_key: NEW_KEY })
    expect(res.status).toBe(200)
    expect(calls.probed).toEqual([NEW_KEY])

    const input = calls.rotated[0] as Record<string, string>
    expect(input['credentialId']).toBe(CREDENTIAL)
    expect(input['apiKeyLast4']).toBe('9876')
    expect(
      vault.decrypt(input['encryptedApiKey'] as string, `revenue_credential:${CREDENTIAL}:${SITE}`),
    ).toEqual({ ok: true, plaintext: NEW_KEY })
    // No webhook secret in the rotation input at all: rotating a provider key
    // does not change the endpoint's signing secret.
    expect(input['encryptedWebhookSecret']).toBeUndefined()

    const body = (await res.json()) as Record<string, unknown>
    expect(body['api_key_last4']).toBe('9876')
    expect(JSON.stringify(body)).not.toContain(NEW_KEY)
  })

  it('refuses a rejected key without touching the stored one', async () => {
    world.live = credential()
    world.probe = 'unauthorized'
    const res = await call('PATCH', CONNECTION, OWNER, { api_key: NEW_KEY })
    expect(res.status).toBe(422)
    expect(calls.rotated).toHaveLength(0)
  })

  it('404s when there is no live connection to rotate', async () => {
    world.live = null
    const res = await call('PATCH', CONNECTION, OWNER, { api_key: NEW_KEY })
    expect(res.status).toBe(404)
    expect(await errorCode(res)).toBe('NOT_FOUND')
    expect(calls.probed).toHaveLength(0)
  })

  it('reports a disconnect that won the race as a 404 rather than resurrecting', async () => {
    world.live = credential()
    world.rotateMoves = false
    const res = await call('PATCH', CONNECTION, OWNER, { api_key: NEW_KEY })
    expect(res.status).toBe(404)
  })
})

describe('DELETE — disconnect', () => {
  it('disconnects the live credential', async () => {
    world.live = credential()
    const res = await call('DELETE', CONNECTION, OWNER)
    expect(res.status).toBe(204)
    expect(calls.disconnected[0]).toMatchObject({
      credentialId: CREDENTIAL,
      siteId: SITE,
      actorUserId: OWNER,
      reason: 'requested',
    })
  })

  it('404s when nothing is connected', async () => {
    world.live = null
    expect((await call('DELETE', CONNECTION, OWNER)).status).toBe(404)
  })
})
