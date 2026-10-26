import { getCaller, json } from "@/lib/session";
import { bytesToBase64, getRunStore } from "@/lib/store";
import { UPLOAD_CHUNK_BYTES } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; fileId: string; n: string }> };

/**
 * Stores chunk n of an attachment. The body is raw bytes (application/octet-stream). Every chunk
 * is UPLOAD_CHUNK_BYTES except the last, which is the remainder of the file. Draft runs only.
 */
export async function PUT(req: Request, { params }: Ctx) {
  const caller = await getCaller(req);
  if (!caller) return json({ error: "unauthorized" }, 401);

  const { id, fileId, n: rawN } = await params;
  const store = getRunStore();
  const run = await store.getRun(caller.id, id);
  if (!run) return json({ error: "not found" }, 404);
  if (run.status !== "draft") return json({ error: "attachments can only be uploaded to a draft run" }, 409);

  const file = await store.getRunFile(run.id, fileId);
  if (!file) return json({ error: "not found" }, 404);
  if (file.complete) return json({ error: "file is already complete" }, 409);

  const n = Number(rawN);
  if (!Number.isInteger(n) || n < 0 || n >= file.chunks) {
    return json({ error: `chunk index must be between 0 and ${file.chunks - 1}` }, 400);
  }

  // Reject oversize bodies before reading them.
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > UPLOAD_CHUNK_BYTES) return json({ error: "chunk is larger than the chunk size" }, 413);

  const bytes = new Uint8Array(await req.arrayBuffer());
  const expected = n === file.chunks - 1 ? file.size - n * file.chunkBytes : file.chunkBytes;
  if (bytes.length !== expected) return json({ error: `chunk ${n} must be ${expected} bytes` }, 400);

  await store.putFileChunk(run.id, fileId, n, bytesToBase64(bytes));
  return new Response(null, { status: 204 });
}
