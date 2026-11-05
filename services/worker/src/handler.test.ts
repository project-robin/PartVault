import { describe, it, expect } from "vitest";
import { parseStl } from "@partvault/shared";

describe("worker STL integration", () => {
  it("parses STL used by worker", () => {
    const ascii = `solid a
facet normal 0 0 1
 outer loop
  vertex 0 0 0
  vertex 1 0 0
  vertex 0 1 0
 end loop
endfacet
endsolid a`;
    const meta = parseStl(Buffer.from(ascii));
    expect(meta.triangleCount).toBe(1);
  });
});
