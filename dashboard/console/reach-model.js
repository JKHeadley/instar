// Who can reach me (docs/specs/team-roles-and-access.md §3.10). Pure: words and rows from
// GET /team/people?scope=pool. A partial pool read never reads as complete.

const TIER = { owner: 'Owner', admin: 'Admin', member: 'Member', guest: 'Guest', unknown: 'Not on your people list' };

/** "Admin (MSP)", "Member", "Not on your people list". */
export function tierWords(row) {
  const label = TIER[row.tier] ?? TIER.unknown;
  return row.relationship === 'msp' ? `${label} (MSP)` : label;
}

/** The first line of the page, and whether it needs the owner. */
export function reachHeadline({ count, privacyOn, pool }) {
  const who = count === 'anyone' ? 'Anyone' : count === 1 ? 'Only you' : `${count} people`;
  const risky = count !== 1 && privacyOn === false;
  const sub = [];
  if (risky) sub.push('Memory privacy is off, so what one person tells it can reach another.');
  if (pool && pool.complete === false) sub.push('Some machines did not answer, so this list may be incomplete.');
  return { text: `${who} can reach this agent.`, sub: sub.join(' ') || undefined, tone: risky ? 'warn' : undefined };
}

export function personRow(row) {
  return {
    key: row.key,
    title: row.name,
    tier: tierWords(row),
    reach: (row.reach ?? []).map((r) => r.detail).join(', '),
    sees: row.sees ?? '',
    warnings: row.warnings ?? [],
  };
}

export function buildReachPage(res) {
  if (!res || !res.ok || !res.data) return { ok: false, reason: res?.reason || 'I could not read who can reach this agent.' };
  const d = res.data;
  return {
    ok: true,
    head: reachHeadline({ count: d.count, privacyOn: d.privacyOn, pool: d.pool }),
    rows: (d.people ?? []).map(personRow),
    notes: [
      ...(d.privacyOn === false && d.count !== 1 ? ['To change this, say "turn on memory privacy" in your chat with me.'] : []),
      ...(d.telegramOpenToGroup ? ['Anyone in the Telegram group can message me, and Telegram does not let me list everyone in it.'] : []),
      ...(d.pool?.failed ?? []).map((f) => `${f.machineId} did not answer.`),
    ],
  };
}
