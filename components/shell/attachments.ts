// Pure helpers for files attached to a new run: size limit, chunk ranges, retry.
// No DOM or network here, so they are unit-tested directly. Limits come from lib/types,
// which the server enforces too.
import { MAX_FILES_PER_RUN, MAX_UPLOAD_BYTES, UPLOAD_CHUNK_BYTES } from "../../lib/types";

export interface FileLike {
  name: string;
  size: number;
}

export interface ChunkRange {
  index: number;
  start: number;
  end: number;
}

export type SizeCheck = { ok: true; totalBytes: number } | { ok: false; error: string };

/** "512 B", "4.0 KB", "12.5 MB". */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Checks the total size of a file set against the cap. Empty files are rejected, and so is
 * a set whose combined size goes over `maxBytes`. The error names the limit and the total.
 */
export function checkUploadSize(files: FileLike[], maxBytes = MAX_UPLOAD_BYTES): SizeCheck {
  if (files.length > MAX_FILES_PER_RUN) {
    return { ok: false, error: `A run takes at most ${MAX_FILES_PER_RUN} files. Remove some files.` };
  }
  const empty = files.find((f) => !(f.size > 0));
  if (empty) return { ok: false, error: `${empty.name} is empty.` };
  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
  if (totalBytes > maxBytes) {
    return {
      ok: false,
      error: `Attachments total ${formatBytes(totalBytes)}, over the ${formatBytes(maxBytes)} limit. Remove some files.`,
    };
  }
  return { ok: true, totalBytes };
}

/** Byte ranges covering [0, size) in chunks of `chunkBytes`. The last chunk may be shorter. */
export function chunkRanges(size: number, chunkBytes = UPLOAD_CHUNK_BYTES): ChunkRange[] {
  if (!Number.isInteger(size) || size <= 0) return [];
  if (!Number.isInteger(chunkBytes) || chunkBytes <= 0) {
    throw new Error("chunkBytes must be a positive integer");
  }
  const ranges: ChunkRange[] = [];
  for (let start = 0, index = 0; start < size; start += chunkBytes, index++) {
    ranges.push({ index, start, end: Math.min(start + chunkBytes, size) });
  }
  return ranges;
}

/**
 * Runs `task` up to `attempts` times, waiting `delayMs * 2^n` between tries. Throws the last
 * error. `sleep` is injectable so tests do not wait.
 */
export async function withRetry<T>(
  task: (attempt: number) => Promise<T>,
  { attempts = 3, delayMs = 500, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)) } = {},
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await task(attempt);
    } catch (err) {
      lastError = err;
      if (attempt < attempts) await sleep(delayMs * 2 ** (attempt - 1));
    }
  }
  throw lastError;
}
