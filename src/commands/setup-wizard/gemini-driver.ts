/**
 * Gemini driver for the hybrid wizard.
 *
 * Per-turn narrative: for each `narrative-then-prompt` state, instar
 * spawns Gemini's canonical one-shot CLI with a tightly-constrained
 * prompt asking Gemini to generate ONE warm 2-3 sentence intro paragraph. The structural
 * prompt (the question text) is printed verbatim by instar from the
 * state machine; Gemini never sees it. This means Gemini cannot reword
 * the question, can't add or remove options, and can't decide to
 * "execute the setup" — each per-turn invocation has nothing to
 * execute and a single bounded text job.
 *
 * Action states call existing instar CLI commands directly. Gemini is
 * never handed the Claude setup skill and is never asked to run shell,
 * write files, configure services, or drive browser automation.
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
import { GEMINI_WIZARD_MODEL } from './model-constants.js';
import {
  buildGeminiChildEnv,
  buildGeminiOneShotArgv,
} from '../../providers/adapters/gemini-cli/transport/geminiSpawn.js';

export interface GeminiDriverOptions {
  geminiPath: string;
  projectDir: string;
  instarRoot: string;
  /**
   * When false, the driver suppresses narrative LLM calls and prints
   * a deterministic fallback intro for each step. Used in tests and
   * when the gemini binary returns an auth error.
   */
  enableNarrative?: boolean;
}

/**
 * Per-state narrative-prompt builders. Each returns the EXACT text we
 * send to Gemini. The contract: ONE paragraph, no tools, no commands.
 * The canonical one-shot argv uses `--approval-mode default`; the prompt
 * itself forbids tool use and side effects, and all actual setup work
 * stays in instar-owned action states.
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
 * Gemini call is suppressed or fails. Keeps the wizard usable even
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
 * during the gemini narrative call so the user sees feedback instead
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
 * Run Gemini's canonical one-shot for one narrative-generation turn. Returns the
 * text body of Gemini's response (stdout), or null on failure /
 * timeout. Bounded to a short per-turn timeout so a flaky network
 * doesn't stall the wizard.
 *
 * Shows a spinner while the call is running so the user sees
 * visible feedback during the latency window (avoids the
 * "is-it-frozen?" reflex that triggers buffered-Enter bugs).
 */
function runGeminiNarrative(
  geminiPath: string,
  prompt: string,
  options: { instarRoot: string; timeoutMs: number },
): string | null {
  const spinner = startSpinner('composing…');
  try {
    const result = spawnSync(
      geminiPath,
      buildGeminiOneShotArgv(GEMINI_WIZARD_MODEL, prompt),
      {
        cwd: options.instarRoot,
        timeout: options.timeoutMs,
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf-8',
        env: buildGeminiWizardEnv(),
      },
    );
    if (result.status !== 0) return null;
    // Strip any trailing trace blocks that gemini one-shot output may print. We want
    // the last contiguous block of plain-English text.
    const stdout = (result.stdout || '').trim();
    // Heuristic: take everything after the last "--------" or "user\n" /
    // "gemini\n" marker if present (gemini output sometimes prefixes
    // session metadata).
    const markers = ['\n--------\n', '\nuser\n', '\ngemini\n'];
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

function buildGeminiWizardEnv(parentEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = buildGeminiChildEnv(parentEnv);
  env.GEMINI_CLI_TRUST_WORKSPACE = 'true';
  if (parentEnv.ASDF_NODEJS_VERSION) {
    env.ASDF_NODEJS_VERSION = parentEnv.ASDF_NODEJS_VERSION;
  }
  return env;
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
 * regenerating the narrative paragraph (cheap loop, no extra gemini
 * exec calls). Returns the first answer that passes validation.
 *
 * This is the structural answer to the buffered-Enter bug from
 * v1.2.13 — the user could press Enter during the silent gemini
 * narrative window, that Enter would buffer in stdin, and the next
 * readline would consume it as an empty answer to a required field
 * (silently defaulting agent-name to "agent"). With validate +
 * retry-loop, an empty submission to a required field surfaces a
 * friendly reprompt instead of accepting the default.
 */
async function renderNarrativeState(
  state: Extract<WizardState, { kind: 'narrative-then-prompt' }>,
  answers: WizardAnswers,
  options: GeminiDriverOptions,
): Promise<string> {
  // Generate narrative once per state entry (re-asks on validation
  // failure skip this and just re-print the question).
  let narrative: string | null = null;
  if (options.enableNarrative !== false) {
    const prompt = narrativeFor(state.id, answers, { projectDir: options.projectDir });
    if (prompt) {
      narrative = runGeminiNarrative(options.geminiPath, prompt, {
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
  options: GeminiDriverOptions,
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
            '--framework', 'gemini-cli',
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
      // Gemini is bounded to narrative-only setup turns. Telegram setup
      // stays instar-native: readline for user input, Telegram Bot API for
      // verification, and direct config writes owned by this process.
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
      // config.json, and sends a 2-3 sentence personalized greeting via
      // sendMessage.
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
  options: GeminiDriverOptions,
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
 * Drives the entire setup from instar
 * with readline + the Telegram Bot API. No LLM session is involved.
 * See spec wizard-telegram-native.md for the original rationale.
 */
async function runTelegramSetup(options: GeminiDriverOptions): Promise<Partial<WizardAnswers>> {
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
export async function runGeminiWizard(options: GeminiDriverOptions): Promise<void> {
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
