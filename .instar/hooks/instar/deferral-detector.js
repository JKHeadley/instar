#!/usr/bin/env node
// Deferral detector — catches agents deferring work they could do themselves
// AND catches agents proposing orphan-TODO follow-ups with no infrastructure.
// PreToolUse hook for shell commands (Claude 'Bash' | Codex 'exec_command').
// Scans outgoing messages for the patterns.
// When detected, injects a due diligence checklist (does NOT block).
//
// Born from two failure modes:
//   1) An agent saying "This is credential input I cannot do myself" when it
//      already had the token available via CLI tools.
//   2) An agent saying "queue for next session" / "loop back later" / "we
//      can pick this up in a follow-up" with no /schedule cron and no
//      /commit-action tracker — the orphan-TODO trap that makes
//      promised follow-through evaporate (incident: 2026-04-27, when
//      Echo proposed exactly this pattern after Layer 1 of a multi-layer
//      build shipped without infra to ensure follow-on layers landed).
//   3) An agent deferring a doable task to a person — "needs a human",
//      "second opinion", "needs reverse-engineering" — when computer use,
//      terminal, send-keys, and MCP tools were right there (the B17
//      "Never a False Blocker" signal; authority is MessagingToneGate B17).
//      Self-fetched cross-model review (GPT/Gemini/etc.) is NOT flagged.
//   4) An agent deferring or winding down because of the HOUR / fatigue rather
//      than a real constraint — "rather than rush at the tail of the night",
//      "it's late", "wrap up", "do it tomorrow" (incident 2026-06-09: deferred
//      a doable fix citing "tail of tonight" at 3:41 PM). Unlike orphan-TODOs,
//      this is NOT exempted by infrastructure-backing — tracking the work as a
//      commitment does not legitimize the time-of-day framing; it launders it.
//   5) An agent handing the MERGE decision for a PR IT AUTHORED back to the
//      operator — "the merge call is yours", "want me to merge?", "ready to
//      merge?", "your call on whether to merge" (incident 2026-06-09: presented
//      its own green PR #1040 as "the merge call is yours"). The operator
//      directed this must NEVER be a blocker: a self-authored green PR is the
//      agent's to merge, full stop (instar-dev Phase 7 — Auto-merge on green).
//      Like time/fatigue, NOT exempted by infrastructure-backing — having tracked
//      the PR does not make handing its merge to the operator legitimate.
//
// SIGNAL ONLY — this hook never blocks. The authority that can hold an
// outbound message is MessagingToneGate (B17_FALSE_BLOCKER).

// Best-effort, NON-BLOCKING auto-open of a candidate Blocker Ledger entry
// (Structure > Willpower — the agent does not have to remember to log a blocker).
// Fires a fire-and-forget POST /blockers when false-blocker/inability framing is
// detected. Wrapped so a failure (e.g. 503 when the ledger ships dark, no auth, no
// server) can NEVER alter the hook's existing stdout checklist behavior. Auth
// mirrors hook-event-reporter.js (INSTAR_AUTH_TOKEN / INSTAR_SERVER_URL env).
function autoOpenBlocker(detectedText, origin) {
  try {
    const authToken = process.env.INSTAR_AUTH_TOKEN || '';
    if (!authToken) return; // no auth → nothing to call; never blocks the checklist.
    const serverUrl = process.env.INSTAR_SERVER_URL || 'http://localhost:4042';
    void (async () => {
      try {
        const { request } = await import('node:http');
        const payload = JSON.stringify({
          detectedText: String(detectedText || '').slice(0, 4000),
          origin: String(origin || 'deferral-detector'),
        });
        const url = new URL(serverUrl + '/blockers');
        const req = request({
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + authToken,
            'X-Instar-Request': '1',
          },
          timeout: 1500,
        }, (res) => { res.resume(); });
        req.on('error', () => {});
        req.on('timeout', () => { try { req.destroy(); } catch (e) {} });
        req.write(payload);
        req.end();
      } catch (e) { /* best-effort — never break the hook */ }
    })();
  } catch (e) { /* best-effort — never break the hook */ }
}

let data = '';
process.stdin.on('data', chunk => data += chunk);
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(data);
    // Codex-aware: Codex's shell tool is 'exec_command' (not 'Bash') and puts the
    // command in tool_input.cmd (Claude uses tool_input.command). Accept both so the
    // detector fires on both engines (same fix class as dangerous-command-guard).
    if (input.tool_name !== 'Bash' && input.tool_name !== 'exec_command') process.exit(0);

    const command = (input.tool_input || {}).command || (input.tool_input || {}).cmd || '';
    if (!command) process.exit(0);

    // Only check communication commands (messages to humans)
    const commPatterns = [
      /telegram-reply/i, /send-email/i, /send-message/i,
      /POST.*\/telegram\/reply/i, /slack.*send/i
    ];
    if (!commPatterns.some(p => p.test(command))) process.exit(0);

    // Exempt: genuinely human-only actions
    if (/password|captcha|legal|billing|payment credential/i.test(command)) process.exit(0);

    // Inability / passing-the-buck patterns (original detector scope)
    const inabilityPatterns = [
      { re: /(?:I |i )(?:can'?t|cannot|am (?:not |un)able to)/i, type: 'inability_claim' },
      { re: /(?:this |it )(?:requires|needs) (?:your|human|manual) (?:input|intervention|action)/i, type: 'human_required' },
      { re: /you(?:'ll| will)? need to (?:do|handle|complete|input|enter|run|execute|click)/i, type: 'directing_human' },
      { re: /(?:you (?:can|could|should|might want to) )(?:run|execute|navigate|open|click)/i, type: 'suggesting_human_action' },
      { re: /(?:want me to|should I|shall I|would you like me to) (?:proceed|continue|go ahead)/i, type: 'permission_seeking' },
      { re: /(?:blocker|blocking issue|can'?t proceed (?:without|until))/i, type: 'claimed_blocker' },
      // B17 false-blocker shapes: deferring a doable task to a person / reverse-engineering.
      { re: /(?:needs?|requires?) (?:a )?human to/i, type: 'needs_human_to' },
      { re: /(?:needs?|requires?|need) (?:to )?reverse[- ]?engineer/i, type: 'needs_reverse_engineering' },
    ];

    // Orphan-TODO patterns — proposing future-self follow-up without infrastructure.
    // The danger: "later" without /schedule or /commit-action evaporates between
    // sessions because there is no automatic carry-over.
    const orphanPatterns = [
      { re: /queue (?:them |it |this )?(?:up |for )?(?:the )?(?:next session|later|future|follow[- ]?up)/i, type: 'queue_for_later' },
      { re: /(?:pick (?:this |it )?up|circle back|loop back|come back) (?:later|in (?:a |the )?(?:next|future|follow[- ]?up))/i, type: 'pick_up_later' },
      { re: /(?:in |for )(?:a |the |another )?(?:follow[- ]?up|next session|future session|later session)/i, type: 'follow_up_session' },
      { re: /(?:i'?ll |i will |i can |we (?:can|could) )(?:address|tackle|handle|fix|do|build|implement) (?:that |this |it )?(?:later|next time|in (?:the |a )?(?:future|follow[- ]?up))/i, type: 'self_promised_later' },
      { re: /(?:deferred|defer|deferring) (?:to|until|for) (?:a |the |next |another )?(?:follow[- ]?up|session|later|future)/i, type: 'explicit_defer' },
      { re: /(?:next time|future work|left for later|future iteration|TODO:?\s*later)/i, type: 'future_work_marker' },
    ];

    // Time/fatigue deferral patterns — deferring or winding down because of the
    // HOUR or to "avoid rushing", not a real constraint. This is the gravity-well
    // tell (incident 2026-06-09: deferred a doable fix citing "the tail of tonight"
    // — at 3:41 PM. The framing, not the hour, was the driver). These are
    // deliberately NOT exempted by the infrastructure-backed anti-trigger below:
    // tracking the work as a commitment/PR does NOT make "I'll do it rather than
    // rush at the end of the night" legitimate — that just launders the deferral.
    const timeFatiguePatterns = [
      { re: /tail (?:end )?of (?:the |this )?(?:night|tonight|day|today|evening|session)/i, type: 'tail_of_period' },
      { re: /(?:at the )?end of (?:a |the |this )?(?:long )?(?:night|day)\b/i, type: 'end_of_period' },
      { re: /(?:rather (?:than|not)|don'?t want to|do not want to|to avoid|instead of|so as not to|avoid) rush(?:ing)?/i, type: 'avoid_rushing' },
      { re: /\bit(?:'?s| is| ?is) (?:late|getting late)\b/i, type: 'its_late' },
      { re: /(?:wrap (?:it |this |things )?up|call it (?:a (?:night|day)|here|quits)|wind(?:ing)? down)\b/i, type: 'wind_down' },
      { re: /(?:tomorrow|in the morning|first thing) (?:i'?ll|we'?ll|i can|i will|let'?s)/i, type: 'do_it_tomorrow' },
      { re: /(?:defer|queue|leave|save|hold|push|punt) (?:it |this |that |them )?(?:to|for|till|until) (?:tomorrow|the morning|tonight|next session)/i, type: 'defer_to_later_time' },
    ];

    // Merge-deferral patterns — handing the MERGE decision for a PR the agent
    // authored back to the operator. The operator directed this must NEVER be a
    // blocker (2026-06-09): a self-authored green PR is the agent's to merge
    // (instar-dev Phase 7). Two shapes: (a) explicitly assigning the call to the
    // user ("the merge call is yours", "your call to merge"), and (b) asking
    // permission to merge one's own PR ("want me to merge?", "ready to merge?").
    // Like time/fatigue, these are NOT exempted by infrastructure-backing —
    // having tracked the PR does not legitimize handing its merge to the operator.
    const mergeDeferralPatterns = [
      // (a) Explicitly assigning the merge decision to the operator.
      { re: /(?:the )?merge (?:call |decision )?(?:is |stays |remains |')?s? ?(?:yours|with you|the user'?s|the operator'?s)/i, type: 'merge_call_is_yours' },
      { re: /your (?:the )?merge (?:call|decision)/i, type: 'your_merge_call' },
      { re: /your (?:final )?call (?:on |to |whether |as to whether )?(?:to )?merge\b/i, type: 'your_call_to_merge' },
      { re: /(?:i'?ll |i will |i'?d |let me )?(?:leave|leaving|let) (?:the merge|you (?:to )?merge|it (?:to|with) you to merge)/i, type: 'leave_merge_to_you' },
      { re: /(?:for |up to )you (?:to|whether to) merge\b/i, type: 'up_to_you_to_merge' },
      { re: /(?:merge|merging) (?:is |when )?(?:your|the user'?s|the operator'?s) (?:to (?:make|call|decide)|call|decision)/i, type: 'merge_is_yours_to_make' },
      // (b) Asking permission to merge one's OWN PR (instar-dev Phase 7 bans this).
      { re: /(?:want me to|should i|shall i|ready to|ok to|okay to|good to|safe to|do you want me to|would you like me to) merge\b/i, type: 'merge_permission_seeking' },
    ];

    // Anti-trigger: messages that DO back the deferral with infrastructure
    // get a pass — they are not orphan TODOs. The same message that mentions
    // /schedule, /commit-action, a cron expression, or a tracked deadline
    // is doing it right.
    const infrastructureBackedPatterns = [
      /\/schedule\b/i,
      /\/commit[-_ ]?action\b/i,
      /commit-action\b/i,
      /scheduled (?:agent|run|cron|routine)/i,
      /cron expression|cron schedule/i,
      /tracked (?:commitment|deadline|action[- ]?item)/i,
      /follow[- ]?up (?:PR|commit|branch)\b/i,
    ];
    const isInfrastructureBacked = infrastructureBackedPatterns.some(p => p.test(command));

    const inabilityMatches = inabilityPatterns.filter(p => p.re.test(command));

    // B17 second-opinion: a false blocker ONLY when the agent hands the task to the
    // user. Seeking a cross-model review the agent will fetch itself (GPT/Gemini/etc.)
    // is endorsed practice, not a deferral — so suppress when a model/agent is named.
    const selfFetchedReview = /\b(?:gpt|gemini|grok|o3|cross[- ]?model|crossreview|another (?:agent|model))\b/i.test(command);
    if (!selfFetchedReview && /second opinion/i.test(command)) {
      inabilityMatches.push({ re: /second opinion/i, type: 'wants_second_opinion' });
    }

    const orphanMatches = isInfrastructureBacked
      ? []  // Backed by real infra — not an orphan TODO.
      : orphanPatterns.filter(p => p.re.test(command));

    // Time/fatigue deferral is NOT exempted by infrastructure-backing — the
    // framing ("rather than rush at the tail of the night") is the gravity well
    // regardless of whether the work was tracked.
    const timeFatigueMatches = timeFatiguePatterns.filter(p => p.re.test(command));

    // Merge-deferral is NOT exempted by infrastructure-backing either — handing
    // the merge of a self-authored PR to the operator is the gravity well
    // regardless of whether the PR was tracked.
    const mergeDeferralMatches = mergeDeferralPatterns.filter(p => p.re.test(command));

    const allMatches = [...inabilityMatches, ...orphanMatches, ...timeFatigueMatches, ...mergeDeferralMatches];
    if (allMatches.length === 0) process.exit(0);

    const checklist = [];

    if (inabilityMatches.length > 0) {
      checklist.push(
        'DEFERRAL DETECTED — Before claiming you cannot do something, verify:',
        '',
        '1. Did you check --help or docs for the tool you are using?',
        '2. Did you search for a token/API-based alternative to interactive auth?',
        '3. Do you already have credentials/tokens that might work? (env vars, CLI auth, saved configs)',
        '4. Did you try your OWN means? — computer use (read the screen, click buttons), terminal, send-keys into a live session, the dashboard, MCP tools. A button on screen is not a human-only blocker.',
        '5. Is this GENUINELY human-only? The tiny set: a password only the user knows, a CAPTCHA, a legal/billing/payment authorization, an account only they can grant, or a judgment call that is theirs.',
        '',
        'If ANY check might work — try it first, naming what you actually tried and what happened.',
        'The pattern: You are DESCRIBING work instead of DOING work. "Needs a human / a second opinion / reverse-engineering" is almost never true when you have computer use and a terminal.',
      );
    }

    if (orphanMatches.length > 0) {
      if (checklist.length > 0) checklist.push('');
      checklist.push(
        'ORPHAN-TODO TRAP DETECTED — You proposed deferring work to "later" or "next session" without backing infrastructure.',
        '',
        'Without one of these, the work will not actually happen:',
        '  - /schedule a remote agent (cron or one-shot) to do the work',
        '  - /commit-action with a deadline so it surfaces on the work queue',
        '  - A same-branch follow-up commit chained to merge before you stop',
        '  - Tying the deferred work to an existing tracked spec/issue',
        '',
        'If none of those apply, the deferral evaporates between sessions.',
        'Either back the deferral with infrastructure NOW, or do the work NOW.',
        '"I will get to it next time" is not infrastructure.',
      );
    }

    if (timeFatigueMatches.length > 0) {
      if (checklist.length > 0) checklist.push('');
      checklist.push(
        'TIME/FATIGUE DEFERRAL DETECTED — you are deferring or winding down based on the hour or "not rushing", not a real constraint.',
        '',
        'There is no "rushing at the tail of the night" — there is doing the work or not.',
        '  1. Quote the ACTUAL current time — it is injected into every turn (CURRENT TIME). Do not use a vibe word like "tonight"; check the clock first.',
        '  2. Time-of-day, "it is late", and "to avoid rushing" are NEVER reasons to defer, queue, or wind down. Having TRACKED the work (a commitment/PR) does NOT make the framing legitimate — that just launders the deferral.',
        '  3. The only legitimate stops: a real external blocker, information only the user has, or genuine completion.',
        '',
        'If you were about to defer because of the hour or to "avoid rushing" — do not. Decide and proceed NOW.',
      );
    }

    if (mergeDeferralMatches.length > 0) {
      if (checklist.length > 0) checklist.push('');
      checklist.push(
        'MERGE-DEFERRAL DETECTED — you are handing the merge decision back to the operator. For a PR YOU authored, that is never the operator\'s call.',
        '',
        '  1. If this is your PR and CI is green, MERGE IT YOURSELF NOW — green CI = mergeable. Use "node scripts/safe-merge.mjs <PR#> --squash --admin" in the instar repo, or "gh pr merge <PR#> --squash" (add --admin if branch protection blocks an otherwise-green PR).',
        '  2. "want me to merge?" / "should I merge?" / "ready to merge?" / "the merge call is yours" for your own green PR is redundant ceremony that stalls delivery. The operator directed (2026-06-09) that merging a self-authored PR must NEVER be a blocker handed back to them.',
        '  3. Having TRACKED the PR (a commitment/issue) does NOT make handing its merge to the operator legitimate — that just launders the deferral.',
        '  4. The ONLY things that stop the merge: CI genuinely RED on this change (fix it + re-run), or it is SOMEONE ELSE\'s PR (then asking is fine). An unrelated flake is re-run, not escalated.',
        '',
        'If it is your PR and green — do not ask, merge it.',
      );
    }

    checklist.push('', 'Detected: ' + allMatches.map(m => m.type).join(', '));

    process.stdout.write(JSON.stringify({ decision: 'approve', additionalContext: checklist.join('\n') }));

    // Auto-open a candidate Blocker Ledger entry for the false-blocker/inability
    // framing (the B17 shape). Best-effort + non-blocking; the checklist above has
    // already been written. We hold the process open just long enough to flush the
    // fire-and-forget POST, then exit. A failure (503 dark / no server) is silent.
    if (inabilityMatches.length > 0) {
      autoOpenBlocker(command, 'deferral-detector');
      setTimeout(() => process.exit(0), 200);
      return;
    }
  } catch { /* don't break on errors */ }
  process.exit(0);
});

// Safety net — never let the process hang open beyond the fire-and-forget window.
setTimeout(() => process.exit(0), 2000);
