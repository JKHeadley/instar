interface RolloutEvent {
  type?: unknown;
  payload?: {
    type?: unknown;
    turn_id?: unknown;
    item?: { type?: unknown; id?: unknown; content?: unknown };
  };
}

export interface ManagedCodexStopCycle {
  assistantItemId: string;
  byteOffset: number;
  turnId: string;
}

/**
 * Attribute a Stop callback against the complete verified native turn history.
 * The caller verifies the rollout identity and bounds the captured bytes.
 * A truncated prefix cannot establish uniqueness and must not be supplied.
 */
export function attributeManagedCodexStopCycle(
  rollout: string,
  turnId: string,
  assistantMessage: string,
): ManagedCodexStopCycle | undefined {
  if (!turnId || !assistantMessage || !rollout.endsWith('\n')) return;

  let byteOffset = 0;
  let latest: ManagedCodexStopCycle | undefined;
  let matching: ManagedCodexStopCycle | undefined;
  for (const line of rollout.slice(0, -1).split('\n')) {
    const offset = byteOffset;
    byteOffset += Buffer.byteLength(line) + 1;
    let event: RolloutEvent;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }

    const payload = event?.payload;
    const item = payload?.item;
    if (event?.type !== 'event_msg' || payload?.type !== 'item_completed'
      || item?.type !== 'AgentMessage') continue;
    if (typeof payload.turn_id !== 'string' || typeof item.id !== 'string'
      || !item.id || !Array.isArray(item.content)) return;

    latest = { assistantItemId: item.id, byteOffset: offset, turnId: payload.turn_id };
    if (payload.turn_id !== turnId) continue;
    const message = item.content
      .filter(part => part?.type === 'Text' && typeof part.text === 'string')
      .map(part => part.text)
      .join('');
    if (message !== assistantMessage) continue;
    if (matching) return;
    matching = latest;
  }
  return matching === latest ? matching : undefined;
}
