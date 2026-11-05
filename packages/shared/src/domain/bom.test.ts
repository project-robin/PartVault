import { describe, it, expect } from "vitest";
import { hasCycle, flattenBom, diffBom, whereUsed, toCsv } from "./bom.js";

describe("BOM cycle detection", () => {
  it("detects direct cycle", () => {
    const map = new Map([["A", [{ child: "B", quantity: 1 }]], ["B", [{ child: "A", quantity: 1 }]]]);
    expect(hasCycle("A", map)).toBe(true);
  });
  it("detects indirect cycle", () => {
    const map = new Map([
      ["A", [{ child: "B", quantity: 1 }]],
      ["B", [{ child: "C", quantity: 1 }]],
      ["C", [{ child: "A", quantity: 1 }]],
    ]);
    expect(hasCycle("A", map)).toBe(true);
  });
  it("allows acyclic graph", () => {
    const map = new Map([["A", [{ child: "B", quantity: 2 }]], ["B", [{ child: "C", quantity: 1 }]]]);
    expect(hasCycle("A", map)).toBe(false);
  });
});

describe("BOM flatten and diff", () => {
  it("flattens with multipliers", () => {
    const map = new Map([["A", [{ child: "B", quantity: 2 }]], ["B", [{ child: "C", quantity: 3 }]]]);
    const flat = flattenBom("A", map);
    expect(flat).toEqual([{ partNumber: "B", quantity: 2, depth: 1 }, { partNumber: "C", quantity: 6, depth: 2 }]);
  });
  it("diffs added/removed/changed", () => {
    const d = diffBom(
      [{ childPartNumber: "X", quantity: 1 }, { childPartNumber: "Y", quantity: 2 }],
      [{ childPartNumber: "Y", quantity: 3 }, { childPartNumber: "Z", quantity: 1 }],
    );
    expect(d).toEqual([
      { childPartNumber: "X", before: 1, after: null, change: "removed" },
      { childPartNumber: "Y", before: 2, after: 3, change: "changed" },
      { childPartNumber: "Z", before: null, after: 1, change: "added" },
    ]);
  });
  it("where-used finds parents transitively", () => {
    const map = new Map([["A", [{ child: "C", quantity: 1 }]], ["B", [{ child: "C", quantity: 1 }]]]);
    const parents = whereUsed("C", map);
    expect(parents.sort()).toEqual(["A", "B"]);
  });
  it("toCsv escapes and formats", () => {
    expect(toCsv([{ partNumber: "A", quantity: 1, depth: 1 }])).toContain("partNumber,quantity,depth");
  });
});
