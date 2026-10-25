import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  basicAuthHeader,
  buildCheckoutArgs,
  buildCommitArgs,
  buildPushArgs,
  cloneUrl,
  isSecretLikePath,
  parseNameList,
  parseRepo,
  prepareWorkspace,
  splitSecretPaths,
  workspaceBranch,
  GitError,
  type Exec,
  type ExecResult,
} from '../scripts/lib/git'
import { redact } from '../scripts/lib/redact'

const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '' })
const fail = (code: number, stderr: string): ExecResult => ({ code, stdout: '', stderr })

test('parseRepo accepts owner/name and rejects anything else', () => {
  assert.deepEqual(parseRepo('acme/app.v2'), { owner: 'acme', name: 'app.v2' })
  for (const bad of ['acme', 'acme/app/extra', '-x/y', 'a b/c', 'acme/../x', '']) {
    assert.throws(() => parseRepo(bad), GitError, bad)
  }
})

test('workspaceBranch uses the workflwpro prefix and rejects unsafe run ids', () => {
  assert.equal(workspaceBranch('abc_123-x'), 'workflwpro/abc_123-x')
  for (const bad of ['', 'a/b', 'a..b', '-rm', 'x y', 'a'.repeat(129)]) {
    assert.throws(() => workspaceBranch(bad), GitError, bad)
  }
})

test('clone URL is plain https without credentials', () => {
  assert.equal(cloneUrl('acme', 'app'), 'https://github.com/acme/app.git')
})

test('auth goes in an extraheader, never in the URL', () => {
  const header = basicAuthHeader('tok')
  assert.equal(header, 'AUTHORIZATION: basic ' + Buffer.from('x-access-token:tok').toString('base64'))
  assert.ok(!cloneUrl('acme', 'app').includes('tok'))
})

test('secret-looking paths are detected by basename', () => {
  for (const p of ['.env', '.env.local', 'app/.env.production', 'certs/server.pem', 'keys/id_rsa',
    'config/secrets.json', 'aws-credentials', 'ci/client_secret.yaml', '.npmrc', 'x/.netrc']) {
    assert.equal(isSecretLikePath(p), true, p)
  }
  for (const p of ['.env.example', 'src/index.ts', 'src/secretary.ts', 'tokenizer.ts', 'id_rsa.pub', 'README.md', 'docs/keys.md']) {
    assert.equal(isSecretLikePath(p), false, p)
  }
})

test('splitSecretPaths keeps normal files and unstages the rest', () => {
  assert.deepEqual(splitSecretPaths(['a.ts', '.env', 'b/.env.local', 'c.md']), {
    keep: ['a.ts', 'c.md'],
    unstage: ['.env', 'b/.env.local'],
  })
})

test('parseNameList splits NUL-separated output', () => {
  assert.deepEqual(parseNameList('a.ts\0dir/b.ts\0'), ['a.ts', 'dir/b.ts'])
  assert.deepEqual(parseNameList(''), [])
})

test('arg builders produce plain, non-forcing commands', () => {
  assert.deepEqual(buildPushArgs(), ['push', 'origin', 'HEAD'])
  assert.deepEqual(buildCheckoutArgs('workflwpro/r1', 'origin/main'), ['checkout', '-B', 'workflwpro/r1', 'origin/main'])
  const commit = buildCommitArgs('msg here')
  assert.ok(commit.includes('user.name=WorkflwPro'))
  assert.ok(commit.includes('user.email=noreply@workflwpro.vercel.app'))
  assert.equal(commit[commit.indexOf('-m') + 1], 'msg here')
  for (const args of [buildPushArgs(), commit]) {
    assert.ok(!args.some((a) => a === '--force' || a === '-f' || a.startsWith('--force') || a === '--delete'))
  }
  assert.throws(() => buildCheckoutArgs('bad..name', 'origin/main'), GitError)
})

test('redact masks every secret value', () => {
  assert.equal(redact('token=abc and abc again', ['abc']), 'token=*** and *** again')
  assert.equal(redact('unchanged', ['']), 'unchanged')
})

// Scripted exec: each call is matched by the first arg list element that starts a known subcommand.
function scripted(handlers: Record<string, (args: string[]) => ExecResult>) {
  const calls: { args: string[]; cwd?: string; env?: Record<string, string> }[] = []
  const exec: Exec = async (args, opts) => {
    calls.push({ args, cwd: opts.cwd, env: opts.env })
    const sub = args.includes('commit') ? 'commit'
      : args.includes('clone') ? 'clone'
      : args.find((a) => Object.hasOwn(handlers, a)) ?? args[0]
    const handler = handlers[sub]
    if (!handler) throw new Error(`unexpected git call: ${args.join(' ')}`)
    return handler(args)
  }
  return { exec, calls }
}

function baseHandlers(extra: Record<string, (args: string[]) => ExecResult> = {}) {
  return {
    clone: () => ok(),
    'symbolic-ref': () => ok('origin/main\n'),
    'ls-remote': () => ok(''),
    checkout: () => ok(),
    fetch: () => ok(),
    commit: () => ok(),
    push: () => ok(),
    'rev-list': () => ok('0\n'),
    ...extra,
  }
}

test('prepareWorkspace clones, branches from the default branch, and cleans up', async () => {
  const removed: string[] = []
  const { exec, calls } = scripted(baseHandlers())
  const ws = await prepareWorkspace({
    repo: 'acme/app', runId: 'r1', token: 'SECRET', exec,
    makeTempDir: async () => '/tmp/fake-root',
    removeDir: async (d) => { removed.push(d) },
  })
  assert.equal(ws.branch, 'workflwpro/r1')
  assert.equal(ws.defaultBranch, 'main')
  assert.equal(ws.dir, join('/tmp/fake-root', 'repo'))

  const clone = calls.find((c) => c.args.includes('clone'))!
  assert.ok(clone.args.includes('https://github.com/acme/app.git'))
  assert.ok(clone.args.includes('-c'))
  assert.ok(!clone.args.join(' ').includes('SECRET'), 'token must not appear in args')
  assert.equal(clone.env?.GIT_TERMINAL_PROMPT, '0')

  const checkout = calls.find((c) => c.args.includes('checkout'))!
  assert.deepEqual(checkout.args, ['checkout', '-B', 'workflwpro/r1', 'origin/main'])

  await ws.cleanup()
  assert.deepEqual(removed, [join('/tmp/fake-root')])
})

test('prepareWorkspace reuses an existing remote branch', async () => {
  const { exec, calls } = scripted(baseHandlers({
    'ls-remote': () => ok('abc123\trefs/heads/workflwpro/r1\n'),
  }))
  await prepareWorkspace({
    repo: 'acme/app', runId: 'r1', token: 'T', exec,
    makeTempDir: async () => '/tmp/x', removeDir: async () => {},
  })
  const checkout = calls.find((c) => c.args.includes('checkout'))!
  assert.deepEqual(checkout.args, ['checkout', '-B', 'workflwpro/r1', 'origin/workflwpro/r1'])
  assert.ok(calls.some((c) => c.args.includes('fetch')))
})

test('prepareWorkspace removes the temp dir and redacts the token when clone fails', async () => {
  const removed: string[] = []
  const { exec } = scripted(baseHandlers({
    clone: () => fail(128, `fatal: could not read\nfatal: ${basicAuthHeader('TOPSECRET')}`),
  }))
  await assert.rejects(
    prepareWorkspace({
      repo: 'acme/app', runId: 'r1', token: 'TOPSECRET', exec,
      makeTempDir: async () => '/tmp/y', removeDir: async (d) => { removed.push(d) },
    }),
    (err: Error) => {
      assert.ok(err instanceof GitError)
      assert.ok(!err.message.includes('TOPSECRET'))
      return true
    },
  )
  assert.deepEqual(removed, ['/tmp/y'])
})

test('commit unstages secret-looking files and commits the rest as WorkflwPro', async () => {
  const { exec, calls } = scripted(baseHandlers({
    diff: (args) => args.includes('--quiet') ? fail(1, '') : ok('src/a.ts\0.env\0config/secrets.json\0'),
    reset: () => ok(),
    add: () => ok(),
  }))
  const ws = await prepareWorkspace({
    repo: 'acme/app', runId: 'r1', token: 'T', exec,
    makeTempDir: async () => '/tmp/z', removeDir: async () => {},
  })
  const result = await ws.commit('wave 1')
  assert.deepEqual(result, { committed: true, skipped: ['.env', 'config/secrets.json'] })

  const reset = calls.find((c) => c.args.includes('reset'))!
  assert.deepEqual(reset.args, ['reset', '-q', '--', '.env', 'config/secrets.json'])
  const commit = calls.find((c) => c.args.includes('commit'))!
  assert.ok(commit.args.includes('user.name=WorkflwPro'))
  assert.equal(commit.args[commit.args.indexOf('-m') + 1], 'wave 1')

  // Pushed right after the commit, so the commit survives a killed job.
  const commitIdx = calls.indexOf(commit)
  const pushIdx = calls.findIndex((c) => c.args.includes('push'))
  assert.ok(pushIdx > commitIdx, 'push must follow the commit')
})

test('commit pushes immediately and surfaces a rejected push', async () => {
  const { exec } = scripted(baseHandlers({
    diff: (args) => args.includes('--quiet') ? fail(1, '') : ok(''),
    add: () => ok(),
    push: () => fail(1, 'error: failed to push some refs\nrejected (non-fast-forward)'),
  }))
  const ws = await prepareWorkspace({
    repo: 'acme/app', runId: 'r1', token: 'T', exec,
    makeTempDir: async () => '/tmp/r', removeDir: async () => {},
  })
  await assert.rejects(ws.commit('x'), (err: Error) => err instanceof GitError && err.message.includes('push failed'))
})

test('finish pushes only when the branch is ahead of the default branch', async () => {
  const ahead = scripted(baseHandlers({ 'rev-list': () => ok('2\n') }))
  const wsAhead = await prepareWorkspace({
    repo: 'acme/app', runId: 'r1', token: 'T', exec: ahead.exec,
    makeTempDir: async () => '/tmp/f1', removeDir: async () => {},
  })
  assert.deepEqual(await wsAhead.finish(), { pushed: true })
  assert.ok(ahead.calls.some((c) => c.args.includes('push')))
  const revList = ahead.calls.find((c) => c.args.includes('rev-list'))!
  assert.deepEqual(revList.args.slice(-2), ['--count', 'origin/main..HEAD'])

  const even = scripted(baseHandlers({ 'rev-list': () => ok('0\n') }))
  const wsEven = await prepareWorkspace({
    repo: 'acme/app', runId: 'r1', token: 'T', exec: even.exec,
    makeTempDir: async () => '/tmp/f2', removeDir: async () => {},
  })
  assert.deepEqual(await wsEven.finish(), { pushed: false })
  assert.ok(!even.calls.some((c) => c.args.includes('push')))
})

test('commit reports nothing committed when only secret files changed', async () => {
  const { exec, calls } = scripted(baseHandlers({
    diff: (args) => args.includes('--quiet') ? ok() : ok('.env\0'),
    reset: () => ok(),
    add: () => ok(),
  }))
  const ws = await prepareWorkspace({
    repo: 'acme/app', runId: 'r1', token: 'T', exec,
    makeTempDir: async () => '/tmp/w', removeDir: async () => {},
  })
  assert.deepEqual(await ws.commit('nothing'), { committed: false, skipped: ['.env'] })
  assert.ok(!calls.some((c) => c.args.includes('commit')))
})

test('push is a plain git push origin HEAD with auth config, never forced', async () => {
  const { exec, calls } = scripted(baseHandlers({ 'rev-list': () => ok('1\n') }))
  const ws = await prepareWorkspace({
    repo: 'acme/app', runId: 'r1', token: 'T', exec,
    makeTempDir: async () => '/tmp/p', removeDir: async () => {},
  })
  await ws.finish()
  const push = calls.find((c) => c.args.includes('push'))!
  assert.deepEqual(push.args.slice(-3), ['push', 'origin', 'HEAD'])
  assert.ok(push.args.includes('-c'))
  assert.ok(!push.args.some((a) => /force|--delete|:refs/.test(a)))
})
