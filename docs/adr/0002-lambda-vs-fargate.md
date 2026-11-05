# ADR-0002: Lambda vs Fargate for API and Worker

**Date:** 2026-11-05  
**Status:** Accepted

## Decision

**Lambda (API + Worker).** No Fargate.

## Rationale

- **API:** Request/response, stateless, bursty. Lambda scales to zero, no VPC/NAT needed (DynamoDB + S3 via AWS SDK over the public endpoint). HTTP API Gateway JWT authorizer gives us Cognito auth for free.
- **Worker:** SQS-driven, embarrassingly parallel, variable duration (2s–5min for large STLs). Lambda with 5-min timeout + 30-min visibility timeout handles 2 GB streaming hashing. Fargate would need a service, task definition, and ECS scaling policies — more moving parts for the same throughput.
- **Cost:** Pay-per-ms. At demo scale Lambda is $0–$2/mo; Fargate has a minimum hourly task cost.

## Trade-offs

- Lambda cold starts (~200ms) — mitigated by provisioned concurrency in production.
- Lambda 5-min timeout caps STL metadata extraction for very large meshes — we cap STL buffering at 200 MB and stream-hash everything else.
- Fargate would be better for long-running (>5 min) or GPU work — not in scope.
