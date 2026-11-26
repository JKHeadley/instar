# Submit a bracketed paste to Claude Code

The approved cluster contains 14 reports across electruck, b2lead-insights, inspec and Echo. In fb-3675796e-061, the initial Enter sometimes leaves pasted text in the composer on Claude Code v2.1.105+. The later recovery Enter usually succeeds. Echo also saw an unsubmitted verdict after Claude answered a first message. These observations supply neither a pane capture nor a measured paste-commit threshold.

On origin/main at 40c6df6c1 (1.3.2045), injectMessage checks provenance, rawInject sanitizes terminal controls, and performTmuxInjectionEffect waits 500 ms after a bracketed paste before sending one Enter to Claude. verifyInjection starts another 500 ms later. Its per-line search can match a historical ❯ above the answer and can miss a 40-character marker containing a newline.

Give a positively identified Claude Code pane until the former first recovery time (one second after paste-end) for its single initial Enter. Keep literal single-line typing and other frameworks' submit sequences. Correlate recovery with the current Claude composer, including visible multiline input. A cleared composer or another draft ends recovery. The bounded ladder retains its busy, incarnation and physical-key fences. Pane evidence informs recovery and conveys no new authority to accept input or claim a reply.

Exercise a synthetic slow paste and a genuinely dropped Enter with a controlled terminal and clock. Count submit keys and degradation reports through injectMessage, then test an authenticated paste request and its recovery lifecycle through the existing server. Run adjacent refusal, sanitization and health ownership tests. A revert suffices for rollback.
