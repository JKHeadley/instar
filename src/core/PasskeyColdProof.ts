/**
 * PasskeyColdProof — the COLD PROOF of one passkey cell (spec docs/specs/agent-held-google-passkey.md
 * §3.8 "Cold proof (identity-verified, assertion-verified, device-stable)", §3.6 outcome mapping,
 * §11 corroboration rows).
 *
 * A proof answers ONE question with evidence, never a claim: can THIS machine sign in to Google as
 * account E with the passkey it holds, right now, from a signed-out state? It runs in the cell's
 * persistent PROOF-ONLY browser profile, which is cleared (cookies / cache / storage) before every
 * proof and must then be CONFIRMED signed out — a sign-in page — before the credential is added;
 * otherwise the result is `unknown` (a warm session proves nothing about the key). It then drives
 * the closed page classes with the parent driver's allowed-action floor (`google-passkey` method,
 * `sign-in` intent: the prompt's Continue and the identifier fill are the only credential-relevant
 * actions; a create control can never appear), and reports `ready` ONLY when all three hold:
 *   1. Google actually asked for and received a WebAuthn assertion from the STORED credential id
 *      (`observedAssertion`), 2. the virtual authenticator held exactly that one credential, and
 *   3. the page shows the expected identity signed in (`readSignedInIdentity` = match) — read ONLY on
 *      a page that carries no sign-in class at all AND only after the assertion was observed, so an
 *      account chip on the passkey prompt or an email printed on a refusal page can never count.
 * Anything short of that is `failed` / `credential-rejected` / `security` / `unknown` per §3.6.
 * Whatever happens, the credential is removed from the authenticator and the profile is signed out
 * (`/Logout`) before the browser closes. Every step is logged as STATES only (page classes, action
 * names, verdicts) — never the email, never a URL with a query, never a credential.
 *
 * What this module does NOT decide: whether a proof may run (the pool admission, the rate limit, the
 * same-account gap, pauses — `PasskeyPoolState`), what the outcome does to the cell
 * (`PasskeyCellHealth`), or the cadence (the watcher increment). The route composes those.
 */
import type { PasskeyRecord } from './PasskeyCredentialStore.js';
import type { WebAuthnCredential } from './ChromeCdpReloginBrowser.js';
import type { ReloginBrowserAction, ReloginBrowserClick, ReloginBrowserSnapshot } from './AnthropicReloginBrowserDriver.js';
import { allowedActions } from './AnthropicReloginBrowserDriver.js';
import { TERMINAL_GOOGLE_PAGE_CLASSES, mapPasskeySignInOutcome, type PasskeySignInOutcome } from './GooglePasskeyPageClasses.js';

/** The browser surface a proof needs — `ChromeCdpReloginBrowser` in passkey mode satisfies it; tests inject a fake. */
export interface ProofBrowser {
  open(url: string): Promise<void>;
  navigateTo(url: string): Promise<void>;
  clearBrowsingData(): Promise<void>;
  snapshot(expectedIdentity: string): Promise<ReloginBrowserSnapshot>;
  click(action: ReloginBrowserClick): Promise<void>;
  chooseExpectedAccount(expectedIdentity: string): Promise<void>;
  fillPublic(field: 'email' | 'device-code', value: string): Promise<void>;
  wait(ms: number): Promise<void>;
  addCredential(credential: WebAuthnCredential): Promise<void>;
  removeCredential(): Promise<void>;
  credentialCount(): Promise<number>;
  observedAssertion(credentialId: string): boolean;
  readSignedInIdentity(expected: string): Promise<'match' | 'other' | 'none'>;
  close(): Promise<void>;
}

export interface PasskeyColdProofInput {
  canonicalEmail: string;
  record: Pick<PasskeyRecord, 'credentialId' | 'rpId' | 'privateKey' | 'userHandle' | 'signCount'>;
  /** The sign-in entry URL on the holder origin (production: accounts.google.com's identifier page). */
  signInUrl: string;
  /** The sign-out URL on the holder origin (production: accounts.google.com/Logout). */
  signOutUrl: string;
  /** The cell's Google-side removal state (§3.2): a pending/attested/verified cell's rejection is `removed-on-google`, never counted. */
  googleSideRemoval?: 'none' | 'pending' | 'attested' | 'verified';
}

export interface PasskeyColdProofDeps {
  openBrowser: () => ProofBrowser | Promise<ProofBrowser>;
  /** Tier-1 supervision over the closed allowed list; absent ⇒ the first allowed action (deterministic). */
  supervise?: (input: { snapshot: ReloginBrowserSnapshot; allowedActions: ReloginBrowserAction[] }) => Promise<ReloginBrowserAction>;
  maxSteps?: number;
  /** Per-step settle wait after an action (ms). */
  settleMs?: number;
  log?: (line: string) => void;
}

export interface PasskeyColdProofStep { pageClass: string; action: ReloginBrowserAction | 'stop'; }

export interface PasskeyColdProofResult {
  outcome: PasskeySignInOutcome;
  /** Why a non-ready outcome was reached (states only). */
  reason: string;
  finalPageClass: string;
  signedInIdentity: 'match' | 'other' | 'none';
  observedAssertion: boolean;
  singleCredential: boolean;
  /** A Google risk / CAPTCHA page was met (§2 risk budget: the caller pauses the account). */
  riskPage: boolean;
  /** The passkey prompt itself reported the key throttled (§4 throttle safety: the caller pauses). */
  throttled: boolean;
  steps: PasskeyColdProofStep[];
  /** Teardown honesty: whether the credential was removed and the profile signed out. */
  teardown: { credentialRemoved: boolean; signedOut: boolean; error?: string };
}

/** Page classes that count as "signed out" (a sign-in page is showing). */
const SIGNED_OUT_CLASSES = new Set<string>(['google-account-identity', 'email', 'account-chooser', 'google-passkey-challenge', 'provider-choice']);

export async function runPasskeyColdProof(deps: PasskeyColdProofDeps, input: PasskeyColdProofInput): Promise<PasskeyColdProofResult> {
  const log = deps.log ?? (() => {});
  const maxSteps = Math.max(1, Math.min(20, deps.maxSteps ?? 10));
  const steps: PasskeyColdProofStep[] = [];
  const teardown = { credentialRemoved: false, signedOut: false } as PasskeyColdProofResult['teardown'];
  let browser: ProofBrowser | null = null;
  let finalPageClass = 'unknown';
  let identity: 'match' | 'other' | 'none' = 'none';
  let observedAssertion = false;
  let singleCredential = false;
  let riskPage = false;
  let throttled = false;
  let transportError = false;
  let reason = '';
  let credentialAdded = false;

  const request = { artifact: { attemptId: 'proof', kind: 'url-code-paste' as const, expiresAt: new Date(Date.now() + 60_000).toISOString(), reissueCount: 0 }, loginMethod: 'google-passkey' as const, secretRefs: {}, intent: 'sign-in' as const };

  try {
    browser = await deps.openBrowser();
    // 1. Open on a blank page, clear, THEN load the sign-in page, and CONFIRM signed out before the key
    //    is anywhere near it. Opening on the sign-in URL first would present a stale cookie (a prior
    //    teardown whose sign-out failed) to Google once before the clear (second-pass finding).
    await browser.open('about:blank');
    await browser.clearBrowsingData();
    await browser.navigateTo(input.signInUrl);
    const start = await browser.snapshot(input.canonicalEmail);
    finalPageClass = start.pageClass;
    if (!SIGNED_OUT_CLASSES.has(start.pageClass)) {
      reason = start.pageClass === 'google-risk-challenge' ? 'risk-page-before-sign-in' : 'not-signed-out';
      riskPage = start.pageClass === 'google-risk-challenge';
      log(`[passkey-proof] not signed out (page ${start.pageClass}) — unknown`);
    } else {
      // 2. Add the ONE credential (the browser refuses unless the top-level frame is the holder origin).
      await browser.addCredential({ credentialId: input.record.credentialId, isResidentCredential: true, rpId: input.record.rpId, privateKey: input.record.privateKey, userHandle: input.record.userHandle, signCount: input.record.signCount });
      credentialAdded = true;
      singleCredential = (await browser.credentialCount()) === 1;
      // 3. Drive the closed classes with the parent floor; stop on a terminal class or a signed-in read.
      for (let step = 0; step < maxSteps; step++) {
        // The confirmed-signed-out page IS the first page of the drive (no second read of the same page).
        const snap = step === 0 ? start : await browser.snapshot(input.canonicalEmail);
        finalPageClass = snap.pageClass;
        if (snap.pageClass === 'google-risk-challenge' || snap.pageClass === 'captcha') { riskPage = true; reason = 'risk-page'; steps.push({ pageClass: snap.pageClass, action: 'stop' }); break; }
        if (snap.pageClass === 'google-passkey-throttled') { throttled = true; reason = 'throttled'; steps.push({ pageClass: snap.pageClass, action: 'stop' }); break; }
        if (TERMINAL_GOOGLE_PAGE_CLASSES.has(snap.pageClass as never)) { reason = snap.pageClass; steps.push({ pageClass: snap.pageClass, action: 'stop' }); break; }
        const allowed = allowedActions(snap, request);
        // The identity read is a POST-SIGN-IN read only: it runs on a page that carries NO closed or
        // parent sign-in class (`unknown` — the signed-in landing page has none) AND only after Google
        // has consumed an assertion from the stored id. Never on a sign-in page: Google's passkey prompt
        // shows the typed identifier as an account chip, which would read as a premature `match`, and
        // an email printed on a refusal page (an admin address, a footer contact) must never read as
        // `other` ⇒ `security` (second-pass finding).
        if (snap.pageClass === 'unknown' && browser.observedAssertion(input.record.credentialId)) {
          const signedIn = await browser.readSignedInIdentity(input.canonicalEmail);
          if (signedIn !== 'none') { identity = signedIn; reason = signedIn === 'match' ? 'signed-in' : 'different-identity'; steps.push({ pageClass: snap.pageClass, action: 'stop' }); break; }
        }
        if (allowed.length === 0 || (allowed.length === 1 && allowed[0] === 'wait' && step === maxSteps - 1)) { reason = `no-action-on-${snap.pageClass}`; steps.push({ pageClass: snap.pageClass, action: 'stop' }); break; }
        const action = deps.supervise ? await deps.supervise({ snapshot: snap, allowedActions: allowed }) : allowed[0];
        if (!allowed.includes(action)) { reason = 'supervisor-chose-unoffered-action'; steps.push({ pageClass: snap.pageClass, action: 'stop' }); break; }
        steps.push({ pageClass: snap.pageClass, action });
        switch (action) {
          case 'fill-email': await browser.fillPublic('email', input.canonicalEmail); break;
          case 'click-passkey-continue': await browser.click('passkey-continue'); break;
          case 'click-not-now': await browser.click('not-now'); break;
          case 'click-next': await browser.click('next'); break;
          case 'choose-expected-account': await browser.chooseExpectedAccount(input.canonicalEmail); break;
          case 'wait': default: await browser.wait(deps.settleMs ?? 500); break;
        }
        await browser.wait(deps.settleMs ?? 500);
      }
      if (!reason) reason = 'step-budget-exhausted';
      observedAssertion = browser.observedAssertion(input.record.credentialId);
      // No identity read after the loop: a terminal / risk / throttled page is never a signed-in page.
    }
  } catch (err) {
    // @silent-fallback-ok — NOT swallowed: a transport/browser failure is the `unknown` outcome by
    // definition (§3.6) and its class is reported in `reason`; nothing about the key is inferred.
    transportError = true;
    reason = `transport:${err instanceof Error ? err.name || 'Error' : 'error'}`;
    log(`[passkey-proof] transport error — unknown (${reason})`);
  } finally {
    if (browser) {
      try {
        if (credentialAdded) { await browser.removeCredential(); teardown.credentialRemoved = true; }
        else teardown.credentialRemoved = true;
      } catch (err) { teardown.error = `remove:${err instanceof Error ? err.name || 'Error' : 'error'}`; }
      try { await browser.navigateTo(input.signOutUrl); await browser.clearBrowsingData(); teardown.signedOut = true; }
      catch (err) { teardown.error = `${teardown.error ? `${teardown.error};` : ''}signout:${err instanceof Error ? err.name || 'Error' : 'error'}`; }
      try { await browser.close(); } catch { /* @silent-fallback-ok — close is best-effort after teardown; the seat lease release is the caller's */ }
    }
  }

  const outcome = mapPasskeySignInOutcome({
    finalPageClass: transportError ? 'unknown' : finalPageClass,
    signedInIdentity: identity === 'other' ? 'mismatch' : identity, observedAssertion, singleCredential, transportError,
    googleSideRemoval: input.googleSideRemoval ?? 'none',
  });
  // §3.8: `ready` needs the observed assertion AND the single credential; a match without them is unknown.
  log(`[passkey-proof] outcome=${outcome} reason=${reason} page=${finalPageClass} assertion=${observedAssertion} single=${singleCredential} identity=${identity} steps=${steps.length}`);
  return { outcome, reason, finalPageClass, signedInIdentity: identity, observedAssertion, singleCredential, riskPage, throttled, steps, teardown };
}
