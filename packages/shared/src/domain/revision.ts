import { z } from "zod";

export const REVISION_TRANSITIONS: Record<string, readonly string[]> = {
  "Draft": ["In Review"],
  "In Review": ["Draft", "Released"],
  "Released": [],
};

export function canTransition(from: string, to: string): boolean {
  return (REVISION_TRANSITIONS[from] ?? []).includes(to);
}

export function nextRevisionLetter(current: string): string {
  if (!/^[A-Z]$/.test(current)) throw new Error(`Invalid revision letter: ${current}`);
  const code = current.charCodeAt(0) + 1;
  if (code > "Z".charCodeAt(0)) throw new Error("Revision limit reached (Z)");
  return String.fromCharCode(code);
}

export function isReleased(status: string): boolean {
  return status === "Released";
}
