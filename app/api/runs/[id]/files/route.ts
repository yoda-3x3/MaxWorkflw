import { getCaller, json } from "@/lib/session";
import {
  MAX_FILES_PER_RUN,
  MAX_RUN_UPLOAD_BYTES,
  MAX_UPLOAD_BYTES,
  UPLOAD_CHUNK_BYTES,
  type RunFile,
} from "@/lib/types";
import { cleanFileName, getRunStore } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** The run's attachments, including uploads in progress. Owner-only. */
export async function GET(req: Request, { params }: Ctx) {
  const caller = await getCaller(req);
  if (!caller) return json({ error: "unauthorized" }, 401);

  const { id } = await params;
  const store = getRunStore();
  const run = await store.getRun(caller.id, id);
  if (!run) return json({ error: "not found" }, 404);
  return json({ files: await store.listRunFiles(run.id, { all: true }) });
}

/**
 * Declares an attachment and returns its id. The bytes follow as chunks of UPLOAD_CHUNK_BYTES.
 * Draft runs only, so the runner never sees a file that is still changing.
 */
export async function POST(req: Request, { params }: Ctx) {
  const caller = await getCaller(req);
  if (!caller) return json({ error: "unauthorized" }, 401);

  const { id } = await params;
  const store = getRunStore();
  const run = await store.getRun(caller.id, id);
  if (!run) return json({ error: "not found" }, 404);
  if (run.status !== "draft") return json({ error: "attachments can only be added to a draft run" }, 409);

  const body = (await req.json().catch(() => null)) as { name?: unknown; size?: unknown; chunks?: unknown } | null;
  const name = cleanFileName(body?.name);
  if (!name) return json({ error: "name must be a plain file name (letters, digits, . _ - space)" }, 400);
  const size = body?.size;
  if (typeof size !== "number" || !Number.isInteger(size) || size <= 0) {
    return json({ error: "size must be a positive integer of bytes" }, 400);
  }
  if (size > MAX_UPLOAD_BYTES) {
    return json({ error: `a file may be at most ${MAX_UPLOAD_BYTES} bytes` }, 413);
  }
  const chunks = Math.ceil(size / UPLOAD_CHUNK_BYTES);
  if (body?.chunks !== undefined && body.chunks !== chunks) {
    return json({ error: `chunks must be ${chunks} for a ${size} byte file` }, 400);
  }

  const existing = await store.listRunFiles(run.id, { all: true });
  if (existing.length >= MAX_FILES_PER_RUN) {
    return json({ error: `a run may have at most ${MAX_FILES_PER_RUN} attachments` }, 409);
  }
  const total = existing.reduce((sum, f) => sum + f.size, 0);
  if (total + size > MAX_RUN_UPLOAD_BYTES) {
    return json({ error: `attachments on one run may total at most ${MAX_RUN_UPLOAD_BYTES} bytes` }, 413);
  }

  const file: RunFile = {
    id: crypto.randomUUID(),
    runId: run.id,
    name,
    size,
    chunkBytes: UPLOAD_CHUNK_BYTES,
    chunks,
    complete: false,
    createdAt: Date.now(),
  };
  await store.createRunFile(file);
  return json(file, 201);
}
