# Orchestrator chat

The dashboard has a chat with the Orchestrator. Ask it about the general state of your work, or
about one run: its plan, what each agent reported, pending approvals, and the final report.

The Worker can't run models, so the chat works the same way as runs: the site stores the message
and queues a job, and the runner answers it with the Orchestrator model (Opus, or
`ORCHESTRATOR_MODEL`) on your Claude subscription. The reply is written back to the same chat, and
the page polls until it arrives.

## Where things run

- **PC runner online:** the job goes to the PC's chat queue. The PC answers between engine steps of
  a running run, or straight away when idle, so a chat waits at most one step.
- **PC runner offline:** the job goes to the cloud runner's chat queue and the cloud runner is
  started (the same rule as Auto runs). If GitHub can't start it, the reply says so in the chat
  and the question stays queued until a runner picks it up.

## Storage (Upstash)

| Key | Contents |
| --- | --- |
| `chat:<owner>:general` | the general chat, oldest first |
| `chat:<owner>:run:<runId>` | one run's chat |
| `chatjob:<jobId>` | the queued question, expires after 24 h |
| `runner:chat`, `runner:chat:cloud` | queue of job ids (PC, cloud) |

Each chat keeps its newest 200 messages and expires 30 days after the last message. Messages are
append-only: a reply is a new `assistant` message with `replyTo` set to the question it answers.
A question with no reply yet is "pending".

## HTTP API

`GET /api/chat[?runId=<id>]` returns `{ messages, pending, runner: { online } }`. `pending` lists
the user message ids still waiting for a reply.

`POST /api/chat` takes `{ text, runId? }` and returns `201 { message, placement, cloudError? }`.
Text is 1 to 4000 characters. A run chat is owner-only: another run id gets `404`.

Both routes need a session, like the other API routes.

## What the Orchestrator sees

For a run chat, the prompt includes the run's status, task, repo, plan summary, every agent's
status and clipped report, pending approvals, final report and error. For the general chat there
is no run context. Each prompt also carries the last 20 messages of the conversation.

The Orchestrator answers in text only. It cannot start runs, edit files, or approve or deny
anything from chat. It tells you what to do instead.

## Failures

A model error or an empty reply is written back as an `assistant` message with `error` set, and
the text says why ("I couldn't answer that: rate limited. Send it again to retry."). The question
is never left pending on a model failure.

If the runner dies mid-answer, the question stays pending. Send it again.

## Code map

- `lib/types.ts`: `ChatMessage`, `ChatJob`, limits.
- `lib/chat.ts`: validation, pending detection, run context, prompt building (pure).
- `lib/prompts.ts`: `orchestratorChatSystemPrompt()`.
- `lib/store.ts`: `appendChatMessages`, `listChatMessages`, `enqueueChatJob`, `popChatJobs`.
- `app/api/chat/route.ts`: GET and POST.
- `scripts/lib/chat.ts`: `answerChat` and `answerQueuedChats` (runner side).
- `scripts/runner.ts`: drains the chat queue between engine steps and when idle.

Tests: `tests/chat.test.ts`, `tests/chat-store.test.ts`, `tests/chat-runner.test.ts`,
`tests/chat-routes.test.ts`.
