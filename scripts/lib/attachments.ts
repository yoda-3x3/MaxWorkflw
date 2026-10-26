// Run attachments on the PC: safe file names, contained paths, and size-checked reassembly.
// Pure, so every rule can be tested without touching the disk or Upstash.
import { isAbsolute, join, relative, resolve } from 'node:path'

// Per-file and per-run limit. Matches the upload limit on the site.
export const MAX_ATTACHMENT_BYTES = 90 * 1024 * 1024
const MAX_NAME_LENGTH = 120

export class AttachmentError extends Error {}

// Keeps only the base name, replaces anything outside a safe set, and rejects names that
// would resolve to a directory. Nothing a client sends can escape the uploads folder.
export function sanitizeFileName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? ''
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '').slice(0, MAX_NAME_LENGTH)
  if (cleaned === '' || cleaned === '.' || cleaned === '..') throw new AttachmentError('file name is empty after sanitizing')
  return cleaned
}

// Run folder under the work dir: <workDir>/<runId>. runId is already validated by the caller.
export function runDirFor(workDir: string, runId: string): string {
  return join(resolve(workDir), runId)
}

// Uploads folder for a run: <runDir>/uploads.
export function uploadsDirFor(runDir: string): string {
  return join(resolve(runDir), 'uploads')
}

// Final path for one attachment. Throws if the result would land outside the uploads folder.
export function attachmentPath(runDir: string, rawName: string): string {
  const uploads = uploadsDirFor(runDir)
  const target = resolve(uploads, sanitizeFileName(rawName))
  const rel = relative(uploads, target)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) throw new AttachmentError('attachment path escapes uploads folder')
  return target
}

// Checks the declared size before anything is fetched: a missing or oversized file is refused up front.
export function checkDeclaredSize(size: number): void {
  if (!Number.isSafeInteger(size) || size < 0) throw new AttachmentError('attachment size is invalid')
  if (size > MAX_ATTACHMENT_BYTES) throw new AttachmentError(`attachment exceeds ${MAX_ATTACHMENT_BYTES} bytes`)
}

// Joins base64 chunks in order and checks the decoded length against the declared size.
// A short or long file is an error, never silently written.
export function assembleBase64(chunks: string[], expectedBytes: number): Buffer {
  checkDeclaredSize(expectedBytes)
  const buf = Buffer.from(chunks.join(''), 'base64')
  if (buf.length !== expectedBytes) {
    throw new AttachmentError(`attachment size mismatch: expected ${expectedBytes} bytes, got ${buf.length}`)
  }
  return buf
}

// Chunk size on the site side. Chunk n is this size except the last one.
export const CHUNK_BYTES = 512 * 1024
// Chunks fetched per Upstash pipeline call, so one request never carries more than this.
const READ_BATCH = 64

export interface AttachmentMeta {
  id: string
  name: string
  size: number
}

// Read side of the site's file store. Chunks come back base64, null when missing.
export interface AttachmentSource {
  listRunFiles(runId: string): Promise<AttachmentMeta[]>
  readFileChunks(runId: string, fileId: string, indexes: number[]): Promise<(string | null)[]>
  deleteRunFile(runId: string, fileId: string): Promise<void>
}

export interface MaterializeDeps {
  source: AttachmentSource
  mkdir(dir: string): Promise<void>
  writeFile(path: string, data: Buffer): Promise<void>
}

// Pure: a name that is not already used in this run, so two files sharing a name both survive.
export function uniqueName(name: string, used: Set<string>): string {
  if (!used.has(name)) return name
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  for (let i = 2; ; i++) {
    const candidate = `${stem}-${i}${ext}`
    if (!used.has(candidate)) return candidate
  }
}

// Downloads, verifies and writes every attachment of a run, then deletes its chunks.
// Chunks are deleted only after every file is written, so a failure can be retried within the 24 h TTL.
export async function materializeAttachments(runId: string, runDir: string, deps: MaterializeDeps): Promise<string[]> {
  const files = await deps.source.listRunFiles(runId)
  if (files.length === 0) return []
  const total = files.reduce((sum, f) => sum + f.size, 0)
  if (total > MAX_ATTACHMENT_BYTES) throw new AttachmentError(`attachments total ${total} bytes, over the ${MAX_ATTACHMENT_BYTES} limit`)

  const uploads = uploadsDirFor(runDir)
  await deps.mkdir(uploads)
  const used = new Set<string>()
  const written: string[] = []

  for (const file of files) {
    checkDeclaredSize(file.size)
    const path = attachmentPath(runDir, uniqueName(sanitizeFileName(file.name), used))
    used.add(sanitizeFileName(file.name))
    const count = Math.ceil(file.size / CHUNK_BYTES)
    const chunks: string[] = []
    for (let from = 0; from < count; from += READ_BATCH) {
      const indexes = Array.from({ length: Math.min(READ_BATCH, count - from) }, (_, i) => from + i)
      const got = await deps.source.readFileChunks(runId, file.id, indexes)
      got.forEach((c, i) => {
        if (c === null) throw new AttachmentError(`chunk ${indexes[i]} of attachment ${file.id} is missing`)
      })
      chunks.push(...(got as string[]))
    }
    await deps.writeFile(path, assembleBase64(chunks, file.size))
    written.push(path)
  }

  for (const file of files) await deps.source.deleteRunFile(runId, file.id)
  return written
}

// One line per file, for the agent's prompt context. Paths are absolute so the agent can open them directly.
export function attachmentNote(paths: string[]): string {
  if (paths.length === 0) return ''
  return ['Files attached to this run (read-only reference, do not modify):', ...paths.map((p) => `- ${p}`)].join('\n')
}
