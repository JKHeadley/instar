/** Monitor-produced native process proof. Reads never probe the OS. */
export interface IdleNativeBinding {
  readonly sessionId: string;
  readonly topicKey: string;
  readonly ownerMachineId: string;
  readonly ownerEpoch: string;
  readonly paneId: string;
  readonly launchId: string;
}

export interface NativeProcessSample {
  readonly pid: number;
  /** An opaque kernel identity, distinct across PID reuse. A wall-clock sample is insufficient. */
  readonly kernelStartToken: string;
}

interface SampleTicket {
  readonly binding: IdleNativeBinding;
  readonly sampledAtMs: number;
}

interface CachedProcess {
  readonly ticket: SampleTicket;
  process: NativeProcessSample | null;
  completed: boolean;
}

function matches(a: IdleNativeBinding, b: IdleNativeBinding): boolean {
  return a.sessionId === b.sessionId && a.topicKey === b.topicKey
    && a.ownerMachineId === b.ownerMachineId && a.ownerEpoch === b.ownerEpoch
    && a.paneId === b.paneId && a.launchId === b.launchId;
}

function complete(binding: IdleNativeBinding): boolean {
  return !!(binding.sessionId && binding.topicKey && binding.ownerMachineId
    && binding.ownerEpoch && binding.paneId && binding.launchId);
}

export class IdleNativeProcessCache {
  private readonly rows = new Map<string, CachedProcess>();

  /** Freshness limit comes from the monitor policy. Times use its monotonic clock. */
  constructor(private readonly freshnessMs: number) {
    if (!Number.isFinite(freshnessMs) || freshnessMs <= 0) throw new RangeError('Invalid native proof freshness');
  }

  /** Start a monitor observation under a new ticket. Older callbacks lose authority immediately. */
  begin(binding: IdleNativeBinding, nowMs: number): SampleTicket | null {
    if (!complete(binding) || !Number.isFinite(nowMs)) return null;
    const previous = this.rows.get(binding.sessionId);
    if (previous && nowMs < previous.ticket.sampledAtMs) return null;
    const ticket = Object.freeze({ binding: Object.freeze({ ...binding }), sampledAtMs: nowMs });
    this.rows.set(binding.sessionId, { ticket, process: null, completed: false });
    return ticket;
  }

  /** The monitor must verify native executable and lineage before supplying a process. */
  observe(
    ticket: SampleTicket,
    after: IdleNativeBinding | null,
    nativeProcesses: readonly NativeProcessSample[],
    nowMs: number,
  ): boolean {
    const row = this.rows.get(ticket.binding.sessionId);
    if (!row || row.ticket !== ticket || row.completed) return false;
    row.completed = true;
    if (!after || !matches(ticket.binding, after) || nativeProcesses.length !== 1
      || !this.fresh(ticket, nowMs)) return false;
    const process = nativeProcesses[0];
    if (!Number.isSafeInteger(process.pid) || process.pid <= 0 || !process.kernelStartToken) return false;
    row.process = { ...process };
    return true;
  }

  /** The monitor retires exact launch evidence when it drops an active binding. */
  retire(binding: IdleNativeBinding): void {
    const row = this.rows.get(binding.sessionId);
    if (row && matches(row.ticket.binding, binding)) this.rows.delete(binding.sessionId);
  }

  /** A cache miss, expiration, or displaced binding leaves identity unknown. */
  read(binding: IdleNativeBinding, nowMs: number): string | null {
    const row = this.rows.get(binding.sessionId);
    if (!row?.process || !this.fresh(row.ticket, nowMs) || !matches(row.ticket.binding, binding)) return null;
    return JSON.stringify([binding.launchId, binding.paneId, row.process.pid, row.process.kernelStartToken]);
  }

  private fresh(ticket: SampleTicket, nowMs: number): boolean {
    const age = nowMs - ticket.sampledAtMs;
    return Number.isFinite(age) && age >= 0 && age < this.freshnessMs;
  }
}
