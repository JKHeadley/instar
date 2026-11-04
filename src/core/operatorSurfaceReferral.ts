/**
 * operatorSurfaceReferral — is this outbound message sending the operator to a surface, and
 * does it carry what they need to get there? (docs/specs/operator-needs-first-screen.md)
 *
 * SIGNAL ONLY, no I/O. It anchors B22_SURFACE_REFERRAL in the tone gate, which judges by
 * meaning whether this is really a referral. It lives outside GateSignalDetectors on purpose:
 * every hit there counts as a leak on the gate's outage path, and a referral is not a leak.
 */
export interface SurfaceReferralSignal {
  referral: boolean;
  /** The phrase that looked like a referral; bounded, rendered as an inert token. */
  phrase?: string;
  hasLink: boolean;
  /** Exact words in quotes, for the operator to look for on screen. */
  hasOnScreenWords: boolean;
}

const SURFACE = String.raw`(?:dashboard|console|(?:[A-Z][\w&’'-]*\s){1,3}(?:page|tab|section)|(?:\w+\s)?(?:page|tab)\b)`;
const SEND = String.raw`\b(?:open|go to|head to|visit|tap|click|press|check|look at|see|use|find)\b[^.!?\n]{0,50}?\b` + SURFACE;
const ON = String.raw`\b(?:on|in|at)\s+the\s+[^.!?\n]{0,30}?\b(?:dashboard|console|page|tab)\b[^.!?\n]{0,40}?\b(?:tap|click|press|button|turn|approve|choose|open)\b`;
const REFERRAL = new RegExp(`${SEND}|${ON}`, 'i');
const LINK = /\bhttps?:\/\/[^\s)>\]]+|(?:^|\s)#\/[\w/-]+/i;
/** Long enough for any real message; the checks stay linear on a pathological one. */
const SCAN_LIMIT = 8000;
const CLOSER: Record<string, string> = { '“': '”', '"': '"', '`': '`', '‘': '’' };

/** Words in real quotes. Straight apostrophes are left out so "don't … it's" is not a quote. */
function hasQuotedWords(t: string): boolean {
  for (let i = 0; i < t.length; i++) {
    const close = CLOSER[t[i]];
    if (!close) continue;
    const end = t.indexOf(close, i + 1);
    if (end < 0) continue;
    if (/[A-Za-z]/.test(t.slice(i + 1, end)) && !t.slice(i + 1, end).includes('\n')) return true;
    i = end;
  }
  return false;
}

export function detectSurfaceReferral(text: string): SurfaceReferralSignal {
  const t = String(text ?? '').slice(0, SCAN_LIMIT);
  const m = REFERRAL.exec(t);
  // Only a referral needs the rest; ordinary replies pay for one bounded regex.
  if (!m) return { referral: false, hasLink: false, hasOnScreenWords: false };
  return { referral: true, phrase: m[0].slice(0, 80), hasLink: LINK.test(t), hasOnScreenWords: hasQuotedWords(t) };
}
