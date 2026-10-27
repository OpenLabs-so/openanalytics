/**
 * The revenue provider catalog (ADR-0033, D1).
 *
 * The same two-layer split M11 used for imports, and for the same reason: a
 * catalog descriptor says what this build offers, and an adapter says how one
 * provider behaves. The frontend renders the catalog, so the picker converges on
 * what the backend can actually do without a redeploy.
 *
 * `available: false` is a *listed* provider rather than an absent one. "Polar is
 * coming" and "Polar is not a thing we do" are different answers, and a screen
 * that can only show working adapters can give only the second.
 *
 * There is no `capability` field here, unlike `ImportProviderDescriptor`. That
 * field exists because a provider's *export* varies in what it contains; every
 * provider in this list connects the same way — an API key plus a webhook — and
 * a field whose value would be identical on all six rows would state nothing.
 */

export interface RevenueProviderDescriptor {
  readonly id: string
  readonly displayName: string
  /** Whether this build has a working adapter. Never inferred from the list. */
  readonly available: boolean
}

/**
 * The catalog, in the order the picker should show it: what works first.
 *
 * Stripe is the launch provider (F-303, closed by ADR-0033 D1). **Polar is the
 * second, and it arrived as the ADR promised**: an adapter, plus this line
 * changing from `false` to `true`. No migration, no environment variable, no
 * OpenAPI change, no new grant — the provider column was free text by design
 * (`0026_revenue_credentials.sql`) and the framework was the whole point.
 *
 * It was not entirely free. Polar's signature spans three headers and its event
 * body carries no id, which cost the webhook route the provider→header-name map
 * it used to keep — a refactor D4's own comment had already named. That is the
 * boundary this catalog is really testing: a second provider may cost the
 * *transport* a generalization, and must cost the architecture nothing.
 *
 * **Dodo Payments is the third**, and it cost the transport nothing: it signs
 * Standard Webhooks per the specification and keeps its event id in the same
 * header Polar's does. It moved up to sit with the providers that work, which is
 * the order this list promises.
 *
 * The remaining three are recorded follow-ups behind the same framework.
 */
export const REVENUE_PROVIDERS: readonly RevenueProviderDescriptor[] = [
  { id: 'stripe', displayName: 'Stripe', available: true },
  { id: 'polar', displayName: 'Polar', available: true },
  { id: 'dodo', displayName: 'Dodo Payments', available: true },
  { id: 'paddle', displayName: 'Paddle', available: false },
  { id: 'lemonsqueezy', displayName: 'Lemon Squeezy', available: false },
  { id: 'creem', displayName: 'Creem', available: false },
]

export function findRevenueProvider(id: unknown): RevenueProviderDescriptor | null {
  if (typeof id !== 'string') return null
  return REVENUE_PROVIDERS.find((provider) => provider.id === id) ?? null
}

/**
 * A credential's connection status (ADR-0033, D3).
 *
 * `degraded` is the one that carries the milestone's whole point: a provider
 * outage is a *state*, never a zero. A degraded credential keeps serving the
 * facts it has and the read surface says so (D7).
 */
export const REVENUE_CREDENTIAL_STATUSES = ['active', 'degraded', 'disabled'] as const
export type RevenueCredentialStatus = (typeof REVENUE_CREDENTIAL_STATUSES)[number]

export function isRevenueCredentialStatus(value: unknown): value is RevenueCredentialStatus {
  return (
    typeof value === 'string' && (REVENUE_CREDENTIAL_STATUSES as readonly string[]).includes(value)
  )
}

/**
 * The AAD a stored provider secret is bound to (ADR-0033, D3).
 *
 * Both the credential id and the site id, so a ciphertext lifted out of one row
 * decrypts on no other row — not on a different credential of the same site, and
 * not on the same credential id if it were somehow re-pointed at another site.
 * Pure, and in `domain` rather than beside the cipher, because the api encrypts
 * and the worker decrypts and the two must derive the identical string.
 */
export function revenueCredentialAad(input: {
  readonly credentialId: string
  readonly siteId: string
}): string {
  return `revenue_credential:${input.credentialId}:${input.siteId}`
}

/**
 * The per-site webhook path (ADR-0033, D4).
 *
 * The token is opaque and per credential, so every site has its own endpoint and
 * its own signing secret — the property the ADR chose over Stripe Connect's one
 * shared platform secret. Built here so the api's connect response and the CP2
 * route derive the same path from one definition.
 */
export function revenueWebhookPath(provider: string, webhookToken: string): string {
  return `/v1/revenue/webhooks/${encodeURIComponent(provider)}/${encodeURIComponent(webhookToken)}`
}
