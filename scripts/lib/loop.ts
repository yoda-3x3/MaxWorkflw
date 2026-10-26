// Drives engine steps until the engine says nothing more is runnable, or the time budget runs out.
export interface StepOutcome {
  action: string
  more: boolean
}

export interface LoopOptions {
  step: () => Promise<StepOutcome>
  /** Stop starting new steps once this much time has passed. */
  budgetMs: number
  /** Pause between steps. */
  gapMs: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  log?: (line: string) => void
  /** Checked before each step. True ends the loop after the current step, never mid-step. */
  shouldStop?: () => boolean
}

export interface LoopResult {
  steps: number
  stoppedBy: 'idle' | 'budget' | 'stopped'
  lastAction: string | null
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export async function runLoop(opts: LoopOptions): Promise<LoopResult> {
  const now = opts.now ?? Date.now
  const sleep = opts.sleep ?? defaultSleep
  const log = opts.log ?? (() => {})
  const start = now()
  let steps = 0
  let lastAction: string | null = null

  for (;;) {
    if (opts.shouldStop?.()) return { steps, stoppedBy: 'stopped', lastAction }
    const outcome = await opts.step()
    steps += 1
    lastAction = outcome.action
    log(`step ${steps}: ${outcome.action}${outcome.more ? '' : ' (stop)'}`)
    if (!outcome.more) return { steps, stoppedBy: 'idle', lastAction }
    if (now() - start >= opts.budgetMs) return { steps, stoppedBy: 'budget', lastAction }
    if (opts.shouldStop?.()) return { steps, stoppedBy: 'stopped', lastAction }
    await sleep(opts.gapMs)
  }
}
