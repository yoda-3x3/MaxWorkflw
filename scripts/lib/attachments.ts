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

// One line per file, for the agent's prompt context. Paths are absolute so the agent can open them directly.
export function attachmentNote(paths: string[]): string {
  if (paths.length === 0) return ''
  return ['Files attached to this run (read-only reference, do not modify):', ...paths.map((p) => `- ${p}`)].join('\n')
}
