# ADR-0004: SQS vs Step Functions / EventBridge

**Date:** 2026-11-05  
**Status:** Accepted

## Decision

**SQS (with DLQ) + Worker Lambda.** No Step Functions, no EventBridge.

## Rationale

- The pipeline is a linear, one-step transform: `S3 ObjectCreated → SQS → Lambda → DynamoDB`. No branching, no long-running orchestration, no human-in-the-loop.
- SQS gives us visibility timeout, retry with backoff, FIFO ordering (not needed but available), and a DLQ with `maxReceiveCount=3` for poison messages.
- Partial batch failure returns only failed message IDs — successful messages in the batch are deleted.

## Alternatives

- **Step Functions:** Better for multi-step workflows (validate → transcode → thumbnail). Overkill here; adds state-machine cost and debugging surface.
- **EventBridge:** Good for event routing, but SQS already provides durable queuing with payload buffering. EventBridge would need a target queue anyway.

## Consequences

- DLQ alarm fires on poison messages. Runbook covers investigation.
- Idempotency: bucket + key + versionId is the dedupe key; the worker skips already-processed versions.
