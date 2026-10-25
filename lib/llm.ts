// The model seam. Engine and runner depend only on the Llm interface here.
// The real implementation is claude-cli.ts (Claude Code CLI on the subscription).
// No Node-only APIs in this file.

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

export interface Usage {
  input: number;
  output: number;
}

// One-shot text completion. No tools, no files.
export interface CompleteRequest {
  model: string;
  system?: string;
  prompt: string;
  maxTokens?: number;
}

export interface CompleteResult {
  text: string;
  usage: Usage;
}

// Agent work: the model may read and edit files under cwd and run shell commands.
export interface WorkRequest {
  model: string;
  system?: string;
  prompt: string;
  cwd?: string;
  maxTurns?: number;
}

// Set when the agent stopped and asked for a human decision. rule is the HARD_STOP_RULES number.
export interface Approval {
  rule: 1 | 2 | 3 | 4;
  request: string;
}

export interface WorkResult {
  text: string;
  usage: Usage;
  approval?: Approval;
}

export interface Llm {
  complete(req: CompleteRequest): Promise<CompleteResult>;
  work(req: WorkRequest): Promise<WorkResult>;
}

export type MockCall = { kind: 'complete'; req: CompleteRequest } | { kind: 'work'; req: WorkRequest };

export interface MockReply {
  text: string;
  usage?: Usage;
  approval?: Approval;
}

export type MockHandler = (call: MockCall) => MockReply | Promise<MockReply>;

export interface MockLlm extends Llm {
  calls: MockCall[];
}

// For tests and the mocked end-to-end run. Records every call. The handler scripts the reply.
export function createMockLlm(handler: MockHandler): MockLlm {
  const calls: MockCall[] = [];
  const run = async (call: MockCall): Promise<MockReply> => {
    calls.push(call);
    return handler(call);
  };
  return {
    calls,
    async complete(req) {
      const reply = await run({ kind: 'complete', req: { ...req } });
      return { text: reply.text, usage: reply.usage ?? { input: 10, output: 10 } };
    },
    async work(req) {
      const reply = await run({ kind: 'work', req: { ...req } });
      return {
        text: reply.text,
        usage: reply.usage ?? { input: 10, output: 10 },
        ...(reply.approval ? { approval: reply.approval } : {}),
      };
    },
  };
}
