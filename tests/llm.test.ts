import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockLlm, DEFAULT_MODELS, resolveModels } from '../lib/llm';

test('resolveModels falls back to the defaults', () => {
  assert.deepEqual(resolveModels({}), {
    orchestrator: 'claude-opus-5-5',
    lead: 'claude-sonnet-5-5',
    worker: 'claude-haiku-5-5',
  });
  assert.deepEqual(DEFAULT_MODELS.worker, 'claude-haiku-5-5');
});

test('resolveModels reads each role from its env var and treats empty strings as unset', () => {
  const models = resolveModels({
    ORCHESTRATOR_MODEL: 'o-model',
    LEAD_MODEL: 'l-model',
    WORKER_MODEL: '',
  });
  assert.deepEqual(models, { orchestrator: 'o-model', lead: 'l-model', worker: 'claude-haiku-5-5' });
});

test('without leads, workers run on the lead model', () => {
  const models = resolveModels({ LEAD_MODEL: 'l-model', WORKER_MODEL: 'w-model' }, false);
  assert.equal(models.worker, 'l-model');
  assert.equal(models.lead, 'l-model');
  assert.equal(resolveModels({ WORKER_MODEL: 'w-model' }, true).worker, 'w-model');
});

test('createMockLlm records each call and returns scripted text, usage and approval', async () => {
  const llm = createMockLlm((call) => {
    if (call.kind === 'complete') return { text: `plan for ${call.req.prompt}` };
    return { text: 'stopped', usage: { input: 3, output: 4 }, approval: { rule: 1, request: 'ship it' } };
  });

  const c = await llm.complete({ model: 'm', prompt: 'x', maxTokens: 50 });
  assert.deepEqual(c, { text: 'plan for x', usage: { input: 10, output: 10 } });

  const w = await llm.work({ model: 'm', prompt: 'y', cwd: '/r' });
  assert.deepEqual(w, { text: 'stopped', usage: { input: 3, output: 4 }, approval: { rule: 1, request: 'ship it' } });

  assert.equal(llm.calls.length, 2);
  assert.deepEqual(llm.calls[0], { kind: 'complete', req: { model: 'm', prompt: 'x', maxTokens: 50 } });
  assert.equal(llm.calls[1].kind, 'work');
});

test('createMockLlm omits approval when the reply has none', async () => {
  const llm = createMockLlm(() => ({ text: 'ok' }));
  const w = await llm.work({ model: 'm', prompt: 'p' });
  assert.equal('approval' in w, false);
});
