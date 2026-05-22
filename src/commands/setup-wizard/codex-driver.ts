/**
 * Codex driver for the hybrid wizard.
 *
 * Per-turn narrative: for each `narrative-then-prompt` state, instar
 * spawns `codex exec` with a tightly-constrained prompt asking Codex
 * to generate ONE warm 2-3 sentence intro paragraph. The structural
 * prompt (the question text) is printed verbatim by instar from the
 * state machine; Codex never sees it. This means Codex cannot reword
 * the question, can't add or remove options, and can't decide to
 * "execute the setup" — each per-turn invocation has nothing to
 * execute and a single bounded text job.
 *
 * Action states call existing instar CLI commands directly. Telegram
 * setup is a special action that spawns Codex as a full agentic
 * session with Playwright access, pointed at a Telegram-specific
 * prompt that aligns with Codex's execution-orientation (the
 * conversational behavior is no longer expected here — Codex is
 * driving the browser, that's its strength).
 */

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import pc from 'picocolors';
import {
  buildFreshProjectInstall,
  INITIAL_STATE,
  resolveChoice,
  type WizardAnswers,
  type WizardState,
  type WizardAction,
} from './state-machine.js';
import { WIZARD_CODEX_MODEL } from './model-constants.js';

export interface CodexDriverOptions {
  codexPath: string;
  projectDir: string;
  instarRoot: string;
  /**
   * When false, the driver suppresses narrative LLM calls and prints
   * a deterministic fallback intro for each step. Used in tests and
   * when the codex binary returns an auth error.
   */
  enableNarrative?: boolean;
}

/**
 * Per-state narrative-prompt builders. Each returns the EXACT text we
 * send to `codex exec`. The contract: ONE paragraph, no tools, no
 * commands. Codex's `-s read-only` sandbox plus the prompt's
 * constraints together prevent execution.
 */
const NARRATIVE_PROMPTS: Record<string, (a: WizardAnswers, ctx: { projectDir: string }) => string> = {
  welcome: (_a, ctx) => `
You are a warm, friendly setup wizard greeting a new user installing
instar (a persistent AI-agent toolkit) in their project at ${path.basename(ctx.projectDir)}.

OUTPUT EXACTLY ONE warm 2-3 sentence paragraph welcoming them. Do NOT
include CLI commands, file paths, or technical jargon. Do NOT use ANY
tools or run ANY commands. Do NOT ask any questions — a separate
structured prompt will follow yours.

After your paragraph, exit. Output text only.
`.trim(),

  'agent-name': (a) => `
You are continuing the instar setup wizard. The user just accepted
the privacy notice. Now you're transitioning to the identity phase
where they'll pick a name for their agent.

OUTPUT EXACTLY ONE warm 2-3 sentence paragraph introducing the
"pick a name" step. Make it feel like the start of something — they're
naming a presence, not configuring a script. Hint that the name can
be anything (made-up word, real name, project-relevant).

Do NOT include CLI commands, file paths, or examples in code blocks.
Do NOT use ANY tools. Do NOT ask the question — a structured prompt
follows. Output text only and exit.

Their answers so far: name not yet given.
`.trim(),

  'agent-role': (a) => `
The user just told you their agent will be called "${a.agentName}".
Acknowledge the name in one short sentence (warmly), then introduce
the next step: a one-sentence description of what the agent should
focus on.

OUTPUT 1-2 sentences total. No CLI, no jargon, no tools, no question
(structured prompt follows). Output text only and exit.
`.trim(),

  'user-name': (a) => `
The user named their agent "${a.agentName}" and described its focus
as: "${a.agentRole}". Now you're asking what they'd like to be called.

OUTPUT ONE short sentence transitioning into "what should ${a.agentName}
call you?". Warm, not formal. No tools, no question (structured
prompt follows). Output text only and exit.
`.trim(),

  autonomy: (a) => `
The user is "${a.userName}". Their agent "${a.agentName}" will focus on:
"${a.agentRole}". Next step: pick an autonomy level.

OUTPUT 2-3 short sentences introducing the autonomy choice. Explain
that this is a starting point — they can change it anytime later by
just chatting the agent ("be more proactive", "ask before acting").
Don't re-list the options (a structured prompt with the options
follows). No tools. Output text only and exit.
`.trim(),

  messaging: (a) => `
The user "${a.userName}" has set up their agent "${a.agentName}" with
${a.autonomy} autonomy. Now they need to pick how to talk to the agent
day-to-day.

OUTPUT 2-3 short sentences introducing the messaging-channel choice.
Hint that messaging is THE interface — the user shouldn't need to
return to a terminal after this. Don't re-list the options. No tools.
Output text only and exit.
`.trim(),
};

function narrativeFor(stateId: string, answers: WizardAnswers, ctx: { projectDir: string }): string | null {
  const builder = NARRATIVE_PROMPTS[stateId];
  return builder ? builder(answers, ctx) : null;
}

/**
 * Default deterministic narrative for each state, used when the
 * Codex call is suppressed or fails. Keeps the wizard usable even
 * when narrative generation is unavailable.
 */
const FALLBACK_NARRATIVES: Record<string, string> = {
  welcome: 'Welcome to instar.',
  'agent-name': 'Let\'s start with a name for your agent.',
  'agent-role': 'Got it.',
  'user-name': 'And one more piece of identity:',
  autonomy: 'A starting point — you can change this anytime.',
  messaging: 'Messaging is the interface you\'ll use day-to-day.',
};

/**
 * Spinner state for the composing indicator. Animates a single line
 * during the codex narrative call so the user sees feedback instead
 * of a silent terminal. Cleared (via carriage-return + spaces)
 * before the narrative paragraph is printed.
 */
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function startSpinner(label: string): { stop: () => void } {
  let i = 0;
  const tty = process.stdout.isTTY;
  if (!tty) {
    process.stdout.write(`  ${label}\n`);
    return { stop: () => {} };
  }
  const render = (): void => {
    process.stdout.write(`\r  ${pc.cyan(SPINNER_FRAMES[i % SPINNER_FRAMES.length])} ${pc.dim(label)}`);
    i++;
  };
  render();
  const handle = setInterval(render, 100);
  return {
    stop: () => {
      clearInterval(handle);
      // Clear the spinner line so the narrative paragraph renders cleanly.
      process.stdout.write(`\r${' '.repeat(label.length + 6)}\r`);
    },
  };
}

/**
 * Run `codex exec` for one narrative-generation turn. Returns the
 * text body of Codex's response (stdout), or null on failure /
 * timeout. Bounded to a short per-turn timeout so a flaky network
 * doesn't stall the wizard.
 *
 * Shows a spinner while the call is running so the user sees
 * visible feedback during the latency window (avoids the
 * "is-it-frozen?" reflex that triggers buffered-Enter bugs).
 */
function runCodexNarrative(
  codexPath: string,
  prompt: string,
  options: { instarRoot: string; timeoutMs: number },
): string | null {
  const spinner = startSpinner('composing…');
  try {
    const result = spawnSync(
      codexPath,
      [
        'exec',
        '-s', 'read-only',
        '-m', WIZARD_CODEX_MODEL,
        '--skip-git-repo-check',
        '--ephemeral',
        prompt,
      ],
      {
        cwd: options.instarRoot,
        timeout: options.timeoutMs,
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf-8',
      },
    );
    if (result.status !== 0) return null;
    // Strip any trailing trace blocks that codex exec prints. We want
    // the last contiguous block of plain-English text.
    const stdout = (result.stdout || '').trim();
    // Heuristic: take everything after the last "--------" or "user\n" /
    // "codex\n" marker if present (codex exec output sometimes prefixes
    // session metadata).
    const markers = ['\n--------\n', '\nuser\n', '\ncodex\n'];
    let body = stdout;
    for (const m of markers) {
      const idx = body.lastIndexOf(m);
      if (idx >= 0 && idx < body.length - 20) body = body.slice(idx + m.length).trim();
    }
    return body || null;
  } catch {
    return null;
  } finally {
    spinner.stop();
  }
}

/**
 * Prompt the user with readline. Returns the trimmed answer (may be
 * empty string for "user pressed enter").
 */
async function askUser(promptText: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(promptText, (answer) => {
      rl.close();
      resolve(answer || '');
    });
  });
}

/**
 * Render a state to the user: narrative paragraph (LLM-generated) +
 * structural prompt (verbatim). Then read the answer, validating it
 * against the state's `validate` function. On invalid input, prints
 * the validator's friendly retry message and re-asks WITHOUT
 * regenerating the narrative paragraph (cheap loop, no extra codex
 * exec calls). Returns the first answer that passes validation.
 *
 * This is the structural answer to the buffered-Enter bug from
 * v1.2.13 — the user could press Enter during the silent codex
 * narrative window, that Enter would buffer in stdin, and the next
 * readline would consume it as an empty answer to a required field
 * (silently defaulting agent-name to "agent"). With validate +
 * retry-loop, an empty submission to a required field surfaces a
 * friendly reprompt instead of accepting the default.
 */
async function renderNarrativeState(
  state: Extract<WizardState, { kind: 'narrative-then-prompt' }>,
  answers: WizardAnswers,
  options: CodexDriverOptions,
): Promise<string> {
  // Generate narrative once per state entry (re-asks on validation
  // failure skip this and just re-print the question).
  let narrative: string | null = null;
  if (options.enableNarrative !== false) {
    const prompt = narrativeFor(state.id, answers, { projectDir: options.projectDir });
    if (prompt) {
      narrative = runCodexNarrative(options.codexPath, prompt, {
        instarRoot: options.instarRoot,
        timeoutMs: 30_000,
      });
    }
  }

  console.log();
  console.log(pc.cyan(narrative ?? FALLBACK_NARRATIVES[state.id] ?? ''));
  console.log();
  console.log(state.prompt);
  console.log();

  const placeholderHint =
    state.input.kind === 'text' && state.input.placeholder
      ? pc.dim(`  (${state.input.placeholder})`)
      : '';
  if (placeholderHint) console.log(placeholderHint);

  // Retry loop: at most 5 attempts so a wedged input doesn't trap
  // the wizard forever. After 5 invalid attempts we let the answer
  // through; the state machine's `next` function still has its own
  // resolveChoice fallback so the wizard doesn't crash.
  for (let attempt = 0; attempt < 5; attempt++) {
    const answer = await askUser('  > ');
    if (!state.validate) {
      echoChoice(state, answer);
      return answer;
    }
    const validationMsg = state.validate(answer);
    if (validationMsg === null) {
      echoChoice(state, answer);
      return answer;
    }
    console.log();
    console.log(pc.yellow(`  ${validationMsg}`));
    console.log();
  }
  // Last-resort: take whatever was last typed even if invalid. The
  // state machine's `next` should still produce a usable transition.
  const answer = await askUser('  > ');
  echoChoice(state, answer);
  return answer;
}

/**
 * For choice prompts, echo the resolved label back to the user as a
 * confirmation line ("→ Proactive"). For text prompts, no-op — the
 * answer is the answer.
 *
 * This closes the v1.2.14 confusion where typing "Proactive" or
 * "Telegram" got correctly interpreted by resolveChoice but the
 * wizard never showed the user what selection it understood.
 */
function echoChoice(
  state: Extract<WizardState, { kind: 'narrative-then-prompt' }>,
  answer: string,
): void {
  if (state.input.kind !== 'choice') return;
  const matched = resolveChoice(answer, state.input.choices);
  if (!matched) return;
  const choice = state.input.choices.find((c) => c.value === matched);
  if (!choice) return;
  console.log(pc.dim(`  → ${choice.label}`));
}

/**
 * Execute an action state — calls the appropriate instar CLI command
 * or hands off to an agentic session.
 */
async function runAction(
  action: WizardAction,
  answers: WizardAnswers,
  options: CodexDriverOptions,
): Promise<Partial<WizardAnswers>> {
  console.log();
  console.log(pc.dim(`  → ${action.description}...`));

  switch (action.kind) {
    case 'init': {
      // We assume instar is on PATH (the bareword `npx instar` flow
      // got us here). Use the installed binary.
      try {
        execFileSync(
          'npx',
          [
            'instar',
            'init',
            '--dir', options.projectDir,
            '--framework', 'codex-cli',
          ],
          { stdio: 'inherit' },
        );
      } catch {
        console.log(pc.yellow('  (init returned non-zero; continuing)'));
      }
      return {};
    }

    case 'add-user': {
      const id = (answers.userName || 'user').toLowerCase().replace(/[^a-z0-9]/g, '') || 'user';
      const name = answers.userName || 'User';
      try {
        // `instar user add` reads project from cwd — does NOT accept
        // -d/--dir (pre-fix passed it and the CLI errored "unknown
        // option '-d'"). Set cwd on the spawn instead.
        execFileSync(
          'npx',
          ['instar', 'user', 'add', '--id', id, '--name', name],
          { stdio: 'inherit', cwd: options.projectDir },
        );
      } catch {
        // non-fatal
      }
      return {};
    }

    case 'start-server': {
      try {
        // server start accepts -d, but pass cwd too for consistency.
        execFileSync(
          'npx',
          ['instar', 'server', 'start', '-d', options.projectDir],
          { stdio: 'inherit', cwd: options.projectDir },
        );
        return { serverStarted: true };
      } catch {
        return { serverStarted: false };
      }
    }

    case 'install-autostart': {
      try {
        execFileSync(
          'npx',
          ['instar', 'autostart', 'install', '-d', options.projectDir],
          { stdio: 'inherit', cwd: options.projectDir },
        );
      } catch {
        // non-fatal
      }
      return {};
    }

    case 'setup-telegram-agentic': {
      // Try Codex+Playwright agentic path first (the experience
      // Justin asked for: "surely codex has the same playwright
      // capabilities as claude code?"). Falls through to the
      // instar-native readline flow when Codex returns the
      // PLAYWRIGHT_UNAVAILABLE sentinel, when the spawn fails, or
      // when the config write didn't actually land.
      const agentic = await runTelegramAgentic(options, answers);
      if (agentic.telegramConfigured) return agentic;
      console.log();
      console.log(pc.dim('  Browser automation didn\'t finish — switching to manual setup.'));
      return await runTelegramSetup(options);
    }

    case 'setup-whatsapp-agentic':
    case 'setup-slack-agentic': {
      // Not yet ported to the hybrid wizard. Fall back to a clear
      // pointer: setup completes, user can configure later via
      // `instar add <channel>`.
      console.log();
      console.log(pc.yellow('  This channel will be configured after setup.'));
      console.log(pc.dim('  (Hybrid wizard will gain agentic setup for it in a follow-up release.)'));
      return {};
    }

    case 'send-greeting': {
      // The "magic moment" — agent's first words to the user in the
      // Lifeline topic, in the agent's voice, after the server is
      // alive. SKILL.md devotes Phase 5b to this; the v1.2.20 audit
      // surfaced that this action was a no-op.
      //
      // Reads token + chatId + lifelineTopicId from the just-written
      // config.json (the agentic Telegram step wrote them), and
      // sends a 2-3 sentence personalized greeting via sendMessage.
      // Silently skips if any of the three fields are missing
      // (Telegram wasn't configured, or the user took the manual
      // backstop without lifelineTopicId).
      return await runSendLifelineGreeting(answers, options);
    }

    case 'github-backup': {
      // Out of scope for v1.2.12 minimum. Future PR.
      return {};
    }
  }
}

/**
 * Telegram setup — Codex+Playwright agentic path (v1.2.17, primary).
 *
 * Spawns Codex with the Playwright MCP available (registered into
 * ~/.codex/config.toml by ensureCodexPlaywrightMcp in setup.ts).
 * Codex drives Telegram Web through the BotFather flow, captures
 * the bot token + chat ID, and writes them into
 * `.instar/config.json` directly.
 *
 * After the spawn returns, instar VERIFIES the config write by
 * reading the file and confirming `messaging[]` contains a telegram
 * entry with non-empty token + chatId. If verification fails — for
 * any reason (Codex output PLAYWRIGHT_UNAVAILABLE, user couldn't
 * complete login, BotFather rejected the username repeatedly,
 * config write didn't happen) — the action returns
 * `telegramConfigured: false` and the dispatch falls through to
 * `runTelegramSetup` (the instar-native readline backstop).
 *
 * This is the structural answer to Justin's question "surely codex
 * has the same playwright capabilities as claude code?" — yes, but
 * only if Playwright MCP is registered for Codex. Pre-v1.2.17,
 * ensurePlaywrightMcp only wrote to ~/.claude.json + .mcp.json,
 * never to ~/.codex/config.toml. With v1.2.17 it does both, and
 * this action exercises the Codex side of that registration.
 */
async function runTelegramAgentic(
  options: CodexDriverOptions,
  answers: WizardAnswers,
): Promise<Partial<WizardAnswers>> {
  console.log();
  console.log(pc.bold('  Telegram setup'));
  console.log();

  const prompt = buildTelegramAgenticPrompt(options.projectDir, {
    agentName: answers.agentName,
    userName: answers.userName,
    agentRole: answers.agentRole,
  });
  // 10-minute spawn timeout — the first-time user might need to
  // install Telegram on their phone before they can scan the QR.
  // Codex itself enforces a tighter login-wait via the prompt
  // (it prints user-facing instructions and polls for the login
  // transition); this is the outer wall in case Codex hangs.
  const result = spawnSync(
    options.codexPath,
    [
      'exec',
      '--dangerously-bypass-approvals-and-sandbox',
      '-m', WIZARD_CODEX_MODEL,
      '--skip-git-repo-check',
      prompt,
    ],
    {
      cwd: options.projectDir,
      stdio: 'inherit',
      timeout: 600_000,
    },
  );
  if (result.status !== 0 && result.status !== null) {
    return { telegramConfigured: false };
  }
  // Verify config write — the agentic path is only "successful"
  // when .instar/config.json actually has a telegram entry with
  // non-empty token + chatId after the spawn ends.
  const verified = verifyTelegramConfig(options.projectDir);
  if (!verified) {
    return { telegramConfigured: false };
  }
  console.log();
  console.log(pc.green('  ✓ Telegram is set up (via Codex + Playwright).'));
  return { telegramConfigured: true };
}

/**
 * Build the prompt for Codex's Playwright-driven Telegram setup.
 * Exported for testing (we can assert the prompt's shape includes
 * the verification sentinels and the success criterion).
 *
 * `ctx.agentName` / `ctx.userName` / `ctx.agentRole` come from the
 * earlier conversational phases of the wizard. They feed the bot's
 * display name (so it shows up as "Codey" in Telegram instead of
 * the v1.2.19 hardcoded "Instar Agent"), the bot description, and
 * the system-topic intro texts.
 */
export interface TelegramAgenticContext {
  agentName?: string;
  userName?: string;
  agentRole?: string;
}

export function buildTelegramAgenticPrompt(
  projectDir: string,
  ctx: TelegramAgenticContext = {},
): string {
  // Defensive fallbacks: project basename for agent name, "friend"
  // for user. The state-machine's validators guarantee these are
  // populated in practice; defaults exist for tests and the
  // pathological "Codex prompt invoked without prior state" case.
  const agentName = (ctx.agentName || projectDir.split('/').filter(Boolean).pop() || 'agent').trim();
  const userName = (ctx.userName || 'friend').trim();
  const agentRole = (ctx.agentRole || 'persistent AI agent').trim();
  return `
You are the instar setup wizard's Telegram phase. The user is sitting
at the terminal RIGHT NOW reading what you print. You also have
Playwright browser-automation MCP tools available
(mcp__playwright__browser_navigate, browser_snapshot, browser_click,
browser_type, browser_press_key, browser_wait_for, etc).

TASK: Set up a Telegram bot for an instar agent at ${projectDir}.

AGENT CONTEXT (use this for the bot's identity throughout):
  - Agent name: "${agentName}"  (use as the BotFather display name,
    bot description, group name, intro voice)
  - User name: "${userName}"    (address the user by this name in
    intros and the final greeting)
  - Agent role: "${agentRole}"  (use in /setdescription text)

CRITICAL CONVERSATIONAL RULES:
  - You are talking to a real person, not running a job. Speak to
    them warmly and clearly at every step. They cannot see your
    snapshot results, your tool calls, or your internal reasoning.
    Only the prose you print appears on their terminal.
  - When you start a step, TELL THE USER what's about to happen and
    what they need to do (if anything) before you do it. Like a
    helpful guide narrating their experience.
  - When you're waiting on the user (e.g. QR-code login), print
    reminder text every ~25-30 seconds — not internal status, but
    REAL instructions they can act on right now.
  - Never print "still polling" or "no transition detected" or
    other internal-state language. The user doesn't care about your
    polling cadence; they care about what to do.

CRITICAL CREDENTIAL HYGIENE:
  - NEVER print the bot token to the terminal, even in error
    messages. The token pattern is \\d+:[A-Za-z0-9_-]{35}.
  - If an error response from the Bot API mentions the token,
    redact to "Token: [REDACTED]" before narrating to the user.
  - stdio is inherited from the calling instar process — anything
    you print lands on the user's terminal AND their shell
    scrollback. Treat every print as a permanent record.

SUCCESS CRITERION (verified by the caller after you exit):
  .instar/config.json's messaging[] contains exactly one entry
  shaped as:
    { type: "telegram", enabled: true,
      config: { token: "<bot-token>", chatId: "<chat-id>",
                pollIntervalMs: 2000, stallTimeoutMinutes: 5 } }

STEPS:

1. Verify Playwright is reachable. Call mcp__playwright__browser_navigate
   with URL "https://web.telegram.org/a/". If the tool call fails or
   the tool is not present, output EXACTLY this string and exit:
     PLAYWRIGHT_UNAVAILABLE
   (Do NOT print any manual instructions; the caller has its own
   manual fallback.)

2. After Playwright loads the page, IMMEDIATELY print to the user
   a clear, friendly instruction block like:

   > A browser window just opened with Telegram Web. To log in:
   >   • Open Telegram on your phone (if you don't have it yet,
   >     install it from your phone's app store — it's free and
   >     takes about 30 seconds)
   >   • In Telegram, open Settings → Devices → Link Desktop Device
   >   • Point your phone at the QR code in the browser window
   >
   > I'll wait up to 5 minutes for the login. Take your time — I'll
   > remind you periodically.

   (Adjust the wording to match the actual UI you see in the
   snapshot if Telegram Web's options/copy differs from this.)

3. Poll for login transition every ~5 seconds via browser_snapshot.
   Up to 5 MINUTES total (60 attempts). The page is "logged in"
   when the left rail shows a chat list rather than the QR/phone-
   number form.

   While polling, EVERY ~25-30 seconds print a short user-facing
   reminder (vary the wording so it doesn't feel robotic):
     "Still waiting for the QR scan — once you've logged in on
     your phone, the browser will update automatically and I'll
     keep going."

   If still on login after 5 minutes, print to the user:
     "I didn't see the login complete after 5 minutes. I'll switch
     us to a manual setup — same end result, just a couple of
     copy-pastes."
   Then output:
     AGENTIC_FAILED: telegram-login-timeout
   and exit.

4. Once logged in, tell the user briefly:
   "You're in. I'll create the bot and the group for us — give me
   a moment."
   Then use the search bar to find "BotFather". Click the verified
   @BotFather result.

5. Send /newbot. Wait for the reply.

6. When BotFather asks for the bot's display name, type the
   AGENT NAME from the context above: "${agentName}".
   (This is what appears as the bot's name in ${userName}'s
   Telegram contact list and message header — it MUST match the
   identity the user chose earlier in the wizard, not a generic
   "Instar Agent" placeholder.)

7. When BotFather asks for the bot's username, generate one ending
   in "bot". Recommended form: "${agentName.toLowerCase().replace(/[^a-z0-9]/g, '')}_instar_bot"
   (lower-case ASCII-only). If taken, append random digits and
   retry up to 5 times.

8. Read BotFather's reply containing the token. Extract the token
   from the message body. Token format: \\d+:[A-Za-z0-9_-]+
   Store it in a local variable. (Do NOT print the token to the
   terminal — it's a credential.)

9. Validate the token via the Telegram Bot API (Bash):
     curl -s "https://api.telegram.org/bot<TOKEN>/getMe"
   If response.ok is not true, tell the user:
     "Something went wrong with the bot creation. Switching to
     manual setup."
   Then output:
     AGENTIC_FAILED: token-invalid
   and exit.

9b. Set the bot description (what appears in the "What can this
    bot do?" panel when someone opens the bot's profile). In the
    BotFather chat:
    a. Send /setdescription
    b. Select the bot you just created.
    c. Send this exact text (or close to it, in the agent's voice):
       "I'm ${agentName}, a ${agentRole} for ${userName}. Talk to me here for anything you'd ask an assistant — questions, tasks, status checks. I'll respond from this chat."
    d. BotFather confirms with "Success!" or similar.

    If BotFather rejects the description (length, content), shorten
    and retry once. If it still fails, narrate "Couldn't set the
    description, moving on" and continue — this is non-fatal, NOT
    AGENTIC_FAILED. The bot works without a description.

9c. Set the bot's About text (the short line shown under the bot's
    name in the chat header). In the BotFather chat:
    a. Send /setabouttext
    b. Select the same bot.
    c. Send a SHORT line (cap is 120 chars) in the agent's voice:
       "${agentRole} • here for ${userName}"
    d. BotFather confirms.

    Same non-fatal handling as 9b — narrate and continue if BotFather
    rejects.

10. CRITICAL — disable the bot's privacy mode via BotFather. Without
    this, the bot can't see normal messages in a group (only direct
    @mentions and replies to its own messages). New bots have
    privacy mode ON by default, which BREAKS messaging entirely.

    Tell the user briefly: "Bot's ready. Disabling its privacy mode
    so it can read messages in the group."

    In the BotFather chat:
    a. Send /setprivacy
    b. BotFather lists your bots. Click the bot you just created.
    c. BotFather asks "Enable or disable privacy?" Click "Disable".

    Verify via the Bot API:
      curl -s "https://api.telegram.org/bot<TOKEN>/getMe"
    Confirm result.can_read_all_group_messages === true. If not,
    retry the Disable step once. If still wrong after the retry,
    tell the user "Couldn't disable bot privacy — switching to
    manual." Output AGENTIC_FAILED: privacy-not-disabled and exit.

11. Tell the user briefly:
    "Creating a group chat now and adding ${agentName}."
    Then create a new group chat:
    a. Click the "new message" / pencil icon.
    b. Choose "New Group".
    c. Search for and add the bot you just created.
    d. Name the group "${userName} + ${agentName}" (or
       "${agentName} + ${userName}" — whichever reads more naturally
       to you given the wizard's tone).
    e. Create the group.

12. CRITICAL — enable Topics (Forum mode) on the new group. This
    converts the basic group to a supergroup with topic threads.
    instar organizes different conversation contexts via topics
    (Lifeline, Updates, Dashboard, Attention). Without this, all
    messages collapse into one stream.

    The Bot API CANNOT enable Forum mode — must be done via UI:
    a. Tell the user briefly: "Enabling topics so we can organize
       different conversation threads."
    b. Open the group you just created (click it in the chat list).
    c. Click the group title at the top to open Group Info.
    d. Click the pencil/edit icon to edit group settings.
    e. Find the "Topics" toggle (sometimes labelled "Forum"). Turn
       it ON.
    f. Save / confirm.

    Send a probe message in the group's General topic:
      "first contact"
    Then flush stale long-poll backlog FIRST (in case another
    instar instance is polling the same bot) and re-probe:
      curl -s "https://api.telegram.org/bot<TOKEN>/getUpdates?offset=-1" > /dev/null
      sleep 1
      curl -s "https://api.telegram.org/bot<TOKEN>/getUpdates?timeout=5"
    Confirm message.chat.type === "supergroup" AND
    message.chat.is_forum === true. The chat.id will have CHANGED
    from the original basic-group id to a -100-prefixed supergroup
    id — use this NEW id going forward (call it FORUM_CHAT_ID).

    If is_forum is not true after 2 retries (enable + re-probe),
    tell the user "Couldn't enable topic threads — switching to
    manual." Output AGENTIC_FAILED: forum-mode-not-enabled.

12b. CRITICAL — promote the bot to group admin. Without admin
     rights, several capabilities silently degrade: the bot can't
     pin messages, can't manage topics (rename / delete / reopen),
     and Telegram's evolving group-permission rules may further
     restrict it.

     The Bot API does NOT let a bot self-promote — must be done
     via Playwright UI:
     a. Tell the user briefly: "Promoting ${agentName} to admin
        so it can pin messages and manage topics."
     b. Open the group, click the group title to open Group Info.
     c. Click "Administrators" (sometimes nested under
        "Permissions" or "Members").
     d. Click "Add Admin" / "Add Administrator".
     e. Search for and select the bot you created.
     f. Save / confirm. (No permission tweaks needed — defaults
        are fine.)

     Verify via the Bot API:
       curl -s "https://api.telegram.org/bot<TOKEN>/getChatMember?chat_id=<FORUM_CHAT_ID>&user_id=<BOT_ID>"
     (BOT_ID is result.id from the /getMe call earlier.) Confirm
     result.status === "administrator". If not after one retry,
     narrate "Couldn't promote ${agentName} to admin, moving on
     — pinning and topic management may not work." This is
     NON-fatal — continue with the rest of setup. NOT AGENTIC_FAILED.

13. Create the 4 system topics. Each via createForumTopic:

    a. Lifeline (color 9367192 — green):
       curl -s -X POST "https://api.telegram.org/bot<TOKEN>/createForumTopic" \\
         -H 'Content-Type: application/json' \\
         -d '{"chat_id": "<FORUM_CHAT_ID>",
              "name": "🛡️ Lifeline",
              "icon_color": 9367192}'
       Capture result.message_thread_id as LIFELINE_TOPIC_ID.

    b. Updates (color 7322096 — blue):
       Same call with name "📢 Updates", icon_color 7322096.
       Capture as UPDATES_TOPIC_ID.

    c. Dashboard (color 7322096 — blue):
       Same with name "📊 Dashboard". Capture as DASHBOARD_TOPIC_ID.

    d. Attention (color 16766590 — yellow):
       Same with name "🔔 Attention". Capture as ATTENTION_TOPIC_ID.

    If any createForumTopic call returns !ok, tell the user
    "Couldn't create the system topics — switching to manual."
    Output AGENTIC_FAILED: topics-create-failed and exit.

14. Seed each topic with one orienting message via sendMessage +
    message_thread_id. These are NEUTRAL channel-purpose blurbs,
    not the agent's personal greeting (that's a separate step
    after server start — see Phase 5 of the wizard). Use the
    agent's first-person voice in plain text. Adapt wording as
    needed for the agent's personality, but keep meaning intact.

    a. Lifeline (LIFELINE_TOPIC_ID) — this one is RICHER because
       new users see it first and need to understand how topics
       work:

       text: |
         Hey ${userName} — I'm ${agentName}. This is the **Lifeline** topic.

         Quick orientation: each topic is a separate conversation
         thread (like Slack channels). Lifeline is the main
         channel between us — anything that doesn't fit elsewhere,
         send it here.

         You can ask me to create new topics for different tasks
         ("create a topic for deployment issues") and I'll
         proactively create topics when something's worth a
         dedicated thread.

         I'll send my proper hello once the server's up — should
         only be a few seconds.

    b. Updates (UPDATES_TOPIC_ID):
       "Updates is where I'll post automated status — job runs,
       sync notifications, anything informational that doesn't
       need a response from you."

    c. Dashboard (DASHBOARD_TOPIC_ID):
       "Dashboard is where I'll post the link to my web dashboard
       once a tunnel is up. You'll be able to monitor sessions
       from your phone."

    d. Attention (ATTENTION_TOPIC_ID):
       "Attention is for things you need to look at — failed jobs,
       missing credentials, anything urgent. I'll only post here
       when something actually needs you."

    All four via:
      curl -s -X POST "https://api.telegram.org/bot<TOKEN>/sendMessage" \\
        -H 'Content-Type: application/json' \\
        -d '{"chat_id": "<FORUM_CHAT_ID>",
             "message_thread_id": <TOPIC_ID>,
             "text": "<intro text>"}'

    Capture the Lifeline intro's result.message_id as
    LIFELINE_INTRO_MESSAGE_ID — used in 14b for pinning.

14b. Pin the Lifeline intro so users scrolling back later don't
     lose the orientation. Requires admin rights from step 12b;
     non-fatal if 12b skipped.

       curl -s -X POST "https://api.telegram.org/bot<TOKEN>/pinChatMessage" \\
         -H 'Content-Type: application/json' \\
         -d '{"chat_id": "<FORUM_CHAT_ID>",
              "message_id": <LIFELINE_INTRO_MESSAGE_ID>,
              "disable_notification": true}'

     If response.ok is false, narrate "Couldn't pin the Lifeline
     intro" and continue. NOT AGENTIC_FAILED.

15. Write the config. Read the existing .instar/config.json. Filter
    out any existing { type: "telegram" } entries. Push:
      { type: "telegram", enabled: true,
        config: {
          token: "<TOKEN>",
          chatId: "<FORUM_CHAT_ID>",
          lifelineTopicId: <LIFELINE_TOPIC_ID>,
          pollIntervalMs: 2000,
          stallTimeoutMinutes: 5
        } }
    Write the file back (atomic-ish: tmp file + rename is fine).

15b. chmod the config file to 0600 since it now contains the bot
     token (credential material). Default umask leaves it
     world-readable.

       chmod 0600 .instar/config.json

16. Verify your write succeeded by re-reading the file and confirming
    the messaging entry has token, chatId, AND lifelineTopicId all
    populated. If not, tell the user "Couldn't save the Telegram
    config — switching to manual." Output:
      AGENTIC_FAILED: config-write-failed
    and exit.

17. Tell the user briefly:
    "Telegram is connected. ${agentName}'s ready in the group —
    you'll see its proper hello in the Lifeline topic once the
    server starts."
    Then exit cleanly.

FAILURE MODE: at ANY step you cannot recover from, FIRST tell the
user in plain English what happened (one sentence, no jargon), THEN
output "AGENTIC_FAILED: <one-line reason>" and exit. The caller
will fall through to a readline-based manual setup. Do NOT try to
be clever — fast-fail is what enables the fallback to work.
`.trim();
}

/**
 * Verify that .instar/config.json has a fully-populated Telegram
 * messaging entry. Used by runTelegramAgentic to confirm the
 * agentic path actually wrote what it was supposed to before
 * declaring success. Exported for testing.
 */
export function verifyTelegramConfig(projectDir: string): boolean {
  const configPath = path.join(projectDir, '.instar', 'config.json');
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const config = JSON.parse(raw) as { messaging?: Array<{ type: string; enabled?: boolean; config?: { token?: string; chatId?: string } }> };
    const tg = (config.messaging || []).find((m) => m.type === 'telegram');
    if (!tg) return false;
    if (!tg.config?.token || !tg.config?.chatId) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Send the agent's personal "first hello" to the Lifeline topic
 * after the server has started. This is SKILL.md's "magic moment"
 * — the agent's first words to the user, in voice, using their
 * actual name + role + the user's name.
 *
 * Reads token + chatId + lifelineTopicId from the just-written
 * config.json. Silently no-ops if any are missing (Telegram wasn't
 * configured, or the manual backstop didn't write lifelineTopicId).
 *
 * Exported for testing.
 */
export async function runSendLifelineGreeting(
  answers: WizardAnswers,
  options: CodexDriverOptions,
): Promise<Partial<WizardAnswers>> {
  const configPath = path.join(options.projectDir, '.instar', 'config.json');
  let token = '';
  let chatId = '';
  let lifelineTopicId = 0;
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const config = JSON.parse(raw) as {
      messaging?: Array<{
        type: string;
        config?: { token?: string; chatId?: string; lifelineTopicId?: number };
      }>;
    };
    const tg = (config.messaging || []).find((m) => m.type === 'telegram');
    if (!tg?.config) return {};
    token = tg.config.token ?? '';
    chatId = tg.config.chatId ?? '';
    lifelineTopicId = tg.config.lifelineTopicId ?? 0;
  } catch {
    return {};
  }
  if (!token || !chatId || !lifelineTopicId) {
    // No Telegram configured, or partial config (manual backstop
    // didn't capture chat id). Silent skip.
    return {};
  }

  const agentName = (answers.agentName || 'your agent').trim();
  const userName = (answers.userName || 'there').trim();
  const autonomy = answers.autonomy || 'proactive';
  const autonomyBlurb =
    autonomy === 'guided'
      ? 'I\'ll check with you before doing things.'
      : autonomy === 'autonomous'
        ? 'I\'ll own outcomes end-to-end and report back when something needs you.'
        : 'I\'ll take initiative on obvious next steps and ask when uncertain.';

  const greeting = `Hey ${userName}, ${agentName} here — server's up and I'm online.\n\n${autonomyBlurb}\n\nAnything we set up just now — name, focus, autonomy, messaging — you can change anytime just by chatting me. What would you like to work on first?`;

  try {
    // RULE 3: EXEMPT — this is a fire-and-forget POST to send a
    // wizard-completion greeting, NOT a state-detection probe.
    // Failure is silently swallowed (non-fatal) so there's no
    // detection-result branching to canary against.
    const res = await fetch(`https://api.telegram.org/bot${encodeURIComponent(token)}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        message_thread_id: lifelineTopicId,
        text: greeting,
      }),
    });
    const data = (await res.json()) as { ok: boolean };
    if (data.ok) {
      console.log();
      console.log(pc.green(`  ✓ ${agentName} said hello in the Lifeline topic.`));
    }
  } catch {
    // Non-fatal — server is up, agent will reach out on its own
    // schedule. Don't block the wizard's completion.
  }
  return {};
}

/**
 * Telegram setup — instar-native readline backstop (v1.2.15 flow).
 *
 * Reached only if runTelegramAgentic returns
 * `telegramConfigured: false`. Drives the entire setup from instar
 * with readline + the Telegram Bot API. No LLM session is involved.
 * See spec wizard-telegram-native.md for the original rationale.
 */
async function runTelegramSetup(options: CodexDriverOptions): Promise<Partial<WizardAnswers>> {
  console.log();
  console.log(pc.bold('  Telegram setup'));
  console.log(pc.dim('  This takes about 2 minutes. I\'ll walk you through each step.'));
  console.log();
  console.log(pc.bold('  Step 1 of 3 — Create a bot'));
  console.log('  • Open https://web.telegram.org/a/ in your browser');
  console.log('  • Search for @BotFather and start a chat');
  console.log('  • Send /newbot and follow the prompts:');
  console.log('      – Display name (e.g. "Instar Codey")');
  console.log('      – Username (must end with "bot", e.g. "instar_codey_bot")');
  console.log('  • BotFather will reply with a token like 1234567890:AAH...');
  console.log();

  let token = '';
  let botUsername = '';
  for (let attempt = 0; attempt < 5; attempt++) {
    const input = (await askUser('  Paste the bot token here: ')).trim();
    if (!input) {
      console.log(pc.yellow('  That looked blank — paste the token from BotFather (the long string).'));
      continue;
    }
    console.log(pc.dim('  Verifying token with Telegram…'));
    const verified = await telegramGetMe(input);
    if (!verified.ok) {
      console.log(pc.yellow(`  Telegram rejected that token: ${verified.error}. Try pasting it again.`));
      continue;
    }
    token = input;
    botUsername = verified.username;
    console.log(pc.green(`  ✓ Bot verified: @${botUsername}`));
    break;
  }
  if (!token) {
    console.log(pc.yellow('  Skipping Telegram for now. You can finish setup by chatting your agent later.'));
    return { telegramConfigured: false };
  }

  console.log();
  console.log(pc.bold('  Step 2 of 3 — Connect a chat'));
  console.log(`  • In Telegram, create a new group (or open an existing one)`);
  console.log(`  • Add @${botUsername} as a member`);
  console.log('  • Send any message in the group ("hi" works)');
  console.log();
  await askUser('  Press Enter once you\'ve done that > ');

  let chatId = '';
  let chatName = '';
  for (let attempt = 0; attempt < 4; attempt++) {
    console.log(pc.dim('  Fetching the chat ID from Telegram…'));
    const updates = await telegramGetUpdates(token);
    if (!updates.ok) {
      console.log(pc.yellow(`  Couldn't reach Telegram: ${updates.error}.`));
      const retry = (await askUser('  Press Enter to try again, type "skip" to skip > ')).toLowerCase().trim();
      if (retry === 'skip') break;
      continue;
    }
    // Prefer group/supergroup chats. Fall back to most recent chat
    // of any type — that's still useful (private DM with the bot
    // works too).
    const groupHit = updates.chats.find((c) => c.type === 'group' || c.type === 'supergroup');
    const hit = groupHit ?? updates.chats[updates.chats.length - 1];
    if (hit) {
      chatId = hit.id;
      chatName = hit.name;
      console.log(pc.green(`  ✓ Chat found: "${chatName}" (id ${chatId})`));
      break;
    }
    console.log(pc.yellow('  No recent messages found yet. Make sure you sent a message in the group AFTER adding the bot.'));
    const retry = (await askUser('  Press Enter to try again, type "skip" to skip > ')).toLowerCase().trim();
    if (retry === 'skip') break;
  }
  if (!chatId) {
    console.log(pc.yellow('  Skipping chat-ID detection. Your bot token is saved; you can add the chat ID later.'));
    // Still save the token — partial config is better than none.
    writeTelegramConfig(options.projectDir, { token, chatId: '' });
    return { telegramConfigured: false };
  }

  console.log();
  console.log(pc.bold('  Step 3 of 3 — Saving config'));
  const written = writeTelegramConfig(options.projectDir, { token, chatId });
  if (!written) {
    console.log(pc.red('  Couldn\'t write to .instar/config.json. Your bot is created but not wired up yet.'));
    return { telegramConfigured: false };
  }
  console.log(pc.green('  ✓ Telegram is set up.'));
  console.log(pc.dim(`  Your agent will message you in "${chatName}" once the server starts.`));
  return { telegramConfigured: true };
}

interface TelegramVerifyResult {
  ok: boolean;
  username: string;
  error: string;
}

async function telegramGetMe(token: string): Promise<TelegramVerifyResult> {
  try {
    const url = `https://api.telegram.org/bot${encodeURIComponent(token)}/getMe`;
    const res = await fetch(url);
    const data = (await res.json()) as { ok: boolean; description?: string; result?: { username?: string } };
    if (!data.ok) return { ok: false, username: '', error: data.description || 'invalid token' };
    return { ok: true, username: data.result?.username || 'unknown', error: '' };
  } catch (err) {
    return { ok: false, username: '', error: err instanceof Error ? err.message : String(err) };
  }
}

interface TelegramChat {
  id: string;
  type: string;
  name: string;
}

interface TelegramUpdatesResult {
  ok: boolean;
  chats: TelegramChat[];
  error: string;
}

async function telegramGetUpdates(token: string): Promise<TelegramUpdatesResult> {
  try {
    const url = `https://api.telegram.org/bot${encodeURIComponent(token)}/getUpdates`;
    const res = await fetch(url);
    const data = (await res.json()) as {
      ok: boolean;
      description?: string;
      result?: Array<{ message?: { chat?: { id?: number; type?: string; title?: string; first_name?: string; username?: string } } }>;
    };
    if (!data.ok) return { ok: false, chats: [], error: data.description || 'getUpdates failed' };
    const chats: TelegramChat[] = (data.result || [])
      .map((u) => u.message?.chat)
      .filter((c): c is NonNullable<typeof c> => !!c && typeof c.id === 'number')
      .map((c) => ({
        id: String(c.id!),
        type: c.type || 'private',
        name: c.title || c.first_name || c.username || `chat ${c.id}`,
      }));
    return { ok: true, chats, error: '' };
  } catch (err) {
    return { ok: false, chats: [], error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Persist a Telegram messaging entry into .instar/config.json's
 * messaging[]. Replaces any existing telegram entry. Returns true on
 * success.
 */
function writeTelegramConfig(projectDir: string, params: { token: string; chatId: string }): boolean {
  const configPath = path.join(projectDir, '.instar', 'config.json');
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const config = JSON.parse(raw) as { messaging?: Array<{ type: string; enabled?: boolean; config?: Record<string, unknown> }> };
    config.messaging = (config.messaging || []).filter((m) => m.type !== 'telegram');
    config.messaging.push({
      type: 'telegram',
      enabled: true,
      config: {
        token: params.token,
        chatId: params.chatId,
        pollIntervalMs: 2000,
        stallTimeoutMinutes: 5,
      },
    });
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    return true;
  } catch {
    return false;
  }
}

/**
 * Entry point — runs the wizard from the initial state to completion.
 */
export async function runCodexWizard(options: CodexDriverOptions): Promise<void> {
  const states = buildFreshProjectInstall();
  const answers: WizardAnswers = {};
  let currentId = INITIAL_STATE;

  let safety = 30; // guard against infinite loops via bad transitions
  while (safety-- > 0) {
    const state = states[currentId];
    if (!state) {
      console.log(pc.red(`  Wizard reached an unknown state: ${currentId}`));
      return;
    }

    if (state.kind === 'terminal') {
      console.log();
      console.log(pc.green(state.farewell));
      console.log();
      return;
    }

    if (state.kind === 'action') {
      const updates = await runAction(state.action, answers, options);
      Object.assign(answers, updates);
      currentId = state.next(answers);
      continue;
    }

    // narrative-then-prompt
    const answer = await renderNarrativeState(state, answers, options);
    const { state: nextId, updates } = state.next(answer, answers);
    Object.assign(answers, updates);
    currentId = nextId;
  }
}
