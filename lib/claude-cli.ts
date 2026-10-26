// Llm implementation that shells out to the Claude Code CLI (`claude -p`), so calls bill
// to the Claude subscription (CLAUDE_CODE_OAUTH_TOKEN) instead of the Anthropic API.
// Node only: runs on the PC runner (scripts/runner.ts), never in the web app or on Workers.

import { spawn as nodeSpawn } from 'node:child_process';
import type { Approval, CompleteRequest, CompleteResult, Llm, Usage, WorkRequest, WorkResult } from './llm';

// The subset of ChildProcess we use. Tests pass a fake that emits the same events.
export interface ChildLike {
  stdout: { on(event: 'data', listener: (chunk: string | Uint8Array) => void): unknown };
  stderr: { on(event: 'data', listener: (chunk: string | Uint8Array) => void): unknown };
  on(event: 'close', listener: (code: number | null) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export type SpawnFn = (
  command: string,
  args: string[],
  opts: { cwd?: string; env: Record<string, string>; stdio: ['ignore', 'pipe', 'pipe'] },
) => ChildLike;

export interface ClaudeCliOptions {
  bin?: string;
  spawn?: SpawnFn;
  // Source of the child env. The child gets only ALLOWLIST keys from it, never the whole object.
  env?: Record<string, string | undefined>;
  // Per-call wall-clock limit. A timed-out call is killed and not retried, since it may have half-finished work.
  timeoutMs?: number;
  // Pause before the single retry of a transient failure.
  retryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

// Everything the agent's subprocess may inherit. Secrets the agent must not see
// (GH_REPO_TOKEN, UPSTASH_*, GITHUB_TOKEN, SESSION_SECRET, ANTHROPIC_API_KEY)
// are absent on purpose. Add a key here only if the CLI cannot work without it.
export const ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'USER',
  'SHELL',
  'LANG',
  'LC_ALL',
  'TMPDIR',
  'CI',
  'CLAUDE_CODE_OAUTH_TOKEN',
] as const;

// Tools the work agent may use. Anything else is refused by the CLI.
export const WORK_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'] as const;

// Shell patterns the agent may never run. Pushing, deleting and deploying belong to the runner
// and to the owner, not to the agent.
export const DISALLOWED_BASH = [
  'Bash(git push:*)',
  'Bash(rm -rf:*)',
  'Bash(npm run deploy:*)',
  'Bash(gh:*)',
];

export const APPROVAL_LINE = /^APPROVAL_REQUEST rule=([1-4]): (.+)$/;

export class ClaudeCliError extends Error {
  readonly transient: boolean;
  constructor(message: string, transient: boolean) {
    super(message);
    this.name = 'ClaudeCliError';
    this.transient = transient;
  }
}

export class ClaudeCliTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`claude CLI timed out after ${timeoutMs} ms`);
    this.name = 'ClaudeCliTimeoutError';
  }
}

// Only ALLOWLIST keys survive. Exported so tests can check it directly.
export function childEnv(source: Record<string, string | undefined>, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ENV_ALLOWLIST) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...extra };
}

export function buildArgs(
  kind: 'complete' | 'work',
  req: { model: string; prompt: string; system?: string; maxTurns?: number },
): string[] {
  const args = ['-p', req.prompt, '--model', req.model, '--output-format', 'json'];
  if (req.system) args.push('--append-system-prompt', req.system);
  if (kind === 'work') {
    args.push('--allowedTools', WORK_TOOLS.join(','));
    args.push('--disallowedTools', DISALLOWED_BASH.join(','));
    args.push('--max-turns', String(req.maxTurns ?? 30));
  } else {
    // A plain completion needs one turn and no tools.
    args.push('--disallowedTools', [...WORK_TOOLS].join(','));
    args.push('--max-turns', '1');
  }
  return args;
}

// Parses `--output-format json`. The result is one object, or an array of messages with a result entry.
export function parseCliOutput(stdout: string): {
  text: string;
  usage: Usage;
  isError: boolean;
  subtype?: string;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new ClaudeCliError(`claude CLI printed no JSON result: ${stdout.slice(0, 200)}`, true);
  }
  const items = Array.isArray(parsed) ? parsed : [parsed];
  const result = items.find((item): item is Record<string, unknown> => isRecord(item) && item.type === 'result');
  if (!result) throw new ClaudeCliError('claude CLI output has no result entry', true);

  const u = isRecord(result.usage) ? result.usage : {};
  // Cache reads and writes are input tokens too; count them so budgets see the real volume.
  const usage: Usage = {
    input: num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens),
    output: num(u.output_tokens),
  };
  return {
    text: typeof result.result === 'string' ? result.result.trim() : '',
    usage,
    isError: result.is_error === true,
    subtype: typeof result.subtype === 'string' ? result.subtype : undefined,
  };
}

// The approval protocol: the agent's final non-empty line is `APPROVAL_REQUEST rule=N: text`.
export function parseApproval(text: string): Approval | undefined {
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  const last = lines[lines.length - 1];
  if (!last) return undefined;
  const match = APPROVAL_LINE.exec(last);
  if (!match) return undefined;
  return { rule: Number(match[1]) as Approval['rule'], request: match[2].trim() };
}

// Errors that are likely gone on a second try: rate limits, overload, 5xx, network blips.
const TRANSIENT_PATTERN = /rate.?limit|overloaded|\b5\d\d\b|ECONNRESET|ETIMEDOUT|socket hang up|temporar/i;

export function createClaudeCliLlm(opts: ClaudeCliOptions = {}): Llm {
  const bin = opts.bin ?? 'claude';
  const spawnFn: SpawnFn = opts.spawn ?? (nodeSpawn as unknown as SpawnFn);
  const source = opts.env ?? process.env;
  const timeoutMs = opts.timeoutMs ?? 30 * 60_000;
  const retryDelayMs = opts.retryDelayMs ?? 5_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  // One process run. Resolves with stdout, rejects with ClaudeCliError or ClaudeCliTimeoutError.
  const runOnce = (args: string[], cwd: string | undefined, extraEnv: Record<string, string>) =>
    new Promise<string>((resolve, reject) => {
      const child = spawnFn(bin, args, {
        cwd,
        env: childEnv(source, extraEnv),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        finish(() => reject(new ClaudeCliTimeoutError(timeoutMs)));
      }, timeoutMs);

      child.stdout.on('data', (chunk) => (stdout += String(chunk)));
      child.stderr.on('data', (chunk) => (stderr += String(chunk)));
      child.on('error', (err) => finish(() => reject(new ClaudeCliError(`failed to start claude CLI: ${err.message}`, false))));
      child.on('close', (code) => {
        if (code === 0) return finish(() => resolve(stdout));
        const detail = (stderr || stdout).trim().slice(0, 300);
        finish(() =>
          reject(new ClaudeCliError(`claude CLI exited ${code}: ${detail}`, TRANSIENT_PATTERN.test(detail))),
        );
      });
    });

  // Runs the CLI once, retries once on a transient failure, and returns the parsed result.
  const call = async (args: string[], cwd: string | undefined, extraEnv: Record<string, string>) => {
    for (let attempt = 0; ; attempt++) {
      let failure: ClaudeCliError;
      try {
        const parsed = parseCliOutput(await runOnce(args, cwd, extraEnv));
        if (!parsed.isError) return parsed;
        failure = new ClaudeCliError(
          `claude CLI error (${parsed.subtype ?? 'error'}): ${parsed.text.slice(0, 300)}`,
          TRANSIENT_PATTERN.test(parsed.text),
        );
      } catch (err) {
        // Timeouts are not ClaudeCliError, so they fall through and are not retried.
        if (!(err instanceof ClaudeCliError)) throw err;
        failure = err;
      }
      if (!failure.transient || attempt >= 1) throw failure;
      await sleep(retryDelayMs);
    }
  };

  return {
    async complete(req: CompleteRequest): Promise<CompleteResult> {
      const parsed = await call(buildArgs('complete', req), undefined, outputCap(req.maxTokens));
      return { text: parsed.text, usage: parsed.usage };
    },
    async work(req: WorkRequest): Promise<WorkResult> {
      const parsed = await call(buildArgs('work', req), req.cwd, {});
      const approval = parseApproval(parsed.text);
      return { text: parsed.text, usage: parsed.usage, ...(approval ? { approval } : {}) };
    },
  };
}

function outputCap(maxTokens: number | undefined): Record<string, string> {
  return maxTokens ? { CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(maxTokens) } : {};
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
