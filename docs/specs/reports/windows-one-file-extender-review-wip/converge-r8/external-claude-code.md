# claude-code ok claude-opus-5-5 MINOR ISSUES None
**Verdict: MINOR ISSUES**

I checked the four open DESIGN items from round 7 against the body, and all four are addressed: Noise KK, cancellation reported separately from outcome, the durable `dispatching` state, and the asymmetric order numbers. The briefing suggested "Noise IK". The spec's KK is the better fit, because both static keys are already pinned at pairing.

**1. DESIGN: the 256 KB frame size is impossible under Noise** (§Connection, "frame cap matched to the 256 KB chunk"; §Encrypted channel)
- **What the spec says:** the WebSocket frame cap matches a 256 KB file chunk.
- **What Noise allows:** a transport message can be at most 65,535 bytes. A 256 KB chunk cannot be sent as one encrypted message, and maintained Noise libraries enforce this limit.
- **Fix:** split each 256 KB relay chunk into Noise messages of at most 65,535 bytes. Set the WebSocket frame cap to that size, or define how the pieces of a chunk are put back together. Add a cross-language test vector for a chunk that spans several Noise messages.

**2. DESIGN: most likely failure, Justin replaces his phone** (§Updates)
- **What the spec says:** every release needs a signature from Justin's phone key, which is compiled into the program. If that key is lost, every fielded PC needs a manual reinstall.
- **Why this is likely:** people replace phones every few years, and a Face ID key cannot be exported. So this is the expected path, not a rare one. The same dependency also blocks urgent security fixes for as long as Justin cannot tap.
- **Fix:** compile in a second, offline recovery key, for example a hardware security key or a paper key held by Justin. That key alone may announce a successor phone key. Alternatively, adopt TUF's root/targets role split, which solves exactly this problem.

**3. PRECISION: release-key rotation rules contradict each other** (§Updates)
- One sentence says a new release key needs "both current keys". A later sentence says it needs "the current key".
- **Fix:** keep the both-keys rule and delete the later sentence.

**4. PRECISION: the architecture hint will usually be missing** (§Journey step 2)
- `Sec-CH-UA-Arch` is a high-entropy client hint. A browser sends it only after the server opts in with `Accept-CH`, or with a `Critical-CH` retry on the first request. Firefox and Safari never send it.
- **Fix:** have instar.sh/pc send `Accept-CH` and `Critical-CH`. Note that Windows 10 on Arm cannot run x64 builds, so the x64 fallback fails there.

**5. PRECISION: "Open questions: none" is not true** (§Packaging, §Open questions)
- The body says the "built into the Windows app" choice waits for Justin, and approval is held on it.
- **Fix:** list it under Open questions.

**6. PRECISION: how the PC knows a `callId` is older than 7 days** (§Calls from other machines)
- The PC refuses retries older than 7 days, but nothing says how it tells a `callId`'s age.
- **Fix:** have the home machine stamp the time on each call, rather than trusting the caller's clock, and say so.

**7. PRECISION: what happens to the old key after Connect again** (§Remover)
- It is unclear whether Connect again deletes the old CNG key and the old order-number state on the same PC.
- **Fix:** say that it does.

**8. PRECISION: the Look-only "lift" setting isn't protected** (§Modes)
- The person can lift the credential-folder list, but that choice isn't stored under the same signed, two-copy protection as the mode.
- **Fix:** store it with the mode.

**On model-family bias:** the spec dropped per-frame signatures, which is the right call. The session-credential filter is openly described as not a security boundary, so its complexity buys little. I'm not asking for it to be removed.
