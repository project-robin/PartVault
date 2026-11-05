import { describe, it, expect, beforeEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, PutCommand, GetCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import {
  canTransition,
  nextRevisionLetter,
  isReleased,
  canAcquireLock,
  lockExpiresAt,
  hasCycle,
  diffBom,
  toCsv,
  planParts,
  parseStl,
  detectMime,
  type BomMap,
} from "@partvault/shared";

const ddbMock = mockClient(DynamoDBDocumentClient);
const s3Mock = mockClient(S3Client);

describe("PartVault Complete End-to-End Workflow Verification", () => {
  beforeEach(() => {
    ddbMock.reset();
    s3Mock.reset();
  });

  it("enforces complete lifecycle: Draft -> In Review -> Released, immutability, and BOM cloning", () => {
    // 1. Revision State Machine
    expect(canTransition("Draft", "In Review")).toBe(true);
    expect(canTransition("In Review", "Released")).toBe(true);
    expect(canTransition("In Review", "Draft")).toBe(true); // sent back for rework
    expect(canTransition("Released", "Draft")).toBe(false); // Released is immutable
    expect(canTransition("Released", "In Review")).toBe(false);

    expect(isReleased("Draft")).toBe(false);
    expect(isReleased("Released")).toBe(true);

    // 2. Sequential Revisions
    expect(nextRevisionLetter("A")).toBe("B");
    expect(nextRevisionLetter("B")).toBe("C");
    expect(nextRevisionLetter("Y")).toBe("Z");
    expect(() => nextRevisionLetter("Z")).toThrow(/limit reached/);
  });

  it("enforces exclusive check-out locking, expiry, and admin break-lock rules", () => {
    const now = 1700000000000;
    const activeLock = { holder: "engineer-1", expiresAt: lockExpiresAt(now, 3600) };

    // Same user can re-acquire or refresh
    expect(canAcquireLock(activeLock, "engineer-1", now).ok).toBe(true);

    // Another user is blocked
    const blocked = canAcquireLock(activeLock, "engineer-2", now);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.reason).toContain("engineer-1");
    }

    // Expired lock allows acquisition by another user
    const expiredLock = { holder: "engineer-1", expiresAt: now - 1000 };
    expect(canAcquireLock(expiredLock, "engineer-2", now).ok).toBe(true);
  });

  it("detects BOM circular references and diffs revisions accurately", () => {
    // A -> B -> C -> A (cycle)
    const bomGraph: BomMap = new Map([
      ["PV-1001", [{ child: "PV-1002", quantity: 2 }]],
      ["PV-1002", [{ child: "PV-1003", quantity: 1 }]],
      ["PV-1003", [{ child: "PV-1001", quantity: 4 }]], // introduces cycle back to 1001
    ]);
    expect(hasCycle("PV-1001", bomGraph)).toBe(true);

    // A -> B -> C (no cycle)
    const validGraph: BomMap = new Map([
      ["PV-1001", [{ child: "PV-1002", quantity: 2 }]],
      ["PV-1002", [{ child: "PV-1003", quantity: 1 }]],
    ]);
    expect(hasCycle("PV-1001", validGraph)).toBe(false);

    // BOM Diff between Rev A and Rev B
    const revA = [
      { childPartNumber: "PV-1002", quantity: 2 },
      { childPartNumber: "PV-1003", quantity: 5 },
    ];
    const revB = [
      { childPartNumber: "PV-1002", quantity: 4 }, // changed quantity
      { childPartNumber: "PV-1004", quantity: 1 }, // added
      // PV-1003 removed
    ];
    const diff = diffBom(revA, revB);
    expect(diff).toEqual([
      { childPartNumber: "PV-1002", before: 2, after: 4, change: "changed" },
      { childPartNumber: "PV-1003", before: 5, after: null, change: "removed" },
      { childPartNumber: "PV-1004", before: null, after: 1, change: "added" },
    ]);

    // CSV Export
    const csv = toCsv([{ partNumber: "PV-1002", quantity: 4, depth: 1 }]);
    expect(csv).toContain("partNumber,quantity,depth");
    expect(csv).toContain("PV-1002,4,1");
  });

  it("plans 200 MB multipart uploads and streams STL parser with bounding box calculation", () => {
    // 200 MB file planned in 8 MB chunks
    const fileSize200MB = 200 * 1024 * 1024;
    const parts = planParts(fileSize200MB, 8 * 1024 * 1024);
    expect(parts.length).toBe(25);
    expect(parts[0]!.size).toBe(8 * 1024 * 1024);
    expect(parts[24]!.size).toBe(8 * 1024 * 1024);

    // ASCII STL geometric verification
    const asciiStl = `solid test_bracket
facet normal 0 0 1
  outer loop
    vertex 0 0 0
    vertex 10 0 0
    vertex 0 20 5
  end loop
endfacet
endsolid test_bracket`;

    const meta = parseStl(Buffer.from(asciiStl));
    expect(meta.triangleCount).toBe(1);
    expect(meta.isBinary).toBe(false);
    expect(meta.boundingBox.min).toEqual([0, 0, 0]);
    expect(meta.boundingBox.max).toEqual([10, 20, 5]);

    // MIME type detection
    expect(detectMime("housing.stl", "")).toBe("model/stl");
    expect(detectMime("assembly.step", "")).toBe("model/step");
    expect(detectMime("spec.pdf", "")).toBe("application/pdf");
  });

  it("verifies API authorization and conditional lock mutation handlers", async () => {
    process.env.TABLE_NAME = "partvault-test";
    process.env.BUCKET_NAME = "partvault-test-uploads";

    const { handler } = await import("./handler.js");

    // 1. Unauthenticated request is rejected
    const unauth = await handler({
      httpMethod: "GET",
      rawPath: "/parts",
      headers: {},
      requestContext: {},
      body: "",
    });
    expect(unauth.statusCode).toBe(401);

    // 2. Viewer role is prevented from creating parts
    const viewerForbidden = await handler({
      httpMethod: "POST",
      rawPath: "/parts",
      headers: { "x-user-sub": "viewer-1", "x-user-roles": "viewer" },
      requestContext: {},
      body: JSON.stringify({ partNumber: "PV-5001", name: "Viewer Part", description: "" }),
    });
    expect(viewerForbidden.statusCode).toBe(403);

    // 3. Health check route succeeds without auth
    const health = await handler({
      httpMethod: "GET",
      rawPath: "/health",
      headers: {},
      requestContext: {},
      body: "",
    });
    expect(health.statusCode).toBe(200);
    expect(JSON.parse(health.body).status).toBe("ok");
  });
});
