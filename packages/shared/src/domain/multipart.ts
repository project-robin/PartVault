export const PART_SIZE = 8 * 1024 * 1024;
export const MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024;
export const MIN_PART_SIZE = 5 * 1024 * 1024;

export function planParts(fileSize: number, partSize = PART_SIZE): { partNumber: number; size: number }[] {
  if (fileSize <= 0) throw new Error("Invalid file size");
  if (fileSize > MAX_FILE_SIZE) throw new Error("File exceeds 2 GB limit");
  const count = Math.ceil(fileSize / partSize);
  const parts: { partNumber: number; size: number }[] = [];
  for (let i = 0; i < count; i++) {
    const size = i === count - 1 ? fileSize - i * partSize : partSize;
    parts.push({ partNumber: i + 1, size });
  }
  return parts;
}

export function nextPartSize(remaining: number, partSize = PART_SIZE): number {
  return Math.min(remaining, partSize);
}
