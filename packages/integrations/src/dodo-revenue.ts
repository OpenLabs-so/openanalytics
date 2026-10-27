import {
  REVENUE_SYNC_RESOURCE_KINDS,
  revenueObservationHash,
  type RevenueAdapter,
  type RevenueCredentialVerification,
  type RevenueFetchOutcome,
  type RevenueIgnoreReason,
  type RevenueListOptions,
  type RevenueListOutcome,
  type RevenueNormalizeOutcome,
  type RevenueNormalizedObject,
  type RevenueObjectKind,
  type RevenueObservation,
  type RevenueSyncResource,
  type RevenueWebhookVerification,
} from '@openanalytics/domain'
import { verifyStandardWebhookSignature } from './standard-webhooks-signature.ts'

/**
 * The Dodo Payments revenue adapter (ADR-0033, D1/D4; the D9 follow-up row for
 * Dodo).
 *
 * The third provider, and the first to arrive after Polar proved the framework:
 * an adapter and a catalog flip. No migration, no environment variable, no
 * OpenAPI change, no new grant — and, unlike Polar, not even a refactor, because
 * the header-set port Polar paid for is exactly what Dodo needs too.
 *
 * SDK-free like the two adapters beside it: `fetch`, a typed outcome, and no
 * third-party code on a path carrying a customer's own key.
 *
 * The connection model is the existing two-step connect: a customer-created API
 * key, plus a webhook endpoint they create in their Dodo dashboard and whose
 * signing secret they paste back.
 *
 * ## What Dodo shares with Polar, and where it differs
 *
 * - **Standard Webhooks, signed as the specification says.** Dodo documents the
 *   spec's own key derivation — strip `whsec_`, base64-decode the rest — and
 *   that is the verifier's default. Polar's literal-bytes deviation is Polar's
 *   alone; see `standard-webhooks-signature.ts`.
 * - **The event body carries no id.** The envelope is `{business_id, type,
 *   timestamp, data}`, so the delivery identity the ledger dedupes on is the
 *   `webhook-id` header, exactly as for Polar.
 * - **A merchant of record.** Dodo collects and remits tax, so `total_amount`
 *   includes money the seller never receives. The charge reads `total_amount -
 *   tax`, the same parity decision Polar's `net_amount` makes.
 * - **The list endpoint is thinner than the object.** `GET /payments` rows carry
 *   no `tax` field at all, so a listed row cannot be normalized to the same
 *   amount a webhook produces. The sync path therefore reads each payment it
 *   lists — see `listObjects`, and the page-size bound that keeps that honest.
 * - **Test and live are separate hosts.** `test.dodopayments.com` and
 *   `live.dodopayments.com` hold separate data under separate keys, so — as for
 *   Polar's sandbox — the environment *is* the base URL, a constructor argument
 *   rather than an environment variable.
 *
 * ## What this module is and is not allowed to do
 *
 * The port's two rules, unsoftened:
 *
 * - **It never throws.** Every failure is a typed outcome.
 * - **No response body leaves it.** `detail` is a status line or a reason word.
 *
 * And the money rule: **amounts are integer passthrough** from Dodo's own
 * integer minor-unit fields, with one documented subtraction (`total_amount -
 * tax`, both integers in the same currency). Nothing is parsed from a decimal or
 * multiplied by 100, and a non-integer is refused rather than rounded.
 */

export const DODO_REVENUE_PROVIDER_ID = 'dodo'

/** Live mode. Test mode is `https://test.dodopayments.com`, which the adapter
 * takes as a constructor argument so tests and a test-mode proof can point at it
 * without an environment variable existing. */
export const DODO_LIVE_API_BASE = 'https://live.dodopayments.com'
export const DODO_TEST_API_BASE = 'https://test.dodopayments.com'

/**
 * The probe: `GET /payments?page_size=1`.
 *
 * Payments is the resource every other one hangs off, so a key that can read it
 * is a key the sync path can start with. The body is never read.
 */
const PROBE_PATH = '/payments?page_size=1'

/** A customer is waiting on a form submit, so this is a UX bound. */
const PROBE_TIMEOUT_MS = 10_000

/** The sync path's per-request deadline: a request with no deadline inside a
 * leased job is a lease that expires while a socket hangs. */
const SYNC_TIMEOUT_MS = 30_000

/** Dodo's documented list maximum. */
export const DODO_LIST_PAGE_SIZE = 100

/**
 * The payments page size, deliberately below Dodo's maximum.
 *
 * A listed payment costs a second request (its row has no `tax`; see the module
 * header), so a payments page is `1 + n` requests, not one. The sync budget is
 * counted in *pages* and a lease is sized against it, so letting a page grow to
 * a hundred and one requests would make that budget mean something five times
 * larger than for every other resource and every other provider. Refunds and
 * disputes list complete objects and keep the full page.
 */
export const DODO_PAYMENTS_PAGE_SIZE = 20

/**
 * The consumed event allowlist (D4).
 *
 * The four `payment.*` events, the two `refund.*` and the seven `dispute.*` are
 * every money-bearing type Dodo documents. The `subscription.*` family is
 * understood and carries no money object of its own — a subscription's money
 * arrives as a `payment.*` event like any other. Anything outside this map is
 * ledgered `ignored` and acked: an endpoint subscribed broadly receives the
 * business's whole stream (license keys, payouts, credit ledger entries…), and a
 * 4xx for a type we correctly do not read would show the customer a permanently
 * failing endpoint.
 */
const CONSUMED_EVENTS: Readonly<Record<string, RevenueObjectKind | null>> = {
  'payment.succeeded': 'charge',
  'payment.failed': 'charge',
  'payment.processing': 'charge',
  'payment.cancelled': 'charge',
  'refund.succeeded': 'refund',
  'refund.failed': 'refund',
  'dispute.opened': 'dispute',
  'dispute.challenged': 'dispute',
  'dispute.accepted': 'dispute',
  'dispute.cancelled': 'dispute',
  'dispute.expired': 'dispute',
  'dispute.won': 'dispute',
  'dispute.lost': 'dispute',
  'subscription.active': null,
  'subscription.renewed': null,
  'subscription.updated': null,
  'subscription.plan_changed': null,
  'subscription.on_hold': null,
  'subscription.cancelled': null,
  'subscription.failed': null,
  'subscription.expired': null,
}

/**
 * The `payload_type` each kind's `data` must carry.
 *
 * Checked rather than trusted from the event name, because the field is Dodo's
 * own statement of what `data` is, and a `refund.succeeded` whose body is not a
 * Refund is a payload this adapter would otherwise read field-by-field into a
 * wrong-but-plausible observation.
 */
const PAYLOAD_TYPES: Readonly<Record<RevenueObjectKind, string>> = {
  charge: 'Payment',
  refund: 'Refund',
  dispute: 'Dispute',
}

// --- Shape readers -----------------------------------------------------------

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null)

/** `Number.isSafeInteger`, for the reason the other adapters give: a corrupted
 * `1234.5` must be refused rather than rounded into a plausible wrong number. */
const asInteger = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) ? value : null

/**
 * A minor-unit amount Dodo sends as a **string** — the dispute's `amount`,
 * documented as "a string to accommodate precision".
 *
 * Digits only. A decimal point here would mean the field is in major units,
 * which no other Dodo amount is, and the honest response to that is to refuse the
 * object rather than guess a scale and multiply.
 */
function asIntegerString(value: unknown): number | null {
  const raw = asString(value)
  if (raw === null || !/^\d+$/u.test(raw)) return null
  const parsed = Number(raw)
  return Number.isSafeInteger(parsed) ? parsed : null
}

/** An ISO-8601 timestamp → Date. Dodo sends microseconds, which `Date.parse`
 * truncates to the milliseconds the ordering decision works in anyway. */
function isoToDate(value: unknown): Date | null {
  const raw = asString(value)
  if (raw === null) return null
  const at = Date.parse(raw)
  return Number.isNaN(at) ? null : new Date(at)
}

/** Lowercase ISO-4217, as D5 stores it. Dodo sends uppercase. */
function currencyOf(object: Record<string, unknown>): string | null {
  const raw = asString(object['currency'])
  return raw === null || raw === '' ? null : raw.toLowerCase()
}

/** The customer's opaque id from the nested `customer` object. Never an email:
 * the same object carries one, and it is not read. */
function customerId(object: Record<string, unknown>): string {
  const customer = asRecord(object['customer'])
  return customer ? (asString(customer['customer_id']) ?? '') : ''
}

/**
 * The site's own opaque reference on a payment (D5/D6 signal 2).
 *
 * `oa_external_id` — OA's documented metadata key — on the payment first, then
 * on the customer. Checkout-session metadata is copied onto the payment, which
 * is where a site that passes it at checkout will find it; customer metadata is
 * where a site that keys customers by its own user id already keeps it.
 *
 * Raw, never hashed and never an email: the api holds no
 * `ANONYMOUS_IDENTITY_SECRET` and the worker derives the hash at projection time
 * (D6 amendment).
 */
function siteReference(object: Record<string, unknown>): string {
  const sources = [
    asRecord(object['metadata']),
    asRecord(asRecord(object['customer'])?.['metadata']),
  ]
  for (const metadata of sources) {
    if (!metadata) continue
    const value = asString(metadata['oa_external_id'])
    if (value !== null && value !== '') return value
  }
  return ''
}

// --- Normalizers -------------------------------------------------------------

/**
 * Build the canonical snapshot with every field present.
 *
 * Absent strings are `''` rather than `undefined`: the document is hashed for
 * the three-way decision, so a field sometimes missing and sometimes empty would
 * hash differently for identical states, and CP3 writes it into ClickHouse
 * `String` columns, which have no null.
 *
 * The fee is always **unknown** here (`fee_minor: 0`, `fee_currency: ''`),
 * because no payment field carries it. `settlement_amount` looks like it should,
 * and does not: checked against a test-mode payment on 2026-10-27, it is the
 * *whole* charge converted to the settlement currency, tax included (2299 USD,
 * of which `settlement_tax` 399, for a 11321 RON payment), while the dashboard
 * shows Dodo's fee (1.79 USD) as a separate line the API does not return.
 * Subtracting anything from it would invent a fee. `fee_currency: ''` is the
 * honest record.
 */
function snapshot(
  base: Pick<RevenueNormalizedObject, 'object_kind' | 'status' | 'livemode' | 'currency'>,
  gross: number,
  occurredAt: Date,
  refs: Partial<
    Pick<
      RevenueNormalizedObject,
      | 'parent_object_id'
      | 'order_id'
      | 'checkout_session_id'
      | 'client_reference_id'
      | 'subscription_id'
      | 'product_id'
      | 'customer_id'
    >
  >,
): RevenueNormalizedObject {
  return {
    object_kind: base.object_kind,
    status: base.status,
    livemode: base.livemode,
    currency: base.currency,
    gross_minor: gross,
    fee_minor: 0,
    fee_currency: '',
    net_minor: gross,
    occurred_at: occurredAt.toISOString(),
    parent_object_id: refs.parent_object_id ?? '',
    order_id: refs.order_id ?? '',
    checkout_session_id: refs.checkout_session_id ?? '',
    client_reference_id: refs.client_reference_id ?? '',
    subscription_id: refs.subscription_id ?? '',
    product_id: refs.product_id ?? '',
    // Dodo's payment carries product ids, not names; a name would cost a
    // product fetch per payment for a display field.
    product_name: '',
    customer_id: refs.customer_id ?? '',
  }
}

/**
 * Payment statuses that describe a payment that has not been attempted yet.
 *
 * Every Dodo status in the `requires_*` family *except* capture: a checkout the
 * customer opened and abandoned is `requires_payment_method`, and it moved no
 * money. These cannot be passed through, because the rollup counts any status it
 * does not know as money (`rollup-plan.ts`, `NO_MONEY_STATUSES` — deliberately,
 * so a provider's new vocabulary is never silently dropped). So they are not
 * charges at all: the webhook path reports them `no_observations` and the sync
 * path skips them. Matched by prefix, so a `requires_*` state Dodo adds later
 * lands on the safe side too.
 */
function isUnattemptedPayment(status: string): boolean {
  return status.startsWith('requires_') && status !== 'requires_capture'
}

/**
 * A payment's status in D5's vocabulary, or null when it is not a charge yet.
 *
 * - `succeeded` stays, promoted to `refunded`/`partially_refunded` from Dodo's
 *   own `refund_status` (`full`/`partial`). The gross is untouched by that — D2d
 *   puts the refund's amount in the refund's bucket.
 * - The in-flight states — `processing`, `requires_capture` and the
 *   `partially_captured*` pair — are `pending`, which the rollup counts, because
 *   the money is genuinely moving and a later failure is a new version.
 * - `cancelled` is spelled `canceled`, Stripe's and D5's spelling. The rollup
 *   accepts both; one spelling across providers is what makes a status filter
 *   on the read side mean the same thing for every connection.
 * - Anything else passes through lowercased, the repository's rule for a
 *   vocabulary it has not learned yet.
 */
function paymentStatus(object: Record<string, unknown>): string | null {
  const status = (asString(object['status']) ?? '').toLowerCase()
  if (status === '' || isUnattemptedPayment(status)) return null
  if (status === 'succeeded') {
    const refundStatus = asString(object['refund_status'])
    if (refundStatus === 'full') return 'refunded'
    if (refundStatus === 'partial') return 'partially_refunded'
    return 'succeeded'
  }
  if (
    status === 'processing' ||
    status === 'requires_capture' ||
    status.startsWith('partially_captured')
  ) {
    return 'pending'
  }
  if (status === 'cancelled') return 'canceled'
  return status
}

type Normalized = RevenueObservation | 'not_money' | null

/**
 * A Payment → a charge observation.
 *
 * ## The amount is `total_amount - tax`
 *
 * `total_amount` is what the customer paid, after discounts and *including* the
 * tax Dodo collects and remits as merchant of record; `tax` is that tax in the
 * same currency and minor unit. The difference is the seller's revenue, the
 * figure Polar's `net_amount` already reports for the same reason.
 *
 * `tax: null` is a documented value — no tax applied, as under a reverse charge
 * — and reads as zero. A **missing** `tax` key is different: it is the list
 * endpoint's row shape, which has no tax field at all, and reading that as zero
 * would overstate every taxed payment by its tax. It is refused, which is what
 * makes `listObjects` fetch the full payment instead.
 *
 * ## A zero total is zero revenue, whatever `tax` says
 *
 * A subscription plan change that nets to nothing is a `succeeded` payment with
 * `total_amount: 0` and a `tax` that is **not** zero — observed in test mode on
 * 2026-10-27 as both `1038` and `-2065` on `charge_type: plan_change` payments.
 * The tax belongs to the proration, not to money the customer paid: nothing was
 * charged, so nothing was remitted, and the seller received nothing. Subtracting
 * it would produce a negative charge or a refusal, and a refusal is worse than
 * it looks — the sync path skips the payment silently and the refetch path
 * retries it forever. Any *other* inconsistent tax (negative, or larger than a
 * positive total) is still refused: there the subtraction is the claim, and a
 * wrong one would be a plausible amount nobody questions.
 *
 * Returns `'not_money'` for a payment that has not been attempted (see
 * `isUnattemptedPayment`) and null when a required field is missing or the wrong
 * shape.
 */
function normalizePayment(object: Record<string, unknown>, livemode: boolean): Normalized {
  const objectId = asString(object['payment_id'])
  const currency = currencyOf(object)
  const total = asInteger(object['total_amount'])
  const created = isoToDate(object['created_at'])
  if (objectId === null || currency === null || total === null || created === null) return null
  if (!('tax' in object)) return null
  const reportedTax = object['tax'] === null ? 0 : asInteger(object['tax'])
  if (reportedTax === null) return null
  const tax = total === 0 ? 0 : reportedTax
  if (tax < 0 || tax > total) return null

  const status = paymentStatus(object)
  if (status === null) return 'not_money'

  const cart = Array.isArray(object['product_cart']) ? object['product_cart'] : []
  // One product is a product; a mixed cart has no single one to name, and naming
  // the first would attribute the whole payment to it.
  const product = cart.length === 1 ? asRecord(cart[0]) : null
  const subscriptions = Array.isArray(object['subscription_ids']) ? object['subscription_ids'] : []

  return {
    objectId,
    objectKind: 'charge',
    snapshotAt: created,
    normalized: snapshot(
      { object_kind: 'charge', status, livemode, currency },
      total - tax,
      created,
      {
        // The payment is the order. Dodo retries a failed renewal as a *new*
        // payment with its own id (`retry_attempt`), not as a second charge
        // under one intent, so there is no layer above it to join on — and the
        // `payment_id` is what Dodo appends to a checkout's `return_url`, which
        // is exactly the value a success page passes to `oa.conversion`.
        order_id: objectId,
        checkout_session_id: asString(object['checkout_session_id']) ?? '',
        client_reference_id: siteReference(object),
        customer_id: customerId(object),
        // `subscription_id` is null on a payment that starts several
        // subscriptions; the first of `subscription_ids` is still a real one.
        subscription_id: asString(object['subscription_id']) ?? asString(subscriptions[0]) ?? '',
        product_id: product ? (asString(product['product_id']) ?? '') : '',
      },
    ),
  }
}

/**
 * A Refund → a refund observation.
 *
 * The refund's own `amount`. Dodo reports no tax portion on a refund, so unlike
 * Polar's refund this is the amount returned to the customer, **tax included** —
 * a full refund of a taxed payment therefore reads larger than the charge it
 * reverses, by that payment's tax. Pro-rating it from the parent payment would
 * be a derived, rounded amount on a path the repository keeps to integer
 * passthrough, and the webhook path has no parent to read; so the provider's
 * number is recorded as-is and the asymmetry is named here rather than hidden.
 *
 * Statuses are Dodo's four; `review` is a refund the processor is still
 * checking, which is `pending` in D5's vocabulary.
 */
function normalizeRefund(object: Record<string, unknown>, livemode: boolean): Normalized {
  const objectId = asString(object['refund_id'])
  const currency = currencyOf(object)
  const gross = asInteger(object['amount'])
  const created = isoToDate(object['created_at'])
  if (objectId === null || currency === null || gross === null || created === null) return null

  const status = (asString(object['status']) ?? 'pending').toLowerCase()
  const paymentId = asString(object['payment_id']) ?? ''

  return {
    objectId,
    objectKind: 'refund',
    snapshotAt: created,
    normalized: snapshot(
      {
        object_kind: 'refund',
        status: status === 'review' ? 'pending' : status,
        livemode,
        currency,
      },
      gross,
      created,
      {
        // Our charge head for a Dodo payment is keyed on the payment id, so the
        // parent link resolves directly.
        parent_object_id: paymentId,
        order_id: paymentId,
        customer_id: customerId(object),
      },
    ),
  }
}

/**
 * A Dispute → a dispute observation.
 *
 * ## The status loses its `dispute_` prefix, and that is load-bearing
 *
 * Dodo spells every status `dispute_<state>`. The rollup decides what a dispute
 * did to the money from its status (`disputeMoneyEffect`), and it recognises a
 * won dispute as `won` — so `dispute_won` passed through would read as funds
 * still withdrawn, and every dispute a seller won would stay a loss in their
 * reports. Stripping the prefix keeps Dodo's own vocabulary (`opened`,
 * `challenged`, `won`, `lost`, …) and lets the shared rule apply to it; it also
 * makes `dispute_cancelled` the `cancelled` the rollup already treats as no
 * money, which is what a withdrawn dispute is.
 */
function normalizeDispute(object: Record<string, unknown>, livemode: boolean): Normalized {
  const objectId = asString(object['dispute_id'])
  const currency = currencyOf(object)
  const gross = asIntegerString(object['amount'])
  const created = isoToDate(object['created_at'])
  if (objectId === null || currency === null || gross === null || created === null) return null

  const raw = (asString(object['dispute_status']) ?? 'dispute_opened').toLowerCase()
  const status = raw.startsWith('dispute_') ? raw.slice('dispute_'.length) : raw
  const paymentId = asString(object['payment_id']) ?? ''

  return {
    objectId,
    objectKind: 'dispute',
    snapshotAt: created,
    normalized: snapshot({ object_kind: 'dispute', status, livemode, currency }, gross, created, {
      parent_object_id: paymentId,
      order_id: paymentId,
      customer_id: customerId(object),
    }),
  }
}

// --- The cursor --------------------------------------------------------------

/**
 * The pagination position, persisted verbatim in `revenue_sync_state.cursor`.
 *
 * Dodo paginates by page number, and caps the page number to bound its own
 * OFFSET scans — so a large window cannot be walked by counting pages, and a
 * walk that hit the cap would fail in a way that resetting the cursor only
 * repeats. The walk therefore moves its **upper bound** instead: Dodo lists
 * newest first, so after a full page the next request asks for everything
 * created at or before the oldest row just read, from page zero again. The page
 * number only advances in the degenerate case of a whole page sharing one
 * timestamp, where moving the bound would make no progress.
 *
 * `created_at_lte` is inclusive, so the boundary row is read twice. That is
 * free: the sync path's ledger id is deterministic per object and the object
 * head skips a byte-identical snapshot. The bound is kept as Dodo's **own**
 * timestamp string rather than a re-serialized `Date`, because Dodo stores
 * microseconds and a millisecond bound sent back would sit *before* the row it
 * came from and silently exclude it.
 *
 * `page|cutoff`. A cursor this module cannot parse is an `invalid_cursor` —
 * drop it and re-walk the window — rather than a silent restart.
 */
interface DodoCursor {
  readonly page: number
  readonly cutoff: string
}

function encodeCursor(cursor: DodoCursor): string {
  return `${String(cursor.page)}|${cursor.cutoff}`
}

function decodeCursor(raw: string): DodoCursor | null {
  const bar = raw.indexOf('|')
  if (bar < 0) return null
  const page = Number(raw.slice(0, bar))
  if (!Number.isSafeInteger(page) || page < 0) return null
  const cutoff = raw.slice(bar + 1)
  if (Number.isNaN(Date.parse(cutoff))) return null
  return { page, cutoff }
}

// --- HTTP helpers ------------------------------------------------------------

/** Bounded at five minutes: the runner's backoff brings a job back sooner and
 * more safely than an in-job sleep of an hour. */
const MAX_RETRY_AFTER_MS = 300_000

function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get('retry-after')
  if (header === null) return undefined
  const seconds = Number(header.trim())
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS)
  }
  const at = Date.parse(header)
  if (Number.isNaN(at)) return undefined
  return Math.min(Math.max(at - Date.now(), 0), MAX_RETRY_AFTER_MS)
}

interface DodoGetSuccess {
  readonly ok: true
  readonly body: Record<string, unknown>
}
interface DodoGetFailure {
  readonly ok: false
  readonly reason: 'unavailable' | 'unauthorized' | 'invalid_cursor'
  readonly detail: string
  readonly retryAfterMs?: number
  /** Dodo answered 404: the object is not there, as opposed to the request
   * being wrong. */
  readonly missing?: boolean
}

/**
 * One authenticated GET, with every failure typed.
 *
 * The residual-4xx split is the other adapters': every path and query here is
 * built by this module, except the one carrying a **stored value** — the
 * cursor's cutoff. On that request a residual 4xx is `invalid_cursor` (drop it
 * and re-walk); everywhere else it is `unauthorized`, whose recovery — check the
 * key — is the actionable one.
 */
async function dodoGet(
  fetchImpl: typeof fetch,
  baseUrl: string,
  apiKey: string,
  path: string,
  options: { readonly cursorSensitive?: boolean } = {},
): Promise<DodoGetSuccess | DodoGetFailure> {
  let response: Response
  try {
    response = await fetchImpl(`${baseUrl}${path}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
      signal: AbortSignal.timeout(SYNC_TIMEOUT_MS),
    })
  } catch {
    // DNS, TLS, a reset socket or our own deadline: none is evidence about the
    // customer's key.
    return { ok: false, reason: 'unavailable', detail: 'dodo request did not complete' }
  }

  if (response.status === 429) {
    const after = retryAfterMs(response)
    return {
      ok: false,
      reason: 'unavailable',
      detail: 'dodo responded 429',
      ...(after === undefined ? {} : { retryAfterMs: after }),
    }
  }
  if (response.status >= 500) {
    return { ok: false, reason: 'unavailable', detail: `dodo responded ${String(response.status)}` }
  }
  if (response.status === 401 || response.status === 403) {
    return {
      ok: false,
      reason: 'unauthorized',
      detail: `dodo responded ${String(response.status)}`,
    }
  }

  const residual: DodoGetFailure['reason'] =
    options.cursorSensitive === true ? 'invalid_cursor' : 'unauthorized'

  if (response.status === 404) {
    return { ok: false, reason: residual, detail: 'dodo responded 404', missing: true }
  }

  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null
  if (!response.ok || asRecord(body) === null) {
    return { ok: false, reason: residual, detail: `dodo responded ${String(response.status)}` }
  }
  return { ok: true, body: body as Record<string, unknown> }
}

const LIST_PATHS: Readonly<Record<RevenueSyncResource, string>> = {
  charges: '/payments',
  refunds: '/refunds',
  disputes: '/disputes',
}

const OBJECT_PATHS: Readonly<Record<RevenueObjectKind, string>> = {
  charge: '/payments',
  refund: '/refunds',
  dispute: '/disputes',
}

/** The id field each list row carries, which differs per resource. */
const ID_FIELDS: Readonly<Record<RevenueObjectKind, string>> = {
  charge: 'payment_id',
  refund: 'refund_id',
  dispute: 'dispute_id',
}

// --- The adapter -------------------------------------------------------------

export function createDodoRevenueAdapter(
  fetchImpl: typeof fetch = fetch,
  baseUrl: string = DODO_LIVE_API_BASE,
): RevenueAdapter {
  // No Dodo object carries a livemode flag: test and live are separate hosts, so
  // the environment is the base URL. Derived once rather than guessed per object.
  const livemode = baseUrl === DODO_LIVE_API_BASE

  const normalizers: Readonly<
    Record<RevenueObjectKind, (object: Record<string, unknown>) => Normalized>
  > = {
    charge: (object) => normalizePayment(object, livemode),
    refund: (object) => normalizeRefund(object, livemode),
    dispute: (object) => normalizeDispute(object, livemode),
  }

  /** The full object, for the refetch path and for a listed payment. */
  async function fetchFull(
    apiKey: string,
    objectKind: RevenueObjectKind,
    objectId: string,
  ): Promise<DodoGetSuccess | DodoGetFailure> {
    return dodoGet(
      fetchImpl,
      baseUrl,
      apiKey,
      `${OBJECT_PATHS[objectKind]}/${encodeURIComponent(objectId)}`,
    )
  }

  return {
    providerId: DODO_REVENUE_PROVIDER_ID,

    async verifyCredential(secretKey: string): Promise<RevenueCredentialVerification> {
      let response: Response
      try {
        response = await fetchImpl(`${baseUrl}${PROBE_PATH}`, {
          method: 'GET',
          headers: { authorization: `Bearer ${secretKey}`, accept: 'application/json' },
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        })
      } catch {
        return { outcome: 'unavailable', detail: 'dodo probe did not complete' }
      }

      if (response.status === 429 || response.status >= 500) {
        return { outcome: 'unavailable', detail: `dodo responded ${String(response.status)}` }
      }
      if (!response.ok) {
        // 401 is a key Dodo does not recognise — revoked, mistyped, or a
        // test-mode key sent to live, which is the mistake this probe will see
        // most. Any other 4xx is a request this module built, so it too means
        // the key did not buy the read.
        return { outcome: 'unauthorized', detail: `dodo responded ${String(response.status)}` }
      }

      // The body is a page of a customer's real payments; this call's only
      // question is answered by the status line.
      return { outcome: 'ok' }
    },

    /**
     * Standard Webhooks, with the specification's key derivation — the
     * verifier's default, so nothing about the secret is named here. That
     * absence is the difference from Polar, and it is deliberate.
     */
    verifyWebhook(input): RevenueWebhookVerification {
      const headers = input.headers ?? {}
      const verified = verifyStandardWebhookSignature({
        rawBody: input.rawBody,
        webhookId: headers['webhook-id'],
        webhookTimestamp: headers['webhook-timestamp'],
        signatureHeader: headers['webhook-signature'],
        secret: input.signingSecret,
        ...(input.now === undefined ? {} : { now: input.now }),
      })
      return verified.ok ? { ok: true } : { ok: false, reason: verified.reason }
    },

    /**
     * A Dodo event → zero or one canonical observation.
     *
     * The event id is the `webhook-id` header, because the body has none; a
     * delivery without it is `malformed_event` rather than an event with a
     * fabricated id that no redelivery could ever match.
     */
    normalizeEvent(parsedEvent: unknown, context): RevenueNormalizeOutcome {
      const event = asRecord(parsedEvent)
      const eventType = event ? asString(event['type']) : null
      const eventAt = event ? isoToDate(event['timestamp']) : null
      const eventId = context?.headers?.['webhook-id']
      if (!event || eventType === null || eventAt === null || !eventId) {
        return { ok: false, reason: 'malformed_event' }
      }

      const base = { eventId, eventType, eventAt }

      if (!(eventType in CONSUMED_EVENTS)) return ignored(base, 'unhandled_event_type')
      const kind = CONSUMED_EVENTS[eventType]
      if (kind === null || kind === undefined) return ignored(base, 'no_observations')

      const object = asRecord(event['data'])
      if (!object || asString(object['payload_type']) !== PAYLOAD_TYPES[kind]) {
        return ignored(base, 'unsupported_object_shape')
      }

      const observation = normalizers[kind](object)
      if (observation === 'not_money') return ignored(base, 'no_observations')
      if (observation === null) return ignored(base, 'unsupported_object_shape')

      return {
        ok: true,
        event: {
          ...base,
          // The event's time, not the object's: `created_at` never moves, so
          // every update to one payment would otherwise collapse into a
          // permanent equal-timestamp tie.
          observations: [{ ...observation, snapshotAt: eventAt }],
        },
      }
    },

    /**
     * One page of a list endpoint.
     *
     * ## Newest first, which D4 would rather not
     *
     * D4 walks a window oldest first. Dodo's lists have no ordering parameter
     * and return newest first, so — like Stripe's — this walk records the
     * deviation: an interrupted Dodo backfill holds a contiguous *newest*-first
     * prefix of its window. The upper-bound cursor above is what makes that
     * order resumable.
     *
     * ## A payments page reads every payment it lists
     *
     * The list row has no `tax`, and `normalizePayment` refuses a payment
     * without one, so each listed payment that could carry money is fetched
     * whole. Unattempted payments are skipped *before* the fetch — they are the
     * bulk of a store's abandoned checkouts and none of them is a charge. A
     * fetch that fails fails the page, so the cursor does not move past a
     * payment that was never read; a payment that 404s between the list and the
     * fetch is gone, and skipped.
     */
    async listObjects(
      secretKey: string,
      resource: RevenueSyncResource,
      options: RevenueListOptions,
    ): Promise<RevenueListOutcome> {
      let cursor: DodoCursor
      if (options.cursor !== null && options.cursor !== '') {
        const decoded = decodeCursor(options.cursor)
        if (decoded === null) {
          return { ok: false, reason: 'invalid_cursor', detail: 'dodo cursor is unreadable' }
        }
        cursor = decoded
      } else {
        cursor = { page: 0, cutoff: options.windowEnd.toISOString() }
      }

      const ceiling = resource === 'charges' ? DODO_PAYMENTS_PAGE_SIZE : DODO_LIST_PAGE_SIZE
      const limit = Math.min(Math.max(options.pageSize, 1), ceiling)
      const query = new URLSearchParams({
        page_size: String(limit),
        page_number: String(cursor.page),
        created_at_gte: options.windowStart.toISOString(),
        created_at_lte: cursor.cutoff,
      })

      const result = await dodoGet(
        fetchImpl,
        baseUrl,
        secretKey,
        `${LIST_PATHS[resource]}?${query.toString()}`,
        { cursorSensitive: options.cursor !== null && options.cursor !== '' },
      )
      if (!result.ok) return failure(result)

      const items = result.body['items']
      if (!Array.isArray(items)) {
        // Not a page we can walk, and treating it as empty would silently
        // complete a resource that was never read.
        return { ok: false, reason: 'unavailable', detail: 'dodo list response has no items' }
      }

      const kind = REVENUE_SYNC_RESOURCE_KINDS[resource]
      const observations: RevenueObservation[] = []
      let oldest: { at: number; raw: string } | null = null

      for (const row of items) {
        const listed = asRecord(row)
        if (!listed) continue

        const raw = asString(listed['created_at'])
        const at = raw === null ? Number.NaN : Date.parse(raw)
        if (raw !== null && !Number.isNaN(at) && (oldest === null || at < oldest.at)) {
          oldest = { at, raw }
        }

        let object = listed
        if (kind === 'charge') {
          if (isUnattemptedPayment((asString(listed['status']) ?? '').toLowerCase())) continue
          const id = asString(listed[ID_FIELDS.charge])
          if (id === null) continue
          const full = await fetchFull(secretKey, 'charge', id)
          if (!full.ok) {
            if (full.missing === true) continue
            return failure(full)
          }
          object = full.body
        }

        // A list row's snapshot time is the OBJECT's own `created_at` (D4),
        // which the normalizer already set — the property that makes a backfill
        // row structurally unable to outrank a newer webhook.
        const observation = normalizers[kind](object)
        if (observation === null || observation === 'not_money') continue
        observations.push(observation)
      }

      // Dodo's list carries no `has_more`; a short page is the end. A full page
      // that ends exactly at the window costs one empty request to learn that.
      const hasMore = items.length >= limit && oldest !== null
      let next: DodoCursor | null = null
      if (hasMore && oldest !== null) {
        next =
          oldest.at < Date.parse(cursor.cutoff)
            ? { page: 0, cutoff: oldest.raw }
            : // The whole page shares the bound's timestamp: moving the bound
              // would re-read this page forever, so step past it instead.
              { page: cursor.page + 1, cutoff: cursor.cutoff }
      }

      return {
        ok: true,
        page: {
          observations,
          nextCursor: next === null ? null : encodeCursor(next),
          hasMore: next !== null,
        },
      }
    },

    async fetchObject(
      secretKey: string,
      objectKind: RevenueObjectKind,
      objectId: string,
    ): Promise<RevenueFetchOutcome> {
      const result = await fetchFull(secretKey, objectKind, objectId)
      if (!result.ok) {
        // "This object does not exist" answers the tie-break's question; a
        // failure here would leave the ledger row `received` and make Dodo
        // redeliver forever over an object it has itself forgotten.
        if (result.missing === true) return { ok: true, observation: null, missing: true }
        return failure(result)
      }

      const observation = normalizers[objectKind](result.body)
      // A payment that turned out never to have been attempted is, for a charge
      // head, an object with nothing to be authoritative about.
      if (observation === 'not_money') return { ok: true, observation: null, missing: true }
      if (observation === null) {
        return { ok: false, reason: 'unavailable', detail: 'dodo object could not be read' }
      }
      return { ok: true, observation }
    },
  }
}

function ignored(
  base: { eventId: string; eventType: string; eventAt: Date },
  reason: RevenueIgnoreReason,
): RevenueNormalizeOutcome {
  return { ok: true, event: { ...base, observations: [], ignored: reason } }
}

/** A typed GET failure, narrowed to the adapter's public failure shape. */
function failure(result: DodoGetFailure): RevenueListOutcome & RevenueFetchOutcome {
  return {
    ok: false,
    reason: result.reason,
    detail: result.detail,
    ...(result.retryAfterMs === undefined ? {} : { retryAfterMs: result.retryAfterMs }),
  }
}

export { revenueObservationHash }
