import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  ClaudeCliError,
  ClaudeCliTimeoutError,
  childEnv,
  createClaudeCliLlm,
  ENV_ALLOWLIST,
  parseApproval,
  parseCliOutput,
  type ChildLike,
  type SpawnFn,
} from '../lib/claude-cli';

// What the fake CLI does on one spawn. Events fire on the next tick, like a real process.
interface FakeRun {
  stdout?: string;
  stderr?: string;
  code?: number | null;
  error?: Error;
  hang?: boolean; // never exits: used for timeouts
}

interface SpawnRecord {
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string>;
  stdio: unknown;
}

function fakeSpawn(runs: FakeRun[]) {
  const spawns: SpawnRecord[] = [];
  const kills: Array<NodeJS.Signals | number | undefined> = [];
  const spawn: SpawnFn = (command, args, opts) => {
    spawns.push({ command, args, cwd: opts.cwd, env: opts.env, stdio: opts.stdio });
    const run = runs.shift();
    if (!run) throw new Error('unexpected spawn');
    const events = new EventEmitter();
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const child: ChildLike = {
      stdout,
      stderr,
      on: (event: string, listener: (...args: any[]) => void) => events.on(event, listener),
      kill: (signal?: NodeJS.Signals | number) => {
        kills.push(signal);
        setImmediate(() => events.emit('close', null));
        return true;
      },
    } as unknown as ChildLike;
    setImmediate(() => {
      if (run.hang) return;
      if (run.error) return events.emit('error', run.error);
      if (run.stdout) stdout.emit('data', run.stdout);
      if (run.stderr) stderr.emit('data', run.stderr);
      events.emit('close', run.code ?? 0);
    });
    return child;
  };
  return { spawn, spawns, kills };
}

const okJson = (result: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result,
    usage: { input_tokens: 5, output_tokens: 7, cache_creation_input_tokens: 2, cache_read_input_tokens: 3 },
    ...extra,
  });

const errorJson = (result: string) => JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result });

const noSleep = async () => {};

test('complete runs the CLI with model, prompt, system prompt, one turn and no tools', async () => {
  const fake = fakeSpawn([{ stdout: okJson('hello there') }]);
  const llm = createClaudeCliLlm({ bin: 'claude-x', spawn: fake.spawn, env: { PATH: '/bin' } });

  const res = await llm.complete({ model: 'claude-haiku-5-5', system: 'Be brief.', prompt: 'hi' });

  assert.deepEqual(res, { text: 'hello there', usage: { input: 10, output: 7 } });
  const [s] = fake.spawns;
  assert.equal(s.command, 'claude-x');
  assert.equal(s.cwd, undefined);
  assert.deepEqual(s.args.slice(0, 7), ['-p', 'hi', '--model', 'claude-haiku-5-5', '--output-format', 'json', '--append-system-prompt']);
  assert.equal(s.args[7], 'Be brief.');
  assert.ok(s.args.includes('--max-turns') && s.args[s.args.indexOf('--max-turns') + 1] === '1');
  assert.ok(!s.args.includes('--allowedTools'));
});

test('complete passes maxTokens as the CLI output cap', async () => {
  const fake = fakeSpawn([{ stdout: okJson('ok') }]);
  const llm = createClaudeCliLlm({ spawn: fake.spawn, env: { PATH: '/bin' } });
  await llm.complete({ model: 'm', prompt: 'p', maxTokens: 900 });
  assert.equal(fake.spawns[0].env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, '900');
});

test('work runs in cwd with the allowed tools, the disallowed shell patterns and the turn cap', async () => {
  const fake = fakeSpawn([{ stdout: okJson('done') }]);
  const llm = createClaudeCliLlm({ spawn: fake.spawn, env: { PATH: '/bin' } });

  const res = await llm.work({ model: 'claude-sonnet-5-5', prompt: 'edit it', cwd: '/work/repo' });

  assert.equal(res.text, 'done');
  assert.equal(res.approval, undefined);
  const [s] = fake.spawns;
  assert.equal(s.cwd, '/work/repo');
  const args = s.args;
  assert.equal(args[args.indexOf('--allowedTools') + 1], 'Read,Write,Edit,Glob,Grep,Bash');
  const disallowed = args[args.indexOf('--disallowedTools') + 1];
  for (const pattern of ['git push', 'rm -rf', 'vercel', 'npm run deploy']) {
    assert.ok(disallowed.includes(pattern), `missing ${pattern}`);
  }
  assert.equal(args[args.indexOf('--max-turns') + 1], '30');
  assert.deepEqual(s.stdio, ['ignore', 'pipe', 'pipe']);
});

test('work honours maxTurns', async () => {
  const fake = fakeSpawn([{ stdout: okJson('done') }]);
  const llm = createClaudeCliLlm({ spawn: fake.spawn, env: { PATH: '/bin' } });
  await llm.work({ model: 'm', prompt: 'p', maxTurns: 4 });
  assert.equal(fake.spawns[0].args[fake.spawns[0].args.indexOf('--max-turns') + 1], '4');
});

test('a final APPROVAL_REQUEST line becomes the approval', async () => {
  const text = 'Built the page.\nAPPROVAL_REQUEST rule=3: Add a paid Vercel plan for previews';
  const fake = fakeSpawn([{ stdout: okJson(text) }]);
  const llm = createClaudeCliLlm({ spawn: fake.spawn, env: { PATH: '/bin' } });
  const res = await llm.work({ model: 'm', prompt: 'p' });
  assert.deepEqual(res.approval, { rule: 3, request: 'Add a paid Vercel plan for previews' });
  assert.equal(res.text, text);
});

test('an APPROVAL_REQUEST line that is not last is ignored', () => {
  assert.equal(parseApproval('APPROVAL_REQUEST rule=1: deploy\nSTATUS: blocked'), undefined);
  assert.equal(parseApproval('STATUS: done\n\n  '), undefined);
  assert.equal(parseApproval('APPROVAL_REQUEST rule=5: nope'), undefined);
  assert.deepEqual(parseApproval('x\n  APPROVAL_REQUEST rule=2: drop the table  \n'), {
    rule: 2,
    request: 'drop the table',
  });
});

test('the child env is an allowlist: agent Bash never sees runner secrets', async () => {
  const source = {
    PATH: '/usr/bin',
    HOME: '/home/runner',
    CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token',
    CI: 'true',
    GH_REPO_TOKEN: 'ghp_repo',
    GITHUB_TOKEN: 'ghp_actions',
    UPSTASH_REDIS_REST_URL: 'https://redis',
    UPSTASH_REDIS_REST_TOKEN: 'redis-token',
    SESSION_SECRET: 'session',
    CRON_SECRET: 'cron',
    ANTHROPIC_API_KEY: 'sk-ant',
    NODE_OPTIONS: '--inspect',
  };
  const fake = fakeSpawn([{ stdout: okJson('ok') }]);
  const llm = createClaudeCliLlm({ spawn: fake.spawn, env: source });
  await llm.work({ model: 'm', prompt: 'p', cwd: '/w' });

  const env = fake.spawns[0].env;
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'oauth-token');
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.HOME, '/home/runner');
  assert.equal(env.CI, 'true');
  for (const secret of ['GH_REPO_TOKEN', 'GITHUB_TOKEN', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'SESSION_SECRET', 'CRON_SECRET', 'ANTHROPIC_API_KEY', 'NODE_OPTIONS']) {
    assert.equal(env[secret], undefined, `${secret} leaked into the child env`);
  }
  for (const key of Object.keys(env)) assert.ok((ENV_ALLOWLIST as readonly string[]).includes(key), `unexpected ${key}`);
});

test('childEnv copies only allowlisted keys and skips unset ones', () => {
  assert.deepEqual(childEnv({ PATH: '/bin', TMPDIR: undefined, SECRET: 'x' }), { PATH: '/bin' });
  assert.deepEqual(childEnv({ PATH: '/bin' }, { CLAUDE_CODE_MAX_OUTPUT_TOKENS: '5' }), {
    PATH: '/bin',
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: '5',
  });
});

test('a timed-out call is killed, throws, and is not retried', async () => {
  const fake = fakeSpawn([{ hang: true }, { stdout: okJson('never reached') }]);
  const llm = createClaudeCliLlm({ spawn: fake.spawn, env: { PATH: '/bin' }, timeoutMs: 20, sleep: noSleep });

  await assert.rejects(llm.work({ model: 'm', prompt: 'p' }), ClaudeCliTimeoutError);
  assert.equal(fake.spawns.length, 1);
  assert.deepEqual(fake.kills, ['SIGTERM']);
});

test('a transient failure is retried once and then succeeds', async () => {
  const sleeps: number[] = [];
  const fake = fakeSpawn([{ code: 1, stderr: 'API Error: 503 overloaded' }, { stdout: okJson('recovered') }]);
  const llm = createClaudeCliLlm({
    spawn: fake.spawn,
    env: { PATH: '/bin' },
    retryDelayMs: 7,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  const res = await llm.complete({ model: 'm', prompt: 'p' });
  assert.equal(res.text, 'recovered');
  assert.equal(fake.spawns.length, 2);
  assert.deepEqual(sleeps, [7]);
});

test('a transient error that persists is thrown after exactly two attempts', async () => {
  const fake = fakeSpawn([
    { code: 1, stderr: 'rate limit exceeded' },
    { code: 1, stderr: 'rate limit exceeded' },
    { stdout: okJson('third is never run') },
  ]);
  const llm = createClaudeCliLlm({ spawn: fake.spawn, env: { PATH: '/bin' }, sleep: noSleep });
  await assert.rejects(llm.complete({ model: 'm', prompt: 'p' }), ClaudeCliError);
  assert.equal(fake.spawns.length, 2);
});

test('a non-transient exit is thrown without a retry', async () => {
  const fake = fakeSpawn([{ code: 2, stderr: 'error: unknown option --bogus' }, { stdout: okJson('no') }]);
  const llm = createClaudeCliLlm({ spawn: fake.spawn, env: { PATH: '/bin' }, sleep: noSleep });
  await assert.rejects(llm.work({ model: 'm', prompt: 'p' }), (err: unknown) => {
    assert.ok(err instanceof ClaudeCliError);
    assert.equal(err.transient, false);
    assert.match(err.message, /unknown option/);
    return true;
  });
  assert.equal(fake.spawns.length, 1);
});

test('an is_error result is retried only when it looks transient', async () => {
  const transient = fakeSpawn([{ stdout: errorJson('Overloaded, try later') }, { stdout: okJson('fine') }]);
  const llmA = createClaudeCliLlm({ spawn: transient.spawn, env: { PATH: '/bin' }, sleep: noSleep });
  assert.equal((await llmA.complete({ model: 'm', prompt: 'p' })).text, 'fine');
  assert.equal(transient.spawns.length, 2);

  const hard = fakeSpawn([{ stdout: errorJson('Prompt is too long') }, { stdout: okJson('no') }]);
  const llmB = createClaudeCliLlm({ spawn: hard.spawn, env: { PATH: '/bin' }, sleep: noSleep });
  await assert.rejects(llmB.complete({ model: 'm', prompt: 'p' }), /Prompt is too long/);
  assert.equal(hard.spawns.length, 1);
});

test('a spawn failure (CLI not installed) is thrown without a retry', async () => {
  const fake = fakeSpawn([{ error: new Error('spawn claude ENOENT') }, { stdout: okJson('no') }]);
  const llm = createClaudeCliLlm({ spawn: fake.spawn, env: { PATH: '/bin' }, sleep: noSleep });
  await assert.rejects(llm.complete({ model: 'm', prompt: 'p' }), /ENOENT/);
  assert.equal(fake.spawns.length, 1);
});

test('usage counts cache tokens as input and tolerates missing fields', () => {
  const parsed = parseCliOutput(okJson('x'));
  assert.deepEqual(parsed.usage, { input: 10, output: 7 });
  const sparse = parseCliOutput(JSON.stringify({ type: 'result', result: ' hi ' }));
  assert.deepEqual(sparse.usage, { input: 0, output: 0 });
  assert.equal(sparse.text, 'hi');
});

test('parseCliOutput accepts an array of messages and picks the result entry', () => {
  const stdout = JSON.stringify([{ type: 'system' }, JSON.parse(okJson('from array'))]);
  assert.equal(parseCliOutput(stdout).text, 'from array');
});

test('parseCliOutput rejects output with no JSON or no result entry', () => {
  assert.throws(() => parseCliOutput('not json'), ClaudeCliError);
  assert.throws(() => parseCliOutput(JSON.stringify({ type: 'system' })), ClaudeCliError);
});
