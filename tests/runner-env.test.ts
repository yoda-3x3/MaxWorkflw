import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mergeEnv, missingEnv, parseEnvText, stripApiKey, validRunId } from '../scripts/lib/env'

test('parseEnvText reads KEY=value lines, comments, export prefix and quotes', () => {
  const text = [
    '# comment',
    '',
    'CLAUDE_CODE_OAUTH_TOKEN=abc123',
    'export UPSTASH_REDIS_REST_URL="https://x.upstash.io"',
    "UPSTASH_REDIS_REST_TOKEN='tok=with=equals'",
    'bad line without equals',
    '1BAD=nope',
    'SPACED = value ',
  ].join('\r\n')
  assert.deepEqual(parseEnvText(text), {
    CLAUDE_CODE_OAUTH_TOKEN: 'abc123',
    UPSTASH_REDIS_REST_URL: 'https://x.upstash.io',
    UPSTASH_REDIS_REST_TOKEN: 'tok=with=equals',
    SPACED: 'value',
  })
})

test('mergeEnv lets non-empty process env override file values, but not empty ones', () => {
  const merged = mergeEnv(
    { A: 'file', B: 'file', C: 'file' },
    { A: 'proc', B: '', C: undefined },
  )
  assert.equal(merged.A, 'proc')
  assert.equal(merged.B, 'file')
  assert.equal(merged.C, 'file')
})

test('stripApiKey removes ANTHROPIC_API_KEY and reports it without the value', () => {
  const env: Record<string, string | undefined> = { ANTHROPIC_API_KEY: 'sk-ant-secret', OTHER: 'x' }
  assert.deepEqual(stripApiKey(env), { removed: true })
  assert.equal('ANTHROPIC_API_KEY' in env, false)
  assert.equal(env.OTHER, 'x')
  assert.deepEqual(stripApiKey({}), { removed: false })
})

test('missingEnv names missing runner variables and never values', () => {
  const env = { CLAUDE_CODE_OAUTH_TOKEN: 'secret-value', UPSTASH_REDIS_REST_URL: '', UPSTASH_REDIS_REST_TOKEN: undefined }
  assert.deepEqual(missingEnv(env), ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'])
  assert.deepEqual(
    missingEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'a', UPSTASH_REDIS_REST_URL: 'u', UPSTASH_REDIS_REST_TOKEN: 't' }),
    [],
  )
})

test('validRunId accepts the store id charset only', () => {
  assert.equal(validRunId('abc-DEF_1'), true)
  for (const bad of [undefined, '', 'a/b', 'a b', 'a'.repeat(129), '$(x)', '-lead']) {
    assert.equal(validRunId(bad), false, String(bad))
  }
})
