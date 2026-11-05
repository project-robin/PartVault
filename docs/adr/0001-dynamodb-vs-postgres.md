# ADR-0001: DynamoDB vs Postgres/RDS

**Date:** 2026-11-05  
**Status:** Accepted

## Context

PartVault needs a store for parts, revisions, BOMs, files (metadata), audit logs, and idempotency keys with conditional writes. Access patterns are point reads, prefix scans, and transactional single-item updates — all tabular data with shallow relationships.

## Decision

**DynamoDB single-table, on-demand.** No RDS.

## Alternatives considered

- **Postgres/RDS:** Rich querying, joins, and ACID across rows. But always-on instance cost (~$15+/mo minimum), VPC/NAT requirements, and operational overhead (backups, patching) for a demo-scale portfolio project. Multi-tenancy and BOM recursion would be easier in SQL — but the workload is key-value shaped.
- **SQLite (local):** Not AWS-native.

## Consequences

- **Positive:** Serverless, pay-per-use, zero ops, single table simplifies scaling. Conditional writes give us atomic locks and state transitions. GSI1 covers history queries.
- **Negative:** No joins — where-used requires an in-memory scan of all BOMs (acceptable at demo scale; document the limit). No ad-hoc SQL. Eventual consistency on GSI (audit reads may lag ~1s).
- **Mitigation:** Business logic (BOM tree, cycle detection, diff) lives in `packages/shared` and is fully unit-tested, so a future migration to Postgres would reuse it.

## Why not OLAP

BOM rollups and where-used are not analytical queries at this scale — keeping them in application code is simpler and testable.
