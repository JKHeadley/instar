/**
 * userNotices — the catalog of fixed notices the SERVER writes to the user
 * itself (not a session reply, not an LLM-composed message).
 *
 * Standard: docs/UX-AND-AGENT-AGENCY-STANDARD.md → Rule 8 "Plain and
 * Complete". Every notice here must say, in plain language, what happened,
 * what it means for the person, and what they need to do (if anything) —
 * never so vague it is useless, never so technical it can't be digested.
 *
 * Why a catalog: these notices go out on deterministic delivery paths that
 * deliberately bypass the LLM tone gate (an alarm must still arrive when the
 * model is down — "The Operator Channel Is Sacred"). So their wording is
 * checked at TEST time instead: tests/unit/userNotices.test.ts renders every
 * entry in USER_NOTICE_CATALOG with realistic inputs and runs it through
 * findPlainNoticeProblems(). scripts/lint-plain-user-notices.mjs keeps new
 * raw internal reasons from being pasted into user text at send sites.
 *
 * Internal detail (timeouts, reason codes, ids) belongs in logs, never here.
 */

/** A machine name safe to show the person; never an id. Rule 7: an
 *  unresolved name is stated plainly ("another machine"), not replaced by an id. */
const MACHINE_NAME_RE = /^[A-Za-z0-9 '’-]{1,40}$/;
export function plainMachineName(name: string | null | undefined): string {
  const n = (name ?? '').trim();
  if (!MACHINE_NAME_RE.test(n)) return 'another machine';
  // A bare machine id (hex/uuid-ish, no spaces) is not a name.
  if (!/\s/.test(n) && /^[0-9a-f-]{8,}$/i.test(n)) return 'another machine';
  // "the Mac Studio", but "Justin's Laptop" and "The Den" stay as they are.
  if (/^the\s/i.test(n) || /['’]s\b/i.test(n)) return n;
  return `the ${n}`;
}

/**
 * The conversation moved to another machine before the session reached a
 * stopping point (the move waited its full allowance, then closed it).
 * Nothing re-checks the cut-off step automatically, so the notice tells the
 * person how to get it checked rather than promising a check.
 */
export function movedMachinesMidStepNotice(targetMachineName: string | null | undefined): string {
  const where = plainMachineName(targetMachineName);
  return `I moved this conversation to ${where} before I'd finished my last step, so that step may be incomplete. `
    + `The conversation carries on there. If that step matters, ask me to check it.`;
}

/** A message arrived for a conversation whose session had stopped; a new one is starting. */
export const SESSION_RESTARTING_NOTICE =
  `🔄 My session for this conversation had stopped, so I'm starting a new one. Your message is saved and I'll answer it once I'm back.`;

/** The replacement session is up and no message was waiting (e.g. a stuck session was
 *  replaced). With a message waiting nothing is sent: the reply is the confirmation. */
export const SESSION_BACK_NOTICE = `I've restarted my session for this conversation and I'm ready.`;

/** Boot sweep found the conversation running without the model settings the person chose. */
export const PROFILE_REAPPLY_NOTICE =
  `The model settings you chose for this conversation didn't take effect when I last restarted. `
  + `I'm applying them now, which means a brief restart once I'm idle.`;

/**
 * Exact texts of server lifecycle notices that are NOT agent replies.
 * isSystemOrProxyMessage() reads this so a reworded notice is never mistaken
 * for a real answer. Old wordings stay listed: they are still in message history.
 */
export const LIFECYCLE_NOTICE_EXACT: ReadonlySet<string> = new Set([
  SESSION_BACK_NOTICE,
  'Session respawned.',
  'Session terminated.',
]);
export const LIFECYCLE_NOTICE_PREFIXES: readonly string[] = [
  '🔄 Session restarting', // legacy wording, still in history
  '🔄 My session for this conversation had stopped', // SESSION_RESTARTING_NOTICE
  'I moved this conversation to ',
  'This conversation moved machines mid-task', // legacy wording
];

/** Every catalogued notice rendered with realistic inputs — the test surface. */
export const USER_NOTICE_CATALOG: ReadonlyArray<{ id: string; render: () => string }> = [
  { id: 'moved-machines-mid-step', render: () => movedMachinesMidStepNotice('Mac Studio') },
  { id: 'moved-machines-mid-step:unnamed', render: () => movedMachinesMidStepNotice(null) },
  { id: 'moved-machines-mid-step:id-only', render: () => movedMachinesMidStepNotice('m_03b30f5b32c6ef3eb0afd3ca7054e252') },
  { id: 'session-restarting', render: () => SESSION_RESTARTING_NOTICE },
  { id: 'session-back', render: () => SESSION_BACK_NOTICE },
  { id: 'profile-reapply', render: () => PROFILE_REAPPLY_NOTICE },
];
