# Remote-browser sign-in repair — Plain-English Overview

> The one-line version: a machine that has no browser it can drive (the Mama PC) fixes its own expired Claude and Codex sign-ins by asking a Mac that holds the right Google profile to click through the sign-in pages for it, while the login itself is still created on the Mama PC and nothing secret ever moves between machines.

## The problem in one breath

Every Claude and Codex subscription signs in "with Google". Instar can already repair an expired sign-in by itself, but only on a Mac, because the repair drives a normal Chrome window on the same machine. The Mama PC runs Instar inside Windows/WSL. It has no Chrome the agent can drive and no screen it can read. So when its six Claude logins expired on September 25, nothing could fix them, and nobody noticed until September 27.

## What already exists

- **The repair episode.** Instar notices an expired login, opens a bounded repair, starts the command-line login on that machine, and only calls it fixed after the account answers a real request as the expected email.
- **The sign-in helper.** On a Mac, a short-lived agent session opens the account's own Chrome profile and clicks through Google and the Authorize page the way a person would. It never decides success; the server does.
- **The hand-run proof.** On September 27 I did exactly this by hand between the Mama PC and the Mac Studio: 13 of 13 accounts signed in and verified, with the Studio's screen locked the whole time. The runbook and the built-in `/subscription-signin` skill record every step.
- **Cross-machine plumbing.** The dashboard's one-tap "Repair sign-in" already sends a signed permission slip to the machine doing the repair, and the paste-back code already travels machine-to-machine over the authenticated mesh, never through chat.

## What this adds

One new setting value, `peer-browser`, for the repair's navigation mode. When a machine on that value reaches the browser step of a repair, it does not try to open a browser locally. It asks its paired Macs "can you do the browser step for this email?", picks the one that says yes from its own records, and sends it the sign-in link. The Mac runs the existing helper in the account's Chrome profile, reads the paste-back code, and hands it straight back to the requesting machine, which types it into its own waiting login. For Codex, the Mac types the device code on OpenAI's page and nothing comes back at all; the credential simply lands where the login was started.

Secondary changes: two small server routes (one for "can you serve?", one for the request itself), a typed list of reasons a Mac may refuse, and the matrix cell on the dashboard showing "browser step on <machine>" while it runs.

## The new pieces

- **The browser-assist request.** A message from the requesting machine to a Mac carrying the sign-in link, the expected email, the expiry, and the operator's existing permission slip. The Mac may only use it to open that link in the matching profile and click through a sign-in. It cannot be used to open any other site, pick a different account, or run longer than 15 minutes.
- **The code forward.** The Mac's helper posts the code to its own server, which forwards it once to the requesting machine and keeps no copy. A code that arrives for a repair that is not waiting for one is refused and reported as a security event.

## The safeguards

**Prevents a credential from crossing machines.** The login is created on the machine that needs it; the secret half of the login never leaves it. The Mac never sees the token, never writes the requester's files, and its Google cookies never leave its disk.

**Prevents a machine from tricking another into acting.** A Mac only accepts a request from a paired machine carrying the operator's signed permission slip for exactly that account, that machine, and that repair. For unattended repairs, where there is no slip, the Mac only helps identities the operator has explicitly listed on the Mac itself. "The other machine says it is allowed" is never enough.

**Prevents a wrong account or a wrong page.** The helper keeps every existing hard line: the expected email must appear on the account chooser, the consent page, and the Authorize page; the permission list must be the standard one; a CAPTCHA or phone check stops the helper and tells the operator once. The requesting machine alone decides success, by a real authenticated call.

**Prevents silent failure and endless retries.** Every refusal has a named reason, every attempt is audited, retries stay inside the existing three-attempt, ten-minute budget, and a cell that keeps failing is handed to the operator once through the existing phone "Sign in" button.

## What ships when

First, the unit and integration tests plus a two-process live test on one Mac against fixture sign-in pages, with no real account touched. Then the real thing on Echo's own machines (Mama PC asking the Mac Studio), with approval required for each repair and the operator watching. Only after at least five verified delegated repairs across both providers and two machine pairs, with zero wrong-identity events, does the default change for other agents.

## What you actually need to decide

Do you approve turning the proven hand procedure into a self-repair path where a browserless machine delegates only the browser click-through to a paired Mac, reusing the existing repair permission slip and keeping every existing sign-in safeguard? Yes or no.
