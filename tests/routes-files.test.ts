import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createSession, SESSION_COOKIE } from "@/lib/auth";
import { base64ToBytes, cleanFileName, getRunStore } from "@/lib/store";
import {
  MAX_FILES_PER_RUN,
  MAX_RUN_UPLOAD_BYTES,
  MAX_UPLOAD_BYTES,
  UPLOAD_CHUNK_BYTES,
  type Run,
} from "@/lib/types";
import { GET as listFiles, POST as createFile } from "@/app/api/runs/[id]/files/route";
import { DELETE as deleteFile } from "@/app/api/runs/[id]/files/[fileId]/route";
import { POST as completeFile } from "@/app/api/runs/[id]/files/[fileId]/complete/route";
import { PUT as putChunk } from "@/app/api/runs/[id]/files/[fileId]/chunks/[n]/route";

const SECRET = "test-session-secret-0123456789abcdef";
const aliceId = "github:alice";

let saved: Record<string, string | undefined>;

beforeEach(async () => {
  // getRunStore() caches one in-memory store on globalThis. Drop it so each test starts empty.
  delete (globalThis as Record<string, unknown>).__workflwproRunStore;
  saved = { SESSION_SECRET: process.env.SESSION_SECRET, ALLOWED_USERS: process.env.ALLOWED_USERS };
  process.env.SESSION_SECRET = SECRET;
  process.env.ALLOWED_USERS = "alice,bob";
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

async function cookieFor(login: string) {
  return `${SESSION_COOKIE}=${await createSession({ method: "github", login }, SECRET)}`;
}

async function draft(status: Run["status"] = "draft"): Promise<string> {
  const id = `run-${Math.random().toString(36).slice(2)}`;
  await getRunStore().saveRun({
    id,
    ownerId: aliceId,
    task: "t",
    status,
    tokens: 0,
    agents: [],
    approvals: [],
    events: [],
    createdAt: 1,
    updatedAt: 1,
    deadlineAt: 2,
  });
  return id;
}

function req(method: string, url: string, cookie: string | undefined, body?: BodyInit | unknown, raw = false): Request {
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = cookie;
  let payload: BodyInit | undefined;
  if (raw) {
    headers["content-type"] = "application/octet-stream";
    payload = body as BodyInit;
  } else if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  return new Request(url, { method, headers, body: payload });
}

const ctx = (id: string, fileId?: string, n?: string) => ({
  params: Promise.resolve({ id, fileId: fileId ?? "", n: n ?? "" }),
});

const filesUrl = (id: string) => `https://app.test/api/runs/${id}/files`;

async function declare(runId: string, body: unknown, cookie?: string) {
  return createFile(req("POST", filesUrl(runId), cookie ?? (await cookieFor("alice")), body), {
    params: Promise.resolve({ id: runId }),
  });
}

describe("cleanFileName", () => {
  test("keeps plain names and rejects paths and traversal", () => {
    assert.equal(cleanFileName("  notes v2.pdf "), "notes v2.pdf");
    assert.equal(cleanFileName("../etc/passwd"), null);
    assert.equal(cleanFileName("a/b.txt"), null);
    assert.equal(cleanFileName("a\\b.txt"), null);
    assert.equal(cleanFileName(".env"), null);
    assert.equal(cleanFileName("x..y"), null);
    assert.equal(cleanFileName(""), null);
    assert.equal(cleanFileName(42), null);
  });
});

describe("declaring an attachment", () => {
  test("a draft owner declares a file and gets its metadata back", async () => {
    const runId = await draft();
    const res = await declare(runId, { name: "data.bin", size: UPLOAD_CHUNK_BYTES + 10 });
    assert.equal(res.status, 201);
    const file = (await res.json()) as Record<string, unknown>;
    assert.equal(file.name, "data.bin");
    assert.equal(file.size, UPLOAD_CHUNK_BYTES + 10);
    assert.equal(file.chunkBytes, UPLOAD_CHUNK_BYTES);
    assert.equal(file.chunks, 2);
    assert.equal(file.complete, false);
    assert.equal(file.runId, runId);
    assert.equal(typeof file.id, "string");
  });

  test("a bad name, size, or declared chunk count is rejected", async () => {
    const runId = await draft();
    assert.equal((await declare(runId, { name: "../x", size: 5 })).status, 400);
    assert.equal((await declare(runId, { name: "x", size: 0 })).status, 400);
    assert.equal((await declare(runId, { name: "x", size: 1.5 })).status, 400);
    assert.equal((await declare(runId, { name: "x", size: 5, chunks: 3 })).status, 400);
  });

  test("a file over the per-file limit gets 413", async () => {
    const runId = await draft();
    assert.equal((await declare(runId, { name: "big", size: MAX_UPLOAD_BYTES + 1 })).status, 413);
  });

  test("a run total over the limit gets 413", async () => {
    const runId = await draft();
    const store = getRunStore();
    await store.createRunFile({
      id: "f-old", runId, name: "old", size: MAX_RUN_UPLOAD_BYTES - 10, chunkBytes: UPLOAD_CHUNK_BYTES,
      chunks: 1, complete: true, createdAt: 1,
    });
    assert.equal((await declare(runId, { name: "more", size: 11 })).status, 413);
    assert.equal((await declare(runId, { name: "fits", size: 10 })).status, 201);
  });

  test("more than MAX_FILES_PER_RUN attachments gets 409", async () => {
    const runId = await draft();
    for (let i = 0; i < MAX_FILES_PER_RUN; i++) {
      await getRunStore().createRunFile({
        id: `f-${i}`, runId, name: `f${i}`, size: 1, chunkBytes: UPLOAD_CHUNK_BYTES, chunks: 1, complete: true, createdAt: i,
      });
    }
    assert.equal((await declare(runId, { name: "one-more", size: 1 })).status, 409);
  });

  test("declaring on a queued run gets 409", async () => {
    const runId = await draft("queued");
    assert.equal((await declare(runId, { name: "x", size: 1 })).status, 409);
  });

  test("another user cannot declare on the run", async () => {
    const runId = await draft();
    assert.equal((await declare(runId, { name: "x", size: 1 }, await cookieFor("bob"))).status, 404);
  });
});

describe("uploading chunks", () => {
  const bytes = (n: number, fill: number) => new Uint8Array(n).fill(fill);

  async function declared(size: number) {
    const runId = await draft();
    const file = (await (await declare(runId, { name: "f.bin", size })).json()) as { id: string; chunks: number };
    return { runId, fileId: file.id, chunks: file.chunks };
  }

  test("stores chunks, rejects wrong sizes and indexes, and completes once all are present", async () => {
    const size = UPLOAD_CHUNK_BYTES + 100;
    const { runId, fileId } = await declared(size);
    const cookie = await cookieFor("alice");
    const put = (n: string, data: Uint8Array) =>
      putChunk(req("PUT", `${filesUrl(runId)}/${fileId}/chunks/${n}`, cookie, data, true), ctx(runId, fileId, n));

    assert.equal((await put("0", bytes(UPLOAD_CHUNK_BYTES - 1, 1))).status, 400, "short non-final chunk");
    assert.equal((await put("0", bytes(UPLOAD_CHUNK_BYTES, 1))).status, 204);
    assert.equal((await put("1", bytes(99, 2))).status, 400, "final chunk must be the remainder");
    assert.equal((await put("2", bytes(100, 2))).status, 400, "index past the end");
    assert.equal((await put("-1", bytes(100, 2))).status, 400);
    assert.equal((await put("1", bytes(100, 2))).status, 204);

    const incomplete = await completeFile(req("POST", "https://app.test/x", cookie), { params: Promise.resolve({ id: runId, fileId }) });
    assert.equal(incomplete.status, 200);
    assert.equal(((await incomplete.json()) as { complete: boolean }).complete, true);

    const again = await put("0", bytes(UPLOAD_CHUNK_BYTES, 9));
    assert.equal(again.status, 409, "a complete file takes no more chunks");
  });

  test("complete reports the missing count while chunks are absent", async () => {
    const { runId, fileId } = await declared(UPLOAD_CHUNK_BYTES * 2);
    const cookie = await cookieFor("alice");
    await putChunk(req("PUT", "https://app.test/x", cookie, bytes(UPLOAD_CHUNK_BYTES, 3), true), ctx(runId, fileId, "0"));

    const res = await completeFile(req("POST", "https://app.test/x", cookie), { params: Promise.resolve({ id: runId, fileId }) });
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), { error: "chunks are missing", missing: 1 });
  });

  test("the stored chunks read back byte for byte", async () => {
    const { runId, fileId } = await declared(UPLOAD_CHUNK_BYTES + 3);
    const cookie = await cookieFor("alice");
    const first = bytes(UPLOAD_CHUNK_BYTES, 7);
    const last = Uint8Array.from([1, 2, 3]);
    await putChunk(req("PUT", "https://app.test/x", cookie, first, true), ctx(runId, fileId, "0"));
    await putChunk(req("PUT", "https://app.test/x", cookie, last, true), ctx(runId, fileId, "1"));
    await completeFile(req("POST", "https://app.test/x", cookie), { params: Promise.resolve({ id: runId, fileId }) });

    const [a, b] = await getRunStore().readFileChunks(runId, fileId, [0, 1]);
    assert.deepEqual(base64ToBytes(a!), first);
    assert.deepEqual(base64ToBytes(b!), last);
    assert.deepEqual(await getRunStore().readFileChunks(runId, fileId, [5]), [null]);
  });

  test("a chunk for a file that is not the caller's run gets 404", async () => {
    const { runId, fileId } = await declared(10);
    const res = await putChunk(
      req("PUT", "https://app.test/x", await cookieFor("bob"), bytes(10, 1), true),
      ctx(runId, fileId, "0"),
    );
    assert.equal(res.status, 404);
  });
});

describe("listing and deleting", () => {
  test("the owner's list includes uploads in progress, oldest first", async () => {
    const runId = await draft();
    const cookie = await cookieFor("alice");
    await declare(runId, { name: "first", size: 1 });
    await declare(runId, { name: "second", size: 1 });
    const body = (await (await listFiles(req("GET", filesUrl(runId), cookie), { params: Promise.resolve({ id: runId }) })).json()) as {
      files: { name: string; complete: boolean }[];
    };
    assert.deepEqual(body.files.map((f) => f.name), ["first", "second"]);
    assert.deepEqual(body.files.map((f) => f.complete), [false, false]);
  });

  test("the runner's listRunFiles returns only complete files", async () => {
    const runId = await draft();
    const store = getRunStore();
    await store.createRunFile({ id: "done", runId, name: "done", size: 1, chunkBytes: UPLOAD_CHUNK_BYTES, chunks: 1, complete: true, createdAt: 1 });
    await store.createRunFile({ id: "wip", runId, name: "wip", size: 1, chunkBytes: UPLOAD_CHUNK_BYTES, chunks: 1, complete: false, createdAt: 2 });
    assert.deepEqual((await store.listRunFiles(runId)).map((f) => f.id), ["done"]);
    assert.deepEqual((await store.listRunFiles(runId, { all: true })).map((f) => f.id), ["done", "wip"]);
  });

  test("delete removes the file and its chunks, and only on a draft", async () => {
    const runId = await draft();
    const cookie = await cookieFor("alice");
    const file = (await (await declare(runId, { name: "gone", size: 3 })).json()) as { id: string };
    await putChunk(req("PUT", "https://app.test/x", cookie, Uint8Array.from([1, 2, 3]), true), ctx(runId, file.id, "0"));

    const del = await deleteFile(req("DELETE", "https://app.test/x", cookie), { params: Promise.resolve({ id: runId, fileId: file.id }) });
    assert.equal(del.status, 204);
    assert.equal(await getRunStore().getRunFile(runId, file.id), null);
    assert.deepEqual(await getRunStore().readFileChunks(runId, file.id, [0]), [null]);

    const again = await deleteFile(req("DELETE", "https://app.test/x", cookie), { params: Promise.resolve({ id: runId, fileId: file.id }) });
    assert.equal(again.status, 404);
  });

  test("delete on a queued run gets 409", async () => {
    const runId = await draft();
    const cookie = await cookieFor("alice");
    const file = (await (await declare(runId, { name: "x", size: 1 })).json()) as { id: string };
    await getRunStore().saveRun({ ...(await getRunStore().getRunForEngine(runId))!, status: "queued" });
    const res = await deleteFile(req("DELETE", "https://app.test/x", cookie), { params: Promise.resolve({ id: runId, fileId: file.id }) });
    assert.equal(res.status, 409);
  });
});
