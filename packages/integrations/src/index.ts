/**
 * External provider adapters.
 *
 * Milestone 0 fixes the boundary only. Stripe billing arrives in Milestone 3,
 * import providers in Milestone 11 and revenue providers in Milestone 12.
 *
 * Two rules hold for every adapter added here:
 *
 * - A provider failure is never flattened into an empty result. Legacy returned
 *   `[]` on error, so the dashboard showed a confident "0 revenue" for an
 *   outage (docs snapshot 01 §12.3). Adapters return an explicit outcome and the
 *   read layer reports `degraded`/`unavailable` with a last-successful-sync time.
 * - Providers are registered, not branched on. The revenue provider list grows
 *   through a registry rather than through `if/else` inside domain code
 *   (docs snapshot 02 §14).
 */

/** Explicit result type; there is no "empty means fine" case. */
export type ProviderResult<T> =
  | { readonly ok: true; readonly data: T; readonly fetchedAt: string }
  | {
      readonly ok: false
      readonly reason: 'unavailable' | 'rate_limited' | 'unauthorized' | 'invalid_response'
      /** Safe, categorized detail — never a raw provider error body. */
      readonly detail: string
      readonly lastSuccessfulSyncAt: string | null
    }

export interface ProviderAdapter<TConfig, TData> {
  readonly id: string
  fetch(config: TConfig, signal: AbortSignal): Promise<ProviderResult<TData>>
}

/**
 * Registry so adding a provider is a registration, not an edit to a switch.
 */
export class ProviderRegistry<TConfig, TData> {
  readonly #adapters = new Map<string, ProviderAdapter<TConfig, TData>>()

  register(adapter: ProviderAdapter<TConfig, TData>): void {
    if (this.#adapters.has(adapter.id)) {
      throw new Error(`Provider "${adapter.id}" is already registered`)
    }
    this.#adapters.set(adapter.id, adapter)
  }

  get(id: string): ProviderAdapter<TConfig, TData> | undefined {
    return this.#adapters.get(id)
  }

  ids(): string[] {
    return [...this.#adapters.keys()].sort()
  }
}

/**
 * Object storage (Milestone 1 item 10, G-001).
 *
 * The contract is fixed; the production provider is not. G-001 stays open until
 * private bucket, encryption, lifecycle, multipart, signed URL, region, egress
 * cost and a restore test have been compared — see
 * `docs/g-001-object-storage-comparison.md`.
 */
export {
  MULTIPART_MINIMUM_PART_BYTES,
  MULTIPART_THRESHOLD_BYTES,
  ObjectStorageError,
  SINGLE_PUT_MAXIMUM_BYTES,
  assertValidLifecycleRule,
  assertValidPartPlan,
  requiresMultipart,
  type BucketLifecycleRule,
  type GetObjectResult,
  type GetObjectStreamResult,
  type HeadObjectResult,
  type ListedObject,
  type MultipartUpload,
  type ObjectRef,
  type ObjectStorage,
  type ObjectStorageConfig,
  type PutObjectInput,
  type PutObjectResult,
  type SignedDownloadInput,
  type SignedUploadInput,
  type SignedUrl,
  type StorageFailureReason,
  type UploadedPart,
} from './object-storage.ts'

export { createS3ObjectStorage } from './object-storage-s3.ts'

/**
 * Transactional email (G-007: Resend behind an adapter, joined by SMTP so a
 * self-hosted install has a door to deliver its magic link through). The API
 * enqueues; the worker delivers by draining the outbox. Every send goes through
 * the outbox and a provider failure is a typed outcome, never a silent success
 * (docs snapshot 02 §6).
 */
export {
  createLogEmailTransport,
  createResendTransport,
  createSmtpTransport,
  selectEmailTransport,
  SMTP_DEFAULT_PORT,
  SMTP_IMPLICIT_TLS_PORT,
  type EmailLogFn,
  type EmailMessage,
  type EmailSendOptions,
  type EmailSendOutcome,
  type EmailTransport,
  type LogEmailTransport,
  type ResendTransportConfig,
  type SelectEmailTransportDeps,
  type SmtpEnvBlock,
  type SmtpMailer,
  type SmtpMailerFactory,
  type SmtpTransportConfig,
} from './email.ts'

/**
 * Stripe billing (Milestone 3). No SDK: the webhook signature is verified
 * directly and the REST calls go over `fetch`, so the security-critical path
 * carries no third-party code. The pure reconciliation decision is in
 * `@openanalytics/domain`; this adapter verifies, normalizes and calls the API.
 */

/**
 * The versioned credential keyring (ADR-0033, D3) and the Stripe revenue
 * adapter that is its first consumer. The keyring is the repository's first
 * encryption-at-rest primitive and is deliberately not revenue-specific: the
 * AAD is caller-supplied, so any future stored provider credential binds its own
 * row identity through the same cipher.
 */
export {
  CREDENTIAL_KEY_BYTES,
  CREDENTIAL_NONCE_BYTES,
  CREDENTIAL_TAG_BYTES,
  CredentialKeyringError,
  createCredentialVault,
  credentialLast4,
  parseCredentialKeyring,
  type CredentialDecryptFailure,
  type CredentialDecryptOutcome,
  type CredentialKeyringFailure,
  type CredentialVault,
  type EncryptedCredential,
} from './credential-vault.ts'

export {
  STRIPE_LIST_PAGE_SIZE,
  STRIPE_REVENUE_PROVIDER_ID,
  createStripeRevenueAdapter,
} from './stripe-revenue.ts'

/**
 * The second revenue provider (ADR-0033 D1's promise, and the D9 follow-up row
 * for Polar). An adapter and a catalog flip — no migration, no environment
 * variable, no OpenAPI change.
 */
export {
  POLAR_API_BASE,
  POLAR_LIST_PAGE_SIZE,
  POLAR_REVENUE_PROVIDER_ID,
  createPolarRevenueAdapter,
} from './polar-revenue.ts'

/**
 * The third revenue provider, and the first that cost the framework nothing at
 * all: Standard Webhooks signed per the specification, an event id in the
 * header Polar already taught the port to carry.
 */
export {
  DODO_LIST_PAGE_SIZE,
  DODO_LIVE_API_BASE,
  DODO_PAYMENTS_PAGE_SIZE,
  DODO_REVENUE_PROVIDER_ID,
  DODO_TEST_API_BASE,
  createDodoRevenueAdapter,
} from './dodo-revenue.ts'

/**
 * The Standard Webhooks verifier, beside the Stripe one. Exported because the
 * webhook suites sign with it, and because the next provider on the D9 list that
 * uses the scheme should find it rather than write a second copy.
 */
export {
  STANDARD_WEBHOOK_TOLERANCE_SECONDS,
  verifyStandardWebhookSignature,
  type StandardWebhookFailure,
  type StandardWebhookResult,
  type StandardWebhookSecretEncoding,
} from './standard-webhooks-signature.ts'

/**
 * The assistant's model provider (ADR-0046, D6). No SDK, for the reason the
 * Stripe adapter has none: Chat Completions with streaming and tool calls is a
 * POST with an SSE response and a documented JSON shape, and a dependency in
 * the api's install path is a cost every CI run pays. Keeping the protocol here
 * is also what makes F-306's "the provider is configuration" true — an SDK is
 * the one thing that would make a provider hard to change.
 */
export {
  createOpenAiChatClient,
  type OpenAiChatClient,
  type OpenAiChatCompletion,
  type OpenAiChatConfig,
  type OpenAiChatMessage,
  type OpenAiFailureReason,
  type OpenAiOutcome,
  type OpenAiToolCall,
  type OpenAiToolDefinition,
  type OpenAiUsage,
  type StreamChatInput,
} from './openai.ts'

export {
  EMAIL_OUTBOX_TOPIC,
  buildBillingTransferOfferEmailPayload,
  buildDeploymentTestEmailPayload,
  buildFormNotificationEmailPayload,
  buildInviteEmailPayload,
  buildRapidBurnEmailPayload,
  buildMagicLinkEmailPayload,
  buildVerificationEmailPayload,
  parseEmailOutboxPayload,
  processEmailOutbox,
  toEmailMessage,
  type DueOutboxRow,
  type EmailOutboxPayload,
  type EmailOutboxStore,
  type ProcessEmailOutboxDeps,
  type ProcessEmailOutboxResult,
} from './email-outbox.ts'

export {
  deploymentSettingAad,
  parseStoredEmailSettings,
  resolveStoredAssistantProvider,
  resolveStoredSecret,
  resolveStoredSmtpBlock,
  type DeploymentSettingScopeName,
  type ResolveStoredSecretDeps,
  type StoredAssistantProvider,
  type StoredDeploymentSetting,
} from './deployment-settings.ts'

/**
 * Telegram notifications (dashboard feedback → the operators' group). The same
 * outbox discipline as email: the API enqueues, the worker delivers, and the
 * destination chat is worker configuration a submitted value can never redirect.
 */

export {
  STRIPE_SIGNATURE_TOLERANCE_SECONDS,
  verifyStripeSignature,
  type StripeSignatureFailure,
  type StripeSignatureResult,
} from './stripe-signature.ts'
