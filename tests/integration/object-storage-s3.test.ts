import { randomUUID } from 'node:crypto'
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3'
import {
  MULTIPART_MINIMUM_PART_BYTES,
  ObjectStorageError,
  assertValidPartPlan,
  createS3ObjectStorage,
  requiresMultipart,
} from '@openanalytics/integrations'
import type { ObjectStorage } from '@openanalytics/integrations'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Milestone 1 item 10 and G-001: the S3-compatible adapter, against MinIO.
 *
 * MinIO stands in for the production provider precisely because the provider is
 * still open. The adapter has one implementation for every candidate, so this
 * exercises the code path production will use — what a later provider changes
 * is configuration, and what this test protects is that that stays true.
 *
 * Skipped unless a MinIO endpoint is supplied, so a contributor without one
 * still gets a green run. CI provides it as a service container.
 */

const ENDPOINT = process.env['TEST_S3_ENDPOINT']
const ACCESS_KEY = process.env['TEST_S3_ACCESS_KEY'] ?? 'minioadmin'
const SECRET_KEY = process.env['TEST_S3_SECRET_KEY'] ?? 'minioadmin'

const describeIfMinio = ENDPOINT ? describe : describe.skip

describeIfMinio('S3-compatible object storage against MinIO', () => {
  const bucket = `oa-m1-${randomUUID().slice(0, 8)}`
  let storage: ObjectStorage

  beforeAll(async () => {
    const admin = new S3Client({
      region: 'us-east-1',
      endpoint: ENDPOINT as string,
      forcePathStyle: true,
      credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
    })
    await admin.send(new CreateBucketCommand({ Bucket: bucket }))

    storage = createS3ObjectStorage({
      endpoint: ENDPOINT as string,
      region: 'us-east-1',
      bucket,
      accessKeyId: ACCESS_KEY,
      secretAccessKey: SECRET_KEY,
      forcePathStyle: true,
    })
  }, 60_000)

  afterAll(async () => {
    // Best effort: the bucket is per-run and MinIO is ephemeral in CI.
    try {
      await storage.delete([{ key: 'roundtrip.json' }, { key: 'export.csv' }])
    } catch {
      /* the run is over; a failed cleanup must not fail the suite */
    }
  })

  it('round-trips an object with its content type', async () => {
    const body = JSON.stringify({ hello: 'world' })
    const put = await storage.put({
      key: 'roundtrip.json',
      body,
      contentType: 'application/json',
    })
    expect(put.size).toBe(Buffer.byteLength(body))

    const got = await storage.get({ key: 'roundtrip.json' })
    expect(Buffer.from(got.body).toString('utf8')).toBe(body)
    expect(got.contentType).toBe('application/json')
  })

  it('streams an object and carries its fingerprint on the same response', async () => {
    // ADR-0032 D6.3. The import pipeline must never buffer a 256 MiB archive in
    // the worker's heap, and it must verify the pinned ETag against the *bytes
    // it is about to read* — doing that with a separate `head()` would leave a
    // window between the check and the read, which is precisely what a client
    // re-PUTting through a still-valid signed URL would use.
    const body = 'a'.repeat(5_000)
    const put = await storage.put({ key: 'stream.csv', body, contentType: 'text/csv' })

    const stream = await storage.getStream({ key: 'stream.csv' })
    expect(stream.size).toBe(body.length)
    expect(stream.etag).toBe(put.etag)

    const chunks: Buffer[] = []
    for await (const chunk of stream.body) chunks.push(Buffer.from(chunk))
    expect(Buffer.concat(chunks).toString('utf8')).toBe(body)
    // More than one chunk is not guaranteed at this size; what matters is that
    // the body arrived as an iterable rather than as one materialised buffer.
    expect(chunks.length).toBeGreaterThan(0)

    await storage.delete([{ key: 'stream.csv' }])
  })

  it('classifies a streamed read of a missing object', async () => {
    const error = await storage.getStream({ key: 'never-written' }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ObjectStorageError)
    expect((error as ObjectStorageError).reason).toBe('not_found')
  })

  it('reports a missing object as absence, not as a failure', async () => {
    // The distinction the import flow depends on: "the upload has not arrived"
    // must be answerable without treating storage as broken.
    await expect(storage.head({ key: 'never-written' })).resolves.toBeNull()
  })

  it('distinguishes a missing object from an outage on read', async () => {
    // The legacy failure this contract exists to prevent is an error that reads
    // as an empty success (docs snapshot 01 §12.3), so `get` must throw, and
    // throw something classified.
    const error = await storage.get({ key: 'never-written' }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ObjectStorageError)
    expect((error as ObjectStorageError).reason).toBe('not_found')
    // A missing object will be missing no matter how often it is asked for.
    expect((error as ObjectStorageError).retryable).toBe(false)
  })

  it('treats delete as idempotent', async () => {
    // D-210 re-runs deletion and verifies afterwards, so deleting an absent key
    // must not be an error.
    await expect(storage.delete([{ key: 'never-written' }])).resolves.toBeUndefined()
    await expect(storage.delete([])).resolves.toBeUndefined()
  })

  it('issues a signed download URL that works without credentials', async () => {
    await storage.put({ key: 'export.csv', body: 'a,b\n1,2\n', contentType: 'text/csv' })

    const signed = await storage.signedDownloadUrl({
      key: 'export.csv',
      expiresInSeconds: 60,
      downloadFilename: 'analytics-export.csv',
    })
    expect(signed.expiresAt.getTime()).toBeGreaterThan(Date.now())

    // No Authorization header: this is what a browser gets handed.
    const response = await fetch(signed.url)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('a,b\n1,2\n')

    // Exports download rather than render; an inline HTML export served from
    // the bucket origin would be a stored-XSS surface.
    expect(response.headers.get('content-disposition')).toContain('attachment')
  })

  it('refuses an unsigned request for the same object', async () => {
    // Proves the bucket is private, which is the assumption every signed URL
    // rests on. If this passes, the signing is decorative.
    const response = await fetch(`${ENDPOINT as string}/${bucket}/export.csv`)
    expect(response.status).toBeGreaterThanOrEqual(400)
  })

  it('signs an upload URL that a browser can PUT to directly', async () => {
    const body = 'uploaded-by-the-browser'
    const signed = await storage.signedUploadUrl({
      key: 'import/raw.csv',
      expiresInSeconds: 60,
      contentType: 'text/csv',
      maxSizeBytes: Buffer.byteLength(body),
    })

    const response = await fetch(signed.url, {
      method: 'PUT',
      headers: signed.requiredHeaders,
      body,
    })
    expect(response.status).toBe(200)

    const stored = await storage.get({ key: 'import/raw.csv' })
    expect(Buffer.from(stored.body).toString('utf8')).toBe(body)

    await storage.delete([{ key: 'import/raw.csv' }])
  })

  it('binds the content type into the upload signature', async () => {
    // Without this the holder of an upload URL chooses what lands in a private
    // bucket the account pays for, and the import parser is handed something it
    // was never meant to read (docs snapshot 02 §16 step 2).
    const signed = await storage.signedUploadUrl({
      key: 'import/typed.csv',
      expiresInSeconds: 60,
      contentType: 'text/csv',
      maxSizeBytes: 10,
    })

    const response = await fetch(signed.url, {
      method: 'PUT',
      headers: { 'content-type': 'application/x-evil', 'content-length': '10' },
      body: '0123456789',
    })
    expect(response.status).toBeGreaterThanOrEqual(400)
  })

  it('binds the content length into the upload signature', async () => {
    // The other half of the same problem: an unbound length turns a signed
    // upload URL into an open write channel into a bucket the account pays for.
    const signed = await storage.signedUploadUrl({
      key: 'import/sized.csv',
      expiresInSeconds: 60,
      contentType: 'text/csv',
      maxSizeBytes: 10,
    })

    const oversized = 'x'.repeat(5_000)
    const response = await fetch(signed.url, {
      method: 'PUT',
      headers: { 'content-type': 'text/csv', 'content-length': String(oversized.length) },
      body: oversized,
    })
    expect(response.status).toBeGreaterThanOrEqual(400)
  })

  it('completes a real multipart upload and returns the whole object', async () => {
    const key = 'backup/clickhouse.bin'
    // Every part but the last must reach the provider minimum, so the smallest
    // honest multipart test is one full-size part plus a remainder.
    const partOne = Buffer.alloc(MULTIPART_MINIMUM_PART_BYTES, 'a')
    const partTwo = Buffer.from('tail')

    const upload = await storage.createMultipartUpload({
      key,
      contentType: 'application/octet-stream',
    })
    const parts = [
      await storage.uploadPart({ upload, partNumber: 1, body: partOne }),
      await storage.uploadPart({ upload, partNumber: 2, body: partTwo }),
    ]
    await storage.completeMultipartUpload({ upload, parts })

    const head = await storage.head({ key })
    expect(head?.size).toBe(partOne.byteLength + partTwo.byteLength)

    await storage.delete([{ key }])
  }, 120_000)

  it('abandons a multipart upload without leaving the object behind', async () => {
    // Unaborted parts are billable until a lifecycle rule reaps them, which is
    // why abort is in the contract rather than left to the caller.
    const key = 'backup/abandoned.bin'
    const upload = await storage.createMultipartUpload({
      key,
      contentType: 'application/octet-stream',
    })
    await storage.uploadPart({
      upload,
      partNumber: 1,
      body: Buffer.alloc(MULTIPART_MINIMUM_PART_BYTES, 'b'),
    })

    await storage.abortMultipartUpload(upload)

    expect(await storage.head({ key })).toBeNull()
    // Cleanup paths run more than once; aborting twice must not throw.
    await expect(storage.abortMultipartUpload(upload)).resolves.toBeUndefined()
  }, 120_000)

  it('reports no lifecycle rules on a bucket that has none', async () => {
    // `NoSuchLifecycleConfiguration` is a 404 that means "the bucket exists and
    // has no rules", which is an answer — not the failure the generic mapping
    // would make of it.
    await expect(storage.getBucketLifecycle()).resolves.toEqual([])
  })

  it('round-trips the expiration rules M11 sets on both prefixes', async () => {
    // ADR-0032 D1: staged import archives and finished exports are transient —
    // the ClickHouse rows and the Postgres records are the durable artefacts —
    // so both prefixes expire.
    const rules = [
      { id: 'imports-expire', prefix: 'imports/', expirationDays: 7 },
      { id: 'exports-expire', prefix: 'exports/', expirationDays: 7 },
    ]

    await storage.putBucketLifecycle(rules)

    const read = [...(await storage.getBucketLifecycle())].sort((a, b) => a.id.localeCompare(b.id))
    expect(read).toEqual([
      { id: 'exports-expire', prefix: 'exports/', expirationDays: 7 },
      { id: 'imports-expire', prefix: 'imports/', expirationDays: 7 },
    ])
  })

  it('documents the provider gap: MinIO refuses an abort-incomplete-only rule', async () => {
    // Measured 2026-07-29 against both the CI image and play.min.io: a rule
    // whose only action is AbortIncompleteMultipartUpload is refused wholesale
    // (`InvalidArgument`), and when the element rides alongside an Expiration
    // it is silently dropped on read-back. The production provider is not so
    // limited — the ADR-0032 D1 live proof shows Hetzner accepting the same
    // rule and returning `DaysAfterInitiation` intact. This test pins the gap
    // so a MinIO upgrade that closes it announces itself by failing here, at
    // which point the round-trip above should regain its abort rule.
    await expect(
      storage.putBucketLifecycle([
        { id: 'abort-incomplete', prefix: '', abortIncompleteMultipartDays: 3 },
      ]),
    ).rejects.toMatchObject({ reason: 'precondition_failed', retryable: false })
  })

  it('replaces the whole rule set rather than merging into it', async () => {
    // The provider API is replace-all, and the port says so: a caller that
    // believed it was adding a rule would silently drop every rule it did not
    // name, and the orphan sweep it thought it had installed would not exist.
    await storage.putBucketLifecycle([{ id: 'only-one', prefix: 'exports/', expirationDays: 7 }])
    const read = await storage.getBucketLifecycle()
    expect(read.map((rule) => rule.id)).toEqual(['only-one'])
  })
})

describe('multipart boundary', () => {
  // Pure arithmetic, so it runs without MinIO — the boundary is a property of
  // the protocol and should be pinned whether or not infrastructure is present.
  it('puts the threshold where a single PUT stops being viable', () => {
    expect(requiresMultipart(MULTIPART_MINIMUM_PART_BYTES)).toBe(false)
    expect(requiresMultipart(64 * 1024 * 1024)).toBe(true)
  })

  it('rejects an undersized part plan before any bytes move', () => {
    // Discovering this on part 900 of 1000 wastes the entire upload.
    expect(() => assertValidPartPlan(1024 * 1024 * 1024, 1024)).toThrow(RangeError)
    expect(() =>
      assertValidPartPlan(1024 * 1024 * 1024, MULTIPART_MINIMUM_PART_BYTES),
    ).not.toThrow()
  })
})
