import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { ERROR_CODES, statusForErrorCode } from '@openanalytics/contracts'
import { REVENUE_PROVIDERS } from '@openanalytics/domain'
import { describe, expect, it } from 'vitest'

const SPEC_PATH = fileURLToPath(
  new URL('../../packages/contracts/openapi/openapi.yaml', import.meta.url),
)

/**
 * The revenue connection contract (ADR-0033, D1/D3/D7).
 *
 * The contract is edited before the implementation (AGENTS.md), so this asserts
 * the document. Two of its claims are worth a test rather than a review comment:
 *
 * - **`RevenueConnection` has no field that could carry a secret.** The document
 *   is what the frontend generates a client from, so a stray `api_key` property
 *   here would be a typed invitation to render one.
 * - The **two new error codes** exist in the catalog, in the document, and at
 *   the statuses their recoveries depend on. A 503 and a 422 are different
 *   client branches — retry versus fix the key — and the whole reason the codes
 *   are separate.
 */

async function spec(): Promise<string> {
  return await readFile(SPEC_PATH, 'utf8')
}

/**
 * One schema's own body — from its key to the next sibling schema.
 *
 * Bounded rather than a fixed window, because the assertions below are mostly
 * negative ("no field of this object could carry a secret") and a window that
 * overran into the next schema would pass while asserting nothing.
 */
function schemaBlock(text: string, name: string): string {
  const marker = `\n    ${name}:\n`
  const at = text.indexOf(marker)
  expect(at, `openapi.yaml is missing schema ${name}`).toBeGreaterThan(-1)
  const rest = text.slice(at + marker.length)
  const next = /\n {4}[A-Za-z][A-Za-z0-9]*:\n/u.exec(rest)
  return rest.slice(0, next?.index ?? rest.length)
}

/** A fixed window from an arbitrary marker, for path items rather than schemas. */
function blockFrom(text: string, marker: string, length = 3_000): string {
  const at = text.indexOf(marker)
  expect(at, `openapi.yaml is missing ${marker}`).toBeGreaterThan(-1)
  return text.slice(at, at + length)
}

describe('OpenAPI documents the revenue operations', () => {
  it('declares all five operationIds exactly once', async () => {
    const text = await spec()
    for (const operationId of [
      'listRevenueProviders',
      'getSiteRevenueConnection',
      'connectSiteRevenue',
      'rotateSiteRevenueCredential',
      'disconnectSiteRevenue',
    ]) {
      const occurrences = text.split(`operationId: ${operationId}\n`).length - 1
      expect(occurrences, operationId).toBe(1)
    }
  })

  it('routes the catalog outside the site subtree and the connection inside it', async () => {
    // The catalog is a property of the build, not of a site, and the picker
    // renders before a site has been chosen.
    const text = await spec()
    expect(text).toContain('/v1/revenue/providers:')
    expect(text).toContain('/v1/sites/{site_id}/revenue/connection:')
  })

  it('puts all four connection verbs on one path item', async () => {
    // One resource — "this site's revenue connection" — rather than four
    // endpoints that could drift apart.
    const text = await spec()
    const block = blockFrom(text, '/v1/sites/{site_id}/revenue/connection:', 12_000)
    for (const verb of ['get:', 'post:', 'patch:', 'delete:']) {
      expect(block, verb).toContain(`\n    ${verb}`)
    }
  })
})

describe('RevenueProvider', () => {
  it('is a closed object with exactly the three catalog fields', async () => {
    const text = await spec()
    const block = schemaBlock(text, 'RevenueProvider')
    expect(block).toContain('additionalProperties: false')
    expect(block).toContain('required: [id, display_name, available]')
    // snake_case on the wire, camelCase in the domain descriptor.
    expect(block).toContain('display_name:')
    expect(block).not.toContain('displayName')
  })

  it('matches the domain catalog the route serves', async () => {
    // The document and `REVENUE_PROVIDERS` are the same list seen from two
    // sides; a provider added to one and not the other is a picker row that
    // 400s.
    expect(REVENUE_PROVIDERS.map((provider) => provider.id)).toEqual([
      'stripe',
      'polar',
      'dodo',
      'paddle',
      'lemonsqueezy',
      'creem',
    ])
  })
})

describe('RevenueConnection', () => {
  it('carries no field a secret could travel in', async () => {
    const text = await spec()
    const block = schemaBlock(text, 'RevenueConnection')
    expect(block).toContain('additionalProperties: false')
    for (const forbidden of ['api_key:', 'webhook_secret:', 'encrypted_', 'webhook_token:']) {
      expect(block, forbidden).not.toContain(forbidden)
    }
    // What it does carry: the display tail and the status surface.
    for (const property of [
      'api_key_last4:',
      'status:',
      'webhook_url:',
      'last_verified_at:',
      'last_synced_at:',
      'last_webhook_at:',
      'last_error:',
    ]) {
      expect(block, property).toContain(property)
    }
  })

  it('makes every optional instant required-and-nullable', async () => {
    // The ADR-0027 convention: `null` is a statement — "this has never
    // happened" — rather than an omission the client has to guess about.
    const text = await spec()
    const block = schemaBlock(text, 'RevenueConnection')
    expect(block).toContain('- last_verified_at')
    expect(block).toContain('- last_synced_at')
    expect(block).toContain('- last_webhook_at')
    expect(block).toContain('- last_error')
    expect(block).toContain("type: [string, 'null']")
  })

  it('declares the three connection statuses and nothing else', async () => {
    const text = await spec()
    const block = schemaBlock(text, 'RevenueConnectionStatus')
    expect(block).toContain('enum: [active, degraded, disabled]')
  })

  it('gives "never connected" its own shape', async () => {
    // Distinct from `disabled`, which is a site that connected and then
    // disconnected — different sentences on the empty-state screen.
    const text = await spec()
    const block = schemaBlock(text, 'RevenueNotConnected')
    expect(block).toContain('enum: [not_connected]')
  })
})

describe('the request bodies', () => {
  it('requires only the API key on connect — the signing secret cannot exist yet', async () => {
    // CP6 closed an ordering knot: a webhook signing secret is readable only
    // AFTER an endpoint has been created at this site's `webhook_url`, and that
    // URL is minted by the connect call. Requiring it here asked for a value the
    // customer provably could not have.
    const text = await spec()
    const connect = schemaBlock(text, 'ConnectRevenueRequest')
    expect(connect).toContain('additionalProperties: false')
    expect(connect).toContain('required: [provider, api_key]')
    // Still accepted, for a re-connect whose endpoint already exists.
    expect(connect).toContain('webhook_secret:')
  })

  it('lets the PATCH carry either half, and refuses an empty body', async () => {
    const text = await spec()
    const rotate = schemaBlock(text, 'RotateRevenueCredentialRequest')
    expect(rotate).toContain('additionalProperties: false')
    // Both optional, at least one present. An empty object is a client bug far
    // more often than an intention.
    expect(rotate).not.toContain('required:')
    expect(rotate).toContain('minProperties: 1')
    expect(rotate).toContain('api_key:')
    // Step two of connecting lives here now.
    expect(rotate).toContain('webhook_secret:')
  })

  it('reports whether a signing secret is set, and never the secret', async () => {
    const text = await spec()
    const connection = schemaBlock(text, 'RevenueConnection')
    expect(connection).toContain('webhook_secret_set:')
    expect(connection).toContain('- webhook_secret_set')
    // The boolean is the whole surface: no field of this object may carry the
    // value, and this is the test that pins it.
    expect(connection).not.toMatch(/^ {8}webhook_secret:$/mu)
  })
})

describe('the two new error codes', () => {
  it('are in the catalog and in the document', async () => {
    const text = await spec()
    for (const code of ['REVENUE_ALREADY_CONNECTED', 'REVENUE_CREDENTIAL_REJECTED'] as const) {
      expect(ERROR_CODES).toContain(code)
      expect(text).toContain(`        - ${code}`)
    }
  })

  it('carry the statuses their recoveries depend on', async () => {
    // 409 says "resolve the conflict"; 422 says "the value is not usable".
    // Neither is 503, which is the retryable one and belongs to the outage.
    expect(statusForErrorCode('REVENUE_ALREADY_CONNECTED')).toBe(409)
    expect(statusForErrorCode('REVENUE_CREDENTIAL_REJECTED')).toBe(422)
    expect(statusForErrorCode('PROVIDER_UNAVAILABLE')).toBe(503)
  })

  it('separates a rejected credential from an unreachable provider on connect', async () => {
    // Both are failures of the same call and they are documented apart, because
    // one is retryable and the other never will be. Collapsing them is exactly
    // how a provider outage becomes "your key is wrong".
    const text = await spec()
    const block = blockFrom(text, 'operationId: connectSiteRevenue', 4_500)
    expect(block).toContain("'422'")
    expect(block).toContain('RevenueCredentialRejected')
    expect(block).toContain("'503'")
    expect(block).toContain('PROVIDER_UNAVAILABLE')
    expect(block).toContain("'409'")
    expect(block).toContain('REVENUE_ALREADY_CONNECTED')
  })
})
