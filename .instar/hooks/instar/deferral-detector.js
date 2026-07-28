#!/usr/bin/env node
// Deferral detector — catches agents deferring work they could do themselves
// AND catches agents proposing orphan-TODO follow-ups with no infrastructure.
// PreToolUse hook for Bash commands. Scans outgoing messages for the patterns.
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
//
// SIGNAL ONLY — this hook never blocks. The authority that can hold an
// outbound message is MessagingToneGate (B17_FALSE_BLOCKER).

let data = '';
process.stdin.on('data', chunk => data += chunk);
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(data);
    if (input.tool_name !== 'Bash') process.exit(0);

    const command = (input.tool_input || {}).command || '';
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

    const allMatches = [...inabilityMatches, ...orphanMatches];
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

    checklist.push('', 'Detected: ' + allMatches.map(m => m.type).join(', '));

    process.stdout.write(JSON.stringify({ decision: 'approve', additionalContext: checklist.join('\n') }));
  } catch { /* don't break on errors */ }
  process.exit(0);
});
