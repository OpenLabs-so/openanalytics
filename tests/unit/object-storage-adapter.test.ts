import type * as S3Module from '@aws-sdk/client-s3'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The S3 adapter's error classification, against a faked client.
 *
 * The S3 contract suite (`tests/integration/object-storage-s3.test.ts`) is
 * where the adapter is proven against a real server, and it stays the truth for
 * everything storage actually does. What it cannot exercise is the failure
 * *classification*: a healthy server never answers `NoSuchBucket`, and provoking
 * one would mean deleting the bucket mid-suite. So the mapping — which failure
 * is an outage, which is an absence, and what each one makes a caller do — is
 * pinned here, where the provider's answer is an input rather than a condition
 * to arrange.
 *
 * The two rules under test both exist because of a real incident or a real
 * contract clause, not for symmetry:
 *
 * 1. `NoSuchBucket` is an **outage**, decided before the generic 404. Verified
 *    live against Hetzner Object Storage on 2026-07-29: a freshly created bucket
 *    is intermittently invisible on some gateway nodes, which answer 404. Under
 *    the generic mapping that reads as `not_found`, and `head()` turns
 *    `not_found` into `null` — so a site deletion's "the object is gone" check
 *    would pass during exactly the window in which storage cannot see the bucket.
 * 2. `delete` is **idempotent** by contract, because D-210 re-runs deletion and
 *    verifies afterwards. A provider that 404s an already-absent key must not
 *    turn the desired end state into a failure.
 */

/**
 * What the faked `send` will do next, set per test.
 *
 * `results` is a queue, for the one call that legitimately makes several
 * requests: a paginated listing. Every other test sets `result` and gets the
 * same answer however many times it asks.
 */
const behaviour: { fail?: unknown; result?: unknown; results?: unknown[] } = {}
/** Every command the adapter sent, so a test can assert on pagination state. */
const sent: unknown[] = []

class FakeS3Client {
  async send(command: unknown): Promise<unknown> {
    await Promise.resolve()
    sent.push(command)
    if (behaviour.fail !== undefined) throw behaviour.fail
    if (behaviour.results !== undefined) return behaviour.results.shift() ?? {}
    return behaviour.result ?? {}
  }
}

vi.mock('@aws-sdk/client-s3', async (importOriginal) => {
  // The command classes stay real: they are what the adapter builds, and a fake
  // that accepted anything would hide a malformed request shape.
  const actual = await importOriginal<typeof S3Module>()
  return { ...actual, S3Client: FakeS3Client }
})

const { ObjectStorageError, createS3ObjectStorage } = await import('@openanalytics/integrations')

const storage = createS3ObjectStorage({
  endpoint: 'https://storage.test',
  region: 'hel1',
  bucket: 'oa-test',
  accessKeyId: 'key',
  secretAccessKey: 'secret',
})

/** An SDK error, in the two shapes providers actually produce. */
function providerError(options: {
  name?: string
  code?: string
  status?: number
}): Error & Record<string, unknown> {
  const error = new Error(options.name ?? options.code ?? 'error') as Error &
    Record<string, unknown>
  error.name = options.name ?? 'Error'
  if (options.code !== undefined) error['Code'] = options.code
  error['$metadata'] = { httpStatusCode: options.status ?? 404 }
  return error
}

beforeEach(() => {
  delete behaviour.fail
  delete behaviour.result
  delete behaviour.results
  sent.length = 0
})

describe('S3 adapter — NoSuchBucket is an outage, not an absence', () => {
  it('maps the error NAME to `unavailable`, ahead of the generic 404', () => {
    behaviour.fail = providerError({ name: 'NoSuchBucket', status: 404 })
    return expect(storage.head({ key: 'k' })).rejects.toMatchObject({
      name: 'ObjectStorageError',
      reason: 'unavailable',
      // Retryable: an invisible bucket resolves on its own, and the deletion
      // executor's whole "waiting is not failing" model depends on this flag.
      retryable: true,
    })
  })

  it('maps the error CODE to `unavailable` too', () => {
    // Some S3-compatible gateways carry the classification in `Code` and leave
    // `name` as the generic SDK error, which is how this slipped past a
    // name-only check in the first place.
    behaviour.fail = providerError({ name: 'Error', code: 'NoSuchBucket', status: 404 })
    return expect(storage.head({ key: 'k' })).rejects.toMatchObject({ reason: 'unavailable' })
  })

  it('does NOT let head() report absence during the flap', async () => {
    // The defect this whole mapping exists to prevent: `head() === null` is what
    // the object purge accepts as proof that a customer's archive is gone.
    behaviour.fail = providerError({ name: 'NoSuchBucket', status: 404 })
    await expect(storage.head({ key: 'k' })).rejects.toBeInstanceOf(ObjectStorageError)
  })

  it('still reports a genuinely missing OBJECT as absence', async () => {
    behaviour.fail = providerError({ name: 'NotFound', status: 404 })
    await expect(storage.head({ key: 'k' })).resolves.toBeNull()
  })
})

describe('S3 adapter — InvalidArgument is a refusal, not an outage', () => {
  it('maps InvalidArgument to a non-retryable precondition failure', () => {
    // Measured against MinIO RELEASE.2025-09: an abort-incomplete-only
    // lifecycle rule is refused with this code. Retrying the identical
    // request can only fail identically, so the flag must say stop.
    behaviour.fail = providerError({ name: 'InvalidArgument', status: 400 })
    return expect(
      storage.putBucketLifecycle([{ id: 'r', prefix: 'x/', expirationDays: 7 }]),
    ).rejects.toMatchObject({ reason: 'precondition_failed', retryable: false })
  })

  it('does not widen the mapping to every 400', () => {
    // S3 reuses 400 for retryable conditions such as RequestTimeout; only the
    // named refusal is a refusal.
    behaviour.fail = providerError({ name: 'RequestTimeout', status: 400 })
    return expect(
      storage.putBucketLifecycle([{ id: 'r', prefix: 'x/', expirationDays: 7 }]),
    ).rejects.toMatchObject({ reason: 'unavailable', retryable: true })
  })
})

describe('S3 adapter — delete is idempotent', () => {
  it('swallows a mapped not_found instead of throwing', async () => {
    behaviour.fail = providerError({ name: 'NoSuchKey', status: 404 })
    await expect(storage.delete([{ key: 'gone' }])).resolves.toBeUndefined()
  })

  it('still surfaces a real outage, which the caller must retry', async () => {
    // The other half of the same rule: idempotent must not mean "never fails".
    // A swallowed 503 would let a purge report success over objects that are
    // still there.
    behaviour.fail = providerError({ name: 'InternalError', status: 503 })
    await expect(storage.delete([{ key: 'k' }])).rejects.toMatchObject({
      reason: 'unavailable',
      retryable: true,
    })
  })

  it('still surfaces a rejected credential', async () => {
    behaviour.fail = providerError({ name: 'AccessDenied', status: 403 })
    await expect(storage.delete([{ key: 'k' }])).rejects.toMatchObject({
      reason: 'unauthorized',
      retryable: false,
    })
  })

  it('sends nothing at all for an empty key list', async () => {
    behaviour.fail = providerError({ name: 'InternalError', status: 503 })
    // No round trip, so the primed failure cannot fire.
    await expect(storage.delete([])).resolves.toBeUndefined()
  })

  it('refuses a 200 that carries per-key errors, and names the keys', async () => {
    // `DeleteObjects` is a batch operation: the HTTP status says the request was
    // understood, and the body says which keys were not removed. Trusting the
    // status alone is how a site deletion would report "erased" over bytes that
    // are still there.
    behaviour.result = {
      Errors: [
        { Key: 'imports/a/1/archive.zip', Code: 'AccessDenied' },
        { Key: 'imports/a/2/archive.zip', Code: 'InternalError' },
      ],
    }
    await expect(
      storage.delete([{ key: 'imports/a/1/archive.zip' }, { key: 'imports/a/2/archive.zip' }]),
    ).rejects.toMatchObject({
      name: 'ObjectStorageError',
      // Retryable: the object phase's model is that waiting is not failing, and
      // the `head() = null` verification is what settles it either way.
      reason: 'unavailable',
      retryable: true,
      message: expect.stringContaining('imports/a/1/archive.zip') as unknown as string,
    })
  })

  it('treats a per-key not-found as the desired end state, not an error', async () => {
    // The same idempotency rule the thrown-404 branch applies, one layer in:
    // deletion re-runs, and a key that is already gone is the outcome asked for.
    behaviour.result = {
      Errors: [
        { Key: 'imports/a/1/archive.zip', Code: 'NoSuchKey' },
        { Key: 'imports/a/2/archive.zip', Code: 'NotFound' },
      ],
    }
    await expect(
      storage.delete([{ key: 'imports/a/1/archive.zip' }, { key: 'imports/a/2/archive.zip' }]),
    ).resolves.toBeUndefined()
  })

  it('accepts the quiet success shape, which reports no errors at all', async () => {
    behaviour.result = {}
    await expect(storage.delete([{ key: 'k' }])).resolves.toBeUndefined()
  })
})

describe('S3 adapter — lifecycle', () => {
  it('reads an unset configuration as an empty rule set', async () => {
    // `NoSuchLifecycleConfiguration` is a 404 that means "the bucket has no
    // rules", which is an answer. It reaches the not_found branch only because
    // a missing *bucket* is now classified as an outage before it.
    behaviour.fail = providerError({ name: 'NoSuchLifecycleConfiguration', status: 404 })
    await expect(storage.getBucketLifecycle()).resolves.toEqual([])
  })

  it('refuses to read an unset configuration when the bucket itself is missing', async () => {
    behaviour.fail = providerError({ name: 'NoSuchBucket', status: 404 })
    await expect(storage.getBucketLifecycle()).rejects.toMatchObject({ reason: 'unavailable' })
  })

  it('refuses a rule that expresses no expiry at all', async () => {
    // Accepted by some providers and silently ignored by others, so the orphan
    // sweep it was meant to install would simply never run.
    await expect(
      storage.putBucketLifecycle([{ id: 'noop', prefix: 'imports/' }]),
    ).rejects.toBeInstanceOf(RangeError)
  })

  it('reads back the deprecated top-level prefix form as well as the filter form', async () => {
    behaviour.result = {
      Rules: [
        { ID: 'a', Filter: { Prefix: 'imports/' }, Expiration: { Days: 7 } },
        { ID: 'b', Prefix: 'exports/', AbortIncompleteMultipartUpload: { DaysAfterInitiation: 3 } },
      ],
    }
    await expect(storage.getBucketLifecycle()).resolves.toEqual([
      { id: 'a', prefix: 'imports/', expirationDays: 7 },
      { id: 'b', prefix: 'exports/', abortIncompleteMultipartDays: 3 },
    ])
  })
})

describe('S3 adapter — newestUnder walks the whole prefix', () => {
  /**
   * The backup alert (ADR-0052, D10) reduces a prefix to one fact: how old the
   * newest object is. Two ways to get that wrong both fail in the same
   * direction — reporting a stale backup as fresh — so both are pinned.
   *
   * 1. **Stopping at the first page.** S3 returns at most 1000 keys and the
   *    caller must follow `NextContinuationToken`. A backup prefix holds 30
   *    objects today, so a truncating implementation would look correct for
   *    years and then quietly cap.
   * 2. **Trusting key order.** S3 lists keys lexicographically, not by time.
   *    "The last entry" is not "the newest object" the moment a key naming
   *    scheme changes, or a generation directory sorts after a newer one.
   */
  it('follows the continuation token instead of stopping at the first page', async () => {
    behaviour.results = [
      {
        Contents: [{ Key: 'backups/daily/a.zip', Size: 1, LastModified: new Date('2026-08-01') }],
        IsTruncated: true,
        NextContinuationToken: 'page-2',
      },
      {
        Contents: [{ Key: 'backups/daily/b.zip', Size: 2, LastModified: new Date('2026-08-09') }],
        IsTruncated: false,
      },
    ]

    await expect(storage.newestUnder('backups/daily/')).resolves.toEqual({
      key: 'backups/daily/b.zip',
      size: 2,
      lastModified: new Date('2026-08-09'),
    })
    expect(sent).toHaveLength(2)
  })

  it('picks the newest by timestamp, not the last key in the listing', async () => {
    behaviour.result = {
      Contents: [
        { Key: 'backups/daily/k2/aaa.zip', Size: 9, LastModified: new Date('2026-08-09') },
        { Key: 'backups/daily/k2/zzz.zip', Size: 1, LastModified: new Date('2026-07-01') },
      ],
      IsTruncated: false,
    }

    await expect(storage.newestUnder('backups/daily/')).resolves.toMatchObject({
      key: 'backups/daily/k2/aaa.zip',
    })
  })

  it('resolves null for an empty prefix rather than inventing a date', async () => {
    behaviour.result = { Contents: [], IsTruncated: false }
    await expect(storage.newestUnder('backups/daily/')).resolves.toBeNull()
  })

  it('reports a storage outage instead of an empty prefix', async () => {
    // The dangerous confusion: "the bucket is unreachable" must not read as
    // "there are no backups", because one is a monitoring fault and the other
    // is a data-loss risk. NoSuchBucket during the ~10-minute Hetzner
    // visibility flap is the concrete case.
    behaviour.fail = providerError({ name: 'NoSuchBucket', status: 404 })
    await expect(storage.newestUnder('backups/daily/')).rejects.toMatchObject({
      reason: 'unavailable',
    })
  })
})
