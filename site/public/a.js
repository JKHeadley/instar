// Fallback page for permanent agent links (docs/specs/permanent-agent-links.md §1, §4).
// Link v1: https://instar.sh/a#v=1&i=<64-hex agent id>&t=home|doc|conversation[&r=<ref>][&c=<comment key>]
// The fragment is never sent to this server in the page request. This script reads it locally,
// never inserts it as HTML, and makes no network request (the page's CSP sets connect-src 'none').
// It is a same-origin file, not an inline script: the page's CSP blocks inline scripts.

const ID_RE = /^[0-9a-f]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TG_RE = /^tg:[1-9][0-9]{0,15}$/; // plus value <= Number.MAX_SAFE_INTEGER (checked below)
// The server's comment-key pattern (src/documents/rows.ts isCommentKey): author key, ':', comment uuid.
const COMMENT_RE = /^[A-Za-z0-9._:-]{1,200}:[0-9a-f-]{36}$/;
const FIELDS = { home: [], doc: ['r', 'c'], conversation: ['r'], card: ['r'] };
/** The longest valid fragment, computed from the field patterns (no separately chosen cap). */
export const MAX_FRAGMENT = 'v=1&i=&t=conversation&r=&c='.length + 64 + 36 + 3 * 237;
// (3x: a comment key may arrive percent-encoded, ':' as %3A.)

/**
 * Parse a v1 agent-link fragment (with or without the leading '#').
 * Returns { id, target, ref, comment } or null when the link is not a valid v1 link.
 */
export function parseAgentLink(hash) {
  if (typeof hash !== 'string') return null;
  const raw = hash.replace(/^#/, '');
  if (!raw || raw.length > MAX_FRAGMENT) return null;
  const q = new Map();
  for (const kv of raw.split('&')) {
    const i = kv.indexOf('=');
    if (i <= 0) return null;
    const k = kv.slice(0, i);
    if (!['v', 'i', 't', 'r', 'c'].includes(k) || q.has(k)) return null;
    let v = kv.slice(i + 1);
    // A '%' is allowed only as %3A inside r or c (the fields that contain ':', which some apps encode); anywhere else the link is invalid.
    if (v.includes('%')) {
      if ((k !== 'c' && k !== 'r') || /%(?!3[aA])/.test(v)) return null;
      v = v.replace(/%3[aA]/g, ':');
    }
    q.set(k, v);
  }
  if (q.get('v') !== '1') return null;
  const id = q.get('i');
  const target = q.get('t');
  if (!id || !ID_RE.test(id)) return null;
  if (!target || !Object.prototype.hasOwnProperty.call(FIELDS, target)) return null;
  for (const k of q.keys()) if (!['v', 'i', 't'].includes(k) && !FIELDS[target].includes(k)) return null;
  const ref = q.get('r') ?? null;
  const comment = q.get('c') ?? null;
  if (target === 'doc' && (!ref || !UUID_RE.test(ref))) return null;
  if (target === 'conversation' && (!ref || !(UUID_RE.test(ref) || (TG_RE.test(ref) && Number(ref.slice(3)) <= Number.MAX_SAFE_INTEGER)))) return null;
  if (target === 'card' && (!ref || !/^wc_[0-9a-f]{16}$/.test(ref))) return null;
  if (comment !== null && !COMMENT_RE.test(comment)) return null;
  return { id, target, ref, comment };
}

/** The app-scheme form of a parsed link (explicit button only), rebuilt from the checked values in
 * canonical order, never the raw fragment. Only the comment key can need encoding. */
export function canonicalFragment(parsed) {
  let f = 'v=1&i=' + parsed.id + '&t=' + parsed.target;
  if (parsed.ref !== null) f += '&r=' + parsed.ref;
  if (parsed.comment !== null) f += '&c=' + parsed.comment.replace(/:/g, '%3A');
  return f;
}
export function appLink(parsed) { return 'instar://a#' + canonicalFragment(parsed); }
/** The canonical web form, what Copy link copies. */
export function webLink(parsed) { return 'https://instar.sh/a#' + canonicalFragment(parsed); }

if (typeof document !== 'undefined') {
  const show = (id) => { const el = document.getElementById(id); if (el) el.hidden = false; };
  const parsed = parseAgentLink(location.hash);
  if (!parsed) show('bad');
  else {
    const open = document.getElementById('open');
    if (open) open.setAttribute('href', appLink(parsed));
    const what = document.getElementById('what');
    if (what) what.textContent = parsed.target === 'card' ? 'a work card' : parsed.target === 'doc' ? 'a document' : parsed.target === 'conversation' ? 'a conversation' : 'an agent';
    const copy = document.getElementById('copy');
    if (copy) copy.addEventListener('click', () => {
      const done = () => { copy.textContent = 'Copied'; };
      try { navigator.clipboard.writeText(webLink(parsed)).then(done, () => {}); } catch { /* no clipboard: the address bar still has it */ }
    });
    show('ok');
  }
}
