# ADR-0006: Content-addressed storage (SHA-256)

**Date:** 2026-11-05  
**Status:** Accepted

## Decision

Files are content-addressed by SHA-256. The client computes the hash before upload; the worker recomputes it in-stream and rejects on mismatch. The same file uploaded twice produces the same key — no duplicate storage.

## Rationale

- Deduplication: identical CAD files across revisions/parts hash to the same content.
- Integrity: hash mismatch (corrupt transfer) fails the file visibly instead of silently storing bad bytes.
- Audit: the hash is a stable identifier for the file version, useful in the audit log and future CAS-style garbage collection.

## Trade-offs

- Client-side hashing of 2 GB files in the browser: `crypto.subtle.digest` streams but will block the main thread for large files — acceptable for the demo; a production build would use a Web Worker.
- Worker recomputes SHA-256 in-stream (never buffers the whole object), so cost is bandwidth, not memory.
- Invalid STL (parse error) marks the file `Failed` and does not overwrite a previous `Ready` version.
