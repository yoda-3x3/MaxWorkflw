import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_MAX_UPLOAD_BYTES,
  checkUploadSize,
  chunkRanges,
  formatBytes,
  withRetry,
} from "./attachments";

const MB = 1024 * 1024;

test("checkUploadSize accepts a set at exactly the limit", () => {
  const r = checkUploadSize([{ name: "a.zip", size: 60 * MB }, { name: "b.zip", size: 30 * MB }], 90 * MB);
  assert.deepEqual(r, { ok: true, totalBytes: 90 * MB });
});

test("checkUploadSize rejects a set over the limit and names both sizes", () => {
  const r = checkUploadSize([{ name: "a.zip", size: 60 * MB }, { name: "b.zip", size: 31 * MB }], 90 * MB);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.match(r.error, /91\.0 MB/);
    assert.match(r.error, /90\.0 MB limit/);
  }
});

test("checkUploadSize defaults to the 90 MB cap", () => {
  assert.equal(DEFAULT_MAX_UPLOAD_BYTES, 90 * MB);
  assert.equal(checkUploadSize([{ name: "x", size: 90 * MB }]).ok, true);
  assert.equal(checkUploadSize([{ name: "x", size: 90 * MB + 1 }]).ok, false);
});

test("checkUploadSize rejects an empty file by name", () => {
  const r = checkUploadSize([{ name: "notes.txt", size: 0 }]);
  assert.deepEqual(r, { ok: false, error: "notes.txt is empty." });
});

test("checkUploadSize rejects more than 20 files", () => {
  const files = Array.from({ length: 21 }, (_, i) => ({ name: `f${i}`, size: 1 }));
  const r = checkUploadSize(files);
  assert.equal(r.ok, false);
  assert.equal(checkUploadSize(files.slice(0, 20)).ok, true);
});

test("checkUploadSize accepts an empty file list", () => {
  assert.deepEqual(checkUploadSize([]), { ok: true, totalBytes: 0 });
});

test("chunkRanges covers the file with no gaps or overlaps", () => {
  const size = 20;
  const ranges = chunkRanges(size, 8);
  assert.deepEqual(ranges, [
    { index: 0, start: 0, end: 8 },
    { index: 1, start: 8, end: 16 },
    { index: 2, start: 16, end: 20 },
  ]);
  const covered = ranges.reduce((sum, r) => sum + (r.end - r.start), 0);
  assert.equal(covered, size);
});

test("chunkRanges gives one chunk when the file fits and none for an empty file", () => {
  assert.deepEqual(chunkRanges(5, 8), [{ index: 0, start: 0, end: 5 }]);
  assert.deepEqual(chunkRanges(0, 8), []);
});

test("chunkRanges puts an exact multiple into full chunks", () => {
  const ranges = chunkRanges(16, 8);
  assert.equal(ranges.length, 2);
  assert.equal(ranges[1].end, 16);
});

test("chunkRanges rejects a non-positive chunk size", () => {
  assert.throws(() => chunkRanges(10, 0));
});

test("formatBytes picks a readable unit", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(4 * 1024), "4.0 KB");
  assert.equal(formatBytes(12.5 * MB), "12.5 MB");
});

test("withRetry returns on the first success without retrying", async () => {
  let calls = 0;
  const v = await withRetry(async () => {
    calls++;
    return "ok";
  }, { sleep: async () => {} });
  assert.equal(v, "ok");
  assert.equal(calls, 1);
});

test("withRetry retries until success and backs off exponentially", async () => {
  const waits: number[] = [];
  let calls = 0;
  const v = await withRetry(async () => {
    calls++;
    if (calls < 3) throw new Error("flaky");
    return calls;
  }, { attempts: 3, delayMs: 100, sleep: async (ms) => void waits.push(ms) });
  assert.equal(v, 3);
  assert.deepEqual(waits, [100, 200]);
});

test("withRetry throws the last error after all attempts", async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(async () => {
      calls++;
      throw new Error(`fail ${calls}`);
    }, { attempts: 2, sleep: async () => {} }),
    /fail 2/,
  );
  assert.equal(calls, 2);
});
