// Anthropic Messages API client over fetch, plus a tool-use loop.
// No SDK, no Node-only APIs: runs in Vercel serverless and edge runtimes.

export type Role = 'orchestrator' | 'lead' | 'worker';

export const DEFAULT_MODELS: Record<Role, string> = {
  orchestrator: 'claude-opus-5-5',
  lead: 'claude-sonnet-5-5',
  worker: 'claude-haiku-5-5',
};

export const MODEL_ENV: Record<Role, string> = {
  orchestrator: 'ORCHESTRATOR_MODEL',
  lead: 'LEAD_MODEL',
  worker: 'WORKER_MODEL',
};

export interface Models {
  orchestrator: string;
  lead: string;
  worker: string;
}

// Empty strings count as unset. Without leads, workers run on the lead model.
export function resolveModels(
  env: Record<string, string | undefined> = process.env,
  hasLeads = true,
): Models {
  const pick = (role: Role) => env[MODEL_ENV[role]] || DEFAULT_MODELS[role];
  const lead = pick('lead');
  return {
    orchestrator: pick('orchestrator'),
    lead,
    worker: hasLeads ? pick('worker') : lead,
  };
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

export interface Message {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
}

export interface MessageRequest {
  model: string;
  max_tokens: number;
  system?: string;
  messages: Message[];
  tools?: ToolDefinition[];
}

export interface MessageResponse {
  id: string;
  model: string;
  role: 'assistant';
  content: ContentBlock[];
  stop_reason: string | null;
  usage: Usage;
}

export interface CallOptions {
  signal?: AbortSignal;
}

// The seam the engine and tests depend on. Anything with this shape works.
export interface ClaudeClient {
  createMessage(req: MessageRequest, call?: CallOptions): Promise<MessageResponse>;
}

export class ClaudeApiError extends Error {
  status: number | undefined;
  retryable: boolean;
  retryAfterMs: number | undefined;
  body: string | undefined;

  constructor(
    message: string,
    opts: { status?: number; retryable: boolean; retryAfterMs?: number; body?: string },
  ) {
    super(message);
    this.name = 'ClaudeApiError';
    this.status = opts.status;
    this.retryable = opts.retryable;
    this.retryAfterMs = opts.retryAfterMs;
    this.body = opts.body;
  }
}

export interface AnthropicClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  // Per-attempt timeout. A slow Opus plan can take a while, so the default is generous.
  timeoutMs?: number;
  // Retries after the first attempt, for 429, 5xx, timeouts and network errors.
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  // Injectable so tests never wait for real time.
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const API_VERSION = '2023-06-01';

export function createAnthropicClient(opts: AnthropicClientOptions): ClaudeClient {
  if (!opts.apiKey) throw new Error('ANTHROPIC_API_KEY is not set');

  const baseUrl = (opts.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '');
  const doFetch: typeof fetch = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const maxRetries = opts.maxRetries ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 1_000;
  const maxDelayMs = opts.maxDelayMs ?? 20_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = opts.random ?? Math.random;

  const backoffMs = (attempt: number, retryAfterMs?: number) => {
    if (retryAfterMs !== undefined) return Math.min(retryAfterMs, maxDelayMs);
    const exp = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
    // Jitter between 50% and 100% of the exponential step.
    return exp * (0.5 + random() / 2);
  };

  // One HTTP attempt. Returns either the parsed response or a classified error.
  const attemptOnce = async (
    body: string,
    call: CallOptions,
  ): Promise<{ ok: MessageResponse } | { error: ClaudeApiError }> => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = call.signal ? AbortSignal.any([timeout, call.signal]) : timeout;

    let res: Response;
    try {
      res = await doFetch(`${baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': opts.apiKey,
          'anthropic-version': API_VERSION,
        },
        body,
        signal,
      });
    } catch (err) {
      if (call.signal?.aborted) throw err; // caller cancelled: never retry
      const message = timeout.aborted ? `Claude request timed out after ${timeoutMs} ms` : `Claude request failed: ${String(err)}`;
      return { error: new ClaudeApiError(message, { retryable: true }) };
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const retryable = res.status === 429 || res.status >= 500;
      return {
        error: new ClaudeApiError(`Claude API ${res.status}: ${text.slice(0, 300)}`, {
          status: res.status,
          retryable,
          retryAfterMs: parseRetryAfter(res.headers.get('retry-after')),
          body: text,
        }),
      };
    }

    const json = (await res.json()) as Partial<MessageResponse>;
    if (!json || !Array.isArray(json.content)) {
      return { error: new ClaudeApiError('Claude API returned a malformed response', { status: res.status, retryable: false }) };
    }
    return { ok: json as MessageResponse };
  };

  return {
    async createMessage(req, call = {}) {
      const body = JSON.stringify(req);
      for (let attempt = 0; ; attempt++) {
        const outcome = await attemptOnce(body, call);
        if ('ok' in outcome) return outcome.ok;
        const err = outcome.error;
        if (!err.retryable || attempt >= maxRetries) throw err;
        await sleep(backoffMs(attempt, err.retryAfterMs));
      }
    },
  };
}

// Retry-After is either delta-seconds or an HTTP date.
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now);
}

export type ToolResult = string | { content: string; isError?: boolean };

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export type ToolExecutor = (call: ToolCall) => Promise<ToolResult>;

export interface RunAgentOptions {
  client: ClaudeClient;
  model: string;
  prompt: string;
  system?: string;
  tools?: ToolDefinition[];
  executeTool?: ToolExecutor;
  maxTokens?: number;
  // Each iteration is one model call. Exceeding this throws.
  maxIterations?: number;
  signal?: AbortSignal;
}

export interface ToolCallRecord {
  name: string;
  isError: boolean;
}

export interface AgentRunResult {
  // Text of the final assistant turn.
  text: string;
  stopReason: string | null;
  usage: Usage;
  iterations: number;
  toolCalls: ToolCallRecord[];
}

export class AgentLoopLimitError extends Error {
  constructor(maxIterations: number) {
    super(`Agent exceeded ${maxIterations} model calls without finishing`);
    this.name = 'AgentLoopLimitError';
  }
}

export function addUsage(total: Usage, delta: Usage): Usage {
  total.input_tokens += delta.input_tokens;
  total.output_tokens += delta.output_tokens;
  return total;
}

export function textOf(content: ContentBlock[]): string {
  return content
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('')
    .trim();
}

// Drives a model until it stops asking for tools. Tool errors are returned to the
// model as is_error results, not thrown, so one bad call does not kill the agent.
export async function runAgent(opts: RunAgentOptions): Promise<AgentRunResult> {
  const maxIterations = opts.maxIterations ?? 20;
  const maxTokens = opts.maxTokens ?? 4096;
  const tools = opts.tools && opts.tools.length > 0 ? opts.tools : undefined;
  const messages: Message[] = [{ role: 'user', content: opts.prompt }];
  const usage: Usage = { input_tokens: 0, output_tokens: 0 };
  const toolCalls: ToolCallRecord[] = [];

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    if (opts.signal?.aborted) throw opts.signal.reason ?? new Error('Agent run aborted');

    const res = await opts.client.createMessage(
      { model: opts.model, max_tokens: maxTokens, system: opts.system, messages, tools },
      { signal: opts.signal },
    );
    addUsage(usage, res.usage);

    const uses = res.content.filter((b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use');
    if (res.stop_reason !== 'tool_use' || uses.length === 0) {
      return { text: textOf(res.content), stopReason: res.stop_reason, usage, iterations: iteration, toolCalls };
    }

    messages.push({ role: 'assistant', content: res.content });
    const results = await Promise.all(uses.map((use) => runTool(use, opts.executeTool, toolCalls)));
    messages.push({ role: 'user', content: results });
  }

  throw new AgentLoopLimitError(maxIterations);
}

async function runTool(
  use: { id: string; name: string; input: unknown },
  executeTool: ToolExecutor | undefined,
  record: ToolCallRecord[],
): Promise<ContentBlock> {
  let content: string;
  let isError = false;
  try {
    if (!executeTool) throw new Error(`No executor for tool "${use.name}"`);
    const out = await executeTool({ id: use.id, name: use.name, input: use.input });
    if (typeof out === 'string') {
      content = out;
    } else {
      content = out.content;
      isError = out.isError === true;
    }
  } catch (err) {
    content = err instanceof Error ? err.message : String(err);
    isError = true;
  }
  record.push({ name: use.name, isError });
  return { type: 'tool_result', tool_use_id: use.id, content, is_error: isError };
}

export type MockRequest = MessageRequest;

export type MockHandler = (req: MockRequest) => MessageResponse | Promise<MessageResponse>;

export interface MockClaudeClient extends ClaudeClient {
  requests: MockRequest[];
}

// For tests and the engine's mocked end-to-end run. Records every request.
// Snapshots messages, because runAgent keeps appending to the same array.
export function createMockClaude(handler: MockHandler): MockClaudeClient {
  const requests: MockRequest[] = [];
  return {
    requests,
    async createMessage(req) {
      requests.push({ ...req, messages: [...req.messages] });
      return handler(req);
    },
  };
}

export function textReply(text: string, usage: Usage = { input_tokens: 10, output_tokens: 10 }): MessageResponse {
  return {
    id: 'msg_mock',
    model: 'mock',
    role: 'assistant',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    usage,
  };
}

export function toolReply(
  calls: Array<{ id: string; name: string; input?: unknown }>,
  usage: Usage = { input_tokens: 10, output_tokens: 10 },
): MessageResponse {
  return {
    id: 'msg_mock',
    model: 'mock',
    role: 'assistant',
    content: calls.map((c) => ({ type: 'tool_use' as const, id: c.id, name: c.name, input: c.input ?? {} })),
    stop_reason: 'tool_use',
    usage,
  };
}
