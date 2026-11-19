# claude-code ok claude-opus-5-5 MINOR ISSUES None
**Reviewer note:** this review was run by Claude (Opus 5.5), not a GPT-tier model. It is not independent of the Claude family. Don't record it as the cross-model review, and keep the `cross-model-review` field pointing to a real non-Claude run.

**Verdict: MINOR ISSUES** (one DESIGN finding)

**1. DESIGN: the claim that the owner's Lower/Remove can never be blocked is false as specified.** (§The PC checks the agent: owner-signed records; §Frontloaded Decisions)
The phone signs using the order number that the home machine mirrors. If the PC's real number is higher, the PC refuses the order because it is not "higher than the last applied". That can happen in two ways:
- a tray Lower made while the PC was offline;
- a home machine that under-reports the number, or keeps issuing its own Lowers.

The 1,000 cap doesn't help, because the phone never learns the true number.
**Resolution:** reducing orders should skip the number check. They should be checked only for purpose, device id, fingerprint and expiry. Applying one sets the PC's number to max(current, its number) + 1. A replayed Lower can only reduce authority, and the 10-minute expiry limits replays. Also fix the Decision Points wording, which drops the cap.

**2. PRECISION: the remote-control list misses today's main scam channel.** (§Journey step 6)
The list has no screen-sharing apps: Zoom, Teams, Google Meet (browser), Discord, Webex. Anyone who can see the screen can scan the QR, so pairing has no proximity binding. Add these apps to the list. Also state plainly that the QR is the only pairing secret and anyone who can see it can pair.

**3. PRECISION: the spec doesn't say why it doesn't reuse an existing remote-access agent.** (§Proposed design)
It names MeshCentral as the pattern, then builds its own versions of the outbound agent, file relay, idempotent dispatch, and an updater close to TUF (The Update Framework: thresholds, expiry, freeze protection). Add a short paragraph on why it doesn't embed MeshCentral or RustDesk, or use TUF directly, for example AV reputation, licence, or trust model. Otherwise readers will assume nobody checked.

**4. PRECISION: the bulk-delete gate is a fence with little effect.** (§Agent side)
Under Full control, `Remove-Item -Recurse` through exec skips it entirely. Yet it adds Work Board cards, a 24-hour expiry and a new state. Either drop it or call it accident protection only. As it stands it reads like containment.

**5. PRECISION: the emergency stop depends on the bad release.** (§Updates)
Raising the minimum build only helps if a newer good build exists, which needs Justin's tap. PCs on a build whose updater is broken get stuck in `update-required` loops. State this and say what the PC shows in that case.

**6. PRECISION: the frontmatter disagrees with the round-8 summary.**
The frontmatter sets `review-convergence` / `review-completed-at`. The round-8 summary says the fixes are unreviewed and approval stays off. Clear the convergence fields until the confirmation round is done.

**Checked and fine:**
- Using Noise KK with a once-per-connection `d` signature over the handshake hash is sound.
- The single home machine is a clear and justified simplification.
- Keeping the PC out of `DeviceRegistry` and testing with a deny-by-default route walk is the right shape.
