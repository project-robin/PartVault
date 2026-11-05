# Data model — DynamoDB single-table

## Table

- **Table name:** `partvault-{stage}`
- **Billing:** On-demand (PAY_PER_REQUEST)
- **PK:** `String`, **SK:** `String`
- **GSI1:** `GSI1PK` / `GSI1SK` (audit history, file-by-revision)

All keys are prefixed with `ORG_ID` (`org-demo` for the seeded single-tenant demo) so multi-tenancy is additive, not a migration.

## Key design

| Entity | PK | SK | Notes |
|---|---|---|---|
| Part | `org#PART` | `PART#{partNumber}` | partNumber like `PV-1001` |
| Revision | `org#PART` | `REV#{partNumber}#{letter}` | letter `A`–`Z`, lifecycle in `status` |
| BOM | `org#BOM` | `BOM#{partNumber}#{revision}` | `lines[]` array of `{childPartNumber, quantity}` |
| File | `org#FILE` | `FILE#{fileId}` | status `Processing`/`Ready`/`Failed`, `s3Key`, `sha256`, `metadata` |
| Audit | `org#AUDIT` | `AUDIT#{entityType}#{entityId}#{ts}#{actor}` | GSI `GSI1PK=org#AUDIT#{type}#{id}` for history per entity |
| Idempotency | `org#IDEMP` | `IDEMP#{key}` | TTL 24h, conditional put |

## Access patterns

| Pattern | Query |
|---|---|
| List parts | `PK=org#PART, SK begins_with PART#` |
| Get part | `Get PART#PV-1001` |
| List revisions | `PK=org#PART, SK begins_with REV#PV-1001#` |
| Get revision | `Get REV#PV-1001#A` |
| List files for revision | `PK=org#FILE, SK begins_with FILE#PV-1001#A#` (also GSI `GSI1PK=org#FILE#PV-1001#A`) |
| Get file | `Get FILE#{fileId}` |
| Get BOM | `Get BOM#PV-1001#A` |
| Where-used | Scan all `BOM#*` + traverse in memory (fine at demo scale; production would materialise a where-used index) |
| BOM diff | Two point reads + in-memory diff (`packages/shared/src/domain/bom.ts`) |
| Audit history | `GSI1PK=org#AUDIT#Part#PV-1001` |
| Idempotency check | `Get IDEMP#{key}` + conditional `Put` |

## Conditional writes

- **Part create:** `attribute_not_exists(PK)` — prevents duplicate part numbers.
- **Revision transition:** `status = :from` — prevents concurrent lifecycle moves.
- **Lock acquire:** `attribute_not_exists(lock) OR lock.expiresAt < :now OR lock.holder = :sub` — atomic check-out; two users cannot hold the same lock.
- **Idempotency:** `attribute_not_exists(PK)` on create; duplicates return cached response.

## Why single-table

- One table, on-demand — minimal cost, no capacity planning.
- All access patterns above are a single `Get` or `Query` (prefix scans).
- GSI1 gives audit/file history without a second table.
- Multi-tenancy: every key starts with `ORG_ID#`; adding an org is a new prefix.

## Trade-offs

See `docs/adr/0001-dynamodb-vs-postgres.md`.
