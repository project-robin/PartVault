export interface StlMetadata {
  triangleCount: number;
  boundingBox: { min: [number, number, number]; max: [number, number, number] };
  isBinary: boolean;
}

export function isBinaryStl(buf: Buffer): boolean {
  if (buf.length < 84) return false;
  const header = buf.subarray(0, 5).toString("ascii");
  if (header !== "solid") return true;
  const triCount = buf.readUInt32LE(80);
  if (triCount === 0) return false;
  const expected = 84 + triCount * 50;
  return buf.length >= expected || buf.subarray(0, 80).includes(0);
}

export function parseStl(buf: Buffer): StlMetadata {
  if (buf.length < 1) throw new Error("Empty STL file");
  const binary = isBinaryStl(buf);
  if (binary) {
    if (buf.length < 84) throw new Error("Truncated binary STL header");
    const triCount = buf.readUInt32LE(80);
    if (buf.length < 84 + triCount * 50) throw new Error("Truncated binary STL body");
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < triCount; i++) {
      const off = 84 + i * 50 + 12;
      for (let v = 0; v < 3; v++) {
        for (let a = 0; a < 3; a++) {
          const val = buf.readFloatLE(off + (v * 3 + a) * 4);
          if (!Number.isFinite(val)) continue;
          if (val < min[a]!) min[a] = val;
          if (val > max[a]!) max[a] = val;
        }
      }
    }
    return { triangleCount: triCount, boundingBox: { min, max }, isBinary: true };
  }
  const text = buf.toString("utf8");
  const vertex = /vertex\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)/g;
  let m: RegExpExecArray | null;
  let count = 0;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  let found = 0;
  while ((m = vertex.exec(text)) !== null) {
    found++;
    const x = parseFloat(m[1]!); const y = parseFloat(m[2]!); const z = parseFloat(m[3]!);
    if (![x, y, z].every(Number.isFinite)) continue;
    if (x < min[0]!) min[0] = x;
    if (y < min[1]!) min[1] = y;
    if (z < min[2]!) min[2] = z;
    if (x > max[0]!) max[0] = x;
    if (y > max[1]!) max[1] = y;
    if (z > max[2]!) max[2] = z;
  }
  if (found === 0) throw new Error("Invalid STL: no vertices found");
  count = Math.floor(found / 3);
  return { triangleCount: count, boundingBox: { min, max }, isBinary: false };
}

export function detectMime(fileName: string, contentType: string): string {
  if (contentType && contentType !== "application/octet-stream") return contentType;
  const ext = fileName.toLowerCase().split(".").pop() ?? "";
  const map: Record<string, string> = {
    stl: "model/stl",
    step: "model/step",
    stp: "model/step",
    dxf: "model/vnd.dxf",
    pdf: "application/pdf",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    txt: "text/plain",
    csv: "text/csv",
    json: "application/json",
  };
  return map[ext] ?? "application/octet-stream";
}
