import { randomBytes } from 'node:crypto'
import { createRevenueAdapterRegistry, revenueCredentialAad } from '@openanalytics/domain'
import {
  createCredentialVault,
  createDodoRevenueAdapter,
  createPolarRevenueAdapter,
  createStripeRevenueAdapter,
} from '@openanalytics/integrations'
import type { Database, RevenueCredentialRow } from '@openanalytics/postgres'
import type * as PostgresModule from '@openanalytics/postgres'
import { signStandardWebhook, signStripeWebhook } from '@openanalytics/testkit'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { dodoEvent, dodoPayment, polarEvent, polarOrder } from '../support/revenue-fixtures.ts'
import { stripeCharge, stripeEvent } from '../support/revenue-fixtures.ts'

/**
 * The webhook route hands the adapter **the whole header set** (ADR-0033 D-P4).
 *
 * Its own file because it is the only thing here driven over real HTTP with real
 * adapters, and because the suite it complements — `api-revenue-webhook.test.ts`
 * — is deliberately left untouched: that one was written against the
 * provider→header-name map this refactor deleted, and its staying green without
 * an edit is the evidence that the Stripe path did not move.
 *
 * What only this file can prove:
 *
 * - **Stripe still authenticates through the real route**, now by picking
 *   `stripe-signature` out of the set instead of being handed it. Same string,
 *   same verifier.
 * - **Polar authenticates at all**, which the old shape made impossible: its
 *   signature spans three headers and its event id is one of them, and a map of
 *   one header name per provider cannot express either.
 * - **The event id really does come off the header** and reaches the ledger as
 *   `providerEventId` — the value a redelivery dedupes on. Polar's body has no
 *   id, so if the header did not arrive there would be nothing to key on.
 * - **Dodo rides the same transport unchanged**, with the specification's key
 *   derivation where Polar has its own — the two must not be interchangeable.
 */

const SITE = '3f2a1c64-9a1a-4e2f-9c1e-2a0f1d3b5c77'
const CREDENTIAL = '7c9e2f10-0000-4000-8000-0000000c0ffe'
const TOKEN = 'tok_opaque_abcdef'
const WEBHOOK_SECRET = 'whsec_test_credential_secret'
const API_KEY = 'rk_test_restricted_abcdef1234'
/** A spec-shaped secret: Dodo base64-decodes what follows `whsec_`. */
const DODO_WEBHOOK_SECRET = `whsec_${Buffer.from('dodo-route-signing-key-24').toString('base64')}`

const vault = createCredentialVault(
  JSON.stringify({ active: 'k1', keys: { k1: randomBytes(32).toString('base64') } }),
)
const aad = revenueCredentialAad({ credentialId: CREDENTIAL, siteId: SITE })

function credential(provider: string, webhookSecret = WEBHOOK_SECRET): RevenueCredentialRow {
  return {
    id: CREDENTIAL,
    siteId: SITE,
    provider,
    encryptedApiKey: vault.encrypt(API_KEY, aad).stored,
    encryptedWebhookSecret: vault.encrypt(webhookSecret, aad).stored,
    keyVersion: 'k1',
    apiKeyLast4: '1234',
    webhookToken: TOKEN,
    status: 'active',
    createdByUserId: 'u-owner',
    connectedAt: new Date('2026-07-31T00:00:00.000Z'),
    lastVerifiedAt: new Date('2026-07-31T00:00:00.000Z'),
    lastSyncedAt: null,
    lastWebhookAt: null,
    lastError: null,
    disabledAt: null,
    backfillGeneration: 0,
    createdAt: new Date('2026-07-31T00:00:00.000Z'),
    updatedAt: new Date('2026-07-31T00:00:00.000Z'),
  }
}

const world = { credential: null as RevenueCredentialRow | null }
const calls = { ledgerInserts: [] as Record<string, unknown>[] }

const db = {} as Database

vi.mock('@openanalytics/postgres', async (importOriginal) => {
  const actual = await importOriginal<typeof PostgresModule>()
  return {
    ...actual,
    readRevenueCredentialByWebhookToken: async (_db: unknown, token: string) =>
      world.credential !== null && world.credential.webhookToken === token
        ? world.credential
        : null,
    recordRevenueProviderEvent: async (_db: unknown, input: Record<string, unknown>) => {
      calls.ledgerInserts.push(input)
      return { id: 'ledger-1', firstSeen: true, status: 'received' as const }
    },
    markRevenueProviderEvent: async () => undefined,
    applyRevenueObservation: async () => ({
      decision: { action: 'apply' as const, version: 1, reason: 'first_observation' },
      objectRowId: 'o1',
    }),
    recordRevenueMatchHints: async () => undefined,
    updateRevenueCredentialState: async () => undefined,
  }
})

const { createRevenueWebhookRoutes } = await import('../../apps/api/src/http/revenue-webhook.ts')

const app = createRevenueWebhookRoutes({
  db,
  vault,
  adapters: createRevenueAdapterRegistry([
    createStripeRevenueAdapter(),
    createPolarRevenueAdapter(),
    createDodoRevenueAdapter(),
  ]),
})

/** POST a delivery at the real route, exactly as a provider would. */
async function deliver(
  provider: string,
  body: string,
  headers: Record<string, string | undefined>,
): Promise<Response> {
  const defined: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) defined[name] = value
  }
  return await app.request(`/revenue/webhooks/${provider}/${TOKEN}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...defined },
    body,
  })
}

beforeEach(() => {
  world.credential = null
  calls.ledgerInserts.length = 0
})

describe('the route passes the whole header set', () => {
  it('authenticates a Stripe delivery by picking its header out of the set', async () => {
    // The route no longer resolves a header name. Stripe's adapter reads
    // `stripe-signature` itself and hands the identical string to the identical
    // verifier — which is what "byte-identical" means here.
    world.credential = credential('stripe')
    const body = JSON.stringify(stripeEvent('charge.succeeded', stripeCharge()))
    const header = signStripeWebhook({
      payload: body,
      secret: WEBHOOK_SECRET,
      timestamp: Math.floor(Date.now() / 1000),
    })

    const res = await deliver('stripe', body, { 'stripe-signature': header })
    expect(res.status).toBe(200)
    expect(calls.ledgerInserts[0]).toMatchObject({ providerEventId: 'evt_charge_succeeded' })
  })

  it('rejects a Stripe delivery whose signature header never arrived', async () => {
    world.credential = credential('stripe')
    const body = JSON.stringify(stripeEvent('charge.succeeded', stripeCharge()))
    const res = await deliver('stripe', body, {})
    expect(res.status).toBe(400)
    expect(calls.ledgerInserts).toHaveLength(0)
  })

  it('authenticates a Polar delivery, which needs THREE headers', async () => {
    // Impossible before this refactor: one header name per provider could carry
    // the signature but not the timestamp it is computed over, nor the id.
    world.credential = credential('polar')
    const body = JSON.stringify(polarEvent('order.paid', polarOrder()))
    const headers = signStandardWebhook({
      payload: body,
      secret: WEBHOOK_SECRET,
      timestamp: Math.floor(Date.now() / 1000),
    })

    const res = await deliver('polar', body, headers)
    expect(res.status).toBe(200)
  })

  it('ledgers the Polar event under the webhook-id HEADER, which the body lacks', async () => {
    // The dedupe key. Polar's envelope is `{type, timestamp, data}` — there is
    // no id in it — so this value can only have come off the header.
    world.credential = credential('polar')
    const body = JSON.stringify(polarEvent('order.paid', polarOrder()))
    expect(JSON.parse(body)).not.toHaveProperty('id')

    const headers = signStandardWebhook({
      payload: body,
      secret: WEBHOOK_SECRET,
      webhookId: 'whid_delivery_42',
      timestamp: Math.floor(Date.now() / 1000),
    })

    const res = await deliver('polar', body, headers)
    expect(res.status).toBe(200)
    expect(calls.ledgerInserts[0]).toMatchObject({
      provider: 'polar',
      providerEventId: 'whid_delivery_42',
    })
  })

  it('refuses a Polar delivery signed under another site’s secret', async () => {
    // The blast-radius property, end to end through the real route.
    world.credential = credential('polar')
    const body = JSON.stringify(polarEvent('order.paid', polarOrder()))
    const headers = signStandardWebhook({
      payload: body,
      secret: 'whsec_a_completely_different_site',
      timestamp: Math.floor(Date.now() / 1000),
    })

    const res = await deliver('polar', body, headers)
    expect(res.status).toBe(400)
    expect(calls.ledgerInserts).toHaveLength(0)
  })

  it('refuses a Polar delivery missing the webhook-id, without writing anything', async () => {
    world.credential = credential('polar')
    const body = JSON.stringify(polarEvent('order.paid', polarOrder()))
    const headers = signStandardWebhook({
      payload: body,
      secret: WEBHOOK_SECRET,
      timestamp: Math.floor(Date.now() / 1000),
    })
    delete headers['webhook-id']

    const res = await deliver('polar', body, headers)
    expect(res.status).toBe(400)
    expect(calls.ledgerInserts).toHaveLength(0)
  })

  it('authenticates a Dodo delivery and ledgers it under the webhook-id header', async () => {
    world.credential = credential('dodo', DODO_WEBHOOK_SECRET)
    const body = JSON.stringify(dodoEvent('payment.succeeded', dodoPayment()))
    expect(JSON.parse(body)).not.toHaveProperty('id')

    const headers = signStandardWebhook({
      payload: body,
      secret: DODO_WEBHOOK_SECRET,
      secretEncoding: 'base64',
      webhookId: 'msg_dodo_delivery_7',
      timestamp: Math.floor(Date.now() / 1000),
    })

    const res = await deliver('dodo', body, headers)
    expect(res.status).toBe(200)
    expect(calls.ledgerInserts[0]).toMatchObject({
      provider: 'dodo',
      providerEventId: 'msg_dodo_delivery_7',
    })
  })

  it('refuses a Dodo delivery signed with Polar’s derivation of the same secret', async () => {
    // Same secret string, different key bytes. A verifier that took either would
    // be checking against two keys at once.
    world.credential = credential('dodo', DODO_WEBHOOK_SECRET)
    const body = JSON.stringify(dodoEvent('payment.succeeded', dodoPayment()))
    const headers = signStandardWebhook({
      payload: body,
      secret: DODO_WEBHOOK_SECRET,
      secretEncoding: 'raw',
      timestamp: Math.floor(Date.now() / 1000),
    })

    const res = await deliver('dodo', body, headers)
    expect(res.status).toBe(400)
    expect(calls.ledgerInserts).toHaveLength(0)
  })

  it('still refuses a payload posted at the wrong provider’s path', async () => {
    // The token is bound to the credential that minted it; a Polar body at
    // `/stripe/{same token}` is a 404 rather than an attempt to normalize it
    // with the wrong adapter. Unchanged by the refactor.
    world.credential = credential('polar')
    const body = JSON.stringify(polarEvent('order.paid', polarOrder()))
    const headers = signStandardWebhook({ payload: body, secret: WEBHOOK_SECRET })
    const res = await deliver('stripe', body, headers)
    expect(res.status).toBe(404)
  })
})
