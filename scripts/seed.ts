import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { CognitoIdentityProviderClient, AdminCreateUserCommand, AdminAddUserToGroupCommand, AdminSetUserPasswordCommand } from "@aws-sdk/client-cognito-identity-provider";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";

const TABLE = process.env.TABLE_NAME ?? "";
const BUCKET = process.env.BUCKET_NAME ?? "";
const USER_POOL_ID = process.env.USER_POOL_ID ?? "";
const ORG_ID = process.env.ORG_ID ?? "org-demo";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION ?? "ap-south-1" }));
const cognito = new CognitoIdentityProviderClient({ region: process.env.AWS_REGION ?? "ap-south-1" });
const s3 = new S3Client({ region: process.env.AWS_REGION ?? "ap-south-1" });

const USERS = [
  { email: "admin@demo.local", password: "Admin123!", role: "admin" },
  { email: "engineer@demo.local", password: "Engineer123!", role: "engineer" },
  { email: "viewer@demo.local", password: "Viewer123!", role: "viewer" },
];

async function put(item: Record<string, unknown>) {
  await ddb.send(new PutCommand({ TableName: TABLE, Item: item }));
}

async function seedParts() {
  const parts = [
    { partNumber: "PV-1001", name: "Bracket", description: "L-shaped bracket" },
    { partNumber: "PV-1002", name: "Bolt M6", description: "Hex bolt" },
    { partNumber: "PV-1003", name: "Plate", description: "Base plate" },
    { partNumber: "PV-1004", name: "Assembly", description: "Top assembly" },
  ];
  for (const p of parts) {
    await put({ PK: `${ORG_ID}#PART`, SK: `PART#${p.partNumber}`, ...p, createdAt: Date.now(), createdBy: "seed", GSI1PK: `${ORG_ID}#PART`, GSI1SK: `PART#${p.partNumber}` });
  }
  // Revisions
  for (const p of parts) {
    await put({ PK: `${ORG_ID}#PART`, SK: `REV#${p.partNumber}#A`, partNumber: p.partNumber, letter: "A", status: "Released", lock: null, createdAt: Date.now(), createdBy: "seed" });
  }
  // BOM: PV-1004 -> PV-1001 x2, PV-1002 x4 ; PV-1001 -> PV-1003 x1
  await put({ PK: `${ORG_ID}#BOM`, SK: `BOM#PV-1004#A`, partNumber: "PV-1004", revision: "A", lines: [{ childPartNumber: "PV-1001", quantity: 2 }, { childPartNumber: "PV-1002", quantity: 4 }] });
  await put({ PK: `${ORG_ID}#BOM`, SK: `BOM#PV-1001#A`, partNumber: "PV-1001", revision: "A", lines: [{ childPartNumber: "PV-1003", quantity: 1 }] });
}

async function seedStlFiles() {
  const ascii = `solid cube
  facet normal 0 0 1
    outer loop
      vertex 0 0 0
      vertex 1 0 0
      vertex 0 1 1
    end loop
  endfacet
endsolid cube`;
  const buf = Buffer.from(ascii);
  const key = "uploads/PV-1001/A/seed/cube.stl";
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: buf, ContentType: "model/stl" }));
  const sha256 = createHash("sha256").update(buf).digest("hex");
  await put({
    PK: `${ORG_ID}#FILE`, SK: `FILE#seed-1`, fileId: "seed-1", partNumber: "PV-1001", revision: "A",
    fileName: "cube.stl", fileSize: buf.length, contentType: "model/stl", sha256,
    status: "Ready", s3Key: key, s3VersionId: null, metadata: { sha256 },
    createdAt: Date.now(), createdBy: "seed", GSI1PK: `${ORG_ID}#FILE#PV-1001#A`, GSI1SK: `FILE#seed-1`,
  });
}

async function seedUsers() {
  if (!USER_POOL_ID) { console.warn("USER_POOL_ID not set — skipping user seed"); return; }
  for (const u of USERS) {
    try {
      await cognito.send(new AdminCreateUserCommand({
        UserPoolId: USER_POOL_ID,
        Username: u.email,
        UserAttributes: [{ Name: "email", Value: u.email }, { Name: "email_verified", Value: "true" }],
        MessageAction: "SUPPRESS",
      }));
    } catch (e) {
      console.log(`User ${u.email} already exists or error: ${e instanceof Error ? e.message : e}`);
    }
    try {
      await cognito.send(new AdminSetUserPasswordCommand({ UserPoolId: USER_POOL_ID, Username: u.email, Password: u.password, Permanent: true }));
    } catch {}
    try {
      await cognito.send(new AdminAddUserToGroupCommand({ UserPoolId: USER_POOL_ID, Username: u.email, GroupName: u.role }));
    } catch {}
  }
}

async function main() {
  if (!TABLE || !BUCKET) throw new Error("TABLE_NAME and BUCKET_NAME must be set");
  console.log("Seeding PartVault...");
  await seedParts();
  await seedStlFiles();
  await seedUsers();
  console.log("Seed complete. Users: admin@demo.local / engineer@demo.local / viewer@demo.local (passwords in USERS array of scripts/seed.ts — change in production)");
}

main().catch((e) => { console.error(e); process.exit(1); });
