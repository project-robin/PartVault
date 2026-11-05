export interface LockInfo {
  holder: string;
  expiresAt: number;
}

export function isLockExpired(lock: LockInfo | null, now: number): boolean {
  if (!lock) return true;
  return lock.expiresAt < now;
}

export function canAcquireLock(
  existing: LockInfo | null,
  userSub: string,
  now: number,
): { ok: true } | { ok: false; reason: string } {
  if (!existing || isLockExpired(existing, now)) return { ok: true };
  if (existing.holder === userSub) return { ok: true };
  return { ok: false, reason: `Locked by ${existing.holder} until ${new Date(existing.expiresAt).toISOString()}` };
}

export function lockExpiresAt(now: number, ttlSeconds = 3600): number {
  return now + ttlSeconds * 1000;
}
