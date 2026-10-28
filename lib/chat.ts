// Pure helpers for the Orchestrator chat: validation, pending detection, and the prompt the runner
// sends. No I/O, so the site (Workers) and the runner share them and tests cover them directly.
import { clipReport } from "./prompts";
import { CHAT_MAX_CHARS, type ChatMessage, type Run } from "./types";

/** Messages of the conversation sent with each question. Older ones are left out. */
export const CHAT_CONTEXT_MESSAGES = 20;
const CHAT_MESSAGE_CLIP = 1500;
const RUN_TASK_CLIP = 2000;
const RUN_REPORT_CLIP = 800;
const RUN_FINAL_CLIP = 4000;

/** Trimmed owner text, or null when it is empty, not a string, or over CHAT_MAX_CHARS. */
export function cleanChatText(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (text.length === 0 || text.length > CHAT_MAX_CHARS) return null;
  return text;
}

/** Owner messages with no orchestrator reply yet, oldest first. */
export function pendingMessageIds(messages: ChatMessage[]): string[] {
  const answered = new Set(
    messages.filter((m) => m.role === "orchestrator" && m.replyTo).map((m) => m.replyTo as string),
  );
  return messages.filter((m) => m.role === "owner" && !answered.has(m.id)).map((m) => m.id);
}

/**
 * What the Orchestrator knows about a run: task, plan summary, each unit's status and report, and the
 * final report. Clipped so a big run still fits the prompt.
 */
export function runContext(run: Run): string {
  const lines: string[] = [`RUN ${run.id} | status: ${run.status}`];
  lines.push("TASK:", clip(run.task, RUN_TASK_CLIP));
  if (run.repo) lines.push(`REPO: ${run.repo}`);
  if (run.plan) lines.push("", "PLAN SUMMARY:", run.plan.summary);
  if (run.agents.length > 0) {
    lines.push("", "AGENTS:");
    for (const a of run.agents) {
      const report = a.report ? clipReport(a.report, RUN_REPORT_CLIP) : a.error ? `error: ${a.error}` : "(no report yet)";
      lines.push(`- ${a.id} (${a.title}, ${a.role}) [${a.status}]: ${report}`);
    }
  }
  const pending = run.approvals.filter((a) => a.status === "pending");
  if (pending.length > 0) {
    lines.push("", "WAITING FOR APPROVAL:", ...pending.map((a) => `- ${a.kind}: ${a.request}`));
  }
  if (run.finalReport) lines.push("", "FINAL REPORT:", clip(run.finalReport, RUN_FINAL_CLIP));
  if (run.error) lines.push("", `ERROR: ${run.error}`);
  return lines.join("\n");
}

/** The user prompt: run context (if any), the recent conversation, then the new question. */
export function chatUserPrompt(args: { message: string; transcript: ChatMessage[]; context?: string }): string {
  const lines: string[] = [];
  if (args.context) lines.push("RUN CONTEXT:", args.context, "");
  const recent = args.transcript.slice(-CHAT_CONTEXT_MESSAGES);
  if (recent.length > 0) {
    lines.push("CONVERSATION SO FAR:");
    for (const m of recent) {
      lines.push(`${m.role === "owner" ? "Owner" : "Orchestrator"}: ${clip(m.text, CHAT_MESSAGE_CLIP)}`);
    }
    lines.push("");
  }
  lines.push("OWNER'S NEW MESSAGE:", args.message);
  return lines.join("\n");
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n[... clipped]`;
}
