import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AgentLoopLimitError,
  ClaudeApiError,
  createAnthropicClient,
  createMockClaude,
  DEFAULT_MODELS,
  parseRetryAfter,
  resolveModels,
  runAgent,
  textReply,
  toolReply,
  type MessageResponse,
} from '../lib/claude';

const okBody: MessageResponse = textReply('hello', { input_tokens: 5, output_tokens: 7 });

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

// Records sleeps instead of waiting, so retry tests run instantly.
function recordingSleep() {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number) => void waits.push(ms) };
}

test('resolveModels uses the documented defaults', () => {
  assert.deepEqual(resolveModels({}), {
    orchestrator: 'claude-opus-5-5',
    lead: 'claude-sonnet-5-5',
    worker: 'claude-haiku-5-5',
  });
  assert.deepEqual(DEFAULT_MODELS, resolveModels({}));
});

test('resolveModels reads env overrides and treats empty strings as unset', () => {
  const models = resolveModels({
    ORCHESTRATOR_MODEL: 'o-test',
    LEAD_MODEL: '',
    WORKER_MODEL: 'w-test',
  });
  assert.equal(models.orchestrator, 'o-test');
  assert.equal(models.lead, 'claude-sonnet-5-5');
  assert.equal(models.worker, 'w-test');
});

test('resolveModels: workers run on the lead model when there are no leads', () => {
  const models = resolveModels({ LEAD_MODEL: 'lead-x', WORKER_MODEL: 'worker-x' }, false);
  assert.equal(models.worker, 'lead-x');
  assert.equal(resolveModels({ WORKER_MODEL: 'worker-x' }, true).worker, 'worker-x');
});

test('createAnthropicClient rejects a missing API key', () => {
  assert.throws(() => createAnthropicClient({ apiKey: '' }), /ANTHROPIC_API_KEY/);
});

test('createAnthropicClient posts to /v1/messages with auth headers and the request body', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const client = createAnthropicClient({
    apiKey: 'sk-test',
    baseUrl: 'https://example.test/',
    fetch: async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return jsonResponse(200, okBody);
    },
  });

  const res = await client.createMessage({
    model: 'claude-haiku-5-5',
    max_tokens: 100,
    system: 'sys',
    messages: [{ role: 'user', content: 'hi' }],
  });

  assert.equal(res.usage.output_tokens, 7);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://example.test/v1/messages');
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers['x-api-key'], 'sk-test');
  assert.equal(headers['anthropic-version'], '2023-06-01');
  const body = JSON.parse(String(calls[0].init.body));
  assert.equal(body.model, 'claude-haiku-5-5');
  assert.equal(body.system, 'sys');
});

test('retries 429 honoring Retry-After, then succeeds', async () => {
  const { waits, sleep } = recordingSleep();
  let n = 0;
  const client = createAnthropicClient({
    apiKey: 'k',
    sleep,
    random: () => 0,
    fetch: async () => {
      n++;
      return n === 1 ? jsonResponse(429, 'slow down', { 'retry-after': '2' }) : jsonResponse(200, okBody);
    },
  });

  const res = await client.createMessage({ model: 'm', max_tokens: 1, messages: [] });
  assert.equal(res.content[0].type, 'text');
  assert.equal(n, 2);
  assert.deepEqual(waits, [2000]);
});

test('retries 5xx with exponential backoff, then throws after maxRetries', async () => {
  const { waits, sleep } = recordingSleep();
  let n = 0;
  const client = createAnthropicClient({
    apiKey: 'k',
    maxRetries: 3,
    baseDelayMs: 100,
    maxDelayMs: 10_000,
    sleep,
    random: () => 1, // full step, so the waits are exact
    fetch: async () => {
      n++;
      return jsonResponse(503, 'overloaded');
    },
  });

  await assert.rejects(
    client.createMessage({ model: 'm', max_tokens: 1, messages: [] }),
    (err: unknown) => err instanceof ClaudeApiError && err.status === 503 && err.retryable,
  );
  assert.equal(n, 4); // 1 attempt + 3 retries
  assert.deepEqual(waits, [100, 200, 400]);
});

test('backoff is capped at maxDelayMs', async () => {
  const { waits, sleep } = recordingSleep();
  const client = createAnthropicClient({
    apiKey: 'k',
    maxRetries: 4,
    baseDelayMs: 100,
    maxDelayMs: 250,
    sleep,
    random: () => 1,
    fetch: async () => jsonResponse(500, 'boom'),
  });
  await assert.rejects(client.createMessage({ model: 'm', max_tokens: 1, messages: [] }));
  assert.deepEqual(waits, [100, 200, 250, 250]);
});

test('does not retry a 400 response', async () => {
  const { waits, sleep } = recordingSleep();
  let n = 0;
  const client = createAnthropicClient({
    apiKey: 'k',
    sleep,
    fetch: async () => {
      n++;
      return jsonResponse(400, { error: 'bad request' });
    },
  });

  await assert.rejects(
    client.createMessage({ model: 'm', max_tokens: 1, messages: [] }),
    (err: unknown) => err instanceof ClaudeApiError && err.status === 400 && !err.retryable,
  );
  assert.equal(n, 1);
  assert.deepEqual(waits, []);
});

test('a per-attempt timeout is retryable and reported as a timeout', async () => {
  const { waits, sleep } = recordingSleep();
  let n = 0;
  const client = createAnthropicClient({
    apiKey: 'k',
    timeoutMs: 10,
    maxRetries: 1,
    sleep,
    random: () => 0,
    // Never answers; only the abort signal ends the call. A real socket keeps the
    // event loop alive; a ref'd timer stands in for it, since AbortSignal.timeout is unref'd.
    fetch: (_url, init) => {
      n++;
      return new Promise<Response>((_resolve, reject) => {
        const keepAlive = setTimeout(() => {}, 1_000);
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(keepAlive);
          reject(init.signal?.reason);
        });
      });
    },
  });

  await assert.rejects(
    client.createMessage({ model: 'm', max_tokens: 1, messages: [] }),
    (err: unknown) => err instanceof ClaudeApiError && /timed out/.test(err.message) && err.retryable,
  );
  assert.equal(n, 2);
  assert.equal(waits.length, 1);
});

test('a caller cancellation is never retried', async () => {
  const { waits, sleep } = recordingSleep();
  let n = 0;
  const controller = new AbortController();
  const client = createAnthropicClient({
    apiKey: 'k',
    sleep,
    fetch: (_url, init) => {
      n++;
      controller.abort(new Error('cancelled by owner'));
      return Promise.reject(init?.signal?.reason);
    },
  });

  await assert.rejects(client.createMessage({ model: 'm', max_tokens: 1, messages: [] }, { signal: controller.signal }));
  assert.equal(n, 1);
  assert.deepEqual(waits, []);
});

test('a malformed success body is not retried', async () => {
  const { sleep } = recordingSleep();
  const client = createAnthropicClient({
    apiKey: 'k',
    sleep,
    fetch: async () => jsonResponse(200, { nope: true }),
  });
  await assert.rejects(
    client.createMessage({ model: 'm', max_tokens: 1, messages: [] }),
    (err: unknown) => err instanceof ClaudeApiError && !err.retryable && /malformed/.test(err.message),
  );
});

test('parseRetryAfter handles seconds, HTTP dates and garbage', () => {
  assert.equal(parseRetryAfter('3'), 3000);
  assert.equal(parseRetryAfter(null), undefined);
  assert.equal(parseRetryAfter('not a date'), undefined);
  const now = Date.parse('2026-01-01T00:00:00Z');
  assert.equal(parseRetryAfter('Thu, 01 Jan 2026 00:00:05 GMT', now), 5000);
  assert.equal(parseRetryAfter('Wed, 31 Dec 2025 23:59:00 GMT', now), 0);
});

test('runAgent returns text and summed usage when no tools are used', async () => {
  const client = createMockClaude(() => textReply('done', { input_tokens: 3, output_tokens: 4 }));
  const result = await runAgent({ client, model: 'm', prompt: 'go' });
  assert.equal(result.text, 'done');
  assert.equal(result.iterations, 1);
  assert.deepEqual(result.usage, { input_tokens: 3, output_tokens: 4 });
  assert.deepEqual(result.toolCalls, []);
  assert.equal(client.requests[0].tools, undefined);
});

test('runAgent runs the tool-use loop and feeds tool results back', async () => {
  const executed: string[] = [];
  let turn = 0;
  const client = createMockClaude(() => {
    turn++;
    if (turn === 1) {
      return toolReply(
        [
          { id: 'tu_1', name: 'read_file', input: { path: 'a.txt' } },
          { id: 'tu_2', name: 'list_files', input: {} },
        ],
        { input_tokens: 10, output_tokens: 2 },
      );
    }
    return textReply('summary', { input_tokens: 20, output_tokens: 5 });
  });

  const result = await runAgent({
    client,
    model: 'm',
    prompt: 'look',
    tools: [{ name: 'read_file', description: 'read', input_schema: { type: 'object', properties: {} } }],
    executeTool: async (call) => {
      executed.push(call.name);
      return call.name === 'read_file' ? 'file body' : { content: 'a.txt\nb.txt' };
    },
  });

  assert.deepEqual(executed, ['read_file', 'list_files']);
  assert.equal(result.text, 'summary');
  assert.equal(result.iterations, 2);
  assert.deepEqual(result.usage, { input_tokens: 30, output_tokens: 7 });
  assert.deepEqual(result.toolCalls, [
    { name: 'read_file', isError: false },
    { name: 'list_files', isError: false },
  ]);

  const second = client.requests[1].messages;
  const toolResults = second[second.length - 1].content;
  assert.deepEqual(toolResults, [
    { type: 'tool_result', tool_use_id: 'tu_1', content: 'file body', is_error: false },
    { type: 'tool_result', tool_use_id: 'tu_2', content: 'a.txt\nb.txt', is_error: false },
  ]);
  assert.equal(client.requests[0].tools?.length, 1);
});

test('a throwing tool becomes an is_error result and the loop continues', async () => {
  let turn = 0;
  const client = createMockClaude(() => {
    turn++;
    return turn === 1 ? toolReply([{ id: 'x', name: 'write_file' }]) : textReply('recovered');
  });
  const result = await runAgent({
    client,
    model: 'm',
    prompt: 'write',
    executeTool: async () => {
      throw new Error('path traversal blocked');
    },
  });
  assert.equal(result.text, 'recovered');
  assert.deepEqual(result.toolCalls, [{ name: 'write_file', isError: true }]);
  const last = client.requests[1].messages[2].content as Array<{ is_error?: boolean; content: string }>;
  assert.equal(last[0].is_error, true);
  assert.equal(last[0].content, 'path traversal blocked');
});

test('a tool call with no executor is reported as an error, not thrown', async () => {
  let turn = 0;
  const client = createMockClaude(() => {
    turn++;
    return turn === 1 ? toolReply([{ id: 'x', name: 'ghost' }]) : textReply('ok');
  });
  const result = await runAgent({ client, model: 'm', prompt: 'p' });
  assert.deepEqual(result.toolCalls, [{ name: 'ghost', isError: true }]);
});

test('runAgent throws once maxIterations model calls pass without finishing', async () => {
  const client = createMockClaude(() => toolReply([{ id: 'x', name: 'noop' }]));
  await assert.rejects(
    runAgent({ client, model: 'm', prompt: 'loop', maxIterations: 3, executeTool: async () => 'ok' }),
    AgentLoopLimitError,
  );
  assert.equal(client.requests.length, 3);
});

test('runAgent stops before calling the model when already aborted', async () => {
  const client = createMockClaude(() => textReply('never'));
  const controller = new AbortController();
  controller.abort(new Error('owner cancelled'));
  await assert.rejects(runAgent({ client, model: 'm', prompt: 'p', signal: controller.signal }), /owner cancelled/);
  assert.equal(client.requests.length, 0);
});
