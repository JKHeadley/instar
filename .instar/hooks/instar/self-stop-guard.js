#!/usr/bin/env node
// Self-stop guard — catches the agent rationalizing a session STOP for reasons
// that are NEVER valid: "maxed out context", "session too long / running long",
// "let's start a fresh session", "good stopping point", "close this out and
// restart". PreToolUse hook for shell commands (Claude 'Bash' | Codex
// 'exec_command'). Scans OUTBOUND messages to the user; when a stop-excuse is
// detected it injects the "No context-death self-stops" reminder (does NOT
// block) so the agent re-grounds before sending.
//
// Born from a real failure (2026-06-02): the agent closed out a 12h autonomous
// run early citing "maxed out context" — one of the most deeply-rooted stop
// excuses. The user's correction, verbatim: "ITS NOT!!!!! PERIOD!!!! Instar has
// infrastructure to handle this and it's never an excuse. ... a session can run
// infinitely." Compaction-recovery re-injects identity, memory, and recent
// context automatically — context length is NEVER a stop reason. The ONLY
// legitimate stops: a real design question only the user can answer, missing
// information only they have, a genuine unrecoverable error, or actual
// completion. The user explicitly asked for "infrastructure and awareness checks
// on multiple levels to prevent this" (Structure > Willpower).
//
// SIGNAL ONLY — never blocks, never destructive. Sibling of deferral-detector.js
// (which guards the false-blocker / orphan-TODO anti-patterns). Pure stdin→stdout
// (no require/fs) so it is ESM-host safe.

let data = '';
process.stdin.on('data', chunk => data += chunk);
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(data);
    // Codex-aware: Codex's shell tool is 'exec_command'; Claude's is 'Bash'.
    if (input.tool_name !== 'Bash' && input.tool_name !== 'exec_command') process.exit(0);

    const command = (input.tool_input || {}).command || (input.tool_input || {}).cmd || '';
    if (!command) process.exit(0);

    // Only check OUTBOUND messages to the user — the surface where a stop-excuse
    // gets communicated ("why don't we close this out and start fresh").
    const commPatterns = [
      /telegram-reply/i, /send-email/i, /send-message/i,
      /POST.*\/telegram\/(reply|post-update)/i, /slack.*send/i,
    ];
    if (!commPatterns.some(p => p.test(command))) process.exit(0);

    // Legitimate-stop anti-triggers — never nag a genuine, valid stop.
    const legitimateStop = [
      /ALL_TASKS_COMPLETE/,
      /<promise>/i,
      /(?:task|build|work|feature|fix|migration|spec|PR|all tests?|the suite) (?:is |are |now )?(?:complete|done|finished|shipped|merged|passing|green)\b/i,
      /(?:you (?:asked|told|said) (?:me )?(?:to )?(?:stop|pause)|emergency stop|stop everything|as you requested|you wanted me to (?:stop|pause))/i,
    ];
    if (legitimateStop.some(p => p.test(command))) process.exit(0);

    // Stop-excuse patterns — rationalizing a stop for context/length reasons.
    const stopExcusePatterns = [
      { re: /max(?:ed|ing)?[\s-]*out (?:my |the |on )?context/i, type: 'maxed_context' },
      { re: /(?:running |getting |almost )?(?:low|short|out) (?:on|of) context/i, type: 'low_on_context' },
      { re: /context (?:window|limit|budget)?\s*(?:is |getting |running )?(?:maxed|full|exhausted|tight|nearly full|almost full)/i, type: 'context_limit' },
      { re: /(?:preserve|conserve|save|protect) (?:my |the |on )?context(?:\s+window)?/i, type: 'preserve_context' },
      { re: /(?:this |the |my )?session (?:has )?(?:been )?(?:going |running )?(?:on )?(?:too |very |really )?long\b/i, type: 'session_too_long' },
      { re: /long[\s-]running session/i, type: 'long_running_session' },
      { re: /been (?:going|running|at (?:this|it)) (?:for )?(?:too long|a (?:long )?while|quite a)/i, type: 'going_too_long' },
      { re: /(?:start|spin up|kick off|begin|open|fire up) (?:a |another |the )?(?:fresh|new|clean|second) (?:session|run|window)/i, type: 'fresh_session_deflection' },
      { re: /(?:continue|pick (?:this|it|things) up|resume) (?:in |with |on )?(?:a |the )?(?:fresh|new|next) session/i, type: 'continue_fresh_session' },
      { re: /close (?:this )?(?:out|up)(?: here)?(?: and| then| to)? (?:start|begin|spin|open|kick)/i, type: 'close_out_and_restart' },
      { re: /(?:good|natural|convenient|nice|reasonable) (?:place to (?:stop|pause|break)|(?:stopping|breaking) point)/i, type: 'good_stopping_point' },
      { re: /(?:i'?ll |let'?s |i should |time to |going to |gonna )(?:stop|wrap (?:up|this up|it up)|pause|call it)(?:\s+(?:here|now|for (?:now|today)))?/i, type: 'premature_wrap' },
    ];

    const matches = stopExcusePatterns.filter(p => p.re.test(command));
    if (matches.length === 0) process.exit(0);

    const checklist = [
      'SELF-STOP EXCUSE DETECTED — you are about to tell the user you are stopping for a reason that is NEVER valid.',
      '',
      '"Maxed out context" / "session too long" / "let me start fresh" / "good stopping point" are NOT stop reasons.',
      'Instar has compaction infrastructure: compaction-recovery re-injects your identity, memory, and recent context automatically. A session can run indefinitely. The worst case of continuing is a ~30s re-read of your plan file — never lost work, as long as durable artifacts (committed code, a plan file, ledger rows) exist on disk.',
      '',
      'The ONLY legitimate stops are:',
      '  1. A real design question only the user can answer.',
      '  2. Missing information only the user has.',
      '  3. A genuine error you cannot resolve.',
      '  4. Actual, verified completion of the work.',
      '',
      'If your stop is NOT one of those four — do not send this. Keep going. If you have a milestone to report, report it AND continue; reporting progress is not stopping.',
      '',
      'Detected: ' + matches.map(m => m.type).join(', '),
    ];

    process.stdout.write(JSON.stringify({ decision: 'approve', additionalContext: checklist.join('\n') }));
  } catch { /* never break on errors */ }
  process.exit(0);
});
