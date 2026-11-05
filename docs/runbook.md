# Runbook

## Investigating a DLQ alarm

Alarm: `PartVault-{stage}-DLQDepth` (SNS email).

1. Open the DLQ in the AWS Console: SQS → `partvault-{stage}-dlq`.
2. Peek at the oldest message — check `ApproximateReceiveCount`. If it is at 3, the worker failed 3 times.
3. Check Lambda logs: CloudWatch → `/aws/lambda/partvault-{stage}-worker` — look for `Failed to process record` and the `err` field.
4. Common causes:
   - **Invalid STL** — status is marked `Failed` and the message is ack'd (not DLQ'd). Only crashes/timeouts reach the DLQ.
   - **Timeout** — file too large for the 5-min Lambda timeout. Check `duration` metric.
   - **S3 object not found** — object deleted after upload. Verify the key in S3.
5. If the message is safe to discard: delete it from the DLQ. If it is a poison pill, investigate the worker code before reprocessing.

## Reprocessing a failed file

1. Identify the file: DynamoDB → `partvault-{stage}` → `PK=org-demo#FILE`, `SK=FILE#{fileId}`.
2. If the S3 object is fine (e.g. transient worker error), re-send the S3 event:
   ```bash
   aws s3api copy-object --bucket <uploads-bucket> --key <uploads/...> --copy-source <uploads-bucket>/<uploads/...>
   ```
   This triggers `ObjectCreated` → SQS → worker.
3. Or, if the file was marked `Failed` due to invalid STL, fix the source file and re-upload from the UI. The new version has a new `fileId`.
4. Never manually set status to `Ready` — the worker computes SHA-256 and metadata.

## Instructions for a forced worker crash (testing the DLQ)

1. Deploy a worker build with a deliberate `throw` on a specific filename.
2. Upload a file with that name.
3. After 3 retries the message lands in the DLQ and the `PartVault-{stage}-DLQDepth` alarm fires an SNS email.
4. Confirm in CloudWatch → Alarms, then restore the worker code and reprocess as above.

## Rolling back a deploy

```bash
# 1. Find the last good commit
git log --oneline -10

# 2. Redeploy that commit (CDK is declarative)
git checkout <last-good-sha>
pnpm install --frozen-lockfile
pnpm --filter ./infra deploy

# 3. Note: DynamoDB schema is not rolled back — additive changes only in production.
#    If a bad deploy wrote bad data, use audit log + S3 versioning to restore.
```

## Lock issues

- A lock expires after 1 hour. If a user reports "stuck lock", an admin can override:
  `PATCH /parts/{partNumber}/revisions/{letter} { "action": "override" }` (admin only).
- Check the lock holder: `GET /parts/{partNumber}/revisions/{letter}` → `lock.holder`.

## Alarm triage

| Alarm | Meaning | First action |
|---|---|---|
| `PartVault-{stage}-DLQDepth` | Poison messages in DLQ | Peek DLQ, check worker logs |
| `PartVault-{stage}-Api5xxRate` | API errors > 5 in 5 min | CloudWatch Logs `partvault-api`, look for `Unhandled error` |
| `PartVault-{stage}-WorkerErrors` | Worker Lambda errors | Same as DLQ triage |
| `PartVault-{stage}-OldMessageAge` | Queue backlog | Check SQS queue depth/age, worker timeout |
