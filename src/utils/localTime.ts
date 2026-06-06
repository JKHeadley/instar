/**
 * Local-timezone timestamp rendering for agent-facing context blocks.
 *
 * Why this exists (2026-06-05 time-incoherency incident): every injected
 * thread-history surface rendered timestamps as unlabeled UTC
 * (`toISOString().slice(11, 19)`). An agent read `[21:23:10]` as local
 * wall-clock and told the user "you heard nothing between 9:23pm and now"
 * about an event that happened at 2:23pm the user's time — while the
 * session-start hook injects CURRENT TIME in local time. Two clocks, one
 * labeled, one not.
 *
 * Structure > Willpower: agents cannot be trusted to remember that history
 * timestamps are UTC while wall-clock is local. Every timestamp an agent
 * sees MUST be rendered in the host's local timezone with an explicit
 * timezone label, so no conversion discipline is required.
 *
 * All thread-history / topic-context / compaction-resume renderers MUST use
 * this helper instead of hand-rolling `toISOString()` slices.
 */

/**
 * The host's short timezone label for a given instant (e.g. "PDT", "GMT+2").
 * Empty string if Intl can't resolve one — callers render without a label
 * rather than failing.
 */
export function localTzAbbreviation(d: Date = new Date()): string {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' })
      .formatToParts(d)
      .find((p) => p.type === 'timeZoneName');
    return part?.value ?? '';
  } catch {
    return '';
  }
}

/**
 * Format a timestamp in the HOST's local timezone with an explicit tz label.
 *
 * Default shape: `2026-06-05 14:23 PDT` (date + minutes + label) — history
 * lines spanning midnight stay unambiguous, and minute granularity matches
 * how users talk about time. Options:
 *   - `date: false`   → `14:23 PDT` (for compact status lines)
 *   - `seconds: true` → include `:SS`
 *
 * Invalid / missing input renders as `??:??` (the existing sentinel the
 * history formats already used).
 */
export function formatLocalTimestamp(
  input: string | number | Date | null | undefined,
  opts: { date?: boolean; seconds?: boolean } = {},
): string {
  if (input == null || input === '') return '??:??';
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return '??:??';
  const pad = (n: number) => String(n).padStart(2, '0');
  const datePart =
    opts.date === false ? '' : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}${opts.seconds ? `:${pad(d.getSeconds())}` : ''}`;
  const tz = localTzAbbreviation(d);
  return `${datePart}${time}${tz ? ` ${tz}` : ''}`;
}
