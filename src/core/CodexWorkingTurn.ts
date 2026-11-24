import { performance } from 'node:perf_hooks'

const MAX_FRESH_MS = 10_000

export interface CodexWorkingStatus {
  v: 1
  freshForMs: number
}

interface PendingTurn {
  requestId: string | number
  responseTurnId?: string
  startedTurn?: { id: string; at: number }
}

/**
 * One instance belongs to one launch and its verified frontend connection.
 * Inputs are ordered metadata from that connection's protocol inspector.
 */
export class CodexWorkingTurn {
  private threadId?: string
  private pending?: PendingTurn
  private activeSince?: number
  private closed = false

  constructor(private readonly now: () => number = () => performance.now()) {}

  selectThread(threadId: string): void {
    if (this.closed) return
    this.clearEvidence()
    this.threadId = threadId
  }

  deselectThread(): void {
    this.threadId = undefined
    this.clearEvidence()
  }

  requestStart(threadId: string, requestId: string | number): void {
    if (this.closed || this.threadId !== threadId) return
    if (this.pending || this.activeSince !== undefined) {
      this.clearEvidence()
      return
    }
    this.pending = { requestId }
  }

  confirmStart(requestId: string | number, threadId?: string, turnId?: string): void {
    if (this.pending?.requestId !== requestId) return
    if (this.threadId !== threadId || !turnId || this.pending.responseTurnId !== undefined) {
      this.clearEvidence()
      return
    }
    this.pending.responseTurnId = turnId
    this.correlate()
  }

  observeStart(threadId: string, turnId: string): void {
    if (threadId !== this.threadId) return
    if (!this.pending || this.pending.startedTurn) {
      this.clearEvidence()
      return
    }
    this.pending.startedTurn = { id: turnId, at: this.now() }
    this.correlate()
  }

  observeEnd(threadId: string): void {
    if (threadId === this.threadId) this.clearEvidence()
  }

  clearEvidence(): void {
    this.pending = undefined
    this.activeSince = undefined
  }

  close(): void {
    this.closed = true
    this.deselectThread()
  }

  read(): CodexWorkingStatus | undefined {
    if (this.activeSince === undefined) return undefined
    const freshForMs = Math.floor(MAX_FRESH_MS - (this.now() - this.activeSince))
    if (freshForMs <= 0) return undefined
    return { v: 1, freshForMs }
  }

  private correlate(): void {
    const pending = this.pending
    if (!pending?.startedTurn || pending.responseTurnId === undefined) return
    this.clearEvidence()
    if (pending.responseTurnId === pending.startedTurn.id) {
      this.activeSince = pending.startedTurn.at
    }
  }
}
