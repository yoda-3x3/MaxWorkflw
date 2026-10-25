import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Agent } from '../../lib/types';
import {
  elapsedMs,
  formatDuration,
  formatTokens,
  reportSnippet,
  sortAgents,
} from './format';

function agent(over: Partial<Agent> & { id: string }): Agent {
  return {
    runId: 'r1',
    parentId: null,
    tier: 1,
    role: 'orchestrator',
    title: over.id,
    model: 'claude-opus-5-5',
    status: 'queued',
    brief: '',
    deps: [],
    attempts: 0,
    tokens: 0,
    createdAt: 0,
    ...over,
  };
}

test('elapsedMs: unstarted is null, running ticks to now, done stops at endedAt', () => {
  assert.equal(elapsedMs(agent({ id: 'a' }), 5000), null);
  assert.equal(elapsedMs(agent({ id: 'a', startedAt: 1000 }), 4000), 3000);
  assert.equal(
    elapsedMs(agent({ id: 'a', startedAt: 1000, endedAt: 2500 }), 9000),
    1500,
  );
});

test('elapsedMs never goes negative on clock skew', () => {
  assert.equal(elapsedMs(agent({ id: 'a', startedAt: 5000 }), 4000), 0);
});

test('formatDuration: mm:ss, and h:mm:ss past an hour', () => {
  assert.equal(formatDuration(null), '--:--');
  assert.equal(formatDuration(0), '00:00');
  assert.equal(formatDuration(65_000), '01:05');
  assert.equal(formatDuration(3_661_000), '1:01:01');
});

test('formatTokens: plain, k and M', () => {
  assert.equal(formatTokens(950), '950');
  assert.equal(formatTokens(1500), '1.5k');
  assert.equal(formatTokens(2_000_000), '2.0M');
});

test('reportSnippet: first non-empty line, trimmed and clipped', () => {
  assert.equal(reportSnippet(undefined), '');
  assert.equal(reportSnippet('\n  \n  Done: wrote API  \nmore'), 'Done: wrote API');
  assert.equal(reportSnippet('abcdefghij', 5), 'abcd…');
});

test('sortAgents: tier, then start time, then id; does not mutate input', () => {
  const input = [
    agent({ id: 'w2', tier: 3, startedAt: 30 }),
    agent({ id: 'l1', tier: 2, startedAt: 20 }),
    agent({ id: 'o', tier: 1, startedAt: 10 }),
    agent({ id: 'w1', tier: 3, startedAt: 30 }),
    agent({ id: 'w0', tier: 3, startedAt: 5 }),
  ];
  const before = input.map((a) => a.id);
  const ids = sortAgents(input).map((a) => a.id);
  assert.deepEqual(ids, ['o', 'l1', 'w0', 'w1', 'w2']);
  assert.deepEqual(input.map((a) => a.id), before);
});
