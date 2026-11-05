# Saved sign-in browser opened by a test

Verdict: unsafe automation is confirmed; historical sign-out causation is inconclusive. The repair did not finish. Do not describe the account itself as lost.

Primary records (machine-local transcripts; contain credentials, so do not publish the raw records):

- Topic 137333 transcript `1929ebbd-fbfa-4a41-b522-5398b4f184a6`, tool use `toolu_01Ug8BFKYVyCjic9qoiQ5NfG`, 2026-11-05 03:54:52.856 UTC: writes and runs a script using `chromium.launchPersistentContext` on the registered `dawn-google` directory. Its subsequent report observes Slack signed out. Earlier normal Chrome reads failed, so they supply no immediately-before authenticated observation.
- Topic 136880 transcript `9a2bf9c7-e67c-4f35-a190-433fa14919bb`, 04:21:08.938 UTC: repair reports password accepted, one saved backup code submitted and rejected, then stopped. It records uncertainty about field entry and whether lockout text was visible. The local backup list was shortened before submission; Bitwarden was locked and its list was not reconciled. No successful Google or Slack verification followed.
- Topic 136110, message 138392 at 04:07:28 UTC asks Justin for a phone tap. Message 138415 at 04:18:38 overstates the timing evidence. Message 138470 at 04:47:53 corrects it: the cited timestamp was an ordinary Chrome launch, and the backup code was rejected.
- Fresh authenticated read of `/subscription-relogin` on 2026-11-05 during this fix found no Dawn repair episode. The registry's account assertion is not a live service proof. No repair-success receipt was found.

What this proves: a real test used an unsafe persistent-profile launch, and the operator was asked to act before a completed normal repair had been established. What it cannot prove: whether that launch caused the original sign-out, merely exposed preexisting unreadable cookies, or encountered an already-expired provider session. No before-and-after authenticated evidence or cookie-decryption failure record establishes that causal distinction. The mock-keychain explanation remains a hypothesis.

Prevention: refuse this launch class using registry ownership at activation, browser startup, dynamic MCP load/registration, and ordinary browser tool execution. Use disposable profiles for tests and normal Chrome for approved repair. No saved profile was used for a destructive reproduction. No laptop session or test agent was started.

Recovery status: failed, not verified recovered. The provider's rejected code and uncertain challenge state must be inspected through the standard normal-browser repair before further credential attempts. Never send another phone prompt solely on the assumption that a test needs it.
