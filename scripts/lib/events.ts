// Batches progress events into fewer Upstash writes. A flush happens when the batch is full,
// when the timer fires, or on close. A failed write keeps its lines for the next attempt.

export interface EventBatcherOptions {
  write: (lines: string[]) => Promise<void>
  maxItems?: number
  flushMs?: number
  /** Upper bound on buffered lines while Upstash is down. Oldest lines are dropped past it. */
  maxBuffered?: number
  onError?: (err: unknown) => void
}

export interface EventBatcher {
  push(event: object): void
  flush(): Promise<void>
  close(): Promise<void>
  /** Lines waiting to be written. */
  pending(): number
}

export function createEventBatcher(opts: EventBatcherOptions): EventBatcher {
  const maxItems = opts.maxItems ?? 20
  const flushMs = opts.flushMs ?? 1000
  const maxBuffered = opts.maxBuffered ?? 1000
  let buffer: string[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  let inFlight: Promise<void> = Promise.resolve()

  const clearTimer = () => {
    if (timer) clearTimeout(timer)
    timer = undefined
  }

  const flush = (): Promise<void> => {
    clearTimer()
    // The batch is taken now, so events pushed later go to the next batch. Writes still run one at
    // a time, so the list keeps event order.
    const batch = buffer
    buffer = []
    if (batch.length === 0) return inFlight
    inFlight = inFlight.then(async () => {
      try {
        await opts.write(batch)
      } catch (err) {
        buffer = [...batch, ...buffer].slice(-maxBuffered)
        opts.onError?.(err)
      }
    })
    return inFlight
  }

  return {
    push(event) {
      buffer.push(JSON.stringify(event))
      if (buffer.length > maxBuffered) buffer = buffer.slice(-maxBuffered)
      if (buffer.length >= maxItems) {
        void flush()
        return
      }
      if (!timer) {
        timer = setTimeout(() => void flush(), flushMs)
        timer.unref?.()
      }
    },
    flush,
    async close() {
      await flush()
    },
    pending: () => buffer.length,
  }
}
