import { createHash, randomBytes } from 'node:crypto'
import { createAuth, drizzleAuthDatabase, type Auth } from '@openanalytics/auth'
import { loadServiceEnv } from '@openanalytics/domain'
import { createServiceMetadata } from '@openanalytics/observability'
import { createDatabase, createPool, type Database } from '@openanalytics/postgres'
import { applyPostgresStreams } from '../support/postgres-streams.ts'
import { createCapturedLogger, testEnv } from '@openanalytics/testkit'
import { Client, type Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../../apps/api/src/app.ts'
import { InProcessRateLimiter } from '../../apps/api/src/http/rate-limit.ts'

/**
 * RFC 7591 dynamic client registration, end to end (ADR-0047).
 *
 * The chain this file exists to prove is the one reported broken on
 * 2026-08-08: an unknown MCP host discovers the authorization server, registers
 * itself, sends a human through authorize → consent → token, and then calls
 * `/mcp` with what it was issued. Every hop below runs against the real app
 * over a real Postgres, because the claim "one fix, all clients" is a claim
 * about the seams between five endpoints, not about any one of them.
 *
 * The policy table itself (which redirect URIs, which auth methods, which
 * grants) is exhausted in `tests/unit/oauth-registration.test.ts`; this file
 * asserts each refusal class once, at the HTTP boundary.
 */

const CONNECTION_STRING = process.env['TEST_POSTGRES_URL']
const describeIfPostgres = CONNECTION_STRING ? describe : describe.skip

const ORIGIN = 'http://localhost:3000'
const PASSWORD = 'sup3r-secret-pw'
const CALLBACK = 'http://127.0.0.1:9400/callback'

/**
 * Every scope the discovery documents advertise, in order (ADR-0043, ADR-0048
 * D1). A literal rather than the imported constant, so this asserts the
 * *decision* and not that a constant equals itself.
 */
const EXPECTED_SUPPORTED_SCOPES = [
  'openid',
  'profile',
  'email',
  'offline_access',
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
]

/** PKCE, the client's half: a verifier and its S256 challenge. */
function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

describeIfPostgres('dynamic client registration', () => {
  const connectionString = CONNECTION_STRING as string
  const schemaName = `dcr_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  let pool: Pool
  let db: Database
  let app: ReturnType<typeof createApp>
  let limitedApp: ReturnType<typeof createApp>
  const tokens: string[] = []
  let userCookie: string

  const request = (path: string, init: RequestInit = {}) =>
    app.fetch(
      new Request(`${ORIGIN}${path}`, {
        ...init,
        headers: { origin: ORIGIN, ...((init.headers as Record<string, string>) ?? {}) },
      }),
    )

  const postJson = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })

  const postForm = (
    path: string,
    fields: Record<string, string>,
    headers: Record<string, string> = {},
  ) =>
    request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
      body: new URLSearchParams(fields).toString(),
    })

  /** Register a client the way an MCP host does, expecting success. */
  const register = async (
    body: Record<string, unknown> = {},
  ): Promise<{ client_id: string; [key: string]: unknown }> => {
    const res = await postJson('/v1/oauth/register', {
      client_name: 'Claude for Desktop',
      token_endpoint_auth_method: 'none',
      redirect_uris: [CALLBACK],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      ...body,
    })
    expect(res.status, 'registration should succeed').toBe(201)
    return (await res.json()) as { client_id: string }
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
    app = createApp({ service, logger, env, auth, db })

    // A second app over the same database with a deliberately tiny registration
    // budget — what its tests prove is the key's shape, not the number.
    limitedApp = createApp({
      service,
      logger,
      env,
      auth,
      db,
      oauth: {
        registrationRateLimiter: new InProcessRateLimiter({ requestsPerMinute: 2, burst: 2 }),
      },
    })

    const email = `dcr-${Date.now()}@example.com`
    await postJson('/api/auth/sign-up/email', { email, password: PASSWORD, name: 'U' })
    await request(`/api/auth/verify-email?token=${encodeURIComponent(tokens.at(-1) ?? '')}`)
    const loggedIn = await postJson('/api/auth/sign-in/email', { email, password: PASSWORD })
    const cookie = loggedIn.headers
      .getSetCookie()
      .map((raw) => raw.split(';')[0] ?? '')
      .find((pair) => pair.includes('oa_session'))
    expect(cookie).toBeDefined()
    userCookie = cookie as string
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

  describe('discovery', () => {
    it('advertises the registration endpoint and every grantable scope wherever a client looks', async () => {
      // The RFC 8414 document Better Auth serves, which is what Claude read.
      const authServer = await request('/api/auth/.well-known/oauth-authorization-server')
      expect(authServer.status).toBe(200)
      const asDoc = (await authServer.json()) as Record<string, unknown>
      expect(asDoc['registration_endpoint']).toBe(`${ORIGIN}/v1/oauth/register`)
      // The full list, on the live document. `toContain('analytics:read')` was
      // here while ADR-0048's five write scopes were absent from what a client
      // could discover, and it stayed green — a discovery document is a
      // complete statement or it is misleading, so it is asserted completely.
      expect(asDoc['scopes_supported']).toEqual(EXPECTED_SUPPORTED_SCOPES)
      expect(asDoc['token_endpoint_auth_methods_supported']).toEqual(['none'])
      expect(asDoc['code_challenge_methods_supported']).toEqual(['S256'])

      // OIDC discovery agrees — one override, both documents (ADR-0047 D7).
      const openid = await request('/api/auth/.well-known/openid-configuration')
      const oidcDoc = (await openid.json()) as Record<string, unknown>
      expect(oidcDoc['registration_endpoint']).toBe(`${ORIGIN}/v1/oauth/register`)
      expect(oidcDoc['scopes_supported']).toEqual(EXPECTED_SUPPORTED_SCOPES)
    })

    it('advertises the product scopes and offline access to MCP clients', async () => {
      // RFC 9728, at the resource root — the document an MCP host reads to
      // learn what it may ask for. `offline_access` is an authorization-server
      // scope, but belongs here because MCP clients derive their requested
      // scopes from this document and need it for refresh tokens.
      const res = await request('/.well-known/oauth-protected-resource')
      expect(res.status).toBe(200)
      const doc = (await res.json()) as { scopes_supported: string[] }
      expect(doc.scopes_supported).toEqual([
        ...EXPECTED_SUPPORTED_SCOPES.filter((scope) => scope.includes(':')),
        'offline_access',
      ])
    })

    it('serves RFC 8414’s two root spellings by forwarding to the one real document', async () => {
      for (const path of [
        '/.well-known/oauth-authorization-server',
        '/.well-known/oauth-authorization-server/api/auth',
      ]) {
        const res = await request(path)
        expect(res.status, path).toBe(200)
        const doc = (await res.json()) as Record<string, unknown>
        expect(doc['registration_endpoint'], path).toBe(`${ORIGIN}/v1/oauth/register`)
      }
    })

    it('mounts neither of the library’s registration endpoints', async () => {
      // The ungated one (`mcp/register`) is the door this milestone found open;
      // the session-gated one (`oauth2/register`) mints confidential clients.
      // Deleted from the plugins, so there is no route under any spelling.
      const mcpRegister = await postJson('/api/auth/mcp/register', {
        redirect_uris: [CALLBACK],
      })
      expect(mcpRegister.status).toBe(404)
      const oidcRegister = await postJson(
        '/api/auth/oauth2/register',
        { redirect_uris: [CALLBACK] },
        { cookie: userCookie },
      )
      expect(oidcRegister.status).toBe(404)
    })
  })

  describe('the registration endpoint', () => {
    it('registers a public client and writes the row Better Auth reads', async () => {
      const client = await register()
      expect(client.client_id).toMatch(/^dcr_[A-Za-z0-9_-]{22}$/u)
      expect(client['token_endpoint_auth_method']).toBe('none')
      expect(client['client_secret']).toBeUndefined()
      expect(client['client_id_issued_at']).toBeTypeOf('number')
      expect(client['redirect_uris']).toEqual([CALLBACK])

      const row = await pool.query<{
        type: string
        client_secret: string | null
        user_id: string | null
        name: string
      }>(`SELECT type, client_secret, user_id, name FROM oauth_applications WHERE client_id = $1`, [
        client.client_id,
      ])
      expect(row.rows[0]?.type).toBe('public')
      expect(row.rows[0]?.client_secret).toBeNull()
      // Anonymous by construction (ADR-0047 D5) — nobody owns a client, so no
      // registration can ever block an account deletion.
      expect(row.rows[0]?.user_id).toBeNull()
      expect(row.rows[0]?.name).toBe('Claude for Desktop')
    })

    it('never stamps a user, even when a session cookie rides along', async () => {
      const res = await postJson(
        '/v1/oauth/register',
        {
          token_endpoint_auth_method: 'none',
          redirect_uris: ['https://example.com/callback'],
        },
        { cookie: userCookie },
      )
      expect(res.status).toBe(201)
      const { client_id } = (await res.json()) as { client_id: string }
      const row = await pool.query<{ user_id: string | null }>(
        `SELECT user_id FROM oauth_applications WHERE client_id = $1`,
        [client_id],
      )
      expect(row.rows[0]?.user_id).toBeNull()
    })

    it('refuses each policy class with RFC 7591’s vocabulary', async () => {
      // One refusal per class at the HTTP boundary; the exhaustive table lives
      // in the unit test beside the policy.
      const secretful = await postJson('/v1/oauth/register', {
        token_endpoint_auth_method: 'client_secret_basic',
        redirect_uris: [CALLBACK],
      })
      expect(secretful.status).toBe(400)
      expect(((await secretful.json()) as { error: string }).error).toBe('invalid_client_metadata')

      const plainHttp = await postJson('/v1/oauth/register', {
        token_endpoint_auth_method: 'none',
        redirect_uris: ['http://example.com/callback'],
      })
      expect(plainHttp.status).toBe(400)
      expect(((await plainHttp.json()) as { error: string }).error).toBe('invalid_redirect_uri')

      const notJson = await request('/v1/oauth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not json',
      })
      expect(notJson.status).toBe(400)
    })

    it('bounds registrations per address, and refusals never charge the window', async () => {
      const registerFrom = (address: string, redirectUris: unknown = [CALLBACK]) =>
        limitedApp.fetch(
          new Request(`${ORIGIN}/v1/oauth/register`, {
            method: 'POST',
            headers: {
              origin: ORIGIN,
              'content-type': 'application/json',
              'x-real-ip': address,
            },
            body: JSON.stringify({
              token_endpoint_auth_method: 'none',
              redirect_uris: redirectUris,
            }),
          }),
        )

      // Invalid bodies first: judged before the window, so they must not spend
      // the budget the valid registrations below are entitled to.
      for (let i = 0; i < 5; i += 1) {
        expect((await registerFrom('203.0.113.7', 'not-a-list')).status).toBe(400)
      }

      expect((await registerFrom('203.0.113.7')).status).toBe(201)
      expect((await registerFrom('203.0.113.7')).status).toBe(201)
      const refused = await registerFrom('203.0.113.7')
      expect(refused.status).toBe(429)
      expect(refused.headers.get('retry-after')).toBeTruthy()
      expect(((await refused.json()) as { error: string }).error).toBe('too_many_requests')

      // The window is the address's, not the endpoint's.
      expect((await registerFrom('203.0.113.8')).status).toBe(201)
    })
  })

  describe('a registered client, end to end', () => {
    it('runs authorize → consent → token → /mcp, PKCE and all', async () => {
      const client = await register()
      const { verifier, challenge } = pkcePair()
      const resourceMetadata = (await (
        await request('/.well-known/oauth-protected-resource')
      ).json()) as {
        scopes_supported: string[]
      }
      const scope = ['openid', ...resourceMetadata.scopes_supported].join(' ')

      // Authorize, holding a session. The client is not trusted, so Better
      // Auth forwards the browser to our consent page.
      const authorize = await request(
        `/api/auth/oauth2/authorize?${new URLSearchParams({
          response_type: 'code',
          client_id: client.client_id,
          redirect_uri: CALLBACK,
          scope,
          state: 'af0ifjsldkj',
          code_challenge: challenge,
          code_challenge_method: 'S256',
        }).toString()}`,
        { headers: { cookie: userCookie }, redirect: 'manual' },
      )
      expect(authorize.status, await authorize.clone().text()).toBe(302)
      const consentUrl = new URL(authorize.headers.get('location') ?? '')
      expect(consentUrl.pathname).toBe('/oauth/consent')
      const consentCode = consentUrl.searchParams.get('consent_code')
      expect(consentCode).toBeTruthy()

      // The consent page names the client by its registered name, not its id
      // (ADR-0047 D8) — a person can decide about "Claude for Desktop"; nobody
      // can decide about `dcr_kT3…`.
      const consentPage = await request(`/oauth/consent?${consentUrl.searchParams.toString()}`, {
        headers: { cookie: userCookie },
      })
      expect(consentPage.status).toBe(200)
      const consentHtml = await consentPage.text()
      expect(consentHtml).toContain('Claude for Desktop')
      expect(consentHtml).not.toContain(client.client_id)
      expect(consentHtml).toContain('Read your sites’ traffic reports')

      const approved = await postForm(
        '/oauth/consent',
        { consent_code: consentCode ?? '', decision: 'approve' },
        { cookie: userCookie },
      )
      expect(approved.status).toBe(303)
      const callback = new URL(approved.headers.get('location') ?? '')
      expect(`${callback.origin}${callback.pathname}`).toBe(CALLBACK)
      expect(callback.searchParams.get('state')).toBe('af0ifjsldkj')
      const code = callback.searchParams.get('code')
      expect(code).toBeTruthy()

      // The token exchange is the library's, and PKCE is not optional for a
      // public client: the same code without a verifier is refused.
      const noVerifier = await postForm('/api/auth/oauth2/token', {
        grant_type: 'authorization_code',
        code: code ?? '',
        redirect_uri: CALLBACK,
        client_id: client.client_id,
      })
      expect(noVerifier.status).toBeGreaterThanOrEqual(400)

      const exchanged = await postForm('/api/auth/oauth2/token', {
        grant_type: 'authorization_code',
        code: code ?? '',
        redirect_uri: CALLBACK,
        client_id: client.client_id,
        code_verifier: verifier,
      })
      expect(exchanged.status, await exchanged.clone().text()).toBe(200)
      const issued = (await exchanged.json()) as {
        access_token: string
        refresh_token?: string
        scope: string
      }
      expect(issued.access_token).toBeTruthy()
      expect(issued.refresh_token).toBeTruthy()

      // The point of the whole chain: the token opens `/mcp`.
      const mcp = await postJson(
        '/mcp',
        { jsonrpc: '2.0', id: 1, method: 'tools/list' },
        { authorization: `Bearer ${issued.access_token}` },
      )
      expect(mcp.status).toBe(200)
      const toolList = (await mcp.json()) as {
        result: { tools: { name: string }[] }
      }
      expect(toolList.result.tools.map((tool) => tool.name)).toContain('list_sites')

      // And the client keeps itself alive the library's way — the refresh
      // grant, against the standard token endpoint, still no secret.
      const refreshed = await postForm('/api/auth/oauth2/token', {
        grant_type: 'refresh_token',
        refresh_token: issued.refresh_token ?? '',
        client_id: client.client_id,
      })
      expect(refreshed.status, await refreshed.clone().text()).toBe(200)
      const renewed = (await refreshed.json()) as {
        access_token: string
        refresh_token: string
      }
      expect(renewed.access_token).toBeTruthy()
      expect(renewed.access_token).not.toBe(issued.access_token)
      expect(renewed.refresh_token).toBeTruthy()
      expect(renewed.refresh_token).not.toBe(issued.refresh_token)

      const refreshedMcp = await postJson(
        '/mcp',
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        { authorization: `Bearer ${renewed.access_token}` },
      )
      expect(refreshedMcp.status).toBe(200)
    })

    it('shows a write scope on the consent screen, grants it, and the read narrowings ignore it (ADR-0048 CP1)', async () => {
      const client = await register({ client_name: 'Funnel Writer' })
      const { verifier, challenge } = pkcePair()

      const authorize = await request(
        `/api/auth/oauth2/authorize?${new URLSearchParams({
          response_type: 'code',
          client_id: client.client_id,
          redirect_uri: CALLBACK,
          scope: 'openid analytics:read funnels:write',
          code_challenge: challenge,
          code_challenge_method: 'S256',
        }).toString()}`,
        { headers: { cookie: userCookie }, redirect: 'manual' },
      )
      expect(authorize.status, await authorize.clone().text()).toBe(302)
      const consentUrl = new URL(authorize.headers.get('location') ?? '')

      // The consent screen renders the write scope as a sentence a person can
      // decide about — the whole reason the scope names exist (ADR-0048 D1).
      const consentPage = await request(`/oauth/consent?${consentUrl.searchParams.toString()}`, {
        headers: { cookie: userCookie },
      })
      const consentHtml = await consentPage.text()
      expect(consentHtml).toContain('Create, edit and archive funnels')
      expect(consentHtml).toContain('Read your sites’ traffic reports')

      const approved = await postForm(
        '/oauth/consent',
        { consent_code: consentUrl.searchParams.get('consent_code') ?? '', decision: 'approve' },
        { cookie: userCookie },
      )
      expect(approved.status).toBe(303)
      const code = new URL(approved.headers.get('location') ?? '').searchParams.get('code')

      const exchanged = await postForm('/api/auth/oauth2/token', {
        grant_type: 'authorization_code',
        code: code ?? '',
        redirect_uri: CALLBACK,
        client_id: client.client_id,
        code_verifier: verifier,
      })
      expect(exchanged.status, await exchanged.clone().text()).toBe(200)
      const issued = (await exchanged.json()) as { access_token: string; scope: string }
      // The grant string carries the write scope…
      expect(issued.scope).toContain('funnels:write')

      // …and until the grant arm exists (CP2), it confers nothing anywhere:
      // the read surface and MCP narrow through `readScopesFromGrant`, which
      // cannot name it. Analytics still works; the scope is an inert string.
      const mcp = await postJson(
        '/mcp',
        { jsonrpc: '2.0', id: 7, method: 'tools/list' },
        { authorization: `Bearer ${issued.access_token}` },
      )
      expect(mcp.status).toBe(200)
    })

    it('refuses an authorization for a redirect URI the client did not register', async () => {
      const client = await register()
      const { challenge } = pkcePair()
      const authorize = await request(
        `/api/auth/oauth2/authorize?${new URLSearchParams({
          response_type: 'code',
          client_id: client.client_id,
          redirect_uri: 'http://127.0.0.1:9999/other',
          scope: 'openid site:read',
          code_challenge: challenge,
          code_challenge_method: 'S256',
        }).toString()}`,
        { headers: { cookie: userCookie }, redirect: 'manual' },
      )
      // Refused, not redirected to the attacker's URI: whatever the exact
      // status, no code may travel to an unregistered destination.
      const location = authorize.headers.get('location') ?? ''
      expect(location).not.toContain('127.0.0.1:9999')
      expect(location).not.toContain('code=')
    })
  })
})
