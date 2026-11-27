/**
 * A tmux name is reused when a conversation comes back to a machine, so several session
 * records can carry one name. The live one is the one callers mean: a running record
 * wins, otherwise the newest. Never reorders the caller's list.
 */
export function pickSessionByTmux<T extends { tmuxSession: string; status?: string; startedAt?: string }>(
  records: readonly T[],
  tmuxSession: string,
): T | undefined {
  const matches = records.filter((s) => s.tmuxSession === tmuxSession);
  return matches.find((s) => s.status === 'running')
    ?? matches.sort((x, y) => String(y.startedAt ?? '').localeCompare(String(x.startedAt ?? '')))[0];
}
