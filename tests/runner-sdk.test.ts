import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agentEnv, createSdkLlm, parseApproval, summarizeMessages, usageLimitFrom, type AgentMessage } from '../scripts/lib/sdk-llm'

const ok = (result: string, input = 10, output = 5): AgentMessage => ({
  type: 'result',
  subtype: 'success',
  result,
  usage: { input_tokens: input, output_tokens: output },
})

test('summarizeMessages takes the last result and its usage', () => {
  const out = summarizeMessages([{ type: 'assistant' }, ok('done', 7, 3)])
  assert.deepEqual(out, { text: 'done', usage: { input: 7, output: 3 } })
})

test('summarizeMessages reports a stream with no result as an error value, not a throw', () => {
  assert.equal(summarizeMessages([{ type: 'assistant' }]).error, 'agent produced no result')
})

test('summarizeMessages marks error results and max-turn stops as errors', () => {
  const max = summarizeMessages([{ type: 'result', subtype: 'error_max_turns', result: 'partial' }])
  assert.equal(max.error, 'agent stopped: error_max_turns')
  assert.equal(max.text, 'partial')
  assert.match(summarizeMessages([{ type: 'result', is_error: true }]).error ?? '', /agent stopped/)
})

test('parseApproval finds an APPROVAL_REQUEST line and ignores other text', () => {
  assert.deepEqual(parseApproval('work\nAPPROVAL_REQUEST rule=2: deploy to prod?\nmore'), {
    rule: 2,
    request: 'deploy to prod?',
  })
  assert.equal(parseApproval('all good'), undefined)
  assert.equal(parseApproval('APPROVAL_REQUEST rule=9: nope'), undefined)
})

test('agentEnv passes only allowlisted variables', () => {
  const env = agentEnv({
    PATH: '/bin',
    CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
    UPSTASH_REDIS_REST_TOKEN: 'secret',
    GITHUB_TOKEN: 'secret',
    ANTHROPIC_API_KEY: 'sk-ant',
    EMPTY: '',
  })
  assert.deepEqual(env, { PATH: '/bin', CLAUDE_CODE_OAUTH_TOKEN: 'oauth' })
})

test('complete returns text and usage from the stream with no tools', async () => {
  let seen: { prompt: string; options: Record<string, unknown> } | undefined
  const llm = createSdkLlm({
    env: { CLAUDE_CODE_OAUTH_TOKEN: 'oauth' },
    queryFn: ({ prompt, options }) => {
      seen = { prompt, options }
      return (async function* () { yield ok('hi', 3, 2) })()
    },
  })
  const res = await llm.complete({ model: 'claude-haiku-5-5', system: 'sys', prompt: 'say hi' })
  assert.deepEqual(res, { text: 'hi', usage: { input: 3, output: 2 } })
  assert.equal(seen?.prompt, 'say hi')
  assert.deepEqual(seen?.options.allowedTools, [])
  assert.equal(seen?.options.model, 'claude-haiku-5-5')
  assert.deepEqual(seen?.options.env, { CLAUDE_CODE_OAUTH_TOKEN: 'oauth' })
})

test('work attaches a parsed approval and passes the work tool allowlist', async () => {
  let options: Record<string, unknown> = {}
  const llm = createSdkLlm({
    env: {},
    queryFn: ({ options: o }) => {
      options = o
      return (async function* () { yield ok('APPROVAL_REQUEST rule=3: push?') })()
    },
  })
  const res = await llm.work({ model: 'm', prompt: 'p', cwd: '/tmp/x', maxTurns: 4 })
  assert.deepEqual(res.approval, { rule: 3, request: 'push?' })
  assert.equal(options.cwd, '/tmp/x')
  assert.equal(options.maxTurns, 4)
  assert.ok((options.allowedTools as string[]).includes('Edit'))
  assert.ok((options.disallowedTools as string[]).some((p) => p.startsWith('Bash(git push')))
})

test('complete throws when the agent errors, so the engine records a failure', async () => {
  const llm = createSdkLlm({
    env: {},
    queryFn: () => (async function* () { throw new Error('spawn claude ENOENT') })(),
  })
  await assert.rejects(llm.complete({ model: 'm', prompt: 'p' }), /ENOENT/)
})

test('work tells the agent about attachments and grants read access to their folder', async () => {
  let options: Record<string, unknown> = {}
  const llm = createSdkLlm({
    env: {},
    attachmentsDir: 'C:/work/run-1/uploads',
    attachmentPaths: ['C:/work/run-1/uploads/a.txt'],
    queryFn: ({ options: o }) => {
      options = o
      return (async function* () { yield ok('done') })()
    },
  })
  await llm.work({ model: 'm', prompt: 'p', system: 'base rules' })
  assert.match(String(options.systemPrompt), /^base rules\n\nFiles attached/)
  assert.match(String(options.systemPrompt), /- C:\/work\/run-1\/uploads\/a\.txt/)
  assert.deepEqual(options.additionalDirectories, ['C:/work/run-1/uploads'])
})

test('work without attachments leaves the system prompt and directories unchanged', async () => {
  let options: Record<string, unknown> = {}
  const llm = createSdkLlm({
    env: {},
    queryFn: ({ options: o }) => {
      options = o
      return (async function* () { yield ok('done') })()
    },
  })
  await llm.work({ model: 'm', prompt: 'p', system: 'base rules' })
  assert.equal(options.systemPrompt, 'base rules')
  assert.deepEqual(options.additionalDirectories, [])
})

test('usageLimitFrom maps rate_limit_info and skips entries without a type', () => {
  assert.deepEqual(usageLimitFrom({ rateLimitType: 'five_hour', status: 'allowed', utilization: 0.4, resetsAt: 123 }, 9), {
    type: 'five_hour', status: 'allowed', utilization: 0.4, resetsAt: 123, updatedAt: 9,
  })
  assert.deepEqual(usageLimitFrom({ rateLimitType: 'seven_day' }, 9), { type: 'seven_day', status: 'unknown', updatedAt: 9 })
  assert.equal(usageLimitFrom({ status: 'allowed' }), null)
})

test('the work loop reports rate_limit_event to onRateLimit', async () => {
  const seen: Record<string, unknown>[] = []
  const llm = createSdkLlm({
    env: {},
    onRateLimit: (info) => seen.push(info),
    queryFn: async function* () {
      yield { type: 'rate_limit_event', rate_limit_info: { rateLimitType: 'seven_day', utilization: 0.88 } }
      yield { type: 'result', subtype: 'success', result: 'done', usage: { input_tokens: 1, output_tokens: 1 } }
    } as never,
  })
  const r = await llm.complete({ model: 'm', system: 's', prompt: 'p' } as never)
  assert.equal(r.text, 'done')
  assert.deepEqual(seen, [{ rateLimitType: 'seven_day', utilization: 0.88 }])
})
