import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { S3Client, CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Logger } from "@aws-lambda-powertools/logger";
import { Metrics, MetricUnit } from "@aws-lambda-powertools/metrics";
import { Tracer } from "@aws-lambda-powertools/tracer";
import { z } from "zod";
import {
  CreatePartSchema,
  UpdatePartSchema,
  CreateRevisionSchema,
  TransitionRevisionSchema,
  LockSchema,
  SetBomSchema,
  InitiateUploadSchema,
  CompleteUploadSchema,
  canTransition,
  nextRevisionLetter,
  isReleased,
  canAcquireLock,
  lockExpiresAt,
  hasCycle,
  flattenBom,
  diffBom,
  whereUsed,
  toCsv,
  planParts,
} from "@partvault/shared";

const logger = new Logger({ serviceName: "partvault-api" });
const metrics = new Metrics({ serviceName: "partvault-api" });
const tracer = new Tracer({ serviceName: "partvault-api" });

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});

const TABLE = process.env.TABLE_NAME ?? "";
const BUCKET = process.env.BUCKET_NAME ?? "";
const ORG_ID = process.env.ORG_ID ?? "org-demo";

type Role = "admin" | "engineer" | "viewer";

interface AuthContext {
  sub: string;
  email: string;
  roles: Role[];
}

const errorResponse = (status: number, code: string, message: string, requestId: string) => ({
  statusCode: status,
  headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  body: JSON.stringify({ code, message, requestId }),
});

const json = (status: number, data: unknown, requestId: string) => ({
  statusCode: status,
  headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  body: JSON.stringify(data),
});

function parseAuth(event: any): AuthContext | null {
  const claims = event.requestContext?.authorizer?.lambda?.claims
    ?? event.requestContext?.authorizer?.jwt?.claims
    ?? event.requestContext?.authorizer?.claims;
  if (claims?.sub) {
    // Cognito groups claim
    const groupsStr: string = claims["cognito:groups"] ?? "";
    let groups: string[] = [];
    try { groups = typeof groupsStr === "string" ? JSON.parse(groupsStr) : groupsStr; } catch { groups = []; }
    return { sub: claims.sub, email: claims.email ?? "", roles: groups as Role[] };
  }
  // Fallback for local testing via headers
  const sub = event.headers?.["x-user-sub"] ?? event.headers?.["X-User-Sub"];
  if (sub) {
    const roles = (event.headers?.["x-user-roles"] ?? "admin").split(",");
    return { sub, email: event.headers?.["x-user-email"] ?? "", roles: roles as Role[] };
  }
  return null;
}

function requireRole(auth: AuthContext, allowed: Role[]): boolean {
  if (auth.roles.includes("admin")) return true;
  return allowed.some((r) => auth.roles.includes(r));
}

const partKey = (partNumber: string) => ({ PK: `${ORG_ID}#PART`, SK: `PART#${partNumber}` });
const revisionKey = (partNumber: string, rev: string) => ({ PK: `${ORG_ID}#PART`, SK: `REV#${partNumber}#${rev}` });
const bomKey = (partNumber: string, rev: string) => ({ PK: `${ORG_ID}#BOM`, SK: `BOM#${partNumber}#${rev}` });
const fileKey = (fileId: string) => ({ PK: `${ORG_ID}#FILE`, SK: `FILE#${fileId}` });
const auditKey = (entityType: string, entityId: string, ts: number, actor: string) => ({ PK: `${ORG_ID}#AUDIT`, SK: `AUDIT#${entityType}#${entityId}#${ts}#${actor}` });
const idempKey = (key: string) => ({ PK: `${ORG_ID}#IDEMP`, SK: `IDEMP#${key}` });

async function putIdempotency(key: string, value: unknown, ttlSeconds = 86400) {
  await ddb.send(new PutCommand({
    TableName: TABLE,
    Item: { ...idempKey(key), value, ttl: Math.floor(Date.now() / 1000) + ttlSeconds },
    ConditionExpression: "attribute_not_exists(PK)",
  }));
}

async function getIdempotency(key: string) {
  const r = await ddb.send(new GetCommand({ TableName: TABLE, Key: idempKey(key) }));
  return r.Item?.value ?? null;
}

async function audit(entityType: string, entityId: string, action: string, actor: string, details: unknown) {
  const ts = Date.now();
  await ddb.send(new PutCommand({
    TableName: TABLE,
    Item: {
      ...auditKey(entityType, entityId, ts, actor),
      entityType, entityId, action, actor, ts, details,
      GSI1PK: `${ORG_ID}#AUDIT#${entityType}#${entityId}`,
      GSI1SK: `TS#${ts}`,
    },
  }));
}

export const handler = async (event: any, context?: any) => {
  if (tracer.isTracingEnabled()) {
    tracer.annotateColdStart();
    tracer.addServiceNameAnnotation();
  }
  const requestId = event.requestContext?.requestId ?? crypto.randomUUID();
  logger.info("Request", { path: event.rawPath, method: event.httpMethod, requestId });

  try {
    const method = event.httpMethod ?? event.requestContext?.http?.method;
    const path = event.rawPath ?? event.requestContext?.http?.path ?? "/";

    // Health (unauthenticated)
    if (path === "/health") return json(200, { status: "ok" }, requestId);

    const auth = parseAuth(event);
    if (!auth) {
      return errorResponse(401, "UNAUTHORIZED", "Missing authentication", requestId);
    }

    // Idempotency-Key handling for writes
    const idempHeader = event.headers?.["Idempotency-Key"] ?? event.headers?.["idempotency-key"];

    // Parts
    if (path === "/parts" && method === "GET") {
      const res = await ddb.send(new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
        ExpressionAttributeValues: { ":pk": `${ORG_ID}#PART`, ":sk": "PART#" },
        Limit: 100,
      }));
      const items = (res.Items ?? []).map((i: any) => ({ partNumber: i.partNumber, name: i.name, description: i.description }));
      const q = event.queryStringParameters?.search;
      const filtered = q ? items.filter((i: any) => (i.partNumber + i.name + i.description).toLowerCase().includes(q.toLowerCase())) : items;
      return json(200, { parts: filtered }, requestId);
    }

    if (path === "/parts" && method === "POST") {
      if (!requireRole(auth, ["engineer", "admin"])) return errorResponse(403, "FORBIDDEN", "Requires engineer role", requestId);
      const body = JSON.parse(event.body ?? "{}");
      const parsed = CreatePartSchema.safeParse(body);
      if (!parsed.success) return errorResponse(400, "VALIDATION_ERROR", "Invalid part", requestId);
      const { partNumber, name, description } = parsed.data;

      if (idempHeader) {
        const cached = await getIdempotency(idempHeader);
        if (cached) return json(200, cached, requestId);
      }

      try {
        await ddb.send(new PutCommand({
          TableName: TABLE,
          Item: { ...partKey(partNumber), partNumber, name, description, createdAt: Date.now(), createdBy: auth.sub, GSI1PK: `${ORG_ID}#PART`, GSI1SK: `PART#${partNumber}` },
          ConditionExpression: "attribute_not_exists(PK)",
        }));
      } catch (e: any) {
        if (e.name === "ConditionalCheckFailedException") return errorResponse(409, "CONFLICT", "Part already exists", requestId);
        throw e;
      }
      await audit("Part", partNumber, "created", auth.sub, { name });
      const result = { partNumber, name, description };
      if (idempHeader) await putIdempotency(idempHeader, result).catch(() => {});
      return json(201, result, requestId);
    }

    const partMatch = path.match(/^\/parts\/([^/]+)$/);
    if (partMatch && method === "GET") {
      const partNumber = decodeURIComponent(partMatch[1]!);
      const res = await ddb.send(new GetCommand({ TableName: TABLE, Key: partKey(partNumber) }));
      if (!res.Item) return errorResponse(404, "NOT_FOUND", "Part not found", requestId);
      return json(200, { partNumber: res.Item.partNumber, name: res.Item.name, description: res.Item.description }, requestId);
    }

    if (partMatch && method === "PATCH") {
      if (!requireRole(auth, ["engineer", "admin"])) return errorResponse(403, "FORBIDDEN", "Requires engineer role", requestId);
      const partNumber = decodeURIComponent(partMatch[1]!);
      const body = JSON.parse(event.body ?? "{}");
      const parsed = UpdatePartSchema.safeParse(body);
      if (!parsed.success) return errorResponse(400, "VALIDATION_ERROR", "Invalid update", requestId);
      const sets: string[] = [];
      const values: Record<string, unknown> = {};
      if (parsed.data.name) { sets.push("name = :n"); values[":n"] = parsed.data.name; }
      if (parsed.data.description !== undefined) { sets.push("description = :d"); values[":d"] = parsed.data.description; }
      if (sets.length === 0) return errorResponse(400, "VALIDATION_ERROR", "Nothing to update", requestId);
      await ddb.send(new UpdateCommand({
        TableName: TABLE,
        Key: partKey(partNumber),
        UpdateExpression: `SET ${sets.join(", ")}`,
        ExpressionAttributeValues: values,
        ConditionExpression: "attribute_exists(PK)",
        ReturnValues: "ALL_NEW",
      }));
      await audit("Part", partNumber, "updated", auth.sub, parsed.data);
      return json(200, { partNumber, ...parsed.data }, requestId);
    }

    // Revisions
    const revListMatch = path.match(/^\/parts\/([^/]+)\/revisions$/);
    if (revListMatch && method === "GET") {
      const partNumber = decodeURIComponent(revListMatch[1]!);
      const res = await ddb.send(new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
        ExpressionAttributeValues: { ":pk": `${ORG_ID}#PART`, ":sk": `REV#${partNumber}#` },
      }));
      const items = (res.Items ?? []).map((i: any) => ({ letter: i.letter, status: i.status, lock: i.lock ?? null }));
      return json(200, { revisions: items }, requestId);
    }

    if (revListMatch && method === "POST") {
      if (!requireRole(auth, ["engineer", "admin"])) return errorResponse(403, "FORBIDDEN", "Requires engineer role", requestId);
      const partNumber = decodeURIComponent(revListMatch[1]!);
      const body = JSON.parse(event.body ?? "{}");
      const parsed = CreateRevisionSchema.safeParse(body);
      if (!parsed.success) return errorResponse(400, "VALIDATION_ERROR", "Invalid revision request", requestId);

      const existing = await ddb.send(new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
        ExpressionAttributeValues: { ":pk": `${ORG_ID}#PART`, ":sk": `REV#${partNumber}#` },
      }));
      const revs = existing.Items ?? [];
      let letter = "A";
      let fromBom: unknown[] = [];
      if (parsed.data.fromRevision) {
        const from = revs.find((r: any) => r.letter === parsed.data.fromRevision);
        if (!from) return errorResponse(404, "NOT_FOUND", "Source revision not found", requestId);
        if (!isReleased(from.status)) return errorResponse(409, "INVALID_STATE", "Source revision must be Released", requestId);
        letter = nextRevisionLetter(parsed.data.fromRevision);
        const bomRes = await ddb.send(new GetCommand({ TableName: TABLE, Key: bomKey(partNumber, parsed.data.fromRevision) }));
        fromBom = (bomRes.Item?.lines as unknown[]) ?? [];
      } else if (revs.length > 0) {
        const last = revs[revs.length - 1];
        if (!last?.letter) return errorResponse(400, "INVALID_STATE", "Invalid previous revision", requestId);
        letter = nextRevisionLetter(last.letter);
      }

      await ddb.send(new PutCommand({
        TableName: TABLE,
        Item: { ...revisionKey(partNumber, letter), partNumber, letter, status: "Draft", lock: null, createdAt: Date.now(), createdBy: auth.sub },
        ConditionExpression: "attribute_not_exists(PK)",
      }));
      if (fromBom.length) {
        await ddb.send(new PutCommand({
          TableName: TABLE,
          Item: { ...bomKey(partNumber, letter), partNumber, revision: letter, lines: fromBom },
        }));
      }
      await audit("Revision", `${partNumber}#${letter}`, "created", auth.sub, { fromRevision: parsed.data.fromRevision ?? null });
      return json(201, { partNumber, letter, status: "Draft" }, requestId);
    }

    const revMatch = path.match(/^\/parts\/([^/]+)\/revisions\/([^/]+)$/);
    if (revMatch && method === "GET") {
      const partNumber = decodeURIComponent(revMatch[1]!);
      const letter = decodeURIComponent(revMatch[2]!);
      const res = await ddb.send(new GetCommand({ TableName: TABLE, Key: revisionKey(partNumber, letter) }));
      if (!res.Item) return errorResponse(404, "NOT_FOUND", "Revision not found", requestId);
      return json(200, { partNumber, letter, status: res.Item.status, lock: res.Item.lock ?? null }, requestId);
    }

    if (revMatch && method === "PATCH") {
      const partNumber = decodeURIComponent(revMatch[1]!);
      const letter = decodeURIComponent(revMatch[2]!);
      const body = JSON.parse(event.body ?? "{}");

      // Lock action?
      if (body.action === "acquire" || body.action === "release" || body.action === "override") {
        const lockParsed = LockSchema.safeParse(body);
        if (!lockParsed.success && body.action !== "override") return errorResponse(400, "VALIDATION_ERROR", "Invalid lock request", requestId);

        const res = await ddb.send(new GetCommand({ TableName: TABLE, Key: revisionKey(partNumber, letter) }));
        if (!res.Item) return errorResponse(404, "NOT_FOUND", "Revision not found", requestId);
        if (isReleased(res.Item.status)) return errorResponse(409, "IMMUTABLE", "Released revision is immutable", requestId);
        const currentLock = res.Item.lock as { holder: string; expiresAt: number } | null;
        const now = Date.now();

        if (body.action === "acquire") {
          if (!requireRole(auth, ["engineer", "admin"])) return errorResponse(403, "FORBIDDEN", "Requires engineer role", requestId);
          const check = canAcquireLock(currentLock, auth.sub, now);
          if (!check.ok) return errorResponse(423, "LOCKED", check.reason, requestId);
          const newLock = { holder: auth.sub, expiresAt: lockExpiresAt(now) };
          await ddb.send(new UpdateCommand({
            TableName: TABLE,
            Key: revisionKey(partNumber, letter),
            UpdateExpression: "SET #lock = :l",
            ExpressionAttributeNames: { "#lock": "lock" },
            ExpressionAttributeValues: { ":l": newLock, ":now": now, ":sub": auth.sub },
            ConditionExpression: "attribute_exists(PK) AND (attribute_not_exists(#lock) OR #lock.expiresAt < :now OR #lock.holder = :sub)",
          }));
          await audit("Revision", `${partNumber}#${letter}`, "check-out", auth.sub, {});
          return json(200, { partNumber, letter, lock: newLock }, requestId);
        }
        if (body.action === "release") {
          if (currentLock?.holder !== auth.sub && !requireRole(auth, ["admin"])) return errorResponse(403, "FORBIDDEN", "Not lock holder", requestId);
          await ddb.send(new UpdateCommand({
            TableName: TABLE,
            Key: revisionKey(partNumber, letter),
            UpdateExpression: "REMOVE #lock",
            ExpressionAttributeNames: { "#lock": "lock" },
          }));
          await audit("Revision", `${partNumber}#${letter}`, "check-in", auth.sub, {});
          return json(200, { partNumber, letter, lock: null }, requestId);
        }
        if (body.action === "override") {
          if (!requireRole(auth, ["admin"])) return errorResponse(403, "FORBIDDEN", "Requires admin", requestId);
          const newLock = { holder: auth.sub, expiresAt: lockExpiresAt(now) };
          await ddb.send(new UpdateCommand({
            TableName: TABLE,
            Key: revisionKey(partNumber, letter),
            UpdateExpression: "SET #lock = :l",
            ExpressionAttributeNames: { "#lock": "lock" },
            ExpressionAttributeValues: { ":l": newLock },
          }));
          await audit("Revision", `${partNumber}#${letter}`, "lock-override", auth.sub, {});
          return json(200, { partNumber, letter, lock: newLock }, requestId);
        }
      }

      // Transition
      const parsed = TransitionRevisionSchema.safeParse(body);
      if (!parsed.success) return errorResponse(400, "VALIDATION_ERROR", "Invalid transition", requestId);
      if (!requireRole(auth, ["engineer", "admin"])) return errorResponse(403, "FORBIDDEN", "Requires engineer role", requestId);

      const res = await ddb.send(new GetCommand({ TableName: TABLE, Key: revisionKey(partNumber, letter) }));
      if (!res.Item) return errorResponse(404, "NOT_FOUND", "Revision not found", requestId);
      if (isReleased(res.Item.status)) return errorResponse(409, "IMMUTABLE", "Released revision is immutable", requestId);
      if (!canTransition(res.Item.status, parsed.data.to)) {
        return errorResponse(409, "INVALID_TRANSITION", `Cannot go from ${res.Item.status} to ${parsed.data.to}`, requestId);
      }
      await ddb.send(new UpdateCommand({
        TableName: TABLE,
        Key: revisionKey(partNumber, letter),
        UpdateExpression: "SET #s = :to",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":to": parsed.data.to, ":from": res.Item.status },
        ConditionExpression: "#s = :from",
      }));
      await audit("Revision", `${partNumber}#${letter}`, "status", auth.sub, { from: res.Item.status, to: parsed.data.to });
      return json(200, { partNumber, letter, status: parsed.data.to }, requestId);
    }

    // Files
    const filesMatch = path.match(/^\/parts\/([^/]+)\/revisions\/([^/]+)\/files$/);
    if (filesMatch && method === "GET") {
      const partNumber = decodeURIComponent(filesMatch[1]!);
      const letter = decodeURIComponent(filesMatch[2]!);
      const res = await ddb.send(new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
        ExpressionAttributeValues: { ":pk": `${ORG_ID}#FILE`, ":sk": `FILE#${partNumber}#${letter}#` },
      }));
      return json(200, { files: (res.Items ?? []).map(fileToDto) }, requestId);
    }

    const uploadInitMatch = path.match(/^\/parts\/([^/]+)\/revisions\/([^/]+)\/files\/initiate$/);
    if (uploadInitMatch && method === "POST") {
      if (!requireRole(auth, ["engineer", "admin"])) return errorResponse(403, "FORBIDDEN", "Requires engineer role", requestId);
      const partNumber = decodeURIComponent(uploadInitMatch[1]!);
      const letter = decodeURIComponent(uploadInitMatch[2]!);
      const body = JSON.parse(event.body ?? "{}");
      const parsed = InitiateUploadSchema.safeParse(body);
      if (!parsed.success) return errorResponse(400, "VALIDATION_ERROR", "Invalid upload request", requestId);

      const revRes = await ddb.send(new GetCommand({ TableName: TABLE, Key: revisionKey(partNumber, letter) }));
      if (!revRes.Item) return errorResponse(404, "NOT_FOUND", "Revision not found", requestId);
      if (isReleased(revRes.Item.status)) return errorResponse(409, "IMMUTABLE", "Released revision is immutable", requestId);
      const lock = revRes.Item.lock as { holder: string; expiresAt: number } | null;
      const lockCheck = canAcquireLock(lock, auth.sub, Date.now());
      if (!lockCheck.ok) return errorResponse(423, "LOCKED", lockCheck.reason, requestId);

      const fileId = crypto.randomUUID();
      const key = `uploads/${partNumber}/${letter}/${fileId}/${decodeURIComponent(parsed.data.fileName).replace(/[^a-zA-Z0-9._-]/g, "_")}`;
      const upload = await s3.send(new CreateMultipartUploadCommand({ Bucket: BUCKET, Key: key, ContentType: parsed.data.contentType }));
      const parts = planParts(parsed.data.fileSize);

      const fileItem = {
        ...fileKey(fileId),
        fileId, partNumber, revision: letter, fileName: parsed.data.fileName, fileSize: parsed.data.fileSize,
        contentType: parsed.data.contentType, sha256: parsed.data.sha256,
        status: "Processing", uploadId: upload.UploadId, s3Key: key, s3VersionId: null,
        metadata: null, createdAt: Date.now(), createdBy: auth.sub,
        GSI1PK: `${ORG_ID}#FILE#${partNumber}#${letter}`, GSI1SK: `FILE#${fileId}`,
      };
      await ddb.send(new PutCommand({ TableName: TABLE, Item: fileItem }));

      // Presigned part URLs
      const partUrls: { partNumber: number; url: string }[] = [];
      for (const p of parts) {
        const cmd = new UploadPartCommand({ Bucket: BUCKET, Key: key, UploadId: upload.UploadId!, PartNumber: p.partNumber });
        const url = await getSignedUrl(s3, cmd, { expiresIn: 900 });
        partUrls.push({ partNumber: p.partNumber, url });
      }
      await audit("File", fileId, "upload-initiated", auth.sub, { partNumber, letter, fileName: parsed.data.fileName });
      return json(201, { fileId, uploadId: upload.UploadId, s3Key: key, parts: partUrls }, requestId);
    }

    const uploadCompleteMatch = path.match(/^\/parts\/([^/]+)\/revisions\/([^/]+)\/files\/(.+)\/complete$/);
    if (uploadCompleteMatch && method === "POST") {
      if (!requireRole(auth, ["engineer", "admin"])) return errorResponse(403, "FORBIDDEN", "Requires engineer role", requestId);
      const fileId = decodeURIComponent(uploadCompleteMatch[3]!);
      const body = JSON.parse(event.body ?? "{}");
      const parsed = CompleteUploadSchema.safeParse(body);
      if (!parsed.success) return errorResponse(400, "VALIDATION_ERROR", "Invalid complete request", requestId);

      const fileRes = await ddb.send(new GetCommand({ TableName: TABLE, Key: fileKey(fileId) }));
      if (!fileRes.Item) return errorResponse(404, "NOT_FOUND", "File not found", requestId);

      await s3.send(new CompleteMultipartUploadCommand({
        Bucket: BUCKET,
        Key: fileRes.Item.s3Key,
        UploadId: parsed.data.uploadId,
        MultipartUpload: {
          Parts: parsed.data.parts.map((p) => ({
            ETag: p.eTag,
            PartNumber: p.partNumber,
          })),
        },
      }));
      await audit("File", fileId, "upload-completed", auth.sub, { uploadId: parsed.data.uploadId });
      // Status stays Processing until worker finishes via S3 event
      return json(200, { fileId, status: "Processing" }, requestId);
    }

    const fileDownloadMatch = path.match(/^\/files\/([^/]+)\/download$/);
    if (fileDownloadMatch && method === "GET") {
      const fileId = decodeURIComponent(fileDownloadMatch[1]!);
      const fileRes = await ddb.send(new GetCommand({ TableName: TABLE, Key: fileKey(fileId) }));
      if (!fileRes.Item) return errorResponse(404, "NOT_FOUND", "File not found", requestId);
      if (fileRes.Item.status !== "Ready") return errorResponse(409, "NOT_READY", "File not ready", requestId);
      const cmd = new GetObjectCommand({ Bucket: BUCKET, Key: fileRes.Item.s3Key, VersionId: fileRes.Item.s3VersionId ?? undefined });
      const url = await getSignedUrl(s3, cmd, { expiresIn: 300 });
      return json(200, { url }, requestId);
    }

    // BOM
    const bomMatch = path.match(/^\/parts\/([^/]+)\/revisions\/([^/]+)\/bom$/);
    if (bomMatch && method === "GET") {
      const partNumber = decodeURIComponent(bomMatch[1]!);
      const letter = decodeURIComponent(bomMatch[2]!);
      const res = await ddb.send(new GetCommand({ TableName: TABLE, Key: bomKey(partNumber, letter) }));
      const lines = (res.Item?.lines as { childPartNumber: string; quantity: number }[]) ?? [];
      // Tree
      const allLines = await loadAllBomLines();
      const tree = buildTree(partNumber, lines, allLines);
      return json(200, { partNumber, revision: letter, lines, tree }, requestId);
    }

    if (bomMatch && method === "PUT") {
      if (!requireRole(auth, ["engineer", "admin"])) return errorResponse(403, "FORBIDDEN", "Requires engineer role", requestId);
      const partNumber = decodeURIComponent(bomMatch[1]!);
      const letter = decodeURIComponent(bomMatch[2]!);
      const body = JSON.parse(event.body ?? "{}");
      const parsed = SetBomSchema.safeParse(body);
      if (!parsed.success) return errorResponse(400, "VALIDATION_ERROR", "Invalid BOM", requestId);

      const revRes = await ddb.send(new GetCommand({ TableName: TABLE, Key: revisionKey(partNumber, letter) }));
      if (!revRes.Item) return errorResponse(404, "NOT_FOUND", "Revision not found", requestId);
      if (isReleased(revRes.Item.status)) return errorResponse(409, "IMMUTABLE", "Released revision is immutable", requestId);
      const lock = revRes.Item.lock as { holder: string; expiresAt: number } | null;
      const lockCheck = canAcquireLock(lock, auth.sub, Date.now());
      if (!lockCheck.ok) return errorResponse(423, "LOCKED", lockCheck.reason, requestId);

      // Cycle check: build map including proposed lines
      const allLines = await loadAllBomLines();
      const testMap = new Map<string, { child: string; quantity: number }[]>();
      for (const [k, v] of allLines) testMap.set(k, v);
      testMap.set(partNumber, parsed.data.lines.map((l) => ({ child: l.childPartNumber, quantity: l.quantity })));
      if (hasCycle(partNumber, testMap)) return errorResponse(400, "CYCLE", "BOM would create a cycle", requestId);

      await ddb.send(new PutCommand({
        TableName: TABLE,
        Item: { ...bomKey(partNumber, letter), partNumber, revision: letter, lines: parsed.data.lines },
      }));
      await audit("BOM", `${partNumber}#${letter}`, "updated", auth.sub, { lines: parsed.data.lines });
      return json(200, { partNumber, revision: letter, lines: parsed.data.lines }, requestId);
    }

    const bomCsvMatch = path.match(/^\/parts\/([^/]+)\/revisions\/([^/]+)\/bom\.csv$/);
    if (bomCsvMatch && method === "GET") {
      const partNumber = decodeURIComponent(bomCsvMatch[1]!);
      const letter = decodeURIComponent(bomCsvMatch[2]!);
      const res = await ddb.send(new GetCommand({ TableName: TABLE, Key: bomKey(partNumber, letter) }));
      const lines = (res.Item?.lines as { childPartNumber: string; quantity: number }[]) ?? [];
      const allLines = await loadAllBomLines();
      const flat = flattenBom(partNumber, allLines);
      return {
        statusCode: 200,
        headers: { "Content-Type": "text/csv", "Content-Disposition": `attachment; filename="bom-${partNumber}-${letter}.csv"`, "Access-Control-Allow-Origin": "*" },
        body: toCsv(flat),
      };
    }

    const whereUsedMatch = path.match(/^\/parts\/([^/]+)\/where-used$/);
    if (whereUsedMatch && method === "GET") {
      const partNumber = decodeURIComponent(whereUsedMatch[1]!);
      const allLines = await loadAllBomLines();
      const parents = whereUsed(partNumber, allLines);
      return json(200, { partNumber, usedIn: parents }, requestId);
    }

    const bomDiffMatch = path.match(/^\/parts\/([^/]+)\/bom\/diff\?from=([^&]+)&to=(.+)$/);
    if (bomDiffMatch && method === "GET") {
      const partNumber = decodeURIComponent(bomDiffMatch[1]!);
      const from = decodeURIComponent(bomDiffMatch[2]!);
      const to = decodeURIComponent(bomDiffMatch[3]!);
      const [fromRes, toRes] = await Promise.all([
        ddb.send(new GetCommand({ TableName: TABLE, Key: bomKey(partNumber, from) })),
        ddb.send(new GetCommand({ TableName: TABLE, Key: bomKey(partNumber, to) })),
      ]);
      const fromLines = (fromRes.Item?.lines as { childPartNumber: string; quantity: number }[]) ?? [];
      const toLines = (toRes.Item?.lines as { childPartNumber: string; quantity: number }[]) ?? [];
      return json(200, { partNumber, from, to, diff: diffBom(fromLines, toLines) }, requestId);
    }

    // Audit history
    const historyMatch = path.match(/^\/parts\/([^/]+)\/history$/);
    if (historyMatch && method === "GET") {
      const partNumber = decodeURIComponent(historyMatch[1]!);
      const res = await ddb.send(new QueryCommand({
        TableName: TABLE,
        IndexName: "GSI1",
        KeyConditionExpression: "GSI1PK = :pk",
        ExpressionAttributeValues: { ":pk": `${ORG_ID}#AUDIT#Part#${partNumber}` },
        ScanIndexForward: false,
        Limit: 100,
      }));
      return json(200, { history: res.Items ?? [] }, requestId);
    }

    return errorResponse(404, "NOT_FOUND", "Route not found", requestId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("Unhandled error", { err: msg, requestId });
    metrics.addMetric("ApiError", MetricUnit.Count, 1);
    if (msg.includes("ConditionalCheckFailed")) return errorResponse(409, "CONFLICT", msg, requestId);
    return errorResponse(500, "INTERNAL", "Internal server error", requestId);
  }
};

function fileToDto(item: any) {
  return {
    fileId: item.fileId,
    fileName: item.fileName,
    fileSize: item.fileSize,
    contentType: item.contentType,
    sha256: item.sha256,
    status: item.status,
    s3Key: item.s3Key,
    metadata: item.metadata ?? null,
    createdAt: item.createdAt,
  };
}

async function loadAllBomLines(): Promise<Map<string, { child: string; quantity: number }[]>> {
  const res = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
    ExpressionAttributeValues: { ":pk": `${ORG_ID}#BOM`, ":sk": "BOM#" },
    Limit: 1000,
  }));
  const map = new Map<string, { child: string; quantity: number }[]>();
  for (const item of res.Items ?? []) {
    const lines = (item.lines as { childPartNumber: string; quantity: number }[]) ?? [];
    map.set(item.partNumber, lines.map((l) => ({ child: l.childPartNumber, quantity: l.quantity })));
  }
  return map;
}

function buildTree(root: string, lines: { childPartNumber: string; quantity: number }[], allLines: Map<string, { child: string; quantity: number }[]>) {
  return lines.map((l) => ({
    partNumber: l.childPartNumber,
    quantity: l.quantity,
    children: (allLines.get(l.childPartNumber) ?? []).map((c) => ({
      partNumber: c.child,
      quantity: c.quantity,
      children: [],
    })),
  }));
}
