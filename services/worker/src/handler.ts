import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { Logger } from "@aws-lambda-powertools/logger";
import { Metrics, MetricUnit } from "@aws-lambda-powertools/metrics";
import { Tracer } from "@aws-lambda-powertools/tracer";
import { createHash } from "node:crypto";
import { parseStl, detectMime } from "@partvault/shared";

const logger = new Logger({ serviceName: "partvault-worker" });
const metrics = new Metrics({ serviceName: "partvault-worker" });
const tracer = new Tracer({ serviceName: "partvault-worker" });

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});

const TABLE = process.env.TABLE_NAME ?? "";
const ORG_ID = process.env.ORG_ID ?? "org-demo";

interface SQSMessage {
  messageId: string;
  body: string;
}

interface S3Notification {
  Records: { s3: { bucket: { name: string }; object: { key: string; versionId?: string } } }[];
}

export const handler = async (event: { Records: SQSMessage[] }, context?: any) => {
  if (tracer.isTracingEnabled()) {
    tracer.annotateColdStart();
    tracer.addServiceNameAnnotation();
  }
  const batchItemFailures: { itemIdentifier: string }[] = [];

  for (const sqsRecord of event.Records) {
    const identifier = sqsRecord.messageId;
    try {
      let record: S3Notification;
      try {
        record = JSON.parse(sqsRecord.body) as S3Notification;
      } catch {
        logger.warn("Message body is not S3 JSON", { identifier });
        continue;
      }
      for (const rec of record.Records ?? []) {
        const objectKey = decodeURIComponent(rec.s3.object.key.replace(/\+/g, " "));
        const versionId = rec.s3.object.versionId;
        const bucketName = rec.s3.bucket.name;
        logger.info("Processing object", { objectKey, versionId, bucketName });

        const fileItem = await findFileByKey(objectKey);
        if (!fileItem) {
          logger.warn("No file record for object", { objectKey });
          continue;
        }
        if (versionId && fileItem.processedVersionId === versionId) {
          logger.info("Already processed version", { fileId: fileItem.fileId, versionId });
          continue;
        }

        const { metadata, sha256, mimeType, fileSize } = await processObject(bucketName, objectKey, versionId, fileItem.fileName);

        if (fileItem.sha256 && fileItem.sha256 !== sha256) {
          logger.error("SHA mismatch", { expected: fileItem.sha256, got: sha256 });
          await markFile(fileItem.fileId, "Failed", { error: "SHA-256 mismatch" }, versionId);
          continue;
        }
        await markFile(fileItem.fileId, "Ready", {
          sha256, mimeType, fileSize,
          triangleCount: metadata?.triangleCount ?? null,
          boundingBox: metadata?.boundingBox ?? null,
          isBinary: metadata?.isBinary ?? null,
        }, versionId);
        metrics.addMetric("FilesReady", MetricUnit.Count, 1);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("Failed to process record", { identifier, err: msg });
      metrics.addMetric("FilesFailed", MetricUnit.Count, 1);
      batchItemFailures.push({ itemIdentifier: identifier });
    }
  }

  return { batchItemFailures };
};

async function findFileByKey(s3Key: string) {
  // Query FILE prefix and filter (small table for demo; production would use GSI on s3Key)
  const res = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
    ExpressionAttributeValues: { ":pk": `${ORG_ID}#FILE`, ":sk": "FILE#" },
    Limit: 1000,
  }));
  const item = (res.Items ?? []).find((i: { s3Key?: string }) => i.s3Key === s3Key);
  return item as (Record<string, unknown> & { fileId: string; s3Key: string; fileName: string; sha256?: string; processedVersionId?: string; s3Bucket?: string }) | null;
}

async function processObject(bucket: string, key: string, versionId: string | undefined, fileName: string) {
  const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key, VersionId: versionId }));
  if (!obj.Body) throw new Error("Empty object body");

  const hash = createHash("sha256");
  const chunks: Buffer[] = [];
  let totalSize = 0;
  // Stream — never buffer whole file beyond the 8 MB needed for STL parsing (STL files in scope are small)
  // For large files we still hash in-stream; STL metadata only for .stl which we buffer with a cap.
  const isStl = fileName.toLowerCase().endsWith(".stl");
  const MAX_STL_BUFFER = 200 * 1024 * 1024; // 200 MB cap for STL parse

  const stream = obj.Body as AsyncIterable<Buffer>;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    hash.update(buf);
    totalSize += buf.length;
    if (isStl) {
      chunks.push(buf);
      if (chunks.reduce((a, c) => a + c.length, 0) > MAX_STL_BUFFER) {
        throw new Error("STL file too large for metadata extraction");
      }
    }
  }

  const sha256 = hash.digest("hex");
  const mimeType = detectMime(fileName, obj.ContentType ?? "");

  let metadata = null;
  if (isStl) {
    const buf = Buffer.concat(chunks);
    try {
      metadata = parseStl(buf);
    } catch (e) {
      throw new Error(`Invalid STL: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { metadata, sha256, mimeType, fileSize: totalSize };
}

async function markFile(fileId: string, status: string, metadata: unknown, versionId?: string) {
  const fileKey = { PK: `${ORG_ID}#FILE`, SK: `FILE#${fileId}` };
  await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: fileKey,
    UpdateExpression: "SET #s = :s, metadata = :m, processedVersionId = :v, processedAt = :t",
    ExpressionAttributeNames: { "#s": "status" },
    ExpressionAttributeValues: {
      ":s": status,
      ":m": metadata,
      ":v": versionId ?? "",
      ":t": Date.now(),
    },
    ConditionExpression: "attribute_exists(PK)",
  }));
  // Audit
  await ddb.send(new PutCommand({
    TableName: TABLE,
    Item: {
      PK: `${ORG_ID}#AUDIT`,
      SK: `AUDIT#File#${fileId}#${Date.now()}#worker`,
      entityType: "File",
      entityId: fileId,
      action: status === "Ready" ? "processed" : "failed",
      actor: "worker",
      ts: Date.now(),
      details: metadata,
      GSI1PK: `${ORG_ID}#AUDIT#File#${fileId}`,
      GSI1SK: `TS#${Date.now()}`,
    },
  }));
}
