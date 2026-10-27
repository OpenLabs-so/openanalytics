import type {
  RevenueAdapter,
  RevenueFetchOutcome,
  RevenueListOutcome,
  RevenueNormalizeOutcome,
  RevenueWebhookVerification,
} from '@openanalytics/domain'

/**
 * Revenue fixtures for the M12 ingest suites (ADR-0033, CP2).
 *
 * Two things live here.
 *
 * **`fakeRevenueAdapter`** is a complete `RevenueAdapter` whose every member has
 * a boring default, so a test overrides only the one it is about. That is worth
 * a shared helper rather than five inline object literals: CP1's tests were
 * written against a one-member interface, and CP2 widened it — with per-file
 * stubs, every future widening breaks every suite that ever touched an adapter,
 * and the pressure to answer that by loosening the type is exactly how a stub
 * becomes a second, weaker contract.
 *
 * **The Stripe payload builders** produce the *shapes Stripe actually sends*,
 * with the fields the normalizer reads and nothing invented. A fixture that
 * quietly used a field Stripe does not send would make the normalizer's tests
 * prove something about our imagination.
 */

/** Every member defaulted; override exactly what a test is about. */
export function fakeRevenueAdapter(overrides: Partial<RevenueAdapter> = {}): RevenueAdapter {
  return {
    providerId: 'stripe',
    verifyCredential: async () => ({ outcome: 'ok' }),
    verifyWebhook: (): RevenueWebhookVerification => ({ ok: true }),
    normalizeEvent: (): RevenueNormalizeOutcome => ({
      ok: true,
      event: {
        eventId: 'evt_default',
        eventType: 'charge.succeeded',
        eventAt: new Date('2026-07-31T00:00:00.000Z'),
        observations: [],
        ignored: 'no_observations',
      },
    }),
    listObjects: async (): Promise<RevenueListOutcome> => ({
      ok: true,
      page: { observations: [], nextCursor: null, hasMore: false },
    }),
    fetchObject: async (): Promise<RevenueFetchOutcome> => ({
      ok: true,
      observation: null,
      missing: true,
    }),
    ...overrides,
  }
}

const CREATED = Math.floor(new Date('2026-07-31T10:00:00.000Z').getTime() / 1000)

/** A Stripe charge object, in the shape a `charge.*` event's `data.object` has. */
export function stripeCharge(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'ch_test_1',
    object: 'charge',
    amount: 4999,
    amount_refunded: 0,
    refunded: false,
    currency: 'USD',
    created: CREATED,
    livemode: false,
    status: 'succeeded',
    customer: 'cus_test_1',
    payment_intent: 'pi_test_1',
    // The UNEXPANDED form, which is what a webhook delivery carries: `expand` is
    // a request parameter and a webhook is not a request we make. Present as an
    // id string so the adapter's tests prove it does not mistake a reference for
    // a fee.
    balance_transaction: 'txn_test_1',
    ...overrides,
  }
}

/**
 * A balance transaction, in the shape `expand[]=…balance_transaction` returns.
 *
 * `currency` here is the account's SETTLEMENT currency and is not required to
 * match the object's — the cross-currency case is the whole reason
 * `fee_currency` exists on the fact.
 */
export function stripeBalanceTransaction(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 'txn_test_1',
    object: 'balance_transaction',
    amount: 4999,
    currency: 'usd',
    fee: 175,
    net: 4824,
    ...overrides,
  }
}

export function stripeRefund(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 're_test_1',
    object: 'refund',
    amount: 1500,
    currency: 'usd',
    created: CREATED + 60,
    livemode: false,
    status: 'succeeded',
    charge: 'ch_test_1',
    payment_intent: 'pi_test_1',
    ...overrides,
  }
}

export function stripeDispute(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'du_test_1',
    object: 'dispute',
    amount: 4999,
    currency: 'usd',
    created: CREATED + 120,
    livemode: false,
    status: 'needs_response',
    charge: 'ch_test_1',
    payment_intent: 'pi_test_1',
    ...overrides,
  }
}

/** The event envelope Stripe wraps an object in. */
export function stripeEvent(
  type: string,
  object: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: `evt_${type.replace(/\./gu, '_')}`,
    object: 'event',
    type,
    created: CREATED,
    livemode: false,
    data: { object },
    ...overrides,
  }
}

// --- Polar -------------------------------------------------------------------

/**
 * Polar payload builders, transcribed from **real sandbox payloads** captured on
 * 2026-08-27 rather than from the documentation.
 *
 * That distinction earned its keep twice. The order below carries
 * `platform_fee_currency: null` beside `platform_fee_amount: 0`, which is the
 * shape a real unsettled order has and the reason `fee_currency` has three
 * states; and the envelope carries **no `id`**, which is why the adapter reads
 * the event id from the `webhook-id` header. A fixture invented from the docs
 * would have had an id and the suite would have proved nothing.
 */

const POLAR_CREATED = '2026-07-31T10:00:00.000Z'

/** A Polar Order, in the shape an `order.*` event's `data` has. */
export function polarOrder(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'ord_test_1',
    created_at: POLAR_CREATED,
    modified_at: null,
    status: 'paid',
    paid: true,
    // Polar reports the whole ladder; the adapter reads `net_amount` — after
    // discounts, before the tax Polar remits as merchant of record.
    subtotal_amount: 4999,
    discount_amount: 0,
    net_amount: 4999,
    tax_amount: 500,
    total_amount: 5499,
    refunded_amount: 0,
    refunded_tax_amount: 0,
    currency: 'usd',
    // The real sandbox shape: an amount with no currency beside it, which means
    // "not settled yet" and must never read as a fee of zero.
    platform_fee_amount: 0,
    platform_fee_currency: null,
    billing_reason: 'purchase',
    checkout_id: 'chk_test_1',
    customer_id: 'cust_test_1',
    product_id: 'prod_test_1',
    subscription_id: null,
    metadata: { reference_id: 'site_order_1' },
    customer: { id: 'cust_test_1', external_id: 'site_user_1' },
    product: { id: 'prod_test_1', name: 'Pro plan' },
    ...overrides,
  }
}

/**
 * A Polar Refund.
 *
 * Written from Polar's documented schema and from enums read off the API's own
 * validation errors — **not** from an observed delivery. No live refund could be
 * produced in the sandbox: a refund needs a non-zero paid order, and Polar's
 * Stripe account refuses publishable-key card tokenization, so no card could be
 * charged headlessly. Recorded here so the next person knows which of these
 * fixtures is evidence and which is schema.
 */
export function polarRefund(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'ref_test_1',
    created_at: '2026-07-31T10:01:00.000Z',
    modified_at: null,
    status: 'succeeded',
    reason: 'customer_request',
    amount: 1500,
    tax_amount: 150,
    currency: 'usd',
    order_id: 'ord_test_1',
    subscription_id: null,
    customer_id: 'cust_test_1',
    metadata: {},
    ...overrides,
  }
}

/** A Polar Checkout, in the shape a `checkout.*` event's `data` has. */
export function polarCheckout(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'chk_test_1',
    created_at: POLAR_CREATED,
    status: 'open',
    // Null until the checkout is confirmed — the real sandbox shape.
    customer_id: null,
    customer_external_id: 'site_user_1',
    metadata: { reference_id: 'site_order_1', utm_source: 'newsletter' },
    product_id: 'prod_test_1',
    currency: 'usd',
    ...overrides,
  }
}

/**
 * The event envelope Polar wraps an object in: `{type, timestamp, data}`.
 *
 * **There is no `id`.** That is the whole reason `polarHeaders` exists beside
 * this, and the reason the adapter takes an event context at all.
 */
export function polarEvent(
  type: string,
  data: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return { type, timestamp: POLAR_CREATED, data, ...overrides }
}

/** The delivery header set, with the event id the body does not carry. */
export function polarHeaders(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return { 'webhook-id': 'whid_test_1', ...overrides }
}

/**
 * A Polar list response: `{items, pagination: {total_count, max_page}}`.
 *
 * Page-number pagination, not a cursor — which is why the adapter's own cursor
 * has to carry a pinned cutoff as well as a page.
 */
export function polarListPage(
  items: readonly Record<string, unknown>[],
  pagination: { total_count?: number; max_page?: number } = {},
): Record<string, unknown> {
  return {
    items,
    pagination: {
      total_count: pagination.total_count ?? items.length,
      max_page: pagination.max_page ?? 1,
    },
  }
}

const DODO_CREATED = '2026-07-31T10:00:00.123456Z'

/**
 * A Dodo Payment, in the shape `GET /payments/{id}` and a `payment.*` event's
 * `data` have.
 *
 * Written from Dodo's published API reference. A taxed payment on purpose: the
 * adapter reads `total_amount - tax`, and a fixture with no tax could not tell
 * that from reading `total_amount`.
 */
export function dodoPayment(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    payload_type: 'Payment',
    payment_id: 'pay_test_1',
    business_id: 'bus_test_1',
    brand_id: 'bus_test_1',
    created_at: DODO_CREATED,
    status: 'succeeded',
    currency: 'EUR',
    // 4999 to the seller plus 1050 VAT that Dodo remits as merchant of record.
    total_amount: 6049,
    tax: 1050,
    settlement_amount: 6049,
    settlement_currency: 'EUR',
    settlement_tax: 1050,
    refund_status: null,
    checkout_session_id: 'cks_test_1',
    subscription_id: null,
    subscription_ids: [],
    product_cart: [{ product_id: 'pdt_test_1', quantity: 1 }],
    metadata: { oa_external_id: 'site_user_1' },
    customer: {
      customer_id: 'cus_test_1',
      email: 'buyer@example.com',
      name: 'Test Buyer',
      metadata: {},
    },
    refunds: [],
    disputes: [],
    ...overrides,
  }
}

/** The thinner row `GET /payments` lists: no `tax`, no settlement fields. */
export function dodoPaymentListRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const {
    payload_type: _payloadType,
    tax: _tax,
    settlement_amount: _settlementAmount,
    settlement_currency: _settlementCurrency,
    settlement_tax: _settlementTax,
    refunds: _refunds,
    disputes: _disputes,
    product_cart: _productCart,
    ...row
  } = dodoPayment()
  return { ...row, ...overrides }
}

/** A Dodo Refund. `amount` is the amount returned to the customer, tax included. */
export function dodoRefund(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    payload_type: 'Refund',
    refund_id: 'ref_test_1',
    payment_id: 'pay_test_1',
    business_id: 'bus_test_1',
    created_at: '2026-07-31T10:01:00.000000Z',
    status: 'succeeded',
    amount: 1500,
    currency: 'EUR',
    is_partial: true,
    reason: null,
    metadata: {},
    customer: { customer_id: 'cus_test_1', email: 'buyer@example.com', name: 'Test Buyer' },
    ...overrides,
  }
}

/** A Dodo Dispute. `amount` is a **string** of minor units, as documented. */
export function dodoDispute(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    payload_type: 'Dispute',
    dispute_id: 'dsp_test_1',
    payment_id: 'pay_test_1',
    business_id: 'bus_test_1',
    created_at: '2026-07-31T10:02:00.000000Z',
    amount: '6049',
    currency: 'EUR',
    dispute_status: 'dispute_opened',
    dispute_stage: 'dispute',
    is_resolved_by_rdr: null,
    customer: { customer_id: 'cus_test_1', email: 'buyer@example.com', name: 'Test Buyer' },
    ...overrides,
  }
}

/** The envelope: `{business_id, type, timestamp, data}` — no id, as for Polar. */
export function dodoEvent(
  type: string,
  data: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    business_id: 'bus_test_1',
    type,
    timestamp: '2026-07-31T10:00:05.000000Z',
    data,
    ...overrides,
  }
}

/**
 * The ECB daily file, in the exact nesting the real document uses.
 *
 * Single-quoted attributes, because that is what the ECB publishes — a fixture
 * that used double quotes would pass against a regex that only reads one form
 * and then fail against production.
 */
export function ecbDocument(date: string, rates: readonly (readonly [string, string])[]): string {
  const cubes = rates
    .map(([currency, rate]) => `      <Cube currency='${currency}' rate='${rate}'/>`)
    .join('\n')
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01">`,
    `  <gesmes:subject>Reference rates</gesmes:subject>`,
    `  <Cube>`,
    `    <Cube time='${date}'>`,
    cubes,
    `    </Cube>`,
    `  </Cube>`,
    `</gesmes:Envelope>`,
    ``,
  ].join('\n')
}
