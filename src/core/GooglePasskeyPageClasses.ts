/**
 * GooglePasskeyPageClasses — the CLOSED set of Google pages the passkey work
 * recognises (spec docs/specs/agent-held-google-passkey.md §3.6), each matched on
 * STRUCTURE (exact origin, sign-in route, element ids / roles / exact control
 * labels), evaluated BEFORE the parent driver's text-regex chain, and the outcome
 * mapping a proof or repair derives from the page it ended on.
 *
 * Why structure first: the parent chain (`ChromeCdpReloginBrowser.snapshot`) reads
 * body prose — "verification code", "password" — which Google's passkey pages also
 * print in help text, so a passkey challenge would read as `totp` and a backup-code
 * page as `password`. A structural match cannot be shadowed by prose, and an
 * unmatched page is `null` here (⇒ the parent chain, ⇒ `unknown`): the safe
 * direction. Every class is a SINGLE-source structural match and errs toward
 * restriction (§11): a false `credential-rejected` costs one proof, a false
 * `ready` is impossible from here because `ready` needs the observed assertion
 * and the identity read as well (§3.8).
 *
 * Provenance of each predicate (`PAGE_CLASS_PROVENANCE`): `measured` = observed
 * live in the 2026-09-20 prototype notes (identifier field id, the `pk/presend`
 * challenge, the device-prompt / TOTP routes, the passkey speedbump, the
 * Workspace refusal); `documented` = Google's long-stable sign-in routes and
 * control ids that the prototype did not need to visit. The Rung-1 live step
 * (§14 FD9) re-checks every `documented` row against real pages before any
 * unattended use; until then a mismatch can only make a page `unknown`.
 *
 * `classifyGooglePasskeyPage` is SELF-CONTAINED (no module-level constants, no
 * imports) so the browser can serialise it with `Function.prototype.toString`
 * and run the SAME code inside the page, exactly as it does for
 * `isClosedOpenAiDeviceApproval`. The unit tests exercise the function directly;
 * the fixture test proves the in-page ordering through real Chrome.
 */

export const GOOGLE_PASSKEY_PAGE_CLASSES = [
  'google-passkey-challenge',
  'google-passkey-create',
  'google-passkey-create-confirm',
  'google-already-enrolled',
  'google-passkey-throttled',
  'google-workspace-policy-blocked',
  'google-credential-not-recognized',
  'google-account-identity',
  'google-passkey-list',
  'google-totp-entry',
  'google-backup-code-entry',
  'google-risk-challenge',
] as const;

export type GooglePasskeyPageClass = typeof GOOGLE_PASSKEY_PAGE_CLASSES[number];

/** Where each predicate came from (see the header). */
export const PAGE_CLASS_PROVENANCE: Readonly<Record<GooglePasskeyPageClass, 'measured' | 'documented'>> = Object.freeze({
  'google-passkey-challenge': 'measured',
  'google-passkey-create': 'measured',
  'google-passkey-create-confirm': 'documented',
  'google-already-enrolled': 'measured',
  'google-passkey-throttled': 'documented',
  'google-workspace-policy-blocked': 'measured',
  'google-credential-not-recognized': 'documented',
  'google-account-identity': 'measured',
  'google-passkey-list': 'measured',
  'google-totp-entry': 'measured',
  'google-backup-code-entry': 'documented',
  'google-risk-challenge': 'measured',
});

/**
 * The REDACTED structural facts the browser extracts from a page. No prose, no
 * input values, no URL query, no email ever enters this object: only the origin,
 * the path, bounded lists of element ids and exact lower-cased control labels,
 * and a handful of role/landmark booleans.
 */
export interface GooglePageFacts {
  origin: string;
  pathname: string;
  /** Element ids present on the page (bounded, lower-cased). */
  ids: string[];
  /** Exact, trimmed, lower-cased accessible labels of buttons/links (bounded). */
  controlLabels: string[];
  hasPasswordInput: boolean;
  /** An open `[role="dialog"]` / `<dialog open>`. */
  hasDialog: boolean;
  /** A non-empty `[role="alert"]` / `[aria-live="assertive"]` region. */
  hasAlert: boolean;
  /** A reCAPTCHA frame or the classic captcha image. */
  hasCaptchaWidget: boolean;
  /** A link into Google Workspace admin help (the Workspace refusal cites it). */
  hasAdminHelpLink: boolean;
}

export interface GooglePageOrigins {
  /** accounts.google.com in production; the fixture's holder origin in tests. */
  holderOrigin: string;
  /** myaccount.google.com in production; the fixture's other origin in tests. */
  accountOrigin: string;
}

export const GOOGLE_ACCOUNT_ORIGIN = 'https://myaccount.google.com';

/**
 * Structural classification. Returns the matched class or `null` (⇒ the caller
 * falls through to its own chain). Pure, self-contained, serialisable.
 */
export function classifyGooglePasskeyPage(facts: GooglePageFacts, origins: GooglePageOrigins): GooglePasskeyPageClass | null {
  const path = String(facts.pathname || '');
  const ids = new Set((facts.ids || []).map((v) => String(v).toLowerCase()));
  const labels = new Set((facts.controlLabels || []).map((v) => String(v).trim().toLowerCase()));
  // An empty origin on either side never matches (a data: page reports 'null', a
  // policy without an account origin reports '').
  const onHolder = !!facts.origin && facts.origin !== 'null' && facts.origin === origins.holderOrigin;
  const onAccount = !!facts.origin && facts.origin !== 'null' && !!origins.accountOrigin && facts.origin === origins.accountOrigin;
  // Google's sign-in routes: current `/v3/signin/...`, legacy `/signin/v2/...`, bare `/signin/...`.
  const challenge = (segment: string) => new RegExp('^/(?:v3/signin|signin/v2|signin)/challenge/' + segment + '(?:/|$)').test(path);
  const identifierRoute = /^\/(?:v3\/signin|signin\/v2|signin)\/identifier(?:\/|$)/.test(path);
  const rejectedRoute = /^\/(?:v3\/signin|signin\/v2|signin)\/rejected(?:\/|$)/.test(path);
  const speedbumpRoute = /^\/(?:signin\/v2\/)?speedbump\/passkeyenrollment(?:\/|$)/.test(path);
  const passkeyOptionsRoute = /^\/signinoptions\/passkeys(?:\/|$)/.test(path);

  if (onHolder) {
    // Risk / CAPTCHA first: it can wear any other page's clothes and must never be acted on.
    if (facts.hasCaptchaWidget || rejectedRoute || challenge('recaptcha') || challenge('ipp') || challenge('iap') || challenge('ipe'))
      return 'google-risk-challenge';
    if (challenge('pk(?:/presend)?')) {
      // The passkey prompt: "Continue" (fires navigator.credentials.get) + "Try another way".
      // A live prompt that still offers Continue is the CHALLENGE even if a live region
      // is announcing something — the rejection classes need the prompt's action GONE
      // plus a visible alert, because `credential-not-recognized` feeds suspension and
      // a false read there is NOT the safe direction (second-pass review, 2026-09-23).
      if (labels.has('continue')) return 'google-passkey-challenge';
      if (facts.hasAlert && labels.has('try again later')) return 'google-passkey-throttled';
      if (facts.hasAlert && labels.has('try another way')) return 'google-credential-not-recognized';
      return null;
    }
    if (challenge('totp') && ids.has('totppin')) return 'google-totp-entry';
    if (challenge('bc') && ids.has('backupcodepin')) return 'google-backup-code-entry';
    if (identifierRoute && ids.has('identifierid')) return 'google-account-identity';
    if (speedbumpRoute) {
      if (facts.hasDialog && (labels.has('continue') || labels.has('create'))) return 'google-passkey-create-confirm';
      if (labels.has('create a passkey')) return 'google-passkey-create';
      return null;
    }
    return null;
  }
  if (onAccount && passkeyOptionsRoute) {
    if (facts.hasAlert && facts.hasAdminHelpLink) return 'google-workspace-policy-blocked';
    if (facts.hasDialog && (labels.has('continue') || labels.has('create'))) return 'google-passkey-create-confirm';
    if (facts.hasDialog && (labels.has('done') || labels.has('ok')) && !labels.has('create a passkey')) return 'google-already-enrolled';
    if (labels.has('create a passkey')) return 'google-passkey-create';
    return 'google-passkey-list';
  }
  return null;
}

/** Classes on which NO action is ever allowed; the driver maps them to a result. */
export const TERMINAL_GOOGLE_PAGE_CLASSES: ReadonlySet<GooglePasskeyPageClass> = new Set<GooglePasskeyPageClass>([
  'google-already-enrolled', 'google-passkey-throttled', 'google-workspace-policy-blocked',
  'google-credential-not-recognized', 'google-passkey-list', 'google-risk-challenge',
]);

// ── Outcome mapping (§3.6) ─────────────────────────────────────────────────

export type PasskeySignInOutcome = 'ready' | 'credential-rejected' | 'removed-on-google' | 'failed' | 'security' | 'unknown';

export interface PasskeySignInObservation {
  /** The last page class the sign-in ended on (`unknown` when the parent chain matched nothing). */
  finalPageClass: string;
  /** Result of the in-port identity read after sign-in: matched E, matched a DIFFERENT identity, or no signed-in identity. */
  signedInIdentity: 'match' | 'mismatch' | 'none';
  /** Google asked for and received a WebAuthn assertion from the STORED credential id (§3.8). */
  observedAssertion: boolean;
  /** The virtual authenticator held exactly the one stored credential. */
  singleCredential: boolean;
  /** Transport/outage/timeouts happened before a verdict could be read. */
  transportError: boolean;
  /** The cell's Google-side removal state (§3.2): a pending/attested cell never counts as rejected. */
  googleSideRemoval: 'none' | 'pending' | 'attested' | 'verified';
}

/**
 * `ready` requires ALL of: identity match, observed assertion for the stored id,
 * a single-credential authenticator (§3.8). `security` = signed in as somebody
 * else (custody is corrupt). `credential-rejected` = Google's not-recognized page
 * (recorded as `removed-on-google` while the cell's removal is pending/attested/
 * verified, so it never counts toward suspension). `failed` = reached sign-in,
 * did not sign in, no rejection page. Everything else is `unknown`.
 */
export function mapPasskeySignInOutcome(obs: PasskeySignInObservation): PasskeySignInOutcome {
  if (obs.signedInIdentity === 'mismatch') return 'security';
  if (obs.transportError) return 'unknown';
  if (obs.finalPageClass === 'google-credential-not-recognized')
    return obs.googleSideRemoval === 'none' ? 'credential-rejected' : 'removed-on-google';
  // Risk pages: the closed class AND the parent driver's `captcha` class (a CAPTCHA that wears no
  // Google route still proves nothing about the key — second-pass finding). Both before the identity read.
  if (obs.finalPageClass === 'google-risk-challenge' || obs.finalPageClass === 'captcha' || obs.finalPageClass === 'google-passkey-throttled') return 'unknown';
  // A signed-in landing page carries no closed class (it is not a sign-in page), so the identity read
  // is consulted BEFORE the unmatched-page rule: match + assertion + single credential ⇒ ready.
  if (obs.signedInIdentity === 'match') {
    return obs.observedAssertion && obs.singleCredential ? 'ready' : 'unknown';
  }
  if (obs.finalPageClass === 'unknown') return 'unknown';
  return 'failed';
}
