// Validation for the New run form's Advanced options. Shared by the route and its tests.
import { MAX_AGENTS, MODEL_CHOICES, type RunOptions } from "./types";

const MODEL_IDS = new Set<string>(MODEL_CHOICES.map((m) => m.id));

/** Validates Advanced options from the New run form. Missing or "auto"/"default" values are dropped. */
export function parseRunOptions(raw: unknown): { options?: RunOptions } | { error: string } {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object") return { error: "options must be an object" };
  const o = raw as Record<string, unknown>;
  const options: RunOptions = {};
  if (o.runOn !== undefined) {
    if (o.runOn !== "auto" && o.runOn !== "pc" && o.runOn !== "cloud") return { error: "runOn must be auto, pc or cloud" };
    if (o.runOn !== "auto") options.runOn = o.runOn;
  }
  if (o.shape !== undefined) {
    if (o.shape !== "auto" && o.shape !== "three-tier" && o.shape !== "flat") return { error: "shape must be auto, three-tier or flat" };
    if (o.shape !== "auto") options.shape = o.shape;
  }
  if (o.maxAgents !== undefined && o.maxAgents !== null && o.maxAgents !== "") {
    const n = Number(o.maxAgents);
    if (!Number.isInteger(n) || n < 2 || n > MAX_AGENTS) return { error: `maxAgents must be a whole number from 2 to ${MAX_AGENTS}` };
    options.maxAgents = n;
  }
  if (o.models !== undefined && o.models !== null) {
    if (typeof o.models !== "object") return { error: "models must be an object" };
    const models: NonNullable<RunOptions["models"]> = {};
    for (const role of ["orchestrator", "lead", "worker"] as const) {
      const v = (o.models as Record<string, unknown>)[role];
      if (v === undefined || v === null || v === "" || v === "default") continue;
      if (typeof v !== "string" || !MODEL_IDS.has(v)) return { error: `unknown model for ${role}` };
      models[role] = v;
    }
    if (Object.keys(models).length) options.models = models;
  }
  return Object.keys(options).length ? { options } : {};
}
