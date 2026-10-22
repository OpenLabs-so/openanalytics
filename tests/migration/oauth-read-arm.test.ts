import { generateKeyPairSync } from 'node:crypto'
import {
  createAuth,
  drizzleAuthDatabase,
  verifyRealtimeToken,
  type Auth,
} from '@openanalytics/auth'
import { loadServiceEnv } from '@openanalytics/domain'
import { createServiceMetadata } from '@openanalytics/observability'
import {
  addMember,
  chargeReadCost,
  createDatabase,
  createPool,
  createSiteWithOwner,
  issueOAuthAccessToken,
  newId,
  readCostSpent,
  removeMember,
  type Database,
} from '@openanalytics/postgres'
import { applyPostgresStreams } from '../support/postgres-streams.ts'
import { createCapturedLogger, testEnv } from '@openanalytics/testkit'
import { Client, type Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../../apps/api/src/app.ts'

const { publicKey: realtimePublic, privateKey: realtimePrivate } = generateKeyPairSync('ed25519')
const REALTIME_VERIFY_KEY = realtimePublic.export({ type: 'spki', format: 'pem' }).toString()
const REALTIME_SIGNING_KEY = realtimePrivate.export({ type: 'pkcs8', format: 'pem' }).toString()

/**
 * The OAuth arm of `ReadPrincipal` (ADR-0043 D2 and D3), live.
 *
 * ADR-0042 D9 set three conditions on this milestone and two of them are only
 * checkable against a running surface: **the same routes** and **the same
 * response shapes** for both credential kinds. So every claim here is made by
 * driving the real routes with both credentials and comparing.
 *
 * The assertion that matters most is D3's: **a site is authorized from live
 * membership on every request**, so removing a member revokes their access with
 * no token revocation at all. That is the strongest revocation story either
 * credential has, and it is worth nothing if it is not exercised.
 */

const CONNECTION_STRING = process.env['TEST_POSTGRES_URL']
const describeIfPostgres = CONNECTION_STRING ? describe : describe.skip

const ORIGIN = 'http://localhost:3000'
const PASSWORD = 'sup3r-secret-pw'

describeIfPostgres('the OAuth read arm', () => {
  const connectionString = CONNECTION_STRING as string
  const schemaName = `m16arm_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  let pool: Pool
  let db: Database
  let app: ReturnType<typeof createApp>
  const tokens: string[] = []

  let ownerId: string
  let ownerCookie: string
  /** The Better Auth instance the app was built with — the session arm's own
   * resolver, so a test app can be rebuilt with different cost numbers and still
   * resolve the same live session (ADR-0046 D4). */
  let authInstance: Auth
  let siteA: string
  let siteB: string
  /** A site the owner is not a member of, held by somebody else. */
  let strangerSite: string
  let ownerToken: string
  let keyToken: string

  const get = (path: string, headers: Record<string, string> = {}) =>
    app.fetch(new Request(`${ORIGIN}${path}`, { headers: { origin: ORIGIN, ...headers } }))

  const postJson = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    app.fetch(
      new Request(`${ORIGIN}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN, ...headers },
        body: JSON.stringify(body),
      }),
    )

  const asToken = (token: string, siteId?: string): Record<string, string> => ({
    authorization: `Bearer ${token}`,
    ...(siteId === undefined ? {} : { 'x-oa-site': siteId }),
  })

  /**
   * An error body with its `request_id` removed.
   *
   * Every one of these comparisons is about whether two *refusals* are
   * distinguishable to a caller, and `request_id` is per-request by design — it
   * differs between any two responses, including two identical ones, so leaving
   * it in would make every such comparison fail for the one reason that carries
   * no information about the refusal.
   */
  const refusal = async (res: Response): Promise<unknown> => {
    const body = (await res.json()) as { error: Record<string, unknown> }
    const { request_id: _perRequest, ...rest } = body.error
    return { error: rest }
  }

  async function signUpVerifyLogin(email: string): Promise<{ userId: string; cookie: string }> {
    const created = await postJson('/api/auth/sign-up/email', {
      email,
      password: PASSWORD,
      name: 'U',
    })
    const body = (await created.json()) as { user: { id: string } }
    await get(`/api/auth/verify-email?token=${encodeURIComponent(tokens.at(-1) ?? '')}`)
    const loggedIn = await postJson('/api/auth/sign-in/email', { email, password: PASSWORD })
    const cookie = loggedIn.headers
      .getSetCookie()
      .map((raw) => raw.split(';')[0] ?? '')
      .find((pair) => pair.includes('oa_session'))
    return { userId: body.user.id, cookie: cookie as string }
  }

  beforeAll(async () => {
    const admin = new Client({ connectionString })
    await admin.connect()
    try {
      await admin.query(`CREATE SCHEMA ${schemaName}`)
    } finally {
      await admin.end()
    }

    const url = new URL(connectionString)
    url.searchParams.set('options', `-c search_path=${schemaName}`)
    const scoped = url.toString()

    const { logger } = createCapturedLogger()
    await applyPostgresStreams({ connectionString: scoped, logger })

    pool = createPool(scoped)
    db = createDatabase(pool)

    const auth: Auth = createAuth({
      database: drizzleAuthDatabase(db),
      secret: 'test-secret-'.padEnd(32, 'x'),
      baseURL: ORIGIN,
      productName: 'Acme Metrics',
      trustedOrigins: [ORIGIN],
      sendVerificationEmail: async ({ token }) => {
        tokens.push(token)
      },
    })

    const env = loadServiceEnv('api', testEnv())
    const service = createServiceMetadata({
      name: 'api',
      version: '0.0.0-test',
      environment: 'test',
    })
    authInstance = auth
    app = createApp({ service, logger, env, auth, db })

    const owner = await signUpVerifyLogin(`arm-owner-${Date.now()}@example.com`)
    ownerId = owner.userId
    ownerCookie = owner.cookie

    siteA = (
      await createSiteWithOwner(db, { slug: `a-${newId()}`, name: 'Alpha', ownerUserId: ownerId })
    ).siteId
    siteB = (
      await createSiteWithOwner(db, { slug: `b-${newId()}`, name: 'Beta', ownerUserId: ownerId })
    ).siteId

    const stranger = await signUpVerifyLogin(`arm-stranger-${Date.now()}@example.com`)
    strangerSite = (
      await createSiteWithOwner(db, {
        slug: `s-${newId()}`,
        name: 'Stranger',
        ownerUserId: stranger.userId,
      })
    ).siteId

    ownerToken = (
      await issueOAuthAccessToken(db, {
        userId: ownerId,
        clientId: 'oa-cli',
        scope: 'site:read analytics:read',
        accessTokenExpiresInSeconds: 3600,
        refreshTokenExpiresInSeconds: 86_400,
      })
    ).accessToken

    const minted = await postJson(
      `/v1/sites/${siteA}/keys`,
      { type: 'private_read', scopes: ['analytics:read'] },
      { cookie: ownerCookie },
    )
    keyToken = ((await minted.json()) as { raw_token: string }).raw_token
  })

  afterAll(async () => {
    await pool?.end()
    const admin = new Client({ connectionString })
    await admin.connect()
    try {
      await admin.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`)
    } finally {
      await admin.end()
    }
  })

  describe('site selection (D3)', () => {
    it('refuses a token that names no site, naming the header', async () => {
      const res = await get('/v1/read/site', asToken(ownerToken))
      expect(res.status).toBe(400)
      const body = (await res.json()) as { error: { code: string; message: string } }
      expect(body.error.code).toBe('VALIDATION_FAILED')
      // There is no "your first site" default: a CLI reporting on the wrong site
      // silently is worse than one that asks.
      expect(body.error.message).toContain('X-OA-Site')
    })

    it('refuses a key that names one, because the key is the site', async () => {
      const res = await get('/v1/read/site', asToken(keyToken, siteA))
      expect(res.status).toBe(400)
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        'VALIDATION_FAILED',
      )
      // And the same key with no header works, so the refusal is about the
      // header and not about the key.
      expect((await get('/v1/read/site', asToken(keyToken))).status).toBe(200)
    })

    it('reads the site the header names, and each of the user’s sites in turn', async () => {
      for (const [siteId, name] of [
        [siteA, 'Alpha'],
        [siteB, 'Beta'],
      ] as const) {
        const res = await get('/v1/read/site', asToken(ownerToken, siteId))
        expect(res.status).toBe(200)
        const body = (await res.json()) as { site_id: string; name: string }
        expect(body.site_id).toBe(siteId)
        expect(body.name).toBe(name)
      }
    })

    it('gives a site the user is not in the same answer as a malformed id', async () => {
      // The oracle question. A caller holding an id must not be able to tell
      // "that site exists and you cannot see it" from "that is not an id".
      const foreign = await get('/v1/read/site', asToken(ownerToken, strangerSite))
      const nonsense = await get('/v1/read/site', asToken(ownerToken, 'not-a-uuid'))
      const missing = await get('/v1/read/site', asToken(ownerToken, newId()))

      expect(foreign.status).toBe(404)
      expect(nonsense.status).toBe(404)
      expect(missing.status).toBe(404)
      const bodies = await Promise.all([refusal(foreign), refusal(nonsense), refusal(missing)])
      expect(bodies[0]).toEqual(bodies[1])
      expect(bodies[1]).toEqual(bodies[2])
    })

    it('accepts a site id in any spelling Postgres accepts', async () => {
      // `canonicalSiteId`'s reason, on this surface: uppercase and brace-wrapped
      // uuids resolve to the same row, so refusing them here would be a rule the
      // rest of the product does not have.
      const upper = await get('/v1/read/site', asToken(ownerToken, siteA.toUpperCase()))
      expect(upper.status).toBe(200)
      expect(((await upper.json()) as { site_id: string }).site_id).toBe(siteA)
    })
  })

  describe('live membership is the revocation (D3)', () => {
    it('loses one site and keeps the others, with no token revocation at all', async () => {
      const member = await signUpVerifyLogin(`arm-member-${Date.now()}@example.com`)
      await addMember(db, { siteId: siteA, userId: member.userId, role: 'viewer' })
      await addMember(db, { siteId: siteB, userId: member.userId, role: 'viewer' })

      const token = (
        await issueOAuthAccessToken(db, {
          userId: member.userId,
          clientId: 'oa-cli',
          scope: 'site:read',
          accessTokenExpiresInSeconds: 3600,
          refreshTokenExpiresInSeconds: 86_400,
        })
      ).accessToken

      expect((await get('/v1/read/site', asToken(token, siteA))).status).toBe(200)
      expect((await get('/v1/read/site', asToken(token, siteB))).status).toBe(200)

      await removeMember(db, { siteId: siteA, userId: member.userId, actorUserId: ownerId })

      // The same token, unrevoked and unexpired, on the very next request.
      expect(
        (await get('/v1/read/site', asToken(token, siteA))).status,
        'the removed site is gone immediately',
      ).toBe(404)
      expect(
        (await get('/v1/read/site', asToken(token, siteB))).status,
        'their other site is untouched',
      ).toBe(200)

      // And the list agrees with the check — they read the same table.
      const listed = (await (await get('/v1/read/sites', asToken(token, siteB))).json()) as {
        items: { site_id: string }[]
      }
      expect(listed.items.map((item) => item.site_id)).toEqual([siteB])
    })
  })

  describe('GET /v1/read/sites', () => {
    it('works with no site selected at all — it is how you find one', async () => {
      // The defect this pins, shipped and then found by the MCP tool test: the
      // first version required `X-OA-Site` inside the credential resolver, on
      // every path under `/read/*`. That made this route — the one you call
      // *before* you know a site id — demand one. Every other test in this file
      // happened to send the header, so nothing caught it until a tool that
      // legitimately has none called it.
      const res = await get('/v1/read/sites', asToken(ownerToken))
      expect(res.status).toBe(200)
      const body = (await res.json()) as { items: { site_id: string }[] }
      expect(body.items.length).toBeGreaterThan(0)
    })

    it('still refuses a site-scoped read with no site', async () => {
      // The other half: dropping the requirement from the resolver must not have
      // dropped it from the routes that genuinely need one.
      const res = await get('/v1/read/site', asToken(ownerToken))
      expect(res.status).toBe(400)
      expect(((await res.json()) as { error: { message: string } }).error.message).toContain(
        'X-OA-Site',
      )
    })

    it('lists a token’s memberships with the role, and a key’s one site without one', async () => {
      const forToken = (await (await get('/v1/read/sites', asToken(ownerToken, siteA))).json()) as {
        items: { site_id: string; role: string | null }[]
      }
      expect(forToken.items.map((item) => item.site_id).sort()).toEqual([siteA, siteB].sort())
      expect(forToken.items.every((item) => item.role === 'owner')).toBe(true)
      expect(forToken.items.some((item) => item.site_id === strangerSite)).toBe(false)

      const forKey = (await (await get('/v1/read/sites', asToken(keyToken))).json()) as {
        items: { site_id: string; role: string | null }[]
      }
      // One element, not an error and not an empty list: a caller writes one
      // code path for both credential kinds.
      expect(forKey.items).toHaveLength(1)
      expect(forKey.items[0]?.site_id).toBe(siteA)
      // Null, not a fabricated role. A key has no membership, which is the same
      // fact that closes realtime and revenue to it.
      expect(forKey.items[0]?.role).toBeNull()
    })
  })

  describe('one surface, two credentials (ADR-0042 D9)', () => {
    it('answers the same route the same way for both, byte for byte', async () => {
      const viaKey = await get('/v1/read/site', asToken(keyToken))
      const viaToken = await get('/v1/read/site', asToken(ownerToken, siteA))
      expect(viaKey.status).toBe(viaToken.status)
      // The response shape is the credential-independent one D9 required. If a
      // future change added a field on one arm only, this is what fails.
      expect(await viaKey.json()).toEqual(await viaToken.json())
    })

    it('withholds a scope the credential does not carry, on both arms, with 403', async () => {
      // `site:read` only — the scope check is the same middleware for both.
      const narrow = (
        await issueOAuthAccessToken(db, {
          userId: ownerId,
          clientId: 'oa-cli',
          scope: 'site:read',
          accessTokenExpiresInSeconds: 3600,
          refreshTokenExpiresInSeconds: 86_400,
        })
      ).accessToken
      const res = await get(
        '/v1/read/analytics/overview?from=2026-07-16T00:00:00.000Z&to=2026-07-23T00:00:00.000Z&timezone=UTC',
        asToken(narrow, siteA),
      )
      expect(res.status).toBe(403)

      const minted = await postJson(
        `/v1/sites/${siteA}/keys`,
        { type: 'private_read' },
        { cookie: ownerCookie },
      )
      const narrowKey = ((await minted.json()) as { raw_token: string }).raw_token
      const keyRes = await get(
        '/v1/read/analytics/overview?from=2026-07-16T00:00:00.000Z&to=2026-07-23T00:00:00.000Z&timezone=UTC',
        asToken(narrowKey),
      )
      expect(keyRes.status).toBe(403)
      expect(await refusal(keyRes)).toEqual(await refusal(res))
    })
  })

  /**
   * The third arm (ADR-0046 D4), against a real Better Auth session.
   *
   * The stubbed-session tests in the contract project prove the routing; only
   * this one proves the resolver — that `readAuth` reaches the *same*
   * `auth.api.getSession` the dashboard's own guard reaches, and that a browser
   * cookie therefore means here exactly what it means everywhere else.
   */
  describe('the session arm (ADR-0046 D4)', () => {
    const asSession = (siteId?: string): Record<string, string> => ({
      cookie: ownerCookie,
      ...(siteId === undefined ? {} : { 'x-oa-site': siteId }),
    })

    it('answers the same route the same way as the token arm, byte for byte', async () => {
      const viaSession = await get('/v1/read/site', asSession(siteA))
      const viaToken = await get('/v1/read/site', asToken(ownerToken, siteA))
      expect(viaSession.status).toBe(200)
      // D4's whole claim: a session grants nothing new, it removes a reason the
      // surface refused.
      expect(await viaSession.json()).toEqual(await viaToken.json())
    })

    it('never falls back to a live cookie when an Authorization header is present', async () => {
      // The security condition of D4. This browser has a perfectly good session
      // and presents a credential that is not: the credential's answer wins, or
      // a withdrawn token silently keeps working for anybody who is signed in.
      const res = await get('/v1/read/site', {
        ...asSession(siteA),
        authorization: 'Bearer AAAAAAAABBBBBBBBCCCCCCCCDDDDDDDD',
      })
      expect(res.status).toBe(401)
    })

    it('lists the live memberships a session may select', async () => {
      // What makes `list_sites` work, and what lets the model choose a site
      // without the client naming one.
      const res = await get('/v1/read/sites', { cookie: ownerCookie })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { items: { site_id: string; role: string | null }[] }
      expect(body.items.map((item) => item.site_id).sort()).toEqual([siteA, siteB].sort())
      expect(body.items.every((item) => item.role === 'owner')).toBe(true)
    })

    it('checks membership live, and answers a site it is not in like a malformed id', async () => {
      const foreign = await get('/v1/read/site', asSession(strangerSite))
      const nonsense = await get('/v1/read/site', asSession('not-a-uuid'))
      expect(foreign.status).toBe(404)
      expect(await refusal(foreign)).toEqual(await refusal(nonsense))
    })

    it('lets an owner’s session through to the revenue service (ADR-0049 D3)', async () => {
      // The ceiling moved by one scope, and the floor did not move at all. No
      // query gateway is wired here, so the honest answer past both checks is
      // "not available on this deployment" — crucially **not** 403, which is
      // what either the scope or the capability failing would produce.
      const res = await get(
        '/v1/read/revenue/summary?from=2026-08-01T00:00:00.000Z&to=2026-08-06T00:00:00.000Z&timezone=UTC',
        asSession(siteA),
      )
      expect(res.status).toBe(503)
    })

    it('withholds revenue from an admin’s session — the capability, not the scope', async () => {
      // The same session ceiling, a different person: the role is what refuses,
      // and it is read off the live membership `selectSite` already fetched. A
      // scope-shaped message here would mean the ceiling was doing the
      // capability's job and would go on doing it wrongly.
      const admin = await signUpVerifyLogin(`arm-session-admin-${Date.now()}@example.com`)
      await addMember(db, { siteId: siteA, userId: admin.userId, role: 'admin' })
      const res = await get(
        '/v1/read/revenue/summary?from=2026-08-01T00:00:00.000Z&to=2026-08-06T00:00:00.000Z&timezone=UTC',
        { cookie: admin.cookie, 'x-oa-site': siteA },
      )
      expect(res.status).toBe(403)
      const error = ((await res.json()) as { error: { code: string; message: string } }).error
      expect(error.code).toBe('FORBIDDEN')
      expect(error.message).toContain('owner')
      expect(error.message).not.toContain('scope')
    })

    it('still refuses realtime at the scope ceiling', async () => {
      // `realtime:read` is the scope ADR-0049 deliberately did not move. No
      // realtime is configured in this suite, so the route is unregistered and
      // the catch-all answers 404 — asserted as such rather than smuggled past.
      const res = await app.fetch(
        new Request(`${ORIGIN}/v1/read/realtime/token`, {
          method: 'POST',
          headers: { origin: ORIGIN, cookie: ownerCookie, 'x-oa-site': siteA },
        }),
      )
      expect([403, 404]).toContain(res.status)
    })

    it('draws on the same cost ledger under a third prefix, once per read', async () => {
      await pool.query(`DELETE FROM read_cost_ledger`)
      const { logger: quiet } = createCapturedLogger()
      const costed = createApp({
        service: createServiceMetadata({ name: 'api', version: '0', environment: 'test' }),
        logger: quiet,
        env: loadServiceEnv('api', testEnv()),
        auth: authInstance,
        db,
        readKey: {
          rateLimiter: { check: () => ({ allowed: true, retryAfterSeconds: 0 }) },
          cost: { maxRangeDays: 400, dailyBudgetMs: 100_000 },
        },
      })

      // The same person, two of their sites. One row, because the budget belongs
      // to the caller — and the charge lands even though this deployment has no
      // query gateway, because it is in a `finally`: the time was spent.
      for (const siteId of [siteA, siteB]) {
        await costed.fetch(
          new Request(
            `${ORIGIN}/v1/read/analytics/overview?from=2026-07-30T00:00:00.000Z&to=2026-08-06T00:00:00.000Z&timezone=UTC`,
            { headers: { origin: ORIGIN, cookie: ownerCookie, 'x-oa-site': siteId } },
          ),
        )
      }

      const rows = await pool.query<{ credential_key: string; request_count: number }>(
        `SELECT credential_key, request_count FROM read_cost_ledger`,
      )
      expect(rows.rows.length).toBe(1)
      // The third prefix, and the same spelling the rate limiter charges.
      expect(rows.rows[0]?.credential_key).toBe(`user:${ownerId}`)
      expect(rows.rows[0]?.request_count).toBe(2)
      await pool.query(`DELETE FROM read_cost_ledger`)
    })
  })

  describe('the two scopes only a person can hold (D5)', () => {
    /**
     * `realtime:read` and `revenue:read` are the whole of D5, and both closures
     * are the same fact: a key resolves to a site and never to a user.
     *
     * The mint endpoint already refuses to put either on a key (CP2's test), so
     * these assert the *other* half — that the read path refuses them too. Those
     * are different claims, and only the second is what the surface's safety
     * actually rests on: a row edited directly, or a scope later added to
     * `KEY_SCOPES` by accident, would otherwise reach a handler that reads
     * `userId` off a principal that has none.
     */
    const revenueUrl =
      '/v1/read/revenue/summary?from=2026-07-16T00:00:00.000Z&to=2026-07-23T00:00:00.000Z&timezone=UTC'

    const tokenFor = async (userId: string, scope: string): Promise<string> =>
      (
        await issueOAuthAccessToken(db, {
          userId,
          clientId: 'oa-cli',
          scope,
          accessTokenExpiresInSeconds: 3600,
          refreshTokenExpiresInSeconds: 86_400,
        })
      ).accessToken

    /**
     * A second app, with realtime configured.
     *
     * The main harness has no signing key and no cache, so
     * `POST /v1/read/realtime/token` is not registered there — which is itself
     * correct behaviour and asserted below, but it means the *minting* path has
     * to be exercised somewhere else. An in-memory epoch store is enough: what is
     * being tested is that the token is minted from the OAuth user's subject and
     * carries that subject's epoch, not that Redis works.
     */
    const withRealtime = (): ReturnType<typeof createApp> => {
      const epochs = new Map<string, number>()
      const { logger: quiet } = createCapturedLogger()
      return createApp({
        service: createServiceMetadata({ name: 'api', version: '0', environment: 'test' }),
        logger: quiet,
        env: loadServiceEnv('api', {
          ...testEnv(),
          REALTIME_TOKEN_SIGNING_KEY: REALTIME_SIGNING_KEY,
        }),
        db,
        realtime: {
          cache: {
            ensureEpoch: async ({ siteId, subject }: { siteId: string; subject: string }) => {
              const key = `${siteId}:${subject}`
              const existing = epochs.get(key)
              if (existing !== undefined) return existing
              epochs.set(key, 0)
              return 0
            },
          } as never,
          rateLimiter: { check: () => ({ allowed: true, retryAfterSeconds: 0 }) },
        },
      })
    }

    it('mints a realtime token for the OAuth user’s own subject', async () => {
      const app2 = withRealtime()
      const token = await tokenFor(ownerId, 'site:read realtime:read')
      const res = await app2.fetch(
        new Request(`${ORIGIN}/v1/read/realtime/token`, {
          method: 'POST',
          headers: { origin: ORIGIN, ...asToken(token, siteA) },
        }),
      )
      expect(res.status).toBe(200)
      const body = (await res.json()) as { token: string; expires_at: string }

      // The subject is the person, which is the whole of D5: it is what makes
      // `removeMember`'s existing revocation event reach this token without a
      // second mechanism being invented for it.
      const verified = verifyRealtimeToken(body.token, {
        verifyKey: REALTIME_VERIFY_KEY,
        now: new Date(),
        maxTtlSeconds: 60,
      })
      expect(verified.ok, JSON.stringify(verified)).toBe(true)
      if (verified.ok) {
        expect(verified.claims.subject).toBe(ownerId)
        expect(verified.claims.site_id).toBe(siteA)
        expect(verified.claims.scope).toBe('private')
      }
    })

    it('refuses a realtime token to a token without the scope', async () => {
      const app2 = withRealtime()
      const token = await tokenFor(ownerId, 'site:read analytics:read')
      const res = await app2.fetch(
        new Request(`${ORIGIN}/v1/read/realtime/token`, {
          method: 'POST',
          headers: { origin: ORIGIN, ...asToken(token, siteA) },
        }),
      )
      expect(res.status).toBe(403)
    })

    it('refuses a key even where realtime is configured', async () => {
      // The route exists on this app, so a 404 here would be the wrong reason to
      // pass. This is the one place the key refusal is unambiguous.
      const app2 = withRealtime()
      const minted = await postJson(
        `/v1/sites/${siteA}/keys`,
        { type: 'private_read' },
        { cookie: ownerCookie },
      )
      const raw = ((await minted.json()) as { raw_token: string }).raw_token
      await pool.query(
        `UPDATE api_keys SET scopes = ARRAY['site:read','realtime:read']
         WHERE key_hash = encode(sha256($1::bytea), 'hex')`,
        [raw],
      )
      const res = await app2.fetch(
        new Request(`${ORIGIN}/v1/read/realtime/token`, {
          method: 'POST',
          headers: { origin: ORIGIN, ...asToken(raw) },
        }),
      )
      expect(res.status).toBe(403)
      expect(((await res.json()) as { error: { message: string } }).error.message).toContain(
        'OAuth token',
      )
    })

    it('refuses a key on both surfaces, naming a different credential kind', async () => {
      // A key cannot legitimately hold either scope, so the row is written
      // directly — which is exactly the state this check exists for.
      const minted = await postJson(
        `/v1/sites/${siteA}/keys`,
        { type: 'private_read' },
        { cookie: ownerCookie },
      )
      const raw = ((await minted.json()) as { raw_token: string }).raw_token
      await pool.query(
        `UPDATE api_keys SET scopes = ARRAY['site:read','revenue:read','realtime:read']
         WHERE key_hash = encode(sha256($1::bytea), 'hex')`,
        [raw],
      )

      const revenue = await get(revenueUrl, asToken(raw))
      expect(revenue.status).toBe(403)
      expect(((await revenue.json()) as { error: { message: string } }).error.message).toContain(
        'OAuth token',
      )

      const realtime = await app.fetch(
        new Request(`${ORIGIN}/v1/read/realtime/token`, {
          method: 'POST',
          headers: { origin: ORIGIN, ...asToken(raw) },
        }),
      )
      // No realtime is configured in this suite, so the route is not registered
      // and the catch-all answers 404 — which is the honest answer here and is
      // asserted as such rather than smuggled past as a pass.
      expect([403, 404]).toContain(realtime.status)
    })

    it('withholds revenue from an admin who holds the scope — a ceiling, not a floor', async () => {
      const admin = await signUpVerifyLogin(`arm-admin-${Date.now()}@example.com`)
      await addMember(db, { siteId: siteA, userId: admin.userId, role: 'admin' })
      const token = await tokenFor(admin.userId, 'site:read revenue:read')

      const res = await get(revenueUrl, asToken(token, siteA))
      // The scope is present and the role is not enough. This is the single
      // assertion that keeps `revenue:read`-the-scope from becoming a second way
      // to grant what `revenue:read`-the-capability withholds.
      expect(res.status).toBe(403)
      expect(((await res.json()) as { error: { message: string } }).error.message).toContain(
        'owner',
      )
    })

    it('refuses an owner who did not ask for the scope', async () => {
      // The other direction: the role is enough and the scope is absent. Both
      // have to be present, which is what "intersected, never substituted" means.
      const token = await tokenFor(ownerId, 'site:read analytics:read')
      const res = await get(revenueUrl, asToken(token, siteA))
      expect(res.status).toBe(403)
      expect(((await res.json()) as { error: { message: string } }).error.message).toContain(
        'revenue:read scope',
      )
    })

    it('lets an owner who holds the scope through to the service', async () => {
      const token = await tokenFor(ownerId, 'site:read revenue:read')
      const res = await get(revenueUrl, asToken(token, siteA))
      // No query gateway is wired here, so the honest answer is "not available on
      // this deployment" — crucially not 403, which is what either check failing
      // would produce. Without this the three refusals above would pass for a
      // route that refuses everybody.
      expect(res.status).toBe(503)
    })
  })

  describe('the expensive-query gate (D7)', () => {
    const range = (days: number): string => {
      const to = new Date('2026-08-06T00:00:00.000Z')
      const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000)
      return `from=${from.toISOString()}&to=${to.toISOString()}&timezone=UTC`
    }
    const overview = (days: number): string => `/v1/read/analytics/overview?${range(days)}`

    /** An app with a narrow ceiling and a tiny budget, so both gates are reachable. */
    const withCost = (maxRangeDays: number, dailyBudgetMs: number) => {
      const { logger: quiet } = createCapturedLogger()
      return createApp({
        service: createServiceMetadata({ name: 'api', version: '0', environment: 'test' }),
        logger: quiet,
        env: loadServiceEnv('api', testEnv()),
        db,
        readKey: {
          rateLimiter: { check: () => ({ allowed: true, retryAfterSeconds: 0 }) },
          cost: { maxRangeDays, dailyBudgetMs },
        },
      })
    }

    it('refuses a declared range past the ceiling, and says by how much', () => {
      // Asserted through the app rather than through `checkDeclaredRange`, which
      // has its own unit test: what is being pinned here is that the gate is
      // *wired* to the analytics reads, which a pure-function test cannot say.
      return (async () => {
        const app2 = withCost(30, 0)
        const res = await app2.fetch(
          new Request(`${ORIGIN}${overview(400)}`, {
            headers: { origin: ORIGIN, ...asToken(keyToken) },
          }),
        )
        expect(res.status).toBe(400)
        const body = (await res.json()) as {
          error: { code: string; details: { requested_days: number; max_days: number } }
        }
        expect(body.error.code).toBe('RANGE_TOO_LARGE')
        expect(body.error.details.requested_days).toBe(400)
        expect(body.error.details.max_days).toBe(30)
      })()
    })

    it('admits a range at the ceiling, so the refusal is about width and not about the route', async () => {
      const app2 = withCost(30, 0)
      const res = await app2.fetch(
        new Request(`${ORIGIN}${overview(30)}`, {
          headers: { origin: ORIGIN, ...asToken(keyToken) },
        }),
      )
      // 503: no query gateway is wired here. Crucially not 400, which is what a
      // gate that refused everything would produce — without this the assertion
      // above would pass for a broken ceiling.
      expect(res.status).toBe(503)
    })

    it('does not turn a malformed instant into a width complaint', async () => {
      // `new Date('yesterday')` is NaN, and NaN arithmetic would make the span
      // NaN too — which compares false against any ceiling and could just as
      // easily have been written to refuse. The gate steps aside instead and
      // lets `parseRange` name the field.
      //
      // The assertion is negative because this harness has no query gateway, so
      // the request dies at `SERVICE_UNAVAILABLE` before the parser is reached
      // — pre-existing M14 ordering, not something this gate changed. What must
      // never happen is `RANGE_TOO_LARGE`, which would send an integrator
      // looking for a width they do not have.
      const app2 = withCost(30, 0)
      const res = await app2.fetch(
        new Request(`${ORIGIN}/v1/read/analytics/overview?from=yesterday&to=today&timezone=UTC`, {
          headers: { origin: ORIGIN, ...asToken(keyToken) },
        }),
      )
      expect(((await res.json()) as { error: { code: string } }).error.code).not.toBe(
        'RANGE_TOO_LARGE',
      )
    })

    it('charges what a read actually cost, and refuses the next one when the budget is gone', async () => {
      // A budget of one millisecond: the first request is admitted (nothing has
      // been spent yet) and pays for itself, which is the whole shape of D7 —
      // you cannot know a query's cost until you have paid it, so the check is
      // before and the charge is after, and the overshoot is bounded by exactly
      // one request.
      const app2 = withCost(400, 1)
      const first = await app2.fetch(
        new Request(`${ORIGIN}${overview(7)}`, {
          headers: { origin: ORIGIN, ...asToken(keyToken) },
        }),
      )
      expect(first.status, 'the first request is under budget').toBe(503)

      const ledger = await pool.query<{ elapsed_ms: string; request_count: number }>(
        `SELECT elapsed_ms::text, request_count FROM read_cost_ledger WHERE credential_key LIKE 'key:%'`,
      )
      expect(ledger.rows.length).toBeGreaterThan(0)
      // A failed read is charged too: the time was spent, and not charging it
      // would make failure the cheapest way to hold the gateway open.
      expect(ledger.rows[0]?.request_count).toBeGreaterThanOrEqual(1)

      const second = await app2.fetch(
        new Request(`${ORIGIN}${overview(7)}`, {
          headers: { origin: ORIGIN, ...asToken(keyToken) },
        }),
      )
      expect(second.status).toBe(429)
      const body = (await second.json()) as { error: { code: string } }
      expect(body.error.code).toBe('RATE_LIMITED')
      // `Retry-After` points inside the hour, when the oldest bucket ages out.
      const retryAfter = Number(second.headers.get('retry-after'))
      expect(retryAfter).toBeGreaterThan(0)
      expect(retryAfter).toBeLessThanOrEqual(3600)
    })

    it('keys the ledger by the credential, not by the site or the caller’s address', async () => {
      await pool.query(`DELETE FROM read_cost_ledger`)
      const app2 = withCost(400, 100_000)
      const issued = await issueOAuthAccessToken(db, {
        userId: ownerId,
        clientId: 'oa-cli',
        scope: 'site:read analytics:read',
        accessTokenExpiresInSeconds: 3600,
        refreshTokenExpiresInSeconds: 86_400,
      })

      // The same credential, two different sites. One ledger row, because the
      // budget belongs to the caller and not to what they asked about — a
      // per-site key would let one token spend the whole budget on every site it
      // can reach.
      for (const siteId of [siteA, siteB]) {
        await app2.fetch(
          new Request(`${ORIGIN}${overview(7)}`, {
            headers: { origin: ORIGIN, ...asToken(issued.accessToken, siteId) },
          }),
        )
      }

      const rows = await pool.query<{ credential_key: string; request_count: number }>(
        `SELECT credential_key, request_count FROM read_cost_ledger`,
      )
      expect(rows.rows.length).toBe(1)
      // The same spelling the rate limiter charges, so the two gates cannot
      // disagree about who a caller is.
      expect(rows.rows[0]?.credential_key).toMatch(/^oauth:[0-9a-f-]{36}$/u)
      expect(rows.rows[0]?.request_count).toBe(2)
    })

    it('spends nothing and refuses nothing when the budget is disabled', async () => {
      await pool.query(`DELETE FROM read_cost_ledger`)
      const app2 = withCost(400, 0)
      for (let i = 0; i < 3; i += 1) {
        await app2.fetch(
          new Request(`${ORIGIN}${overview(7)}`, {
            headers: { origin: ORIGIN, ...asToken(keyToken) },
          }),
        )
      }
      const rows = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM read_cost_ledger`,
      )
      // Zero means zero: a disabled budget writes no rows at all, rather than
      // writing them and never reading them.
      expect(Number(rows.rows[0]?.n)).toBe(0)
    })

    it('charges a completed read at least one millisecond', async () => {
      // The ledger is denominated in milliseconds, so a read faster than half of
      // one would round to nothing and be free. The two tests above depend on it
      // directly: their first request dies at `SERVICE_UNAVAILABLE` with no
      // gateway to reach, and on a fast host that takes under half a
      // millisecond — a rounded charge leaves the one-millisecond budget
      // untouched and admits the second request instead of refusing it.
      const credentialKey = `key:${newId()}`
      await chargeReadCost(db, { credentialKey, elapsedMs: 0.2 })
      expect(await readCostSpent(db, credentialKey)).toBeGreaterThanOrEqual(1)
    })
  })

  describe('MCP tools are the read routes (plan item 3)', () => {
    /**
     * Plan 04 §Milestone 16 item 3 says the typed tools must "use the same
     * service, metric and cost-limit layer". That is the kind of sentence a
     * milestone can claim without it being true, so it is proven three ways
     * here — and every one of them would be impossible to write honestly against
     * a parallel implementation that merely called the same service methods.
     */
    const rpc = async (
      token: string,
      method: string,
      params?: Record<string, unknown>,
      appOverride?: ReturnType<typeof createApp>,
    ): Promise<{ status: number; body: Record<string, unknown> }> => {
      const target = appOverride ?? app
      const res = await target.fetch(
        new Request(`${ORIGIN}/mcp`, {
          method: 'POST',
          headers: {
            origin: ORIGIN,
            'content-type': 'application/json',
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) }),
        }),
      )
      const text = await res.text()
      return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} }
    }

    it('answers initialize and lists tools with schemas', async () => {
      const init = await rpc(ownerToken, 'initialize')
      expect((init.body['result'] as { protocolVersion: string }).protocolVersion).toBe(
        '2025-06-18',
      )

      const listed = await rpc(ownerToken, 'tools/list')
      const tools = (listed.body['result'] as { tools: { name: string; inputSchema: unknown }[] })
        .tools
      expect(tools.map((tool) => tool.name)).toContain('list_sites')
      expect(tools.map((tool) => tool.name)).toContain('site_overview')
      // Every site-scoped tool requires a site id in its schema, so a model is
      // told rather than discovering it from a 400.
      const overview = tools.find((tool) => tool.name === 'site_overview')
      expect(JSON.stringify(overview?.inputSchema)).toContain('site_id')
      // Revenue's two **aggregates** became tools with ADR-0049, by the named
      // reopening path ADR-0046 D3 left open. The route is what refuses a
      // non-owner, so the catalogue is the same for everybody.
      expect(tools.map((tool) => tool.name)).toContain('revenue_summary')
      expect(tools.map((tool) => tool.name)).toContain('revenue_timeseries')
      // The half ADR-0043 D15 keeps, and realtime, are still not tools: there is
      // no per-customer read on this surface to name, and realtime mints a
      // token rather than returning a read.
      expect(tools.some((tool) => tool.name.includes('transaction'))).toBe(false)
      expect(tools.some((tool) => tool.name.includes('journey'))).toBe(false)
      expect(tools.some((tool) => tool.name.includes('realtime'))).toBe(false)
    })

    it('gives a tool call and the route byte-identical answers', async () => {
      // **Proof one.** The tool dispatches into the route, so the bodies are the
      // same object serialized twice — not two implementations that agree today.
      const viaRoute = await get('/v1/read/sites', asToken(ownerToken, siteA))
      const viaTool = await rpc(ownerToken, 'tools/call', { name: 'list_sites', arguments: {} })
      const content = viaTool.body['result'] as { content: { text: string }[]; isError: boolean }
      expect(content.isError, content.content[0]?.text ?? JSON.stringify(viaTool.body)).toBe(false)
      expect(JSON.parse(content.content[0]?.text ?? '{}')).toEqual(await viaRoute.json())
    })

    it('refuses an unauthenticated call and says where to authenticate', async () => {
      const res = await app.fetch(
        new Request(`${ORIGIN}/mcp`, {
          method: 'POST',
          headers: { origin: ORIGIN, 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
        }),
      )
      expect(res.status).toBe(401)
      // RFC 9728 section 5.1. Without this an MCP host can only report a 401;
      // with it, it can start an authorization flow.
      expect(res.headers.get('www-authenticate')).toContain('resource_metadata=')
    })

    it('refuses a dead token before answering any method, not only on a tool call', async () => {
      /**
       * Found in production, on this milestone's own proof run: a token that had
       * just been withdrawn still got `200` from `tools/list`, because the
       * endpoint checked only that an `Authorization` header was present and
       * left validation to the route each tool dispatches into.
       *
       * Not a data leak — the tool catalogue is static — but a protocol defect,
       * and the protocol is the point: RFC 9728's `401` plus `WWW-Authenticate`
       * is exactly the signal that makes a client re-authorize, and a `200` in
       * its place is a client that never refreshes.
       */
      const doomed = await issueOAuthAccessToken(db, {
        userId: ownerId,
        clientId: 'oa-mcp',
        scope: 'site:read',
        accessTokenExpiresInSeconds: 3600,
        refreshTokenExpiresInSeconds: 86_400,
      })
      expect((await rpc(doomed.accessToken, 'tools/list')).status).toBe(200)

      await pool.query(`DELETE FROM oauth_access_tokens WHERE access_token = $1`, [
        doomed.accessToken,
      ])
      const dead = await rpc(doomed.accessToken, 'tools/list')
      expect(dead.status).toBe(401)

      // An expired one too, which is the case a long-running MCP host actually
      // hits.
      const stale = await issueOAuthAccessToken(db, {
        userId: ownerId,
        clientId: 'oa-mcp',
        scope: 'site:read',
        accessTokenExpiresInSeconds: -60,
        refreshTokenExpiresInSeconds: 86_400,
      })
      expect((await rpc(stale.accessToken, 'initialize')).status).toBe(401)
    })

    it('does not accept a private key: this is an OAuth protected resource', async () => {
      // A key cannot select a site and has `/v1/read` directly. Keeping the rule
      // "OAuth tokens only" is what makes the `WWW-Authenticate` pointer we hand
      // out always the right advice.
      expect((await rpc(keyToken, 'tools/list')).status).toBe(401)
    })

    it('serves protected-resource metadata at the resource root', async () => {
      const res = await get('/.well-known/oauth-protected-resource')
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        resource: string
        authorization_servers: string[]
        scopes_supported: string[]
      }
      expect(body.authorization_servers[0]).toContain('/api/auth')
      // The full grant vocabulary (ADR-0048): this list is where an MCP
      // client learns what it may request, so the OAuth-only scopes must
      // appear here or they never reach the consent screen.
      expect(body.scopes_supported).toEqual([
        'site:read',
        'analytics:read',
        'realtime:read',
        'revenue:read',
        'team:read',
        'sites:write',
        'funnels:write',
        'events:write',
        'widgets:write',
        'share:write',
        'offline_access',
      ])
    })

    it('carries the caller own authorization, so membership decides', async () => {
      // **Proof two.** A site the token's user is not a member of is refused
      // through the tool exactly as through the route — because it *is* the
      // route, and `X-OA-Site` is re-checked against live membership.
      const viaTool = await rpc(ownerToken, 'tools/call', {
        name: 'site_overview',
        arguments: {
          site_id: strangerSite,
          from: '2026-07-16T00:00:00.000Z',
          to: '2026-07-23T00:00:00.000Z',
        },
      })
      const result = viaTool.body['result'] as { content: { text: string }[]; isError: boolean }
      expect(result.isError).toBe(true)
      // A refusal comes back as readable tool content, not as a JSON-RPC error:
      // the model has to be able to read "no such site" and stop asking.
      expect(JSON.parse(result.content[0]?.text ?? '{}')).toMatchObject({
        error: { code: 'SITE_NOT_FOUND' },
      })
    })

    it('spends the same cost budget the routes spend', async () => {
      // **Proof three, and the one plan item 3 actually names.** A tool call
      // charges the ledger, and the *route* is then refused for the same
      // credential. One budget, because there is one code path.
      await pool.query(`DELETE FROM read_cost_ledger`)
      const { logger: quiet } = createCapturedLogger()
      const tiny = createApp({
        service: createServiceMetadata({ name: 'api', version: '0', environment: 'test' }),
        logger: quiet,
        env: loadServiceEnv('api', testEnv()),
        db,
        readKey: {
          rateLimiter: { check: () => ({ allowed: true, retryAfterSeconds: 0 }) },
          cost: { maxRangeDays: 400, dailyBudgetMs: 1 },
        },
      })
      const issued = await issueOAuthAccessToken(db, {
        userId: ownerId,
        clientId: 'oa-mcp',
        scope: 'site:read analytics:read',
        accessTokenExpiresInSeconds: 3600,
        refreshTokenExpiresInSeconds: 86_400,
      })

      await rpc(
        issued.accessToken,
        'tools/call',
        {
          name: 'site_overview',
          arguments: {
            site_id: siteA,
            from: '2026-07-16T00:00:00.000Z',
            to: '2026-07-23T00:00:00.000Z',
          },
        },
        tiny,
      )

      const ledger = await pool.query<{ credential_key: string }>(
        `SELECT credential_key FROM read_cost_ledger`,
      )
      expect(ledger.rows.length, 'the tool call was charged').toBe(1)

      // And now the plain route refuses the same credential — same ledger, same
      // budget, no second accounting.
      const direct = await tiny.fetch(
        new Request(
          `${ORIGIN}/v1/read/analytics/overview?from=2026-07-16T00:00:00.000Z&to=2026-07-23T00:00:00.000Z&timezone=UTC`,
          { headers: { origin: ORIGIN, ...asToken(issued.accessToken, siteA) } },
        ),
      )
      expect(direct.status).toBe(429)
    })

    it('refuses a tool nobody defined, and a call missing its site', async () => {
      const unknown = await rpc(ownerToken, 'tools/call', { name: 'drop_database', arguments: {} })
      expect((unknown.body['error'] as { code: number }).code).toBe(-32602)

      const siteless = await rpc(ownerToken, 'tools/call', {
        name: 'site_overview',
        arguments: { from: '2026-07-16T00:00:00.000Z', to: '2026-07-23T00:00:00.000Z' },
      })
      expect((siteless.body['error'] as { message: string }).message).toContain('site_id')
    })
  })

  describe('the credential itself', () => {
    it('refuses an expired token exactly as it refuses an invented one', async () => {
      const expired = (
        await issueOAuthAccessToken(db, {
          userId: ownerId,
          clientId: 'oa-cli',
          scope: 'site:read',
          accessTokenExpiresInSeconds: -60,
          refreshTokenExpiresInSeconds: 86_400,
        })
      ).accessToken

      const stale = await get('/v1/read/site', asToken(expired, siteA))
      const invented = await get('/v1/read/site', asToken('z'.repeat(32), siteA))
      expect(stale.status).toBe(401)
      expect(invented.status).toBe(401)
      // Indistinguishable: telling somebody holding a stolen string whether it
      // was ever real is a favour we do not owe them.
      expect(await refusal(stale)).toEqual(await refusal(invented))
    })

    it('refuses a deleted token on its next request', async () => {
      const doomed = (
        await issueOAuthAccessToken(db, {
          userId: ownerId,
          clientId: 'oa-cli',
          scope: 'site:read',
          accessTokenExpiresInSeconds: 3600,
          refreshTokenExpiresInSeconds: 86_400,
        })
      ).accessToken
      expect((await get('/v1/read/site', asToken(doomed, siteA))).status).toBe(200)

      await pool.query(`DELETE FROM oauth_access_tokens WHERE access_token = $1`, [doomed])
      expect((await get('/v1/read/site', asToken(doomed, siteA))).status).toBe(401)
    })

    it('refuses an implausible bearer without touching the database', async () => {
      /**
       * The shape gate, made observable.
       *
       * Both a malformed bearer and an unknown-but-plausible one answer `401` on
       * the real app, so "did it query" is invisible there. Against a database
       * that throws on contact, the two separate cleanly: the shape gate still
       * answers `401` because it never asks, and anything reaching the lookup
       * fails loudly instead. Without the gate, the cheapest possible flood —
       * arbitrary strings — would cost one indexed lookup each.
       *
       * A throwing stub rather than a pool pointed at a closed port: an
       * unreachable *socket* leaves a pending connection attempt that keeps the
       * event loop alive long after the assertions pass, which stalls the run.
       * "Any query throws" is also the plainer statement of what is being tested.
       */
      const unreachable = new Proxy(
        {},
        {
          get() {
            throw new Error('the database is unreachable')
          },
        },
      ) as Database
      const { logger: quiet } = createCapturedLogger()
      const offline = createApp({
        service: createServiceMetadata({ name: 'api', version: '0', environment: 'test' }),
        logger: quiet,
        env: loadServiceEnv('api', testEnv()),
        db: unreachable,
      })
      const ask = (bearer: string) =>
        offline.fetch(
          new Request(`${ORIGIN}/v1/read/site`, {
            headers: { origin: ORIGIN, authorization: `Bearer ${bearer}`, 'x-oa-site': siteA },
          }),
        )

      expect((await ask('short')).status, 'too short to be a token').toBe(401)
      expect((await ask('!'.repeat(40))).status, 'not the token alphabet').toBe(401)
      expect((await ask('x'.repeat(200))).status, 'far too long').toBe(401)
      // The control: a well-shaped token does reach the lookup, and the broken
      // database is what answers. If this were also 401, the three cases above
      // would prove nothing.
      expect((await ask('z'.repeat(32))).status, 'a plausible token is looked up').toBe(500)
    })
  })
})
