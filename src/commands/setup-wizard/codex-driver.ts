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

import { execFileSync, spawn, spawnSync } from 'node:child_process';
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
 * Run `codex exec` for one narrative-generation turn. Returns the
 * text body of Codex's response (stdout), or null on failure /
 * timeout. Bounded to a short per-turn timeout so a flaky network
 * doesn't stall the wizard.
 */
function runCodexNarrative(
  codexPath: string,
  prompt: string,
  options: { instarRoot: string; timeoutMs: number },
): string | null {
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
 * structural prompt (verbatim). Then read the answer.
 */
async function renderNarrativeState(
  state: Extract<WizardState, { kind: 'narrative-then-prompt' }>,
  answers: WizardAnswers,
  options: CodexDriverOptions,
): Promise<string> {
  // Generate narrative
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

  return askUser('  > ');
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
      const id = (answers.userName || 'user').toLowerCase().replace(/[^a-z0-9]/g, '');
      const name = answers.userName || 'User';
      try {
        execFileSync(
          'npx',
          ['instar', 'user', 'add', '-d', options.projectDir, '--id', id, '--name', name],
          { stdio: 'inherit' },
        );
      } catch {
        // non-fatal
      }
      return {};
    }

    case 'start-server': {
      try {
        execFileSync('npx', ['instar', 'server', 'start', '-d', options.projectDir], { stdio: 'inherit' });
        return { serverStarted: true };
      } catch {
        return { serverStarted: false };
      }
    }

    case 'install-autostart': {
      try {
        execFileSync('npx', ['instar', 'autostart', 'install', '-d', options.projectDir], { stdio: 'inherit' });
      } catch {
        // non-fatal
      }
      return {};
    }

    case 'setup-telegram-agentic': {
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
      // Lifeline topic greeting depends on Telegram being configured.
      // Defer to existing helper if available; otherwise skip silently.
      return {};
    }

    case 'github-backup': {
      // Out of scope for v1.2.12 minimum. Future PR.
      return {};
    }
  }
}

/**
 * Telegram setup — the agentic phase. Spawns Codex with a tight
 * Telegram-specific prompt and Playwright access. Codex's
 * execution-orientation is an asset here.
 */
async function runTelegramSetup(options: CodexDriverOptions): Promise<Partial<WizardAnswers>> {
  const skillPath = path.join(
    options.instarRoot,
    '.claude',
    'skills',
    'setup-wizard',
    'SKILL.md',
  );
  // Inline Codex-specific Telegram-only prompt. The skill text isn't
  // perfect for Codex but the Telegram-via-Playwright phase is
  // primarily execution (open browser, click buttons, capture token),
  // which Codex handles well.
  const telegramPrompt = `
You are completing the Telegram messaging setup for an instar agent
already initialized at ${options.projectDir}.

Your task is OPERATIONAL and BOUNDED:
1. Open Telegram Web in a browser via Playwright (if Playwright MCP
   tools are available; otherwise fall back to printing manual steps).
2. Help the user create a bot via BotFather.
3. Capture the bot token and chat ID.
4. Write them to .instar/config.json under messaging[].config.

When you have the token + chat ID and have written them, exit. Do NOT
proceed past Telegram setup — the rest of the wizard is owned by
instar's state machine.

If Playwright is not available, print clear manual steps (open
t.me/BotFather, type /newbot, etc.) and prompt the user for the token
and chat ID. Then write them to config.

Reference skill (for the wizard sections about Telegram if you need
detail): ${skillPath}
`.trim();

  return new Promise((resolve) => {
    const child = spawn(
      options.codexPath,
      [
        'exec',
        '--dangerously-bypass-approvals-and-sandbox',
        '-m', WIZARD_CODEX_MODEL,
        telegramPrompt,
      ],
      {
        cwd: options.projectDir,
        stdio: 'inherit',
      },
    );
    child.on('close', () => resolve({ telegramConfigured: true }));
    child.on('error', () => resolve({ telegramConfigured: false }));
  });
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
