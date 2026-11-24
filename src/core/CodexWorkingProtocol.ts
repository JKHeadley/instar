import { CodexWorkingTurn } from './CodexWorkingTurn.js'

export const MAX_OBSERVED_BYTES = 64 * 1024
const MAX_ID_LENGTH = 256

type RequestId = string | number

function record(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return undefined
}

function stringId(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH) return value
  return undefined
}

function requestId(value: unknown): RequestId | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value
  return stringId(value)
}

/**
 * Observes complete text messages on one verified local frontend connection.
 * The transport forwards bytes independently, and calls skipMessage as soon
 * as it abandons inspection of a message.
 */
export class CodexWorkingProtocol {
  private selectedThread?: string
  private threadRequest?: RequestId
  private stopped = false

  constructor(private readonly turn: CodexWorkingTurn) {}

  inspect(direction: 'frontend' | 'backend', message: Buffer): void {
    if (this.stopped) return
    if (message.byteLength > MAX_OBSERVED_BYTES) {
      this.skipMessage(direction)
      return
    }

    let rpc: Record<string, unknown> | undefined
    try {
      rpc = record(JSON.parse(message.toString('utf8')))
    } catch {
      // @silent-fallback-ok: clearing evidence only withdraws an optional badge.
      this.skipMessage(direction)
      return
    }
    if (!rpc) {
      this.skipMessage(direction)
      return
    }

    if (direction === 'frontend') this.frontend(rpc)
    else this.backend(rpc)
  }

  stopObservation(): void {
    this.stopped = true
    this.skipMessage('frontend')
    this.turn.close()
  }

  skipMessage(direction: 'frontend' | 'backend'): void {
    this.threadRequest = undefined
    this.turn.clearEvidence()
    if (direction === 'backend') return
    // A skipped request might replace the selected thread. Require fresh
    // selection before attributing more work to this connection.
    this.selectedThread = undefined
    this.turn.deselectThread()
  }

  private frontend(rpc: Record<string, unknown>): void {
    const id = requestId(rpc.id)
    const params = record(rpc.params)
    // The TUI can use an ephemeral thread for auxiliary work after a resume.
    if (rpc.method === 'thread/start' && params?.ephemeral === true) return
    if (rpc.method === 'thread/start' || rpc.method === 'thread/resume') {
      if (this.threadRequest !== undefined) {
        this.skipMessage('frontend')
        return
      }
      this.skipMessage('frontend')
      this.threadRequest = id
      return
    }

    if (rpc.method === 'thread/fork') {
      this.skipMessage('frontend')
      return
    }

    const thread = stringId(params?.threadId)
    if (!thread || thread !== this.selectedThread) return
    if (rpc.method === 'turn/start' && id !== undefined) this.turn.requestStart(thread, id)
    if (rpc.method === 'turn/interrupt') this.turn.observeEnd(thread)
  }

  private backend(rpc: Record<string, unknown>): void {
    const id = requestId(rpc.id)
    const result = record(rpc.result)
    if (id !== undefined && id === this.threadRequest && rpc.method === undefined) {
      this.threadRequest = undefined
      const thread = stringId(record(result?.thread)?.id)
      if (thread && rpc.error === undefined) {
        this.selectedThread = thread
        this.turn.selectThread(thread)
      }
      return
    }

    if (id !== undefined && rpc.method === undefined) {
      const nativeTurn = record(result?.turn)
      const turnId = rpc.error === undefined && nativeTurn?.status === 'inProgress'
        ? stringId(nativeTurn.id)
        : undefined
      this.turn.confirmStart(id, this.selectedThread, turnId)
      return
    }

    const params = record(rpc.params)
    const thread = stringId(params?.threadId)
    if (!thread || thread !== this.selectedThread) return
    if (rpc.method === 'turn/completed') this.turn.observeEnd(thread)
    if (rpc.method === 'turn/started') {
      const turnId = stringId(record(params?.turn)?.id)
      if (turnId) this.turn.observeStart(thread, turnId)
      else this.turn.clearEvidence()
    }
  }
}
