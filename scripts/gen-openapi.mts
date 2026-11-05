import * as fs from "node:fs";
import * as path from "node:path";
import {
  CreatePartSchema,
  UpdatePartSchema,
  CreateRevisionSchema,
  TransitionRevisionSchema,
  LockSchema,
  SetBomSchema,
  InitiateUploadSchema,
  CompleteUploadSchema,
  ErrorBodySchema,
} from "../packages/shared/src/index.js";

const spec = {
  openapi: "3.0.3",
  info: {
    title: "PartVault API",
    version: "0.1.0",
    description: "Cloud Product Data Management (PDM) API for hardware teams",
  },
  components: {
    securitySchemes: {
      CognitoAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT",
      },
    },
    schemas: {
      CreatePart: {
        type: "object",
        required: ["partNumber", "name"],
        properties: {
          partNumber: { type: "string", pattern: "^PV-\\d{3,6}$", example: "PV-1001" },
          name: { type: "string", minLength: 1, maxLength: 200 },
          description: { type: "string", maxLength: 2000, default: "" },
        },
      },
      UpdatePart: {
        type: "object",
        properties: {
          name: { type: "string", minLength: 1, maxLength: 200 },
          description: { type: "string", maxLength: 2000 },
        },
      },
      CreateRevision: {
        type: "object",
        properties: {
          fromRevision: { type: "string", pattern: "^[A-Z]$", example: "A" },
        },
      },
      TransitionRevision: {
        type: "object",
        required: ["to"],
        properties: {
          to: { type: "string", enum: ["Draft", "In Review", "Released"] },
        },
      },
      Lock: {
        type: "object",
        required: ["action"],
        properties: {
          action: { type: "string", enum: ["acquire", "release"] },
        },
      },
      BomLine: {
        type: "object",
        required: ["childPartNumber", "quantity"],
        properties: {
          childPartNumber: { type: "string", pattern: "^PV-\\d{3,6}$" },
          quantity: { type: "integer", minimum: 1, maximum: 100000 },
        },
      },
      SetBom: {
        type: "object",
        required: ["lines"],
        properties: {
          lines: {
            type: "array",
            items: { $ref: "#/components/schemas/BomLine" },
            maxItems: 500,
          },
        },
      },
      InitiateUpload: {
        type: "object",
        required: ["fileName", "fileSize", "contentType", "sha256"],
        properties: {
          fileName: { type: "string", minLength: 1, maxLength: 512 },
          fileSize: { type: "integer", minimum: 1, maximum: 2147483648 },
          contentType: { type: "string", minLength: 1, maxLength: 200 },
          sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
        },
      },
      CompleteUpload: {
        type: "object",
        required: ["uploadId", "parts"],
        properties: {
          uploadId: { type: "string" },
          parts: {
            type: "array",
            items: {
              type: "object",
              required: ["eTag", "partNumber"],
              properties: {
                eTag: { type: "string" },
                partNumber: { type: "integer", minimum: 1 },
              },
            },
          },
        },
      },
      ErrorBody: {
        type: "object",
        required: ["code", "message", "requestId"],
        properties: {
          code: { type: "string" },
          message: { type: "string" },
          requestId: { type: "string" },
          details: {
            type: "array",
            items: {
              type: "object",
              properties: {
                path: { type: "string" },
                message: { type: "string" },
              },
            },
          },
        },
      },
    },
  },
  security: [{ CognitoAuth: [] }],
  paths: {
    "/health": {
      get: {
        summary: "Service health check",
        security: [],
        responses: {
          200: { description: "Service healthy" },
        },
      },
    },
    "/parts": {
      get: {
        summary: "List all parts",
        parameters: [
          { name: "search", in: "query", schema: { type: "string" } },
          { name: "limit", in: "query", schema: { type: "integer", default: 50 } },
        ],
        responses: {
          200: { description: "List of parts" },
          401: { description: "Unauthorized" },
        },
      },
      post: {
        summary: "Create a new part",
        parameters: [
          { name: "Idempotency-Key", in: "header", schema: { type: "string" } },
        ],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/CreatePart" } } },
        },
        responses: {
          201: { description: "Part created" },
          400: { description: "Validation error" },
          403: { description: "Forbidden" },
          409: { description: "Part already exists" },
        },
      },
    },
    "/parts/{partNumber}": {
      get: {
        summary: "Get part details",
        parameters: [{ name: "partNumber", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          200: { description: "Part details" },
          404: { description: "Part not found" },
        },
      },
      patch: {
        summary: "Update part metadata",
        parameters: [{ name: "partNumber", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/UpdatePart" } } },
        },
        responses: {
          200: { description: "Part updated" },
          403: { description: "Forbidden" },
          404: { description: "Part not found" },
        },
      },
    },
    "/parts/{partNumber}/revisions": {
      get: {
        summary: "List revisions for a part",
        parameters: [{ name: "partNumber", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          200: { description: "List of revisions" },
          404: { description: "Part not found" },
        },
      },
      post: {
        summary: "Create a new revision",
        parameters: [{ name: "partNumber", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          content: { "application/json": { schema: { $ref: "#/components/schemas/CreateRevision" } } },
        },
        responses: {
          201: { description: "Revision created" },
          409: { description: "State conflict" },
        },
      },
    },
    "/parts/{partNumber}/revisions/{letter}/lifecycle": {
      post: {
        summary: "Transition revision lifecycle state",
        parameters: [
          { name: "partNumber", in: "path", required: true, schema: { type: "string" } },
          { name: "letter", in: "path", required: true, schema: { type: "string" } },
        ],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/TransitionRevision" } } },
        },
        responses: {
          200: { description: "Lifecycle updated" },
          409: { description: "Invalid transition or revision is Released (immutable)" },
        },
      },
    },
    "/parts/{partNumber}/revisions/{letter}/lock": {
      post: {
        summary: "Acquire or release exclusive check-out lock",
        parameters: [
          { name: "partNumber", in: "path", required: true, schema: { type: "string" } },
          { name: "letter", in: "path", required: true, schema: { type: "string" } },
        ],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/Lock" } } },
        },
        responses: {
          200: { description: "Lock status updated" },
          409: { description: "Revision already locked by another user" },
        },
      },
    },
    "/parts/{partNumber}/revisions/{letter}/bom": {
      get: {
        summary: "Get BOM tree for revision",
        parameters: [
          { name: "partNumber", in: "path", required: true, schema: { type: "string" } },
          { name: "letter", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          200: { description: "BOM tree with line items" },
        },
      },
      put: {
        summary: "Set BOM lines for Draft revision",
        parameters: [
          { name: "partNumber", in: "path", required: true, schema: { type: "string" } },
          { name: "letter", in: "path", required: true, schema: { type: "string" } },
        ],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/SetBom" } } },
        },
        responses: {
          200: { description: "BOM lines saved" },
          400: { description: "Circular dependency detected" },
          409: { description: "Revision is Released or locked by another user" },
        },
      },
    },
    "/parts/{partNumber}/revisions/{letter}/bom/where-used": {
      get: {
        summary: "Find where this part is used across all assemblies",
        parameters: [
          { name: "partNumber", in: "path", required: true, schema: { type: "string" } },
          { name: "letter", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          200: { description: "List of parent assembly part numbers" },
        },
      },
    },
    "/parts/{partNumber}/revisions/{letter}/bom/diff": {
      get: {
        summary: "Diff BOM against another revision",
        parameters: [
          { name: "partNumber", in: "path", required: true, schema: { type: "string" } },
          { name: "letter", in: "path", required: true, schema: { type: "string" } },
          { name: "otherRevision", in: "query", required: true, schema: { type: "string" } },
        ],
        responses: {
          200: { description: "BOM diff comparison" },
        },
      },
    },
    "/parts/{partNumber}/revisions/{letter}/bom/export": {
      get: {
        summary: "Export BOM as CSV",
        parameters: [
          { name: "partNumber", in: "path", required: true, schema: { type: "string" } },
          { name: "letter", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          200: {
            description: "CSV file content",
            content: { "text/csv": { schema: { type: "string" } } },
          },
        },
      },
    },
    "/parts/{partNumber}/revisions/{letter}/files": {
      get: {
        summary: "List files attached to revision",
        parameters: [
          { name: "partNumber", in: "path", required: true, schema: { type: "string" } },
          { name: "letter", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          200: { description: "Attached file records" },
        },
      },
      post: {
        summary: "Initiate direct-to-S3 multipart upload",
        parameters: [
          { name: "partNumber", in: "path", required: true, schema: { type: "string" } },
          { name: "letter", in: "path", required: true, schema: { type: "string" } },
        ],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/InitiateUpload" } } },
        },
        responses: {
          201: { description: "Upload initiated with presigned part URLs" },
          409: { description: "Revision locked or released" },
        },
      },
    },
    "/files/{fileId}/complete": {
      post: {
        summary: "Complete multipart upload and trigger async worker processing",
        parameters: [{ name: "fileId", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/CompleteUpload" } } },
        },
        responses: {
          200: { description: "Upload completed, processing queued" },
          404: { description: "File not found" },
        },
      },
    },
    "/files/{fileId}/download": {
      get: {
        summary: "Generate presigned download URL for file",
        parameters: [{ name: "fileId", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          200: { description: "Presigned S3 download URL (5m expiry)" },
          404: { description: "File not found" },
        },
      },
    },
    "/parts/{partNumber}/history": {
      get: {
        summary: "Audit trail history for part and revisions",
        parameters: [{ name: "partNumber", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          200: { description: "Audit trail log items" },
        },
      },
    },
  },
};

const outDir = path.resolve("openapi");
fs.mkdirSync(outDir, { recursive: true });
const targetFile = path.join(outDir, "openapi.json");
fs.writeFileSync(targetFile, JSON.stringify(spec, null, 2));
console.log(`OpenAPI specification written to ${targetFile}`);
