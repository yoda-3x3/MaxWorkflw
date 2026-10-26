import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'
import {
  attachmentNote,
  attachmentPath,
  AttachmentError,
  assembleBase64,
  checkDeclaredSize,
  MAX_ATTACHMENT_BYTES,
  runDirFor,
  sanitizeFileName,
  uploadsDirFor,
} from '../scripts/lib/attachments'

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
