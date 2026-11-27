interface NativeHookPromptEvent {
  type?: unknown;
  payload?: {
    type?: unknown;
    turn_id?: unknown;
    item?: { type?: unknown; id?: unknown; fragments?: unknown };
  };
}

/**
 * Match a complete native receipt from the verified rollout, starting on the
 * saved record boundary. The caller binds the rollout and turn to the enrolled
 * worker and supplies only the bounded suffix after the directive was issued.
 */
export function matchManagedCodexStopReceipt(
  suffix: string,
  expectedTurn: string,
  marker: string,
): string | undefined {
  const lastNewline = suffix.lastIndexOf('\n');
  if (lastNewline < 0 || !expectedTurn || !/^[A-Za-z0-9_-]+$/.test(marker)) return;

  const token = new RegExp('(?:^|\\s)' + marker + '(?=\\s|$)');
  let receipt: string | undefined;
  for (const line of suffix.slice(0, lastNewline).split('\n')) {
    let event: NativeHookPromptEvent;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }

    const payload = event?.payload;
    const item = payload?.item;
    if (event?.type !== 'event_msg' || payload?.type !== 'item_completed'
      || payload.turn_id !== expectedTurn || item?.type !== 'HookPrompt'
      || typeof item.id !== 'string' || !item.id || !Array.isArray(item.fragments)) continue;

    const containsMarker = item.fragments.some((fragment: unknown) =>
      fragment !== null && typeof fragment === 'object' && !Array.isArray(fragment)
      && Object.values(fragment).some((value: unknown) => typeof value === 'string' && token.test(value)));
    if (!containsMarker) continue;
    if (receipt !== undefined) return;
    receipt = item.id;
  }
  return receipt;
}
