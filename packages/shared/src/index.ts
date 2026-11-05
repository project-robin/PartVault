import { z } from "zod";

export const RoleSchema = z.enum(["admin", "engineer", "viewer"]);
export type Role = z.infer<typeof RoleSchema>;

export const OrgIdSchema = z.string().min(1).max(128);
export const PartNumberSchema = z.string().regex(/^PV-\d{3,6}$/, "PV-1001");

export const CreatePartSchema = z.object({
  partNumber: PartNumberSchema,
  name: z.string().min(1).max(200),
  description: z.string().max(2000).default(""),
});
export type CreatePart = z.infer<typeof CreatePartSchema>;

export const UpdatePartSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
});
export type UpdatePart = z.infer<typeof UpdatePartSchema>;

export const RevisionLetterSchema = z.string().regex(/^[A-Z]$/);
export const LifecycleSchema = z.enum(["Draft", "In Review", "Released"]);
export type Lifecycle = z.infer<typeof LifecycleSchema>;

export const CreateRevisionSchema = z.object({
  fromRevision: RevisionLetterSchema.optional(),
});
export type CreateRevision = z.infer<typeof CreateRevisionSchema>;

export const TransitionRevisionSchema = z.object({
  to: LifecycleSchema,
});
export type TransitionRevision = z.infer<typeof TransitionRevisionSchema>;

export const LockSchema = z.object({
  action: z.enum(["acquire", "release"]),
});
export type Lock = z.infer<typeof LockSchema>;

export const BomLineSchema = z.object({
  childPartNumber: PartNumberSchema,
  quantity: z.number().int().min(1).max(100000),
});
export type BomLineInput = z.infer<typeof BomLineSchema>;

export const SetBomSchema = z.object({
  lines: z.array(BomLineSchema).max(500),
});
export type SetBom = z.infer<typeof SetBomSchema>;

export const FileStatusSchema = z.enum(["Processing", "Ready", "Failed"]);
export type FileStatus = z.infer<typeof FileStatusSchema>;

export const InitiateUploadSchema = z.object({
  fileName: z.string().min(1).max(512),
  fileSize: z.number().int().min(1).max(2 * 1024 * 1024 * 1024),
  contentType: z.string().min(1).max(200),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export type InitiateUpload = z.infer<typeof InitiateUploadSchema>;

export const CompleteUploadSchema = z.object({
  uploadId: z.string().min(1),
  parts: z.array(z.object({ eTag: z.string().min(1), partNumber: z.number().int().min(1) })).min(1).max(10000),
});
export type CompleteUpload = z.infer<typeof CompleteUploadSchema>;

export const ErrorBodySchema = z.object({
  code: z.string(),
  message: z.string(),
  requestId: z.string(),
  details: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
});
export type ErrorBody = z.infer<typeof ErrorBodySchema>;

export const PaginationSchema = z.object({
  limit: z.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
});
export type Pagination = z.infer<typeof PaginationSchema>;

export * from "./domain/revision.js";
export * from "./domain/stl.js";
export * from "./domain/bom.js";
export * from "./domain/lock.js";
export * from "./domain/multipart.js";
