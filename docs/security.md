# Security

## Authentication (authN)

- Cognito User Pool with Hosted UI (authorization code + PKCE).
- API Gateway HTTP API uses a JWT authorizer (`cognito-idp.{region}.amazonaws.com/{userPoolId}`, audience = WebClientId).
- The API Lambda reads `sub`, `email`, and `cognito:groups` from the JWT claims. No route is unauthenticated except `/health` (no-op) — every handler checks `parseAuth()` first.

## Authorization (authZ)

- Roles: `admin`, `engineer`, `viewer` (Cognito groups).
- Server-side enforcement on every route in `services/api/src/handler.ts`:
  - `viewer`: read-only (parts, revisions, BOM, files, history).
  - `engineer`: `viewer` + create/update parts, revisions, BOM, initiate/complete uploads, acquire/release locks.
  - `admin`: `engineer` + lock override.
- Released revisions are immutable — the API returns `409 IMMUTABLE` on any mutation.
- Locks are enforced with DynamoDB conditional writes; two users cannot hold the same lock.

## Presigned URL scope and expiry

- **Upload part URLs:** `UploadPartCommand`, expiry **900s (15 min)**, scoped to a single `Key` + `UploadId`. The client must PUT part bytes; it cannot read, delete, or list.
- **Download URLs:** `GetObjectCommand`, expiry **300s (5 min)**, scoped to a single object version (`VersionId` when available). Only issued when `status === "Ready"`.
- **Multipart initiate/complete** go through the API (which checks lock + authZ); only the byte transfer is presigned.
- **CORS:** `uploads` bucket allows `GET, PUT, POST` from the CloudFront origin pattern and `http://localhost:5173` (dev). Allowed headers: `Content-Type`, `Content-Length`, `x-amz-meta-*`, `Idempotency-Key`. Exposed: `ETag`.

## S3 and storage

- Uploads and web buckets: `BlockPublicAccess.BLOCK_ALL`, SSE-S3 (AES256), versioning enabled.
- Uploads bucket: lifecycle rule aborts incomplete multipart uploads after **1 day**.
- Web served only via CloudFront OAC (S3 bucket policy allows only the CloudFront distribution).

## IAM (least privilege)

CDK grants:
- API Lambda: `table.grantReadWriteData` + `uploadsBucket.grantReadWrite`.
- Worker Lambda: `table.grantReadWriteData` + `uploadsBucket.grantReadWrite` + `queue.grantConsumeMessages`.
- No `*` resources; no long-lived AWS keys. CI/CD uses GitHub OIDC (see `docs/security.md` and `.github/workflows/cd.yml`).
- No secrets in the repo. `.env.example` only; credentials via named AWS profile locally and OIDC in CI.

## File validation

- Zod schemas on every input (`packages/shared/src/index.ts`): part numbers, lifecycle transitions, BOM lines, upload metadata.
- File size cap: 2 GB (`MAX_FILE_SIZE`). Extension/MIME detection is indicative only — the worker validates by content:
  - SHA-256 recomputed in-stream and compared to client-supplied hash.
  - STL files are parsed (binary + ASCII); invalid STL marks the file `Failed`.
- Uploads must hold a valid revision lock (or be admin); Released revisions reject uploads.

## Idempotency

Create endpoints (`POST /parts`) accept an `Idempotency-Key` header. The API stores the response under a DynamoDB idempotency key with a 24h TTL and a conditional put — duplicate requests return the cached response instead of creating duplicates.

## Secrets and logging

- No credentials in code or git history. Powertools structured logs include `requestId` (correlation ID) and user `sub` for audit, never tokens or passwords.
- X-Ray tracing enabled on API and Worker; segments carry request IDs, not PII.
