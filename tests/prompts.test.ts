import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HARD_STOP_RULES,
  PlanParseError,
  approvalResumePrompt,
  capPlan,
  clipReport,
  countAgents,
  finalUserPrompt,
  leadUserPrompt,
  parsePlan,
  plannerSystemPrompt,
  plannerUserPrompt,
  renderBrief,
  unitBrief,
  validatePlan,
  leadSystemPrompt,
  workerSystemPrompt,
} from '../lib/prompts';
import type { Plan, PlanUnit } from '../lib/types';

const unit = (id: string, extra: Partial<PlanUnit> = {}): PlanUnit => ({
  id,
  title: `Title ${id}`,
  brief: `Brief for ${id}. Scope: lib/${id}.ts. Done when tests pass.`,
  deps: [],
  ...extra,
});

const validPlan = {
  summary: 'Ship the thing. Done when the check passes.',
  units: [
    unit('scaffold'),
    unit('auth', { deps: ['scaffold'] }),
    unit('engine', {
      deps: ['scaffold', 'auth'],
      workers: [
        { id: 'step', title: 'Step', brief: 'Write step.ts' },
        { id: 'cron', title: 'Cron', brief: 'Write cron.ts', deps: ['step'] },
      ],
    }),
  ],
};

test('the §4 brief template renders every labelled field in order', () => {
  const text = renderBrief({
    role: 'worker',
    model: 'claude-haiku-5-5',
    goal: 'Add the parser',
    scope: 'lib/parse.ts only',
    context: 'Parse the plan.',
    doneWhen: 'Reading confirms the parser handles fences',
  });
  const labels = [
    'ROLE: worker (claude-haiku-5-5)',
    'GOAL: Add the parser',
    'SCOPE (exclusive): lib/parse.ts only',
    'CONTEXT: Parse the plan.',
    'CONSTRAINTS: ',
    'DONE WHEN: Reading confirms the parser handles fences',
    'HARD STOPS: ',
    'RETURN: report in the format below, max 150 words.',
    'STATUS: done | blocked | partial',
    'CHANGED: ',
    'VERIFIED: ',
    'RISKS/OPEN: ',
  ];
  let at = 0;
  for (const label of labels) {
    const i = text.indexOf(label, at);
    assert.notEqual(i, -1, `missing or out of order: ${label}`);
    at = i + label.length;
  }
});

test('unitBrief uses the unit title as GOAL and its brief as CONTEXT', () => {
  const text = unitBrief(unit('auth'), 'lead', 'claude-sonnet-5-5');
  assert.match(text, /^ROLE: lead \(claude-sonnet-5-5\)/);
  assert.match(text, /GOAL: Title auth/);
  assert.match(text, /CONTEXT: Brief for auth\./);
});

test('the four hard stops are listed once each, mapped to approval kinds', () => {
  assert.deepEqual(
    HARD_STOP_RULES.map((r) => [r.rule, r.kind]),
    [
      [1, 'production_deploy'],
      [2, 'destructive_op'],
      [3, 'paid_or_secret'],
      [4, 'budget_exceeded'],
    ],
  );
  const planner = plannerSystemPrompt();
  const worker = workerSystemPrompt();
  for (const r of HARD_STOP_RULES) {
    assert.ok(planner.includes(r.text), `planner missing rule ${r.rule}`);
    assert.ok(unitBrief(unit('x'), 'worker', 'm').includes(r.text.split('.')[0]), `brief missing rule ${r.rule}`);
  }
  assert.match(worker, /APPROVAL_REQUEST rule=N: /);
  assert.doesNotMatch(worker, /request_approval|list_files|read_file|write_file/);
});

test('worker and lead prompts describe repo-mode file work and never pushing', () => {
  for (const prompt of [workerSystemPrompt(), leadSystemPrompt()]) {
    assert.match(prompt, /checkout of the project at your working directory/);
    assert.match(prompt, /push nothing/);
  }
  assert.match(plannerUserPrompt('x', { repo: 'acme/app' }), /agents never push/);
});

test('the planner prompt states the agent cap, depth cap and JSON shape', () => {
  const text = plannerSystemPrompt();
  assert.match(text, /at most 30 agents/);
  assert.match(text, /deeper than 3 tiers/);
  assert.match(text, /"units": \[\{"id"/);
  assert.match(text, /Output ONLY one JSON object/);
  assert.match(plannerSystemPrompt({ maxAgents: 6 }), /at most 6 agents/);
});

test('the planner user prompt includes the repo when given', () => {
  assert.doesNotMatch(plannerUserPrompt('  build it  '), /REPO:/);
  const text = plannerUserPrompt('build it', { repo: 'acme/app' });
  assert.match(text, /TASK:\nbuild it/);
  assert.match(text, /REPO: acme\/app/);
});

test('lead and final prompts carry reports, clipped, and the cut list', () => {
  const long = 'x'.repeat(5000);
  const lead = leadUserPrompt('BRIEF', [{ id: 'w1', title: 'W1', status: 'done', report: long }]);
  assert.match(lead, /^BRIEF\n\nWORKER REPORTS:\n- w1 \(W1\) \[done\]: /);
  assert.match(lead, /\[\.\.\. clipped\]/);
  assert.ok(lead.length < 2000);

  const final = finalUserPrompt({
    task: 'T',
    summary: 'S',
    units: [{ id: 'a', title: 'A', status: 'failed', report: 'no output' }],
    cut: ['z'],
    prUrl: 'https://github.com/acme/app/pull/1',
  });
  assert.match(final, /UNIT REPORTS:\n- a \(A\) \[failed\]: no output/);
  assert.match(final, /CUT BY THE AGENT LIMIT: z/);
  assert.match(final, /PR: https:\/\/github.com\/acme\/app\/pull\/1/);
});

test('clipReport leaves short text alone and cuts long text at a line break', () => {
  assert.equal(clipReport('  short  '), 'short');
  const lines = Array.from({ length: 20 }, (_, i) => `line ${i} ${'.'.repeat(20)}`).join('\n');
  const clipped = clipReport(lines, 200);
  assert.ok(clipped.endsWith('\n[... clipped]'));
  const body = clipped.slice(0, -'\n[... clipped]'.length);
  assert.ok(body.length <= 200);
  assert.ok(lines.startsWith(body), 'clipped text must be a prefix of the original');
  assert.ok(!body.endsWith('\n'), 'cut lands on a line break, not after it');
});

test('approvalResumePrompt feeds the decision and note back for both outcomes', () => {
  const approved = approvalResumePrompt({ kind: 'production_deploy', decision: 'approved', note: 'use preview' });
  assert.match(approved, /hard stop 1/);
  assert.match(approved, /APPROVED/);
  assert.match(approved, /Owner note: use preview/);
  assert.match(approved, /You may now take that step/);

  const denied = approvalResumePrompt({ kind: 'destructive_op', decision: 'denied' });
  assert.match(denied, /hard stop 2/);
  assert.match(denied, /DENIED/);
  assert.doesNotMatch(denied, /Owner note/);
  assert.match(denied, /Do not take that step/);
});

test('parsePlan accepts raw JSON, fenced JSON and JSON inside prose', () => {
  const raw = JSON.stringify(validPlan);
  const fenced = '```json\n' + raw + '\n```';
  const prose = 'Here is the plan:\n' + raw + '\nThanks.';
  for (const input of [raw, fenced, prose]) {
    const plan = parsePlan(input);
    assert.equal(plan.summary, validPlan.summary);
    assert.deepEqual(plan.units.map((u) => u.id), ['scaffold', 'auth', 'engine']);
  }
});

test('parsePlan rejects non-JSON with a clear error', () => {
  assert.throws(() => parsePlan('no json here'), (e: unknown) => e instanceof PlanParseError && /not valid JSON/.test((e as Error).message));
});

test('validatePlan normalizes an empty workers list to a standalone unit', () => {
  const plan = validatePlan({ summary: 's', units: [{ id: 'a', title: 'A', brief: 'b', workers: [] }] });
  assert.equal(plan.units[0].workers, undefined);
  assert.deepEqual(plan.units[0].deps, []);
});

test('validatePlan reports every structural problem it finds', () => {
  const bad = {
    summary: '',
    units: [
      { id: 'a', title: 'A', brief: 'b', deps: ['ghost'] },
      { id: 'a', title: 'dup', brief: 'b', deps: ['a'] },
      { id: 'b', title: '', brief: '', deps: [], workers: [{ id: 'w', title: 'W', brief: 'x', deps: ['nope'] }] },
    ],
  };
  let message = '';
  try {
    validatePlan(bad);
  } catch (e) {
    message = (e as Error).message;
  }
  assert.match(message, /summary must be a non-empty string/);
  assert.match(message, /duplicate id "a"/);
  assert.match(message, /unit "a" depends on unknown unit "ghost"/);
  assert.match(message, /unit "a" depends on itself/);
  assert.match(message, /units\[2\] needs a title/);
  assert.match(message, /units\[2\] needs a brief/);
  assert.match(message, /worker "w" depends on unknown worker "nope"/);
});

test('validatePlan rejects dependency cycles between units and between workers', () => {
  assert.throws(
    () =>
      validatePlan({
        summary: 's',
        units: [unit('a', { deps: ['b'] }), unit('b', { deps: ['a'] })],
      }),
    /dependency cycle/,
  );
  assert.throws(
    () =>
      validatePlan({
        summary: 's',
        units: [
          unit('lead', {
            workers: [
              { id: 'w1', title: 'W1', brief: 'x', deps: ['w2'] },
              { id: 'w2', title: 'W2', brief: 'x', deps: ['w1'] },
            ],
          }),
        ],
      }),
    /dependency cycle in unit "lead"/,
  );
});

test('countAgents counts the Orchestrator, each lead and each worker', () => {
  // Orchestrator + scaffold (1) + auth (1) + engine lead with 2 workers (3)
  assert.equal(countAgents(validPlan as Plan), 6);
});

test('capPlan keeps units in order while they fit under the agent cap', () => {
  const plan = validPlan as Plan;
  // Orchestrator takes 1. Budget 4 fits scaffold (1) and auth (1) but not engine (3).
  const { plan: kept, cut } = capPlan(plan, 4);
  assert.deepEqual(kept.units.map((u) => u.id), ['scaffold', 'auth']);
  assert.deepEqual(cut, ['engine']);
  assert.equal(countAgents(kept), 3);
  assert.equal(kept.summary, plan.summary);
});

test('capPlan cuts a unit whose dependency was cut, and keeps the rest', () => {
  const plan: Plan = {
    summary: 's',
    units: [
      unit('big', { workers: [{ id: 'w1', title: 'W', brief: 'b' }, { id: 'w2', title: 'W', brief: 'b' }] }),
      unit('after-big', { deps: ['big'] }),
      unit('independent'),
    ],
  };
  // Cap 3 leaves 2 slots after the Orchestrator, so "big" (lead + 2 workers) is cut.
  const { plan: kept, cut } = capPlan(plan, 3);
  assert.deepEqual(kept.units.map((u) => u.id), ['independent']);
  assert.deepEqual(cut, ['big', 'after-big']);
});

test('capPlan leaves a plan under the cap untouched', () => {
  const { plan, cut } = capPlan(validPlan as Plan, 30);
  assert.deepEqual(cut, []);
  assert.equal(plan.units.length, 3);
});

test('workerSystemPrompt says a worker cannot run code and must keep reports short', () => {
  const text = workerSystemPrompt();
  assert.match(text, /cannot execute code/);
  assert.match(text, /under 150 words/);
  assert.match(text, /STATUS: done \| blocked \| partial/);
});
