// Runner side of the Orchestrator chat. Pops queued chat jobs, asks the Orchestrator model for a
// reply with the run's context, and appends the reply to the owner's chat. Errors become a reply,
// so a question never sits pending forever.
import { randomUUID } from 'node:crypto'
import { chatUserPrompt, runContext } from '../../lib/chat'
import { orchestratorChatSystemPrompt } from '../../lib/prompts'
import type { RunStore } from '../../lib/store'
import type { Llm } from '../../lib/llm'
import { CHAT_HISTORY_MAX, type ChatJob, type ChatMessage, type Placement } from '../../lib/types'

const NO_RUN_CONTEXT = '(The run this chat is about is no longer available.)'

export interface AnswerDeps {
  store: RunStore
  llm: Llm
  /** The Orchestrator model (Opus unless ORCHESTRATOR_MODEL says otherwise). */
  model: string
  now?: () => number
  newId?: () => string
}

/** Writes the Orchestrator's reply to `job` and returns it. Never throws for a model failure. */
export async function answerChat(job: ChatJob, deps: AnswerDeps): Promise<ChatMessage> {
  const now = deps.now ?? Date.now
  const newId = deps.newId ?? randomUUID
  const history = await deps.store.listChatMessages(job.ownerId, job.runId, CHAT_HISTORY_MAX)
  // The question itself is already in the history; the prompt carries it separately, so drop it and what follows.
  const cut = history.findIndex((m) => m.id === job.messageId)
  const transcript = cut >= 0 ? history.slice(0, cut) : history

  let context: string | undefined
  if (job.runId) {
    const run = await deps.store.getRunForEngine(job.runId)
    context = run && run.ownerId === job.ownerId ? runContext(run) : NO_RUN_CONTEXT
  }

  const base = { id: newId(), role: 'orchestrator' as const, runId: job.runId, replyTo: job.messageId, model: deps.model, createdAt: now() }
  let reply: ChatMessage
  try {
    const out = await deps.llm.complete({
      model: deps.model,
      system: orchestratorChatSystemPrompt(),
      prompt: chatUserPrompt({ message: job.text, transcript, context }),
    })
    const text = out.text.trim()
    if (text.length === 0) throw new Error('the model returned an empty reply')
    reply = { ...base, text }
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err)
    reply = { ...base, text: `I couldn't answer that: ${why}. Send it again to retry.`, error: why }
  }
  await deps.store.appendChatMessages(job.ownerId, job.runId, [reply])
  return reply
}

/** Answers up to `max` queued chat jobs from one placement's chat queue. Returns how many it handled. */
export async function answerQueuedChats(
  deps: AnswerDeps & { placement: Placement; max?: number; log?: (line: string) => void },
): Promise<number> {
  const jobs = await deps.store.popChatJobs(deps.max ?? 5, deps.placement)
  for (const job of jobs) {
    try {
      await answerChat(job, deps)
      deps.log?.(`answered chat ${job.id}`)
    } catch (err) {
      // The job is already off the queue; the owner's pending question stays visible until they resend.
      deps.log?.(`chat ${job.id} failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return jobs.length
}
