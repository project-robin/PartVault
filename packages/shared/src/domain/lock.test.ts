import { describe, it, expect } from "vitest";
import { canAcquireLock, isLockExpired, lockExpiresAt } from "./lock.js";

describe("lock rules", () => {
  const now = Date.now();
  it("allows acquire when no lock", () => {
    expect(canAcquireLock(null, "user1", now).ok).toBe(true);
  });
  it("blocks acquire when locked by another user", () => {
    const lock = { holder: "user2", expiresAt: now + 3600_000 };
    expect(canAcquireLock(lock, "user1", now).ok).toBe(false);
  });
  it("allows re-acquire by holder", () => {
    const lock = { holder: "user1", expiresAt: now + 3600_000 };
    expect(canAcquireLock(lock, "user1", now).ok).toBe(true);
  });
  it("allows acquire when expired", () => {
    const lock = { holder: "user2", expiresAt: now - 1 };
    expect(canAcquireLock(lock, "user1", now).ok).toBe(true);
  });
  it("isLockExpired and lockExpiresAt behave", () => {
    expect(isLockExpired(null, now)).toBe(true);
    expect(isLockExpired({ holder: "u", expiresAt: now - 1 }, now)).toBe(true);
    expect(isLockExpired({ holder: "u", expiresAt: now + 1000 }, now)).toBe(false);
    expect(lockExpiresAt(now)).toBe(now + 3600_000);
  });
});
