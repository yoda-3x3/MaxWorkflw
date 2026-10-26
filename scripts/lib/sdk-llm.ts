// Llm implementation on the Claude Agent SDK. Calls bill to the Claude subscription through
// CLAUDE_CODE_OAUTH_TOKEN, the same as the CLI path in lib/claude-cli.ts.
// Node only: the runner runs it on the PC, never in the web app.
import { query } from '@anthropic-ai/claude-agent-sdk'
import { APPROVAL_LINE, DISALLOWED_BASH, ENV_ALLOWLIST, WORK_TOOLS } from '../../lib/claude-cli'
import type { Approval, CompleteRequest, CompleteResult, Llm, Usage, WorkRequest, WorkResult } from '../../lib/llm'

// The slice of an SDK message this file reads. Kept loose so one SDK version bump is one edit here.
export interface AgentMessage {
  type: string
  subtype?: string
  result?: string
  is_error?: boolean
  usage?: { input_tokens?: number; output_tokens?: number }
}

export interface RunOutcome {
  text: string
  usage: Usage
  error?: string
}

// Pure: picks the final result from a message stream. Errors come back as a value, not a throw,
// so the caller can record them on the run.
export function summarizeMessages(messages: AgentMessage[]): RunOutcome {
  const result = [...messages].reverse().find((m) => m.type === 'result')
  if (!result) return { text: '', usage: { input: 0, output: 0 }, error: 'agent produced no result' }
  const usage = { input: result.usage?.input_tokens ?? 0, output: result.usage?.output_tokens ?? 0 }
  if (result.is_error || (result.subtype && result.subtype !== 'success')) {
    return { text: result.result ?? '', usage, error: `agent stopped: ${result.subtype ?? 'error'}` }
  }
  return { text: result.result ?? '', usage }
}

// The agent asks for a human decision by printing an APPROVAL_REQUEST line. Same contract as the CLI path.
export function parseApproval(text: string): Approval | undefined {
  for (const line of text.split('\n')) {
    const m = APPROVAL_LINE.exec(line.trim())
    if (m) return { rule: Number(m[1]) as Approval['rule'], request: m[2] }
  }
  return undefined
}

// Only these variables reach the agent's process. Secrets the agent must not see stay out.
export function agentEnv(source: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of ENV_ALLOWLIST) {
    const v = source[key]
    if (v) out[key] = v
  }
  return out
}

export type QueryFn = (args: {
  prompt: string
  options: Record<string, unknown>
}) => AsyncIterable<AgentMessage>

export interface SdkLlmOptions {
  env: Record<string, string | undefined>
  timeoutMs?: number
  queryFn?: QueryFn
}

export function createSdkLlm(opts: SdkLlmOptions): Llm {
  const run = opts.queryFn ?? (query as unknown as QueryFn)
  const timeoutMs = opts.timeoutMs ?? 30 * 60 * 1000

  // Collects the stream, bounded by the timeout. A timed-out call is aborted and reported as an error.
  const collect = async (prompt: string, options: Record<string, unknown>): Promise<RunOutcome> => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    timer.unref?.()
    const messages: AgentMessage[] = []
    try {
      for await (const m of run({ prompt, options: { ...options, abortController: controller, env: agentEnv(opts.env) } })) {
        messages.push(m)
      }
    } catch (err) {
      return { text: '', usage: { input: 0, output: 0 }, error: err instanceof Error ? err.message : String(err) }
    } finally {
      clearTimeout(timer)
    }
    return summarizeMessages(messages)
  }

  return {
    async complete(req: CompleteRequest): Promise<CompleteResult> {
      const outcome = await collect(req.prompt, {
        model: req.model,
        systemPrompt: req.system,
        allowedTools: [],
        maxTurns: 1,
        settingSources: [],
      })
      if (outcome.error) throw new Error(outcome.error)
      return { text: outcome.text, usage: outcome.usage }
    },

    async work(req: WorkRequest): Promise<WorkResult> {
      const outcome = await collect(req.prompt, {
        model: req.model,
        systemPrompt: req.system,
        cwd: req.cwd,
        allowedTools: [...WORK_TOOLS],
        disallowedTools: [...DISALLOWED_BASH],
        maxTurns: req.maxTurns,
        settingSources: [],
      })
      if (outcome.error) throw new Error(outcome.error)
      const approval = parseApproval(outcome.text)
      return { text: outcome.text, usage: outcome.usage, ...(approval ? { approval } : {}) }
    },
  }
}
