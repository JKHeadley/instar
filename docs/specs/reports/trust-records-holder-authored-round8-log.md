# trust-records-holder-authored — round 8 log (2026-11-18, scoped review of the cut form)

Authorized by the Chief of Staff (2026-11-18 03:24 PST, message 942dabd9 in the M5 store): one short round on the cut text, the same five reviewers, scoped to ONE question: does the cut form open any hole the pre-cut design closed, or leave a peer-grant path. Hand-over UX and re-ask cost out of scope (accepted; operator item a). If a reviewer finds a real hole in the cut, fix that hole and re-ask the same reviewer only.

Reviewers: the same three internal reviewers as round 7 (re-asked, never replaced), claude-opus-5-5; codex-cli gpt-6-astra (ok, MINOR ISSUES); clean-door claude-code claude-fable-5-2 (ok, MINOR ISSUES). Spec hash at review: 5dfac833. Standards-Conformance Gate: 3 flags (Trust Is Earned by Work = item a; Always a Multi-Machine Entity = item c; Judgment Within Floors on the fixed five-second lease read: a cost item, out of scope; the read only ever fails closed).

Peer-grant path (kind b): none, all five reviewers, the internal ones checked against the build.

Holes the cut reopened (kind a), all fixed and re-asked:
1. Same-epoch tie (integration; security): a resolved tie did not end the winner's run, so an earlier approval could run twice. Fix: foreign epochs. An epoch at which the coordinator names another holder, reports a contest, emits its split-brain detection, or at which any peer's own lease (live or expired) shows that peer held it, is foreign; no run spans one. Integration: CONCUR. Security (first re-ask): partly, the loser-gives-up-first tie was missed; fixed with the expired-peer-lease rule; second re-ask: CONCUR.
2. Withdrawal on a standby (decision-completeness; security): a standby had no current run, so its withdrawal named nothing and the holder's acceptance stayed live. Fix: a withdrawal names every acceptance id any machine recorded for its subject (device: by device id or key fingerprint), an evidence-only read that can only narrow. Decision-completeness: CONCUR. Security: CONCUR.

External DESIGN claims, checked: fable 1 (a self-claimed replica at boot) was already closed by the build (the boot reader skips a self-named replica file and drops entries claiming this machine); now stated in decision 2. Fable 2 (an epoch recorded from a view) is closed by `holdsLease()` validating the view's lease as this machine's at that epoch, plus a consistent read (an epoch that moves during the read counts as contested).

Precision taken: lost-file wording; peer `request-status` only closes; `apply-outcome` own-only; `s<N>` keys; foreign list pruned by value and fail-closed past its bound; residuals for withdrawal before replication and withdrawal fan-out.

Result: all five reviewers report no remaining hole of kind (a) or (b). Converged at round 8.

Convergence-tag counts (decision-completeness, round 8): 12 frontloaded decisions, 16 cheap tags, 3 contested cleared.
