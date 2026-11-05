import { describe, it, expect } from "vitest";
import { planParts, PART_SIZE, MAX_FILE_SIZE } from "./multipart.js";

describe("multipart helpers", () => {
  it("plans single part for small file", () => {
    expect(planParts(1000)).toEqual([{ partNumber: 1, size: 1000 }]);
  });
  it("plans multiple parts for large file", () => {
    const parts = planParts(200 * 1024 * 1024);
    expect(parts.length).toBe(Math.ceil((200 * 1024 * 1024) / PART_SIZE));
    expect(parts[0]!.size).toBe(PART_SIZE);
    const last = parts[parts.length - 1]!;
    expect(last.size).toBeLessThanOrEqual(PART_SIZE);
  });
  it("rejects over 2 GB", () => {
    expect(() => planParts(MAX_FILE_SIZE + 1)).toThrow();
  });
});
