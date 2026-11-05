# ADR-0003: Direct-to-S3 multipart vs proxying through API

**Date:** 2026-11-05  
**Status:** Accepted

## Decision

**Direct-to-S3 multipart.** The browser uploads to S3 with presigned part URLs; only `initiate` and `complete` hit the API.

## Rationale

- Files up to 2 GB: proxying through Lambda would exceed the 6 MB payload limit, 5-min timeout, and memory — and pay Lambda egress for every byte.
- Presigned URLs keep S3 as the transfer plane; the API only issues URLs and records metadata.
- Content-addressed by SHA-256: the client computes the hash before upload; the worker verifies it after processing. Duplicate uploads dedupe by hash.

## Trade-offs

- **Security:** Presigned URLs must be short-lived (15 min) and scoped to a single key. CORS is restricted to the CloudFront origin + `http://localhost:5173`.
- **Complexity:** Client must implement parallel parts, retry, and resume. `planParts()` and per-part PUTs in `FileUploader` handle this; STL parsing stays server-side.
- **Incomplete uploads:** Lifecycle rule aborts incomplete multipart uploads after 1 day.
