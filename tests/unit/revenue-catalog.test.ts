import {
  REVENUE_CREDENTIAL_STATUSES,
  REVENUE_PROVIDERS,
  createRevenueAdapterRegistry,
  findRevenueProvider,
  isRevenueCredentialStatus,
  revenueCredentialAad,
  revenueWebhookPath,
  type RevenueAdapter,
} from '@openanalytics/domain'
import {
  DODO_REVENUE_PROVIDER_ID,
  POLAR_REVENUE_PROVIDER_ID,
  STRIPE_REVENUE_PROVIDER_ID,
  createDodoRevenueAdapter,
  createPolarRevenueAdapter,
  createStripeRevenueAdapter,
} from '@openanalytics/integrations'
import { describe, expect, it } from 'vitest'
import { fakeRevenueAdapter } from '../support/revenue-fixtures.ts'

/**
 * The pure revenue vocabularies M12 publishes (ADR-0033, D1/D3/D4).
 *
 * The catalog is a contract with the frontend rather than an internal helper: it
 * decides what a picker may offer, so the table below is **transcribed from the
 * ADR** rather than derived from the implementation. A silent change to it is a
 * screen that promises a connection nothing can complete.
 */

describe('revenue provider catalog', () => {
  it('offers Stripe, Polar and Dodo, and nothing without an adapter behind it', () => {
    // M12 shipped the framework plus Stripe (D1's scope cut); Polar and Dodo
    // arrived as catalog flips. Anything else marked
    // available would promise a connection nothing can complete — the picker
    // renders this list verbatim.
    const available = REVENUE_PROVIDERS.filter((provider) => provider.available)
    expect(available.map((provider) => provider.id)).toEqual(['stripe', 'polar', 'dodo'])
  })

  it('lists the follow-up providers rather than hiding them, after the working ones', () => {
    // "Supported later" and "not something we do" are different answers, and a
    // catalog carrying only working adapters could give only the second.
    expect(REVENUE_PROVIDERS.map((provider) => provider.id)).toEqual([
      'stripe',
      'polar',
      'dodo',
      'paddle',
      'lemonsqueezy',
      'creem',
    ])
  })

  it('gives every descriptor a display name and a stable id', () => {
    for (const provider of REVENUE_PROVIDERS) {
      expect(provider.id).toMatch(/^[a-z0-9_]+$/u)
      expect(provider.displayName.length).toBeGreaterThan(0)
    }
  })

  it('answers null for an unknown or non-string id', () => {
    expect(findRevenueProvider('not-a-provider')).toBeNull()
    expect(findRevenueProvider(42)).toBeNull()
    expect(findRevenueProvider(undefined)).toBeNull()
    expect(findRevenueProvider('stripe')?.available).toBe(true)
  })

  it('names the same providers the adapters register under', () => {
    // A drift between the two would make the catalog offer a provider the
    // registry has no adapter for — a 503 on a row the picker said was ready.
    expect(STRIPE_REVENUE_PROVIDER_ID).toBe('stripe')
    expect(findRevenueProvider(STRIPE_REVENUE_PROVIDER_ID)?.available).toBe(true)
    expect(POLAR_REVENUE_PROVIDER_ID).toBe('polar')
    expect(findRevenueProvider(POLAR_REVENUE_PROVIDER_ID)?.available).toBe(true)
    expect(DODO_REVENUE_PROVIDER_ID).toBe('dodo')
    expect(findRevenueProvider(DODO_REVENUE_PROVIDER_ID)?.available).toBe(true)
  })

  it('registers every real adapter side by side, which is the whole claim', () => {
    // The registry refuses a duplicate id, so this also proves the adapters
    // do not collide — and it is the exact composition both `main.ts` files use.
    const registry = createRevenueAdapterRegistry([
      createStripeRevenueAdapter(),
      createPolarRevenueAdapter(),
      createDodoRevenueAdapter(),
    ])
    expect([...registry.keys()].sort()).toEqual(['dodo', 'polar', 'stripe'])

    // Every provider the catalog advertises must resolve to an adapter here.
    for (const provider of REVENUE_PROVIDERS.filter((row) => row.available)) {
      expect(registry.get(provider.id)?.providerId).toBe(provider.id)
    }
  })
})

describe('credential status vocabulary', () => {
  it('is exactly the three states the ADR names', () => {
    // `degraded` is the one the milestone exists for: a provider outage is a
    // status, never a revenue of zero.
    expect([...REVENUE_CREDENTIAL_STATUSES]).toEqual(['active', 'degraded', 'disabled'])
    expect(isRevenueCredentialStatus('degraded')).toBe(true)
    expect(isRevenueCredentialStatus('broken')).toBe(false)
    expect(isRevenueCredentialStatus(null)).toBe(false)
  })
})

describe('AAD derivation', () => {
  it('binds both the credential and the site', () => {
    // Both, so a ciphertext lifted out of one row decrypts on no other — not on
    // a different credential of the same site, and not on the same credential id
    // if it were somehow re-pointed at another site.
    expect(revenueCredentialAad({ credentialId: 'cred-1', siteId: 'site-1' })).toBe(
      'revenue_credential:cred-1:site-1',
    )
    expect(revenueCredentialAad({ credentialId: 'cred-1', siteId: 'site-2' })).not.toBe(
      revenueCredentialAad({ credentialId: 'cred-1', siteId: 'site-1' }),
    )
  })
})

describe('webhook path', () => {
  it('carries the provider and the opaque token, escaped', () => {
    expect(revenueWebhookPath('stripe', 'tok_abc')).toBe('/v1/revenue/webhooks/stripe/tok_abc')
    // base64url tokens are URL-safe already; escaping is the guard against a
    // provider id or a token shape that is not.
    expect(revenueWebhookPath('stripe', 'a/b')).toBe('/v1/revenue/webhooks/stripe/a%2Fb')
  })
})

describe('adapter registry', () => {
  const fake = (providerId: string): RevenueAdapter => fakeRevenueAdapter({ providerId })

  it('keys adapters by provider id', () => {
    const registry = createRevenueAdapterRegistry([createStripeRevenueAdapter(), fake('polar')])
    expect(registry.get('stripe')?.providerId).toBe('stripe')
    expect(registry.get('paddle')).toBeUndefined()
  })

  it('refuses a duplicate provider', () => {
    // Which adapter runs would otherwise depend on array order, which is exactly
    // the kind of thing that is discovered by a customer.
    expect(() => createRevenueAdapterRegistry([fake('stripe'), fake('stripe')])).toThrow(
      /duplicate revenue adapter/u,
    )
  })
})

describe('stripe revenue adapter probe', () => {
  const probe = async (respond: () => Response | Promise<Response>) =>
    await createStripeRevenueAdapter(async () => await respond()).verifyCredential('rk_test_x')

  it('sends one authenticated GET to the charges list and reads only the status', async () => {
    const seen: { url: string; init: RequestInit | undefined }[] = []
    const adapter = createStripeRevenueAdapter(async (url, init) => {
      seen.push({ url: String(url), init })
      return await Promise.resolve(new Response('{"data":[]}', { status: 200 }))
    })

    expect(await adapter.verifyCredential('rk_test_secret')).toEqual({ outcome: 'ok' })
    expect(seen).toHaveLength(1)
    expect(seen[0]?.url).toBe('https://api.stripe.com/v1/charges?limit=1')
    expect(seen[0]?.init?.method).toBe('GET')
    expect((seen[0]?.init?.headers as Record<string, string>)['authorization']).toBe(
      'Bearer rk_test_secret',
    )
    // A deadline, because a customer is waiting on a form submit.
    expect(seen[0]?.init?.signal).toBeDefined()
  })

  it.each([401, 403])('reports %i as a rejected credential', async (status) => {
    // 401 is a key Stripe does not recognise; 403 is a restricted key without
    // `Charges` read. Both are the customer's to fix in their own dashboard.
    const result = await probe(() => new Response('{}', { status }))
    expect(result.outcome).toBe('unauthorized')
  })

  it.each([429, 500, 502, 503])('reports %i as the provider being unavailable', async (status) => {
    // Retryable and emphatically NOT evidence about the key. Reporting an outage
    // as a bad credential is the failure mode snapshot 01 §12.3 records.
    const result = await probe(() => new Response('{}', { status }))
    expect(result.outcome).toBe('unavailable')
  })

  it('reports a thrown fetch as unavailable rather than letting it escape', async () => {
    const result = await probe(() => {
      throw new Error('ECONNRESET')
    })
    expect(result.outcome).toBe('unavailable')
  })

  it('never carries the provider response body into the outcome', async () => {
    // The body is a page of a customer's real charges, or a provider error
    // naming their account. Neither is ours to relay.
    const result = await probe(
      () => new Response('{"error":{"message":"acct_1234 is restricted"}}', { status: 403 }),
    )
    expect(JSON.stringify(result)).not.toContain('acct_1234')
  })
})
