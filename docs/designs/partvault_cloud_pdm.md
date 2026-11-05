# PartVault: Serverless Cloud PDM System for Hardware Teams

* **Author:** Senior Full-Stack & Cloud Engineering Team
* **Date:** 2026-11-05
* **RFC File:** `docs/designs/partvault_cloud_pdm.md`

## Overview

PartVault is a cloud Product Data Management (PDM) system engineered for hardware engineering teams. It provides revision-controlled part management, multi-level Bill of Materials (BOM) hierarchy tracking with graph cycle detection, exclusive check-out/check-in revision locking, and direct-to-S3 engineering file ingestion with asynchronous metadata processing.

The system is deployed on AWS serverless infrastructure (Amazon API Gateway HTTP API, Node.js 22 Lambda, Amazon DynamoDB single-table, Amazon S3, Amazon SQS, Amazon Cognito, and Amazon CloudFront) using AWS CDK v2. It operates entirely on pay-per-use primitives to eliminate baseline infrastructure and licensing costs while enforcing strict immutability for released engineering definitions.

## Analysis

A multi-lens evaluation of the architecture identified technical trade-offs, operational constraints, and failure modes across six focus areas:

### 1. Concurrency and Lock Isolation (Architecture & Data Integrity)
* **Lock Expiry Race Conditions:** A static expiration timestamp can lead to split-brain edits if a client request arrives while or immediately after a lock expires.
* **Resolution:** Every mutation to a draft revision or its BOM must enforce an atomic DynamoDB condition:
  `attribute_exists(PK) AND lock.holder = :userId AND lock.expiresAt > :now`
  If a lock has expired or was overridden by an administrator, incoming writes fail immediately with HTTP 409 Conflict. Clients can send periodic heartbeat requests to extend active locks during prolonged CAD editing sessions.
* **Release Immutability Invariant:** Once a revision transitions to `Released`, it cannot be modified or deleted. Creating a subsequent revision clones the BOM of the released revision into a new `Draft` state.

### 2. File Streaming and Worker Memory Bounds (Implementation Details)
* **Worker Heap Exhaustion on Large Files:** Streaming files up to 2 GB while parsing ASCII STL geometry in-memory can exceed Node.js heap limits and trigger out-of-memory crashes in Lambda.
* **Resolution:** The worker streams chunks directly into crypto hash streams for SHA-256 calculation. For STL metadata extraction, the parser processes byte chunks sequentially with strict buffer ceilings (max 200 MB), or streams polygon vertex data. The worker Lambda is allocated 1536 MB RAM, and SQS visibility timeout is configured to 18 minutes (exceeding the 15-minute Lambda execution timeout). SQS partial batch response (`reportBatchItemFailures`) is configured on all event batches.
* **Deduplication Concurrency:** Multiple concurrent uploads of identical files generate matching SHA-256 digests. S3 promotion to `files/{sha256}` uses a DynamoDB conditional put on `PK: ORG#{orgId}#FILE, SK: HASH#{sha256}` to prevent race conditions and redundant S3 storage.

### 3. BOM Graph Traversal and Hot Partitions (Data Modeling)
* **Single-Partition Hotspots:** Grouping all parts under a static partition key (e.g., `PK: org#PART`) risks DynamoDB throughput throttling at scale.
* **Resolution:** Part items are partitioned by part number: `PK: ORG#{orgId}#PART#{partNumber}`, with revision items grouped under the same partition key (`SK: REV#{letter}`).
* **Cycle Prevention Mechanics:** DynamoDB lacks recursive query capabilities. BOM trees are resolved in memory by traversing adjacency edges (`PK: ORG#{orgId}#BOM, SK: BOM#{partNumber}#{letter}`). Graph cycles are detected prior to persistence via depth-first search (DFS) with visited sets. When a cycle is detected, the API returns the explicit circular path (e.g., `PV-1001 -> PV-1045 -> PV-1088 -> PV-1001`) with HTTP 400. Assembly tree resolution is constrained to a maximum depth of 25 levels.

### 4. Zero-Base-Cost Cloud Economics (Operational Strategy)
* **Legacy PDM Comparison:** Traditional on-premise PDM systems (SolidWorks PDM, Autodesk Vault, PTC Windchill) demand dedicated Windows servers, SQL Server licensing, and annual maintenance fees exceeding $2,500 to $5,000 per seat.
* **Serverless Cost Profile:** By using DynamoDB on-demand, S3 standard storage, Lambda compute, and CloudFront CDN, idle system cost is $0/month. Operational costs scale purely with active file transfers and API requests, staying well within a $10/month budget for small to mid-sized engineering teams.

### 5. S3 Multipart Cleanup and Authorization Boundaries (Production Readiness)
* **Orphaned Multipart Uploads:** Incomplete multipart uploads for large files (up to 2 GB) can accumulate silently in S3 when uploads abort ungracefully. An S3 lifecycle configuration (`abortIncompleteMultipartUploadAfter: 1 day`) is mandatory on the storage bucket.
* **Token Claim Extraction:** API Gateway HTTP API validates Cognito JWTs. Lambda functions parse user identity and role assignments directly from the verified `cognito:groups` token claims (`admin`, `engineer`, `viewer`) rather than relying on unauthenticated client-supplied headers.
* **CI/CD Security:** Deployments use GitHub Actions federated with AWS IAM through OpenID Connect (OIDC), eliminating stored long-lived AWS access keys.

## Goals vs. Non-Goals

### In-Scope Goals
* **Part and Revision Control:** Part numbering (`PV-\d{3,6}`), descriptions, sequential letter revisions (`A`, `B`, ...), and lifecycle transitions (`Draft` -> `In Review` -> `Released`).
* **Revision Immutability:** Released revisions, attached files, and BOM lines are permanent and unalterable. Creating a new revision deep-copies the released BOM.
* **Exclusive Check-Out Locks:** Time-bounded editing locks on Draft revisions with configurable TTL, manual check-in, heartbeat renewal, and administrator override.
* **BOM Hierarchies and Graph Analytics:** Multi-level tree display, quantity rollups, reverse where-used lookups, CSV export, BOM diff between revisions, and DFS cycle detection with explicit path reporting.
* **Direct S3 Multipart Upload:** Browser-direct multipart upload via presigned S3 URLs supporting files up to 2 GB with progress tracking and automatic multipart abort after 24 hours.
* **Asynchronous Pipeline:** S3 ObjectCreated -> SQS -> Worker Lambda streaming SHA-256 digest computation, MIME detection, STL metadata extraction (triangle count, bounding box, binary vs. ASCII), and status transitions (`Processing` -> `Ready` | `Failed`).
* **Audit Trail:** Append-only record of lifecycle transitions, lock acquisitions/releases, file uploads, and BOM edits.
* **Operational Monitoring:** CloudWatch dashboards, DLQ alarms with SNS email notifications, and GitHub Actions CI/CD with AWS OIDC.

### Out-of-Scope Non-Goals
* Server-side STEP/IGES parametric B-rep solid modeling or kernel tessellation.
* Automated workflow approval graphs with conditional multi-stage branching rules.
* Multi-region active-active database replication.
* Enterprise SAML/SSO federation (Cognito hosted UI with email/password authentication only).

## Alternatives Weighed

* **DynamoDB Single-Table vs. RDS PostgreSQL:**
  * *Rejected:* RDS PostgreSQL requires either an always-on EC2/RDS instance or Aurora Serverless v2, plus a VPC, private subnets, and a NAT Gateway ($32+/month), violating the zero-base-cost requirement.
  * *Selected:* DynamoDB on-demand provides zero idle cost, single-digit millisecond latency, and conditional writes for atomic lock and lifecycle enforcement.
* **Lambda Streaming Worker vs. AWS Fargate Task:**
  * *Rejected:* Fargate tasks introduce 30-60 second cold-start latency for container provisioning and higher minimum run costs.
  * *Selected:* Node.js 22 Lambda with 1536 MB RAM streams up to 2 GB files via Node streams directly into SHA-256 hashers and chunked STL parsers within execution limits.
* **Direct-to-S3 Multipart vs. API Gateway Proxy:**
  * *Rejected:* API Gateway HTTP API has a strict 10 MB payload limit, preventing direct binary CAD file uploads.
  * *Selected:* The browser requests presigned multipart upload URLs from the API, streams chunks directly to S3, and notifies the API upon completion.
* **SQS vs. AWS Step Functions:**
  * *Rejected:* Step Functions execution histories add state transition costs and orchestration overhead for linear single-worker file ingestion.
  * *Selected:* SQS standard queue with dead-letter queue (DLQ) provides backpressure buffering, retry limits (`maxReceiveCount: 3`), and partial batch failure reporting.

## Key Decisions & Staging for Next Steps

* **Key Decision 1:** S3 upload destination uses a two-phase quarantine workflow (`uploads/{fileId}` -> worker verification -> content-addressed `files/{sha256}`).
* **Key Decision 2:** All API authorization checks read verified `cognito:groups` claims from the JWT context.
* **Key Decision 3:** BOM modifications run DFS cycle detection in memory prior to committing adjacency lines to DynamoDB.
* **Key Decision 4:** Worker memory is sized to 1536 MB with SQS visibility set to 18 minutes to ensure stable streaming processing of 2 GB files.
