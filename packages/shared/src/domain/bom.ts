export type BomMap = Map<string, { child: string; quantity: number }[]>;

export function hasCycle(rootPart: string, map: BomMap): boolean {
  const visited = new Set<string>();
  const stack = new Set<string>();

  function dfs(node: string): boolean {
    if (stack.has(node)) return true;
    if (visited.has(node)) return false;
    visited.add(node);
    stack.add(node);
    for (const edge of map.get(node) ?? []) {
      if (dfs(edge.child)) return true;
    }
    stack.delete(node);
    return false;
  }
  return dfs(rootPart);
}

export function flattenBom(
  rootPart: string,
  map: BomMap,
  multiplier = 1,
  depth = 0,
  out: { partNumber: string; quantity: number; depth: number }[] = [],
): { partNumber: string; quantity: number; depth: number }[] {
  for (const edge of map.get(rootPart) ?? []) {
    const totalQty = edge.quantity * multiplier;
    out.push({ partNumber: edge.child, quantity: totalQty, depth: depth + 1 });
    flattenBom(edge.child, map, totalQty, depth + 1, out);
  }
  return out;
}

export interface BomDiffEntry {
  childPartNumber: string;
  before: number | null;
  after: number | null;
  change: "added" | "removed" | "changed";
}

export function diffBom(
  before: { childPartNumber: string; quantity: number }[],
  after: { childPartNumber: string; quantity: number }[],
): BomDiffEntry[] {
  const b = new Map(before.map((l) => [l.childPartNumber, l.quantity]));
  const a = new Map(after.map((l) => [l.childPartNumber, l.quantity]));
  const keys = new Set([...b.keys(), ...a.keys()]);
  const out: BomDiffEntry[] = [];
  for (const k of keys) {
    const bv = b.get(k) ?? null;
    const av = a.get(k) ?? null;
    if (bv === av) continue;
    out.push({
      childPartNumber: k,
      before: bv,
      after: av,
      change: bv === null ? "added" : av === null ? "removed" : "changed",
    });
  }
  return out.sort((x, y) => x.childPartNumber.localeCompare(y.childPartNumber));
}

export function whereUsed(
  target: string,
  map: BomMap,
  visited = new Set<string>(),
  out: string[] = [],
): string[] {
  if (visited.has(target)) return out;
  visited.add(target);
  for (const [parent, children] of map) {
    if (children.some((c) => c.child === target)) {
      out.push(parent);
      whereUsed(parent, map, visited, out);
    }
  }
  return out;
}

export function toCsv(rows: { partNumber: string; quantity: number; depth: number }[]): string {
  const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const lines = ["partNumber,quantity,depth"];
  for (const r of rows) lines.push(`${esc(r.partNumber)},${r.quantity},${r.depth}`);
  return lines.join("\n");
}
