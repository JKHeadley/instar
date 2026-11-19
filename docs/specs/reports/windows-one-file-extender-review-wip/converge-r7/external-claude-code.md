# claude-code ok claude-opus-5-5 MINOR ISSUES None
**Note on provenance:** I am Claude (Opus 5.5), not a GPT-family model. This report does not give the cross-model independence the prompt assumes, so don't record it as the `cross-model-review` result.

**Verdict: MINOR ISSUES**

**1. DESIGN: A signature on every frame is slow and unnecessary (§"The PC checks the agent").** Every frame in both directions is signed, and on the PC that means the key `d`, TPM-backed when a TPM is present. A TPM P-256 signature usually takes tens to hundreds of milliseconds. That would limit 256 KB file chunks to a few MB/s and add lag to input and screenshots. The extra signatures also buy nothing: ChaCha20-Poly1305 under keys derived from the signed transcript already ties each frame to this connection and these peers. The handshake also isn't really "Noise XX", since that pattern has no signatures; it is closer to SIGMA. Calling it Noise invites someone to build a custom hybrid. **Fix:** sign only the handshake transcript, then rely on AEAD with nonce/sequence checks. Better still, use an existing Noise library (for example Noise IK, with the static keys bound by one signature) and name the pattern correctly.

**2. DESIGN: The strict "+1" order number can block the owner's direct Remove (§Owner-signed records, §Lower and Remove).** The phone learns the current number from the home machine's mirror, and home-signed console Lowers also advance the number. A home machine that reports the wrong number, or that keeps issuing Lowers, can make every owner Lower or Remove fail the exact-match check. That breaks the direct-to-home fallback in the one case it exists for. **Fix:** keep the exact `last+1` rule for orders that add authority (grant, raise, key changes). Accept orders that reduce authority (Lower, Remove) at any number above the last applied one, still with expiry and device/key binding.

**3. PRECISION: "Stop cancels everything" claims too much (§Scam safeguards, Job Object).** A Job Object does not hold processes started through WMI (`Win32_Process.Create`), Task Scheduler, COM out-of-process servers or `explorer`. The tray and consent text should say Stop ends the program's own processes and may not end ones those started.

**4. PRECISION: The update scheme rebuilds TUF by hand (§Updates).** It already has two keys, rotation signed by both, a timestamp and a "newer only" rule. It still lacks a freeze defence (a stale manifest served forever) and has no emergency path if Justin's key is lost. Either adopt TUF's role model or name freeze and key loss explicitly. Raising the minimum build already works as a crude kill switch; say so.

**5. PRECISION: Architecture detection (§Journey step 2).** Chromium browsers on Windows on Arm often report "Win64; x64" in the user agent. Use the `Sec-CH-UA-Arch` client hint, or rely on x64 emulation and say so.

**6. PRECISION: The packaging decision conflicts with the attached report.** The comparison report recommends the app mode first, but the spec ships the file first. The spec does reconcile this (Justin's approval plus a migration path), but the report's "Connect spec stays unapproved / nothing is built" status should be updated so the two documents agree.

No over-reliance on LLM judgment: every decision is a deterministic check on signatures and modes. The heavy use of consent steps fits a scam-exposed remote-control tool.
