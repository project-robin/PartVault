import { describe, it, expect } from "vitest";
import { canTransition, nextRevisionLetter, isReleased } from "./revision.js";

describe("revision state machine", () => {
  it("allows Draft -> In Review", () => expect(canTransition("Draft", "In Review")).toBe(true));
  it("allows In Review -> Released and Draft fallback", () => {
    expect(canTransition("In Review", "Released")).toBe(true);
    expect(canTransition("In Review", "Draft")).toBe(true);
  });
  it("blocks Released -> anything", () => {
    expect(canTransition("Released", "Draft")).toBe(false);
    expect(canTransition("Released", "In Review")).toBe(false);
  });
  it("blocks invalid Draft -> Released skip", () => expect(canTransition("Draft", "Released")).toBe(false));
  it("next letter increments and caps at Z", () => {
    expect(nextRevisionLetter("A")).toBe("B");
    expect(() => nextRevisionLetter("Z")).toThrow();
  });
  it("isReleased checks status", () => {
    expect(isReleased("Released")).toBe(true);
    expect(isReleased("Draft")).toBe(false);
  });
});
