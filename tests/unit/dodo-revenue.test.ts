import {
  DODO_PAYMENTS_PAGE_SIZE,
  DODO_TEST_API_BASE,
  createDodoRevenueAdapter,
} from '@openanalytics/integrations'
import { signStandardWebhook } from '@openanalytics/testkit'
import { describe, expect, it } from 'vitest'
import {
  dodoDispute,
  dodoEvent,
  dodoPayment,
  dodoPaymentListRow,
  dodoRefund,
} from '../support/revenue-fixtures.ts'

/**
 * The Dodo Payments revenue adapter's semantics (ADR-0033, D1/D4/D5).
 *
 * The Polar suite's twin, proving the same port contract plus what only exists
 * because Dodo is a different provider:
 *
 * 1. **The amount is `total_amount - tax`.** Dodo is a merchant of record, and a
 *    payment without a `tax` field — the list endpoint's row — is refused rather
 *    than read as untaxed.
 * 2. **A payment nobody attempted is not a charge.** The rollup counts unknown
 *    statuses as money, so `requires_*` must never reach it.
 * 3. **A won dispute reads `won`.** The rollup's reinstatement rule keys on it.
 * 4. **The signature is the specification's**, not Polar's literal-bytes variant.
 * 5. **The walk moves its upper bound**, because Dodo caps page numbers.
 */

const adapter = createDodoRevenueAdapter()
const HEADERS = { 'webhook-id': 'msg_test_1' }

function normalizeOne(event: Record<string, unknown>, headers = HEADERS) {
  const outcome = adapter.normalizeEvent(event, { headers })
  if (!outcome.ok) throw new Error(`normalize failed: ${outcome.reason}`)
  return outcome.event
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  })
}

describe('normalizeEvent — payments become charges', () => {
  it('reads payment.succeeded net of the tax Dodo remits', () => {
    const event = normalizeOne(dodoEvent('payment.succeeded', dodoPayment()))
    expect(event.eventType).toBe('payment.succeeded')
    expect(event.observations).toHaveLength(1)
    const [observation] = event.observations
    expect(observation?.objectId).toBe('pay_test_1')
    expect(observation?.objectKind).toBe('charge')
    expect(observation?.normalized).toMatchObject({
      object_kind: 'charge',
      status: 'succeeded',
      livemode: true,
      currency: 'eur',
      // 6049 paid, 1050 of it VAT the seller never receives.
      gross_minor: 4999,
      net_minor: 4999,
      // Unknown, not zero: Dodo reports no fee field.
      fee_minor: 0,
      fee_currency: '',
      order_id: 'pay_test_1',
      checkout_session_id: 'cks_test_1',
      client_reference_id: 'site_user_1',
      customer_id: 'cus_test_1',
      product_id: 'pdt_test_1',
      parent_object_id: '',
    })
  })

  it('never stores the customer email it was sent', () => {
    const event = normalizeOne(dodoEvent('payment.succeeded', dodoPayment()))
    expect(JSON.stringify(event.observations)).not.toContain('buyer@example.com')
  })

  it('reads a null tax as untaxed — a documented value, as under a reverse charge', () => {
    const event = normalizeOne(dodoEvent('payment.succeeded', dodoPayment({ tax: null })))
    expect(event.observations[0]?.normalized.gross_minor).toBe(6049)
  })

  it('refuses a payment with NO tax field rather than reading it as untaxed', () => {
    // The list row's shape. Read as zero, it would overstate every taxed payment.
    const event = normalizeOne(
      dodoEvent('payment.succeeded', dodoPaymentListRow({ payload_type: 'Payment' })),
    )
    expect(event.ignored).toBe('unsupported_object_shape')
  })

  it.each([
    ['a fractional total', { total_amount: 6049.5 }],
    ['a tax larger than the total', { tax: 7000 }],
    ['a negative tax', { tax: -1 }],
    ['no currency', { currency: null }],
  ])('refuses %s instead of rounding it into a plausible number', (_label, overrides) => {
    const event = normalizeOne(dodoEvent('payment.succeeded', dodoPayment(overrides)))
    expect(event.ignored).toBe('unsupported_object_shape')
  })

  it.each([1038, -2065])(
    'reads a zero-total plan change carrying tax %s as zero revenue',
    async (tax) => {
      // Both values observed on real test-mode `plan_change` payments. Refused,
      // they were skipped by the sync walk and retried forever by the refetch.
      const payment = dodoPayment({ total_amount: 0, tax, charge_type: 'plan_change' })
      const event = normalizeOne(dodoEvent('payment.succeeded', payment))
      expect(event.observations[0]?.normalized).toMatchObject({
        status: 'succeeded',
        gross_minor: 0,
        net_minor: 0,
      })

      const client = createDodoRevenueAdapter(async () => jsonResponse(payment))
      const fetched = await client.fetchObject('dodo_key', 'charge', 'pay_test_1')
      expect(fetched.ok && fetched.observation?.normalized.gross_minor).toBe(0)
    },
  )

  it.each([
    ['processing', null, 'pending'],
    ['requires_capture', null, 'pending'],
    ['failed', null, 'failed'],
    ['cancelled', null, 'canceled'],
    ['succeeded', 'full', 'refunded'],
    ['succeeded', 'partial', 'partially_refunded'],
  ])('maps a %s payment (refund_status %s) to %s', (status, refundStatus, expected) => {
    const event = normalizeOne(
      dodoEvent('payment.processing', dodoPayment({ status, refund_status: refundStatus })),
    )
    expect(event.observations[0]?.normalized.status).toBe(expected)
  })

  it('keeps the full gross on a refunded payment — the refund carries the negative', () => {
    const event = normalizeOne(
      dodoEvent('payment.succeeded', dodoPayment({ refund_status: 'full' })),
    )
    expect(event.observations[0]?.normalized.gross_minor).toBe(4999)
  })

  it.each(['requires_payment_method', 'requires_customer_action', 'requires_something_new'])(
    'reports an unattempted %s payment as carrying no money',
    (status) => {
      // Passed through, the rollup would count it: unknown statuses are money.
      const event = normalizeOne(dodoEvent('payment.cancelled', dodoPayment({ status })))
      expect(event.observations).toHaveLength(0)
      expect(event.ignored).toBe('no_observations')
    },
  )

  it('names no product for a mixed cart', () => {
    const cart = [
      { product_id: 'pdt_a', quantity: 1 },
      { product_id: 'pdt_b', quantity: 2 },
    ]
    const event = normalizeOne(dodoEvent('payment.succeeded', dodoPayment({ product_cart: cart })))
    expect(event.observations[0]?.normalized.product_id).toBe('')
  })

  it('falls back to the customer metadata for the site reference', () => {
    const event = normalizeOne(
      dodoEvent(
        'payment.succeeded',
        dodoPayment({
          metadata: {},
          customer: { customer_id: 'cus_test_1', metadata: { oa_external_id: 'site_user_9' } },
        }),
      ),
    )
    expect(event.observations[0]?.normalized.client_reference_id).toBe('site_user_9')
  })

  it('takes a multi-subscription payment’s subscription from subscription_ids', () => {
    const event = normalizeOne(
      dodoEvent(
        'payment.succeeded',
        dodoPayment({ subscription_id: null, subscription_ids: ['sub_a', 'sub_b'] }),
      ),
    )
    expect(event.observations[0]?.normalized.subscription_id).toBe('sub_a')
  })

  it('orders a webhook observation by the EVENT time, not the payment’s', () => {
    const event = normalizeOne(dodoEvent('payment.succeeded', dodoPayment()))
    expect(event.observations[0]?.snapshotAt.toISOString()).toBe('2026-07-31T10:00:05.000Z')
    expect(event.observations[0]?.normalized.occurred_at).toBe('2026-07-31T10:00:00.123Z')
  })

  it('reports livemode false for an adapter pointed at test mode', () => {
    const test = createDodoRevenueAdapter(fetch, DODO_TEST_API_BASE)
    const outcome = test.normalizeEvent(dodoEvent('payment.succeeded', dodoPayment()), {
      headers: HEADERS,
    })
    expect(outcome.ok && outcome.event.observations[0]?.normalized.livemode).toBe(false)
  })
})

describe('normalizeEvent — refunds and disputes', () => {
  it('reads refund.succeeded as a refund linked to its payment', () => {
    const event = normalizeOne(dodoEvent('refund.succeeded', dodoRefund()))
    expect(event.observations[0]).toMatchObject({ objectId: 'ref_test_1', objectKind: 'refund' })
    expect(event.observations[0]?.normalized).toMatchObject({
      status: 'succeeded',
      currency: 'eur',
      gross_minor: 1500,
      parent_object_id: 'pay_test_1',
      order_id: 'pay_test_1',
    })
  })

  it('reads a refund under review as pending', () => {
    const event = normalizeOne(dodoEvent('refund.succeeded', dodoRefund({ status: 'review' })))
    expect(event.observations[0]?.normalized.status).toBe('pending')
  })

  it.each([
    ['dispute_opened', 'opened'],
    ['dispute_won', 'won'],
    ['dispute_lost', 'lost'],
    ['dispute_cancelled', 'cancelled'],
  ])('strips the prefix from %s so the rollup reads %s', (status, expected) => {
    const event = normalizeOne(dodoEvent('dispute.won', dodoDispute({ dispute_status: status })))
    expect(event.observations[0]?.normalized.status).toBe(expected)
  })

  it('reads the dispute amount from its string of minor units', () => {
    const event = normalizeOne(dodoEvent('dispute.opened', dodoDispute()))
    expect(event.observations[0]?.normalized).toMatchObject({
      object_kind: 'dispute',
      gross_minor: 6049,
      parent_object_id: 'pay_test_1',
    })
  })

  it('refuses a dispute amount with a decimal point rather than guessing its scale', () => {
    const event = normalizeOne(dodoEvent('dispute.opened', dodoDispute({ amount: '60.49' })))
    expect(event.ignored).toBe('unsupported_object_shape')
  })
})

describe('normalizeEvent — the envelope', () => {
  it('takes the event id from the HEADER, because the body has none', () => {
    const event = normalizeOne(dodoEvent('payment.succeeded', dodoPayment()), {
      'webhook-id': 'msg_from_header',
    })
    expect(event.eventId).toBe('msg_from_header')
  })

  it('refuses a delivery with no webhook-id rather than inventing one', () => {
    const outcome = adapter.normalizeEvent(dodoEvent('payment.succeeded', dodoPayment()), {
      headers: {},
    })
    expect(outcome).toEqual({ ok: false, reason: 'malformed_event' })
  })

  it('acks an event type it does not read, with a category', () => {
    const event = normalizeOne(dodoEvent('license_key.created', { payload_type: 'LicenseKey' }))
    expect(event.ignored).toBe('unhandled_event_type')
  })

  it('understands subscription events as carrying no money of their own', () => {
    const event = normalizeOne(dodoEvent('subscription.active', { payload_type: 'Subscription' }))
    expect(event.ignored).toBe('no_observations')
  })

  it('refuses data whose payload_type does not match the event', () => {
    const event = normalizeOne(dodoEvent('refund.succeeded', dodoPayment()))
    expect(event.ignored).toBe('unsupported_object_shape')
  })
})

describe('verifyWebhook — the specification’s key derivation', () => {
  // A realistic secret: `whsec_` and base64 of 24 bytes.
  const SECRET = `whsec_${Buffer.from('dodo-test-signing-key-24').toString('base64')}`
  const body = JSON.stringify(dodoEvent('payment.succeeded', dodoPayment()))
  const now = new Date('2026-07-22T00:00:00.000Z')

  it('accepts a delivery signed under the base64-decoded secret', () => {
    const headers = signStandardWebhook({ payload: body, secret: SECRET, secretEncoding: 'base64' })
    expect(
      adapter.verifyWebhook({
        rawBody: body,
        signatureHeader: undefined,
        headers,
        signingSecret: SECRET,
        now,
      }),
    ).toEqual({ ok: true })
  })

  it('refuses a delivery signed the way Polar signs', () => {
    // Accepting both derivations would be accepting signatures under two keys.
    const headers = signStandardWebhook({ payload: body, secret: SECRET, secretEncoding: 'raw' })
    expect(
      adapter.verifyWebhook({
        rawBody: body,
        signatureHeader: undefined,
        headers,
        signingSecret: SECRET,
        now,
      }),
    ).toEqual({ ok: false, reason: 'no_matching_signature' })
  })
})

describe('verifyCredential', () => {
  it('probes one payment and reads nothing else', async () => {
    const urls: string[] = []
    const client = createDodoRevenueAdapter(async (input) => {
      urls.push(String(input))
      return jsonResponse({ items: [] })
    })
    expect(await client.verifyCredential('dodo_key')).toEqual({ outcome: 'ok' })
    expect(urls).toEqual(['https://live.dodopayments.com/payments?page_size=1'])
  })

  it('reports a rejected key as the customer’s problem', async () => {
    const client = createDodoRevenueAdapter(async () => new Response('{}', { status: 401 }))
    expect(await client.verifyCredential('test_mode_key')).toMatchObject({
      outcome: 'unauthorized',
    })
  })

  it.each([429, 503])('reports a %s as Dodo’s problem, not a bad key', async (status) => {
    const client = createDodoRevenueAdapter(async () => new Response('{}', { status }))
    expect(await client.verifyCredential('dodo_key')).toMatchObject({ outcome: 'unavailable' })
  })

  it('reports a network failure as unavailable rather than throwing', async () => {
    const client = createDodoRevenueAdapter(async () => {
      throw new TypeError('fetch failed')
    })
    expect(await client.verifyCredential('dodo_key')).toMatchObject({ outcome: 'unavailable' })
  })
})

describe('listObjects — payments', () => {
  const window = {
    windowStart: new Date('2026-07-01T00:00:00.000Z'),
    windowEnd: new Date('2026-08-01T00:00:00.000Z'),
  }

  it('reads each listed payment whole, because the row has no tax', async () => {
    const urls: string[] = []
    const client = createDodoRevenueAdapter(async (input) => {
      const url = String(input)
      urls.push(url)
      if (url.includes('/payments?')) return jsonResponse({ items: [dodoPaymentListRow()] })
      return jsonResponse(dodoPayment())
    })
    const outcome = await client.listObjects('dodo_key', 'charges', {
      cursor: null,
      pageSize: 100,
      ...window,
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.page.observations).toHaveLength(1)
    expect(outcome.page.observations[0]?.normalized.gross_minor).toBe(4999)
    // The list row's own time, never the fetch time.
    expect(outcome.page.observations[0]?.snapshotAt.toISOString()).toBe('2026-07-31T10:00:00.123Z')
    expect(urls[1]).toBe('https://live.dodopayments.com/payments/pay_test_1')

    const list = new URL(urls[0] ?? '')
    expect(list.searchParams.get('page_size')).toBe(String(DODO_PAYMENTS_PAGE_SIZE))
    expect(list.searchParams.get('page_number')).toBe('0')
    expect(list.searchParams.get('created_at_gte')).toBe('2026-07-01T00:00:00.000Z')
    expect(list.searchParams.get('created_at_lte')).toBe('2026-08-01T00:00:00.000Z')
    // A short page is the end: Dodo's list carries no `has_more`.
    expect(outcome.page).toMatchObject({ hasMore: false, nextCursor: null })
  })

  it('skips unattempted payments without spending a request on them', async () => {
    const urls: string[] = []
    const client = createDodoRevenueAdapter(async (input) => {
      urls.push(String(input))
      return jsonResponse({ items: [dodoPaymentListRow({ status: 'requires_payment_method' })] })
    })
    const outcome = await client.listObjects('dodo_key', 'charges', {
      cursor: null,
      pageSize: 100,
      ...window,
    })
    expect(outcome.ok && outcome.page.observations).toEqual([])
    expect(urls).toHaveLength(1)
  })

  it('moves the upper bound to the oldest row, in Dodo’s own microseconds', async () => {
    const rows = Array.from({ length: DODO_PAYMENTS_PAGE_SIZE }, (_, index) =>
      dodoPaymentListRow({
        payment_id: `pay_${String(index)}`,
        created_at: `2026-07-${String(30 - (index % 20)).padStart(2, '0')}T08:00:00.654321Z`,
      }),
    )
    const client = createDodoRevenueAdapter(async (input) =>
      String(input).includes('/payments?')
        ? jsonResponse({ items: rows })
        : jsonResponse(dodoPayment()),
    )
    const outcome = await client.listObjects('dodo_key', 'charges', {
      cursor: null,
      pageSize: 100,
      ...window,
    })
    expect(outcome.ok && outcome.page).toMatchObject({
      hasMore: true,
      // Re-serialized to milliseconds this would sit before the row it came from.
      nextCursor: '0|2026-07-11T08:00:00.654321Z',
    })
  })

  it('steps a page forward when a whole page shares the bound’s timestamp', async () => {
    const cutoff = '2026-07-20T08:00:00.000000Z'
    const rows = Array.from({ length: DODO_PAYMENTS_PAGE_SIZE }, (_, index) =>
      dodoPaymentListRow({ payment_id: `pay_${String(index)}`, created_at: cutoff }),
    )
    const client = createDodoRevenueAdapter(async (input) =>
      String(input).includes('/payments?')
        ? jsonResponse({ items: rows })
        : jsonResponse(dodoPayment()),
    )
    const outcome = await client.listObjects('dodo_key', 'charges', {
      cursor: `0|${cutoff}`,
      pageSize: 100,
      ...window,
    })
    expect(outcome.ok && outcome.page.nextCursor).toBe(`1|${cutoff}`)
  })

  it('fails the page when a payment cannot be read, so the cursor does not pass it', async () => {
    const client = createDodoRevenueAdapter(async (input) =>
      String(input).includes('/payments?')
        ? jsonResponse({ items: [dodoPaymentListRow()] })
        : new Response('{}', { status: 503 }),
    )
    const outcome = await client.listObjects('dodo_key', 'charges', {
      cursor: null,
      pageSize: 100,
      ...window,
    })
    expect(outcome).toMatchObject({ ok: false, reason: 'unavailable' })
  })

  it('skips a payment that vanished between the list and the read', async () => {
    const client = createDodoRevenueAdapter(async (input) =>
      String(input).includes('/payments?')
        ? jsonResponse({ items: [dodoPaymentListRow()] })
        : new Response('{}', { status: 404 }),
    )
    const outcome = await client.listObjects('dodo_key', 'charges', {
      cursor: null,
      pageSize: 100,
      ...window,
    })
    expect(outcome.ok && outcome.page.observations).toEqual([])
  })

  it('calls an unreadable cursor invalid rather than restarting silently', async () => {
    const client = createDodoRevenueAdapter(async () => jsonResponse({ items: [] }))
    const outcome = await client.listObjects('dodo_key', 'charges', {
      cursor: 'not-a-cursor',
      pageSize: 100,
      ...window,
    })
    expect(outcome).toMatchObject({ ok: false, reason: 'invalid_cursor' })
  })

  it('calls a 4xx on a stored cursor invalid, not a bad key', async () => {
    const client = createDodoRevenueAdapter(async () => new Response('{}', { status: 422 }))
    const outcome = await client.listObjects('dodo_key', 'charges', {
      cursor: '0|2026-07-20T08:00:00.000000Z',
      pageSize: 100,
      ...window,
    })
    expect(outcome).toMatchObject({ ok: false, reason: 'invalid_cursor' })
  })

  it('never relays a response body into its detail', async () => {
    const client = createDodoRevenueAdapter(
      async () => new Response(JSON.stringify({ message: 'secretish body' }), { status: 400 }),
    )
    const outcome = await client.listObjects('dodo_key', 'charges', {
      cursor: null,
      pageSize: 100,
      ...window,
    })
    expect(JSON.stringify(outcome)).not.toContain('secretish')
  })
})

describe('listObjects — refunds and disputes list whole objects', () => {
  it('reads refunds straight off the page, with the full page size', async () => {
    const urls: string[] = []
    const client = createDodoRevenueAdapter(async (input) => {
      urls.push(String(input))
      return jsonResponse({ items: [dodoRefund()] })
    })
    const outcome = await client.listObjects('dodo_key', 'refunds', {
      cursor: null,
      pageSize: 100,
      windowStart: new Date('2026-07-01T00:00:00.000Z'),
      windowEnd: new Date('2026-08-01T00:00:00.000Z'),
    })
    expect(outcome.ok && outcome.page.observations[0]?.objectId).toBe('ref_test_1')
    expect(urls).toHaveLength(1)
    expect(new URL(urls[0] ?? '').searchParams.get('page_size')).toBe('100')
  })

  it('reads disputes, which Dodo emits events for', async () => {
    const client = createDodoRevenueAdapter(async () => jsonResponse({ items: [dodoDispute()] }))
    const outcome = await client.listObjects('dodo_key', 'disputes', {
      cursor: null,
      pageSize: 100,
      windowStart: new Date('2026-07-01T00:00:00.000Z'),
      windowEnd: new Date('2026-08-01T00:00:00.000Z'),
    })
    expect(outcome.ok && outcome.page.observations[0]?.objectKind).toBe('dispute')
  })
})

describe('fetchObject — the tie-break path', () => {
  it('reads the payment authoritatively', async () => {
    const client = createDodoRevenueAdapter(async () => jsonResponse(dodoPayment({ tax: 49 })))
    const outcome = await client.fetchObject('dodo_key', 'charge', 'pay_test_1')
    expect(outcome.ok && outcome.observation?.normalized.gross_minor).toBe(6000)
  })

  it('answers a 404 as missing, which settles the tie', async () => {
    const client = createDodoRevenueAdapter(async () => new Response('{}', { status: 404 }))
    expect(await client.fetchObject('dodo_key', 'refund', 'ref_gone')).toEqual({
      ok: true,
      observation: null,
      missing: true,
    })
  })
})
