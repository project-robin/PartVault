import { describe, it, expect } from "vitest";
import { parseStl, isBinaryStl, detectMime } from "./stl.js";

describe("STL parser", () => {
  it("parses ASCII STL", () => {
    const ascii = `solid test
  facet normal 0 0 1
    outer loop
      vertex 0 0 0
      vertex 1 0 0
      vertex 0 1 1
    end loop
  endfacet
endsolid test`;
    const meta = parseStl(Buffer.from(ascii));
    expect(meta.triangleCount).toBe(1);
    expect(meta.isBinary).toBe(false);
    expect(meta.boundingBox.max).toEqual([1, 1, 1]);
  });

  it("parses binary STL", () => {
    const triCount = 1;
    const buf = Buffer.alloc(84 + triCount * 50);
    buf.write("solid cube", 0, "ascii");
    buf.writeUInt32LE(triCount, 80);
    // vertex 0: (0,0,0) vertex 1: (1,0,0) vertex 2: (0,1,1)
    buf.writeFloatLE(0, 84 + 12);
    buf.writeFloatLE(0, 84 + 16);
    buf.writeFloatLE(0, 84 + 20);
    buf.writeFloatLE(1, 84 + 24);
    buf.writeFloatLE(0, 84 + 28);
    buf.writeFloatLE(0, 84 + 32);
    buf.writeFloatLE(0, 84 + 36);
    buf.writeFloatLE(1, 84 + 40);
    buf.writeFloatLE(1, 84 + 44);
    const meta = parseStl(buf);
    expect(meta.triangleCount).toBe(1);
    expect(meta.isBinary).toBe(true);
    expect(meta.boundingBox.max).toEqual([1, 1, 1]);
  });

  it("rejects invalid STL", () => {
    expect(() => parseStl(Buffer.from("not an stl"))).toThrow();
  });

  it("isBinaryStl detects binary", () => {
    const buf = Buffer.alloc(84);
    buf.write("solid x", 0, "ascii");
    buf.writeUInt32LE(1, 80);
    expect(isBinaryStl(buf)).toBe(true);
  });

  it("detectMime maps extensions", () => {
    expect(detectMime("a.step", "")).toBe("model/step");
    expect(detectMime("a.pdf", "")).toBe("application/pdf");
    expect(detectMime("a.stl", "model/stl")).toBe("model/stl");
  });
});
