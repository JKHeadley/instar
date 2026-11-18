---
title: "The one-time local dashboard link"
slug: identity-security-piece1a-local-link
author: Echo
tier: 2
status: approved
eli16-overview: identity-security-piece1a-local-link.eli16.md
parent-principle: "Know Your Principal — An Unverified Identity Is a Guess"
sibling-principles: "Signal vs. Authority; Bounded Blast Radius; Structure beats Willpower; Judgment Within Floors; Verify the State, Not Its Symbol"
parent-spec: "identity-security-levels.md (approved 2026-11-17 19:34 PST, Justin, topic 144636), §4.6 and §12 item 1, first bullet"
split-from: "identity-security-piece1.md (review rounds 1-5; split after round 5, see reports/identity-security-piece1a-local-link-convergence.md)"
lessons-engaged: "operator-session-is-not-human-proof, no-single-device-lockout, a-dark-guard-is-worse-than-no-guard, an-empty-result-is-not-a-verified-fact, user-setup-must-be-trivial, justin-warns-against-over-engineering, spec-reviews-not-falling-means-cut"
review-convergence: "2026-11-18T07:55:00Z"
review-iterations: 4
review-completed-at: "2026-11-18T07:55:00Z"
review-report: "reports/identity-security-piece1a-local-link-convergence.md"
cross-model-review: "codex-cli gpt-6.2-astra (headley.justin) rounds 1-4, not converged on items outside this spec; gemini-cli gemini-4-argon rounds 1-3"
approved: true
approved-by: "Under the approved umbrella identity-security-levels.md (Justin, topic 144636, 2026-11-17 19:34 PST: \"great! approved, please enter a 24 hour autonomous session in gpt 6.2 astra to build this\") and Justin's standing guidance that only constitution changes need his approval (2026-10-22). No constitution text changes here."
---
# The one-time local dashboard link

## Problem statement

The approved identity design (umbrella §12, item 1) builds the one-time local link first, so every later step has a way in that does not depend on the PIN, a phone or a chat. Umbrella §4.6: `instar dashboard open` mints a link with a single-use secret and opens the browser; through SSH the same command prints the link for a forwarded port; tunnel traffic is never local.

Piece 1 was first written as one spec covering ten changes. Five review rounds kept finding new design problems across all of them, so piece 1 is built as a sequence of small specs in the umbrella's order. This is the first. The later ones (no-token refusal with the four filed fixes and iMessage SMS rows; one PIN policy; PIN non-disclosure and Basic reset; relay enforcement and session controls; member conversations) carry the round-5 findings that concern them (`reviews/r5` in the build state folder). **Piece 1 is complete only when all of them are.**

Today a browser at the agent's computer that has never unlocked there (a first visit, cleared cookies, an expired prior-unlock marker, a private window) has one way to show it is local: arriving over loopback. Every process on the machine shares that, including other OS accounts and confined sessions, so the local PIN budget (`AgentServer.ts`, `LOCAL_PIN_KEY`, 10 failures per 5 minutes) can be drained by any of them, and that browser is then refused PIN entry. A browser with a prior-unlock marker is already judged on its own marker and is not affected.

## Proposed design

### What the link proves, and to whom

A browser that redeems a link holds a **local credential**: proof that the link was minted by a process able to read this agent's private local-access key on this machine, and was redeemed through this machine's loopback within 15 minutes. With an ordinary open the browser is on this machine. With SSH print mode it is on the SSH client, reaching this machine through the forward, and that machine's other accounts are inside the boundary for that one link.

It proves nothing about which person is there. The agent's own sessions run as the same OS account and can mint too; umbrella §3.3 accepts this at Basic ("enforced against everyone except the agent itself").

In this spec the credential has exactly one consumer: **dashboard PIN unlock judges a credential-holding browser on its own verified-local budget** (§5). The PIN is still required. The credential grants no dashboard API access and no other exemption. Later pieces may add consumers, each with its own review, and each must re-judge the residual in §6.

### 1. The listener and the private key

The link's origin is **`http://127.0.0.1:<port>`**, the numeric loopback address, as the existing native owner-device route already uses (`mobileLocalOwnerDevice.ts`, `sameMacHost`). A numeric host resolves to one address, so no second address family can catch the link. (`localhost` resolves to both `::1` and `127.0.0.1`; piece 3 needs `localhost` for security keys and carries the round-1 findings about holding both families.)

The link is available only when the server's own listening socket (`server.address()` after listen, not the configured host string) covers `127.0.0.1` at its port: an address of `127.0.0.1`, `0.0.0.0`, or a dual-stack `::`. Any other bind (a specific LAN or Tailscale address) turns the link off for this run, with a plain reason the CLI shows. While the server holds that socket, no other OS account can bind `127.0.0.1` at the same port (Linux refuses a specific bind over a listening wildcard; macOS refuses one from a different user). The throwaway proof checks this on macOS.

On first start with the feature on, the server creates `<stateDir>/local-access/listener.key`: 32 random bytes, directory 0700, file 0600, exclusive create; a symlink or a file owned by another user is refused, not repaired. Only processes that can read this file can mint. This is the agent's OS account; other accounts cannot read it even where the agent's config file is world-readable.

### 2. Minting

The CLI reads `listener.key` and sends `POST /local-access/v1/mint` to `127.0.0.1:<port>`:

`{ browserPort, startedBy, timeMs, clientNonce, proof }`, where `proof = HMAC-SHA256(key, "instar-local-mint-v1\n" + agentName + "\n" + port + "\n" + browserPort + "\n" + startedBy + "\n" + timeMs + "\n" + clientNonce)`.

- No bearer token is sent. A program squatting the address learns nothing it can use.
- The server answers only a loopback peer with no forwarding header and Host `127.0.0.1:<port>`. It checks `timeMs` within 60 seconds and not earlier than the moment this server process began listening (a request stamped before that may have been captured by a program that held the port while the server was down or still starting), and the HMAC, **before** storing anything, then remembers `clientNonce` until `timeMs` + 60 seconds so a request cannot be replayed. `port` is the accepting socket's local port.
- `browserPort` defaults to the server's port. SSH print mode passes the forwarded port; the ticket's origin is then `http://127.0.0.1:<browserPort>`.
- `startedBy` (`terminal` or `session`) is **telemetry the CLI reports**: `session` when it runs with a session environment (`INSTAR_SESSION_ID`, or inside a tmux session the server owns) or without a terminal. It is recorded in the feature-evidence log. No gate reads it, and no later piece may treat it as proof of a person.

The server creates a ticket: an independent 128-bit public id, a 256-bit secret (only two digests are stored: `sha256(secret)` and `sha256("instar-local-challenge-v1\n" + secret)`), the origin, `expiresAt` = now + 15 minutes (the browser's launch time comes out of these 15 minutes), state `minted`, and a launch name the server chooses (`[A-Za-z0-9_-]{22}`).

The response is `{ id, secret, expiresAt, launchName, origin, responseProof }`, with `responseProof = HMAC-SHA256(key, "instar-local-mint-response-v1\n" + clientNonce + "\n" + id + "\n" + sha256(secret) + "\n" + expiresAt + "\n" + launchName + "\n" + origin)`. **The CLI uses nothing from the response until `responseProof` checks out**, checks that `origin` is the one it asked for, and builds the link itself from those checked fields and the fixed path: `<origin>/local-access/v1/open#<id>.<secret>`. A wrong or missing proof means something other than this agent answered: the CLI refuses, says another program may be using the agent's local address, and prints the agent's tunnel address if one is configured, never a link to the same address.

**Capacity.** At most 10 unredeemed tickets: a mint at the cap revokes the oldest unredeemed one (its launch document is deleted) and proceeds. At most 10 live credentials: an exchange at the cap ends the oldest live credential in the same transaction. No mint or exchange is refused for capacity, so neither repeated clicks nor a busy session can lock the person out; the cost of eviction is one re-run of the command. There is no hourly mint rate.

**Restart.** At every server start, once this process holds its listening socket (so a second instance that fails to bind never touches the running server's links), every unredeemed ticket and every open challenge is revoked and its launch document deleted. A link minted before a restart therefore never works after it; the person runs the command again. Credentials already bound stay valid until their own expiry, because only the browser holding the key can use them.

**Storage.** `<stateDir>/local-access/tickets.db`, SQLite (better-sqlite3, WAL, 0600), written only by the server process, so contention is nil; a 250 ms busy timeout bounds any wait on the event loop. File deletions run after the transaction commits. Expired tickets, credentials, challenges and remembered nonces are deleted by a sweep at every mint and every 60 seconds; nothing is kept past its expiry. Remembered nonces are bounded by the 60-second window and are only stored after the key proof checks out.

### 3. Opening the browser

**How it is run.** On a standard install the `instar` command is not on the PATH: global installs are removed at every server start (`GlobalInstallCleanup.ts`), and the agent's own CLI lives in its shadow install. So, with the switch on, the server writes a launcher at every start: `<stateDir>/bin/dashboard-open` (0700, rewritten each start so it follows updates), a short script that runs the agent's own installed CLI with `dashboard open --dir <agent folder>` and passes its arguments through. Every message that offers the link prints this absolute path, never a bare `instar`. The person rarely needs it: the awareness entry tells the agent that when a person at its computer cannot unlock, it runs the launcher itself (an ordinary open shows the browser on that computer's screen). Run as `instar dashboard open` from inside an agent folder, the command resolves the agent as other commands do; outside one it uses `--dir`, or the only agent under `~/.instar/agents/` if there is exactly one, and otherwise lists them.

The command mints, and opens the browser.

- **Ordinary open (macOS):** the CLI writes `<stateDir>/local-access/launch/<launchName>.html` (0600, exclusive create, name from the verified response) containing `<meta name="referrer" content="no-referrer">` and a script that calls `location.replace(url)`, so the file is not left in the tab's history. It opens that file path with `open`. The secret never appears in a process argument. The server deletes the file at the ticket's first accepted challenge, and in any case when the ticket is redeemed, revoked or expires, deleting only a regular, non-symlink file directly under `local-access/launch/` whose name matches the ticket's launch name. A sweep at start and every 60 seconds removes any launch document no live unredeemed ticket owns (for example one a slow CLI wrote after its ticket was evicted), and it runs even with the switch off, so turning the link off leaves no secret-bearing file behind.
- **Print mode (`--print --port <forwarded port>`):** for SSH. Requires a terminal (refuses when stdout is not a TTY). Prints the link once, with a line saying it is private and works once, and the forward to use (`ssh -L 127.0.0.1:<port>:127.0.0.1:<agent port>`, bound to the client's loopback only).
- **Anything else** prints how to use `--print` and the ordinary sign-in address.

Coverage this spec does **not** claim, reported `unknown` until a real run proves it: Linux desktop browsers (a snap-packaged browser cannot open files under hidden folders; `--print` is the route), native Windows, and the "Open dashboard" action in the Mac app. The Mac action needs a signed app build, so it is a row in piece 3's spec, where the Mac app calls this same CLI. **Acceptance from the WSL gateway address** (umbrella §4.6), needed when a Windows browser reaches a WSL agent, is its own small piece-1 spec (1g, listed below) because it needs a Windows machine to prove; piece 1 is not complete without it.

### 4. Redeeming the link

`GET /local-access/v1/open` serves a fixed page and `GET /local-access/v1/open.js` its script, to a loopback peer only, with `Content-Security-Policy: default-src 'none'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`, `Cache-Control: no-store`, `Referrer-Policy: no-referrer`. These routes mount before the auth middleware, and the dashboard's own security headers do not replace this CSP.

The script reads the fragment into memory, clears it from the address bar, and creates a non-extractable ECDSA P-256 key with WebCrypto (the same key and low-S signature format as `dashboard/console/browser-device.js`). Then:

1. `POST /local-access/v1/challenge { ticketId, secretProof, publicKey }`, where `secretProof = sha256("instar-local-challenge-v1\n" + secret)`. A wrong proof allocates nothing. The server returns a single-use challenge (60 seconds) bound to the ticket and that key. One open challenge per ticket and key, at most 8 per ticket; a request never cancels another key's challenge.
2. `POST /local-access/v1/exchange { ticketId, secret, publicKey, challenge, signature }`, the signature covering `"instar-local-exchange-v1\n" + agentName + "\n" + ticketId + "\n" + challenge + "\n" + origin`.

Every link route (mint, open, challenge, exchange, use-challenge) and the unlock check accept a request only when it arrived on a socket whose **local** address is `127.0.0.1` (or `::ffff:127.0.0.1`), from a loopback peer with no forwarding header. A program holding `127.0.0.1:<port>` therefore has no second path into the server (for example over `[::1]` on a dual-stack bind) through which it could relay a request. Challenge, exchange and use requests also need `Host` and `Origin` equal to the ticket's origin (in print mode its port differs from the server's), as `application/json`; bodies over 8 KB are refused (the largest valid body is about 1 KB). In **one transaction** the server checks the ticket is live and unrevoked, the secret's digest, the challenge and the signature; consumes the challenge; binds the ticket to the key; and creates one credential (`credentialId`, 128 random bits; expiry = the ticket's original `expiresAt`). A ticket binds to one key, ever: an exchange with a different key after binding is refused and changes nothing. A redeemed ticket whose credential has ended (expired or evicted) is refused too, so a same-key retry never revives an ended credential.

**A lost response:** the same page, still holding the secret in memory, may repeat the exchange with the same key and a fresh challenge; the server returns the same credential. After a reload the secret is gone and the person runs the command again; minting is free.

The script stores the key and credential id in IndexedDB under the agent's name, then goes to `/dashboard/`. Nothing renews the credential: not a reload, a status read, or a sign-in.

### 5. The one consumer: dashboard unlock

All seven places that post a PIN to `/dashboard/unlock` (`dashboard/index.html` ×2, `console/console.js`, `console/ui.js`, `desktop.js`, `recovery.js`, `maturation/app.js`) go through one helper, `dashboard/local-access.js`. When the browser holds a live local credential for this agent and origin, the helper first asks `POST /local-access/v1/use-challenge { credentialId, action: 'dashboard-unlock' }` (each 60 seconds, single-use, at most 8 open per credential, so several tabs never cancel each other; unknown ids allocate nothing), then adds `localAccess: { credentialId, challenge, signature }` to the unlock body. The signature covers `"instar-local-use-v1\n" + agentName + "\n" + credentialId + "\n" + action + "\n" + challenge + "\n" + origin + "\nPOST /dashboard/unlock"`. If anything in that step fails (no IndexedDB, a signing error, a refused challenge), the helper sends the PIN without `localAccess`, exactly once; it never resubmits a PIN after an unclear answer. A test fails if any dashboard file posts to `/dashboard/unlock` other than through the helper.

The unlock route checks `localAccess` **first**, before it classifies the request as local or remote. Verification: a live credential, loopback peer, no forwarding header, Host and Origin equal to the credential's origin (in print mode that port differs from the server's), and the single-use challenge signed by the bound key. The whole check, the PIN comparison and the charge run synchronously in one request, so concurrent requests cannot overspend a budget.

| Request | Budgets checked and charged | Unchanged |
| --- | --- | --- |
| `localAccess` verified, no prior-unlock marker | only the verified-local budget | the PIN, the operator session and the marker it sets on success |
| a valid prior-unlock marker that `PinThrottle` still honours (with or without `localAccess`) | exactly today's marker rules; the credential is not used | everything: a browser that already has a working marker keeps it |
| an abused marker (past its own cap) with `localAccess` verified | only the verified-local budget, as with no marker | the PIN and the session it issues |
| `localAccess` verified, but the verified-local budget is full | exactly today's rules for that request | everything: a valid link never makes unlock harder than it is without one |
| `localAccess` present but not verified, or the local-access store cannot be read | exactly today's rules for that request | everything |
| no `localAccess` | exactly today's rules | everything |

The verified-local budget is 10 failures per 5 minutes, the size of today's local budget, keyed `local-verified:<machine id or "single">:<PIN generation or "none">` in the durable PinAttemptStore, or an in-memory counter when there is no store (as the loopback budget does today). It skips the loopback budget, the unmarked PinThrottle limits (source backoff, coarse budget, global cap) and, with the throttle off, the legacy per-address and global limits: those protect against strangers, and a verified link is not a stranger. A success does not reset it. When it fills, the owner gets the same kind of notice as today's `DashboardPin.localGuessing` ("repeated wrong PINs through the local link on this machine"), through DegradationReporter, at most once per 30 minutes. A broken or missing credential never earns an exemption and never makes unlock harder than it is today.

The local lockout message ("Too many wrong PINs from this machine…") adds, when the link is available: "At this computer, ask your agent to open the dashboard for you, or run <absolute launcher path>."

Any process that can mint shares the verified-local budget. That is the agent's own OS account. What it keeps out is everything that shares loopback without that account: other OS accounts and confined sessions that cannot read the agent's state folder.

### 6. Residuals stated

- Any script served from `http://127.0.0.1:<port>` can use the stored key, including dashboard pages (whose CSP allows inline script and one CDN) and the unauthenticated preview mount. Here that only selects a PIN budget for at most 15 minutes. Later consumers must re-judge it.
- After redemption the dashboard page itself, and the PIN typed into it, are served by whatever holds `127.0.0.1:<port>`, exactly as today; a program that takes the address while the server is down could show a fake page today too. This spec adds no protection there and claims none; authenticating the dashboard's listener to the browser belongs to the later sign-in pieces (4 and 6).
- A program running as the agent's own OS account can mint, use the shared verified-local budget, or (on a wildcard bind) take `127.0.0.1` after a mint. That account is inside the boundary at Basic. Its worst effect here is using up the verified-local budget, after which unlock falls back to today's rules.
- `PinAttemptStore` starts empty if its file is unreadable and keeps counting in memory if a write fails (both as today). The verified-local budget inherits that.
- The prior-unlock marker cookie is not port-scoped on `127.0.0.1`/`localhost`. Recorded for the PIN-policy piece; the local credential lives in origin-scoped IndexedDB and is not affected.
- If the server stops and another account binds `127.0.0.1:<port>` before the browser opens, that program receives the page load and can read the link. The link is already dead: the restart revokes every unredeemed ticket (§2), so it can be redeemed nowhere. If the other program holds the port while the real server is down, the real server cannot start, which the existing boot failure report already raises.

### 7. Storage hygiene, restore and other machines

`local-access/` is added to `KEY_MATERIAL_PATHS`, `local-access/listener.key` to `KEY_MATERIAL_FILES` and `local-access/launch/` to `KEY_MATERIAL_DYNAMIC_DIRS` (`src/core/keyMaterialPaths.ts`). That keeps them out of the dashboard file viewer (including the hard-link check), backups (both path spellings, export and restore, custom includes too), `.gitignore` and git-sync. The store is registered in `src/data/state-coherence-registry.json` with its retention (expiry plus the 60-second sweep).

A restore never contains tickets, credentials or the key, so it cannot bring back an old grant.

### 8. Switch and awareness

`security.localAccessLink.enabled`, a `DEV_GATED_FEATURES` entry resolved by `resolveDevAgentGate`: on for development agents, off for the fleet until graduation; a throwaway agent sets it on explicitly. When off: the routes answer 404, the unlock route ignores `localAccess`, and the CLI says the link is not available on this agent and prints the ordinary sign-in address. Turning it off loses nothing: a live credential simply stops counting.

An awareness entry, `src/data/awareness/local-dashboard-link.md`, tells agents the command exists and when to offer it (a person at the agent's computer who cannot unlock).

## Decision points touched

- **Who may mint** (proof of the private key + loopback peer + no forwarding header + exact Host) — invariant; basis: external-constraint; evidence: umbrella §4.6 (tunnel traffic is never local) and §3.3 (the agent's OS account is the boundary at Basic); the bearer token is not used because it can be readable by other accounts.
- **Listener authenticated before the CLI uses any response** — invariant; basis: irreversible-consequence; evidence: an unauthenticated answer could hand the person a link to a squatter.
- **Origin `127.0.0.1` and bind coverage** — invariant; basis: external-constraint; evidence: one address, held exclusively by the listening socket.
- **One key per ticket; one credential per ticket** — invariant; basis: irreversible-consequence; evidence: a second binding hands the credential to another key.
- **Lifetimes: ticket and credential 15 minutes from mint, never renewed; challenges and replay window 60 seconds** — judgment-candidate; floor: finite, single-use, non-renewing; default from umbrella §5.2/§11.11 (person-started flows); arbiter: Echo, from launch-to-unlock times measured on the throwaway agent (including a slow, interrupted run), recorded in the PR. An expired link costs one re-run.
- **Capacity: 10 unredeemed tickets and 10 live credentials, oldest evicted; 8 open challenges per ticket or credential** — judgment-candidate; floor: bounded storage and no refusal of a new launch; arbiter: Echo from the throwaway measurements.
- **Which PIN budget an unlock is charged to** (the table in §5) — invariant; basis: enumerable-domain.
- **Verified-local budget, 10 failures per 5 minutes** — invariant; basis: external-constraint; evidence: the existing shipped local floor (`AgentServer.ts` `LOCAL_PIN_MAX_FAILURES`, `LOCAL_PIN_WINDOW_MS`), reused. It is shared per machine and PIN generation, so re-minting cannot reset it, and it is never smaller than today's loopback allowance.
- **Request body cap 8 KB; store busy timeout 250 ms; owner notice at most once per 30 minutes** — judgment-candidate; floor: the largest valid body (~1 KB) fits; one writer process, and an unreadable store falls back to today's rules; the 30 minutes is the shipped `LOCAL_PIN_ALERT_COOLDOWN_MS`; arbiter: Echo.
- **Mint requests stamped before this server began listening refused** — invariant; basis: irreversible-consequence; evidence: a request captured while another program held the port could otherwise be replayed to the restarted server (round-3 finding).
- **Unredeemed tickets revoked at every server start** — invariant; basis: irreversible-consequence; evidence: a ticket outliving its listener could be read by a program that took the port during the restart (round-2 finding).
- **`startedBy` grants no authority** — invariant; basis: enumerable-domain; evidence: it is reported by the CLI itself and no gate reads it.

No model decides any of these; every check is deterministic (Tier 0).

## Frontloaded Decisions

1. The credential's only consumer is unlock-budget selection.
2. A lost exchange response is recovered within the page only; otherwise re-mint.
3. CLI only. The link is a physical-access route, which umbrella §9 records as the approved exception to Mobile-Complete; every phone and remote route stays as it is. The Mac app action is a row in piece 3's spec.
4. Origin `127.0.0.1` here; `localhost` and its two address families are piece 3's.
5. The switch is dev-gated; the fleet stays off until graduation.
6. This run ends piece 1a at merge plus the throwaway proof. Throughput (the merge-line session) owns the Local Verify run, the merge and the install; the PR number is sent to it. The dev-agent evidence is the maturation plan's dev-agent-live rung, recorded by this build after throughput installs the merged build.

## Multi-machine posture

- Ticket store, launch documents, challenges, nonces, credentials and the key — machine-local-justification: physical-credential-locality. Each machine's CLI mints against its own listener; a credential from one machine means nothing on another.
- The verified-local PIN budget — machine-local-justification: physical-credential-locality. It covers only attempts arriving at this machine's loopback.
- The browser's key in IndexedDB — machine-local-justification: physical-credential-locality.

## Verify the state, not its symbol

| Detector | Symbol it reads | State it claims | Independent corroboration | When unmeasurable |
| --- | --- | --- | --- | --- |
| Mint response check | an HMAC in the response | the agent's own server wrote the response the CLI received | the key is readable only by the agent's OS account; the HMAC covers the CLI's fresh nonce, the secret's digest and the origin; the server accepts link requests only on its `127.0.0.1` socket, so no other path can feed it a relayed request | refuse; offer the tunnel address if any |
| Bind coverage | `server.address()` | the server holds `127.0.0.1` at its port | the OS refuses another account's bind while the socket listens (checked on the throwaway); the mint response check is the backstop and fails closed | link off for this run; if the macOS check fails, the link still fails closed and the residual is recorded |
| Credential at unlock | a credential row and a signature | a link minted by the agent's OS account was redeemed through this machine's loopback within 15 minutes | the private key never leaves the browser; peer, Host and Origin are checked again at use | today's rules |

## Rollout

| Stage | What happens | Fallback |
| --- | --- | --- |
| test-agent-live | A throwaway agent from the branch build, switch set on. Prove the rows below with a real browser. | Discard the agent. |
| dev-agent-live | Throughput installs the merged build on the development agent, where the gate resolves on. Record one real `instar dashboard open` and one unlock through it. | Set the switch off. |
| fleet | Default flips after dev evidence; later pieces depend on it. | Set the switch off. |

## Tests and evidence

- **Unit:** ticket store (digests only, expiry, eviction of the oldest unredeemed ticket and the oldest live credential, unknown ids allocate nothing, challenge caps, secret proof required, same-key retry returns the same credential, a second key is refused, challenges single-use); mint HMAC and replay window; response proof; bind-coverage classification; budget-key fallbacks; `startedBy` detection.
- **Integration (mounted routes):** link requests arriving on a non-`127.0.0.1` local address are refused; mint refused without a valid key proof, with a replayed nonce, from a non-loopback peer, with a forwarding header, with a tunnel Host; a forged response makes the CLI refuse; exchange refused with a wrong Origin or Host; unlock with a valid `localAccess` and the loopback budget, PinThrottle global cap and loopback source backoff all exhausted still accepts the right PIN and charges `local-verified:*` only; an invalid `localAccess` behaves exactly as today; switch off: 404 and `localAccess` ignored; the helper ratchet over dashboard files.
- **E2E alive (production init path):** with the switch on, `POST /local-access/v1/mint` with a valid proof returns 200 and a usable ticket, and a full exchange plus unlock charges the verified-local key; with it off, 404.
- **Wiring:** the unlock route's verifier and the ticket store are real instances, not null or no-ops.
- **Throwaway live proof:** a real browser through `instar dashboard open`: redeem, exhaust the loopback budget from a separate process, unlock with the PIN through the link; print mode with a different forwarded port (open, challenge, exchange, use and unlock all with `Host: 127.0.0.1:<browserPort>`); a ticket minted before a restart is refused after it and binds nothing; a mint stamped before the restarted server began listening (including after process start) is refused; another account bound to `127.0.0.1:<port>` first makes the CLI refuse; a second instance that fails to bind leaves the running server's links working; expiry; two tabs unlocking at once; the launcher run from `~` in a fresh shell; a second process's attempt to bind `127.0.0.1:<port>` fails while the server runs; launch file gone after redemption. Measured launch-to-unlock times recorded.

## Maturation plan

- **ladder:** security.localAccessLink
- **test-agent-live:** the throwaway proof above, all rows green.
- **dev-agent-live:** one real open and unlock on the development agent after throughput installs it.
- **fleet:** flip the default after dev evidence.
- **graduation criterion:** green Local Verify, merged commit, throwaway proof and dev evidence recorded.
- **dark-window:** until real use, coverage of the Mac, Linux desktop, WSL and Windows paths stays `unknown`.

## Open questions

*(none)*

## Left behind

The rest of piece 1, in the umbrella's order, as their own specs (piece 1 is complete only when all are): the no-token refusal with the four filed fixes and iMessage SMS rows; one PIN policy across unlock, step-up, mandate PIN and the other PIN checks, keyed on the real client behind the tunnel, with a stated posture for a synced PIN and the marker cookie's port scope; PIN non-disclosure and the Basic reset ceremony with disputed claims; relay enforcement and session controls; members' own tool-free conversations with a declared home for their history; and (1g) acceptance of this link from the WSL gateway address, proved with a Windows browser. Round-5 findings for those parts are kept in the build state folder. `localhost` with both address families, and the Mac app action, belong to piece 3.
