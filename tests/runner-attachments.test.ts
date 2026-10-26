import { test } from 'node:test'
import assert from 'node:assert/strict'
import { basename, dirname, join, resolve } from 'node:path'
import {
  attachmentNote,
  isFinishedStatus,
  prepareRunAttachments,
  resolveWorkDir,
  materializeAttachments,
  uniqueName,
  type AttachmentSource,
  attachmentPath,
  AttachmentError,
  assembleBase64,
  checkDeclaredSize,
  MAX_ATTACHMENT_BYTES,
  runDirFor,
  sanitizeFileName,
  uploadsDirFor,
} from '../scripts/lib/attachments'

const CHUNK = 512 * 1024

test('sanitizeFileName keeps the base name and replaces unsafe characters', () => {
  assert.equal(sanitizeFileName('report.pdf'), 'report.pdf')
  assert.equal(sanitizeFileName('my file (1).txt'), 'my_file__1_.txt')
  assert.equal(sanitizeFileName('C:\\Users\\x\\data.csv'), 'data.csv')
  assert.equal(sanitizeFileName('../../etc/passwd'), 'passwd')
  assert.equal(sanitizeFileName('.hidden'), 'hidden')
  assert.equal(sanitizeFileName('a'.repeat(300)).length, 120)
})

test('sanitizeFileName rejects names with nothing left', () => {
  for (const bad of ['', '..', '.', '/', '...', '/..']) {
    assert.throws(() => sanitizeFileName(bad), AttachmentError, JSON.stringify(bad))
  }
})

test('attachmentPath always lands inside the run uploads folder', () => {
  const runDir = runDirFor('C:/work', 'run-1')
  const uploads = uploadsDirFor(runDir)
  for (const name of ['a.txt', '../../escape.txt', '..\\..\\escape.txt', 'sub/dir/b.md']) {
    const p = attachmentPath(runDir, name)
    assert.ok(p.startsWith(uploads + (process.platform === 'win32' ? '\\' : '/')), p)
  }
  assert.equal(attachmentPath(runDir, 'a.txt'), join(resolve(uploads), 'a.txt'))
})

test('runDirFor nests the run id under the work dir', () => {
  assert.equal(runDirFor('C:/work', 'run-1'), join(resolve('C:/work'), 'run-1'))
})

test('checkDeclaredSize refuses negative, fractional and oversized files', () => {
  checkDeclaredSize(0)
  checkDeclaredSize(MAX_ATTACHMENT_BYTES)
  for (const bad of [-1, 1.5, MAX_ATTACHMENT_BYTES + 1, Number.NaN]) {
    assert.throws(() => checkDeclaredSize(bad), AttachmentError, String(bad))
  }
})

test('assembleBase64 joins chunks in order and checks the decoded size', () => {
  const data = Buffer.from('hello world, chunked')
  const b64 = data.toString('base64')
  const cut = Math.floor(b64.length / 2)
  // Chunks are split on a 4-character boundary so each piece decodes on its own.
  const aligned = cut - (cut % 4)
  const out = assembleBase64([b64.slice(0, aligned), b64.slice(aligned)], data.length)
  assert.equal(out.toString(), 'hello world, chunked')
})

test('assembleBase64 rejects a size mismatch instead of writing a short or long file', () => {
  const b64 = Buffer.from('abc').toString('base64')
  assert.throws(() => assembleBase64([b64], 4), /size mismatch: expected 4 bytes, got 3/)
  assert.throws(() => assembleBase64([b64], 2), /size mismatch/)
})

test('attachmentNote lists paths for the prompt and is empty with no files', () => {
  assert.equal(attachmentNote([]), '')
  const note = attachmentNote(['C:/work/run-1/uploads/a.txt'])
  assert.match(note, /read-only reference/)
  assert.match(note, /- C:\/work\/run-1\/uploads\/a\.txt/)
})

// Fake store: serves chunks from an in-memory map and records every call.
function fakeSource(files: Record<string, Buffer>, opts: { dropChunk?: string } = {}) {
  const metas = Object.keys(files).map((id) => ({ id, name: id, size: files[id].length, chunkBytes: CHUNK }))
  const reads: number[][] = []
  const deleted: string[] = []
  const source: AttachmentSource = {
    async listRunFiles() { return metas },
    async readFileChunks(_runId, fileId, indexes) {
      reads.push(indexes)
      // Each chunk is its own base64 of a raw slice, as the site stores it.
      const raw = files[fileId]
      return indexes.map((n) => (fileId === opts.dropChunk && n === 0 ? null : raw.subarray(n * CHUNK, (n + 1) * CHUNK).toString('base64')))
    },
    async deleteRunFile(_runId, fileId) { deleted.push(fileId) },
  }
  return { source, reads, deleted }
}

function fakeDeps(source: AttachmentSource) {
  const written = new Map<string, Buffer>()
  return {
    written,
    deps: {
      source,
      mkdir: async () => {},
      writeFile: async (path: string, data: Buffer) => { written.set(path, data) },
    },
  }
}

test('uniqueName suffixes duplicates and keeps the extension', () => {
  const used = new Set<string>()
  const names = ['a.txt', 'a.txt', 'a.txt', 'noext', 'noext']
  const out = names.map((n) => { const u = uniqueName(n, used); used.add(u); return u })
  assert.deepEqual(out, ['a.txt', 'a-2.txt', 'a-3.txt', 'noext', 'noext-2'])
})

test('materializeAttachments reassembles files, batches reads, then deletes the chunks', async () => {
  const big = Buffer.alloc(CHUNK * 2 + 100, 7)
  const small = Buffer.from('small file')
  const { source, reads, deleted } = fakeSource({ big, small })
  const { deps, written } = fakeDeps(source)
  const runDir = runDirFor('C:/work', 'run-1')
  const paths = await materializeAttachments('run-1', runDir, deps)
  assert.equal(paths.length, 2)
  assert.deepEqual(written.get(paths[0]), big)
  assert.deepEqual(written.get(paths[1]), small)
  assert.deepEqual(reads[0], [0, 1, 2])
  assert.deepEqual(deleted, ['big', 'small'])
})

test('materializeAttachments refuses a missing chunk and keeps chunks for a retry', async () => {
  const { source, deleted } = fakeSource({ f: Buffer.alloc(CHUNK + 5, 1) }, { dropChunk: 'f' })
  const { deps } = fakeDeps(source)
  await assert.rejects(materializeAttachments('run-1', runDirFor('C:/work', 'run-1'), deps), /chunk 0 of attachment f is missing/)
  assert.deepEqual(deleted, [])
})

test('materializeAttachments refuses a total over the limit before reading anything', async () => {
  const reads: number[][] = []
  const source: AttachmentSource = {
    async listRunFiles() { return [{ id: 'a', name: 'a', size: MAX_ATTACHMENT_BYTES, chunkBytes: CHUNK }, { id: 'b', name: 'b', size: 1, chunkBytes: CHUNK }] },
    async readFileChunks(_r, _f, indexes) { reads.push(indexes); return [] },
    async deleteRunFile() {},
  }
  const { deps } = fakeDeps(source)
  await assert.rejects(materializeAttachments('run-1', runDirFor('C:/work', 'run-1'), deps), /over the/)
  assert.equal(reads.length, 0)
})

test('materializeAttachments keeps two files with the same name', async () => {
  const { source } = fakeSource({ x: Buffer.from('1') })
  const same = { ...source, async listRunFiles() { return [{ id: 'x', name: 'a.txt', size: 1, chunkBytes: CHUNK }, { id: 'x2', name: 'a.txt', size: 1, chunkBytes: CHUNK }] }, async readFileChunks(_r: string, f: string) { return [Buffer.from(f === 'x' ? '1' : '2').toString('base64')] } }
  const { deps, written } = fakeDeps(same)
  const paths = await materializeAttachments('run-1', runDirFor('C:/work', 'run-1'), deps)
  assert.equal(new Set(paths).size, 2)
  assert.equal(written.size, 2)
})

test('assembleBase64 decodes padded middle chunks correctly', () => {
  const a = Buffer.from([1, 2, 3, 4])
  const b = Buffer.from([5, 6])
  const out = assembleBase64([a.toString('base64'), b.toString('base64')], 6)
  assert.deepEqual(out, Buffer.from([1, 2, 3, 4, 5, 6]))
})

// Fake disk: a map of path to bytes, with readdir over its keys.
function fakeFs(disk: Map<string, Buffer>) {
  return {
    async mkdir() {},
    async writeFile(path: string, data: Buffer) { disk.set(path, data) },
    async readdir(dir: string) {
      return [...disk.keys()].filter((k) => dirname(k) === dir).map((k) => basename(k))
    },
  }
}

test('prepareRunAttachments writes the files, deletes chunks, and lists the uploads', async () => {
  const { source, deleted } = fakeSource({ doc: Buffer.from('hello doc') })
  const disk = new Map<string, Buffer>()
  const prepared = await prepareRunAttachments('run-1', 'C:/work', source, fakeFs(disk))
  assert.equal(prepared.paths.length, 1)
  assert.equal(disk.get(prepared.paths[0])?.toString(), 'hello doc')
  assert.deepEqual(deleted, ['doc'])
})

test('prepareRunAttachments on a retry finds files from an earlier claim even when no chunks remain', async () => {
  const disk = new Map<string, Buffer>()
  const source: AttachmentSource = {
    async listRunFiles() { return [] },
    async readFileChunks() { return [] },
    async deleteRunFile() {},
  }
  const earlier = attachmentPath(runDirFor('C:/work', 'run-1'), 'kept.txt')
  disk.set(earlier, Buffer.from('from before'))
  const prepared = await prepareRunAttachments('run-1', 'C:/work', source, fakeFs(disk))
  assert.deepEqual(prepared.paths, [earlier])
})

test('resolveWorkDir prefers RUNNER_WORK_DIR, then LOCALAPPDATA, then the home folder', () => {
  assert.equal(resolveWorkDir({ RUNNER_WORK_DIR: 'D:/runs' }, 'C:/home'), resolve('D:/runs'))
  assert.equal(resolveWorkDir({ LOCALAPPDATA: 'C:/Users/x/AppData/Local' }, 'C:/home'), join('C:/Users/x/AppData/Local', 'workflwpro', 'runs'))
  assert.equal(resolveWorkDir({}, 'C:/home'), join('C:/home', 'workflwpro', 'runs'))
})

test('isFinishedStatus is true only for done and failed', () => {
  assert.equal(isFinishedStatus('done'), true)
  assert.equal(isFinishedStatus('failed'), true)
  for (const s of ['draft', 'queued', 'planning', 'running']) assert.equal(isFinishedStatus(s), false, s)
})
