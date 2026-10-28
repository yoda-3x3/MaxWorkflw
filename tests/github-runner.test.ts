import { test } from 'node:test'
import assert from 'node:assert/strict'
import { remoteHasBranch } from '../scripts/lib/git'
import { parseGhToken, GhAuthError } from '../scripts/lib/gh'

test('remoteHasBranch matches only the exact refs/heads line', () => {
  assert.equal(remoteHasBranch('abc123\trefs/heads/workflwpro/r1\n', 'workflwpro/r1'), true)
  assert.equal(remoteHasBranch('abc123\trefs/heads/workflwpro/r1', 'workflwpro/r1'), true)
  // ls-remote matches by suffix, so these must not count as the run's branch.
  assert.equal(remoteHasBranch('abc123\trefs/heads/feature/workflwpro/r1\n', 'workflwpro/r1'), false)
  assert.equal(remoteHasBranch('abc123\trefs/heads/workflwpro/r10\n', 'workflwpro/r1'), false)
  assert.equal(remoteHasBranch('', 'workflwpro/r1'), false)
  assert.equal(remoteHasBranch('abc123\trefs/heads/main\n', 'workflwpro/r1'), false)
})

test('remoteHasBranch finds the branch among several lines', () => {
  const out = 'a1\trefs/heads/main\nb2\trefs/heads/workflwpro/r1\nc3\trefs/heads/x/workflwpro/r1\n'
  assert.equal(remoteHasBranch(out, 'workflwpro/r1'), true)
})

test('parseGhToken accepts a gh token and trims whitespace', () => {
  assert.equal(parseGhToken('gho_abcdefghij1234\n'), 'gho_abcdefghij1234')
  assert.equal(parseGhToken('github_pat_11ABCDEFG_xyz\n'), 'github_pat_11ABCDEFG_xyz')
})

test('parseGhToken rejects empty or implausible output', () => {
  for (const bad of ['', '\n', 'short', 'not a token!', 'error: not logged in']) {
    assert.throws(() => parseGhToken(bad), GhAuthError, JSON.stringify(bad))
  }
})
