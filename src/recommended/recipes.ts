/**
 * Setup recipes for recommended services (docs/specs/recommended-services.md, The agent owns setup).
 *
 * A recipe is a proven head start, not the limit: its brief hands a session the whole job, and the
 * session researches and adapts when a provider's flow has changed. Its `verify` is the end-to-end
 * check that decides whether the service works. A service is only available once its recipe is
 * proven, and until then only an agent that lists it under `recommendedServices.provingRecipes` can
 * reach it.
 */
import { execFile } from 'node:child_process';
import type { TelegramSetupSurface } from './telegramSetup.js';
import { DOOR_NAMES, mainDoor, secondDoorCandidates, type AiDoorSurface } from './aiDoors.js';
import { VOICE_TRANSCRIPTION_SECRET, resolveTranscriptionProvider } from '../core/VoiceTranscription.js';
import type { CatalogRow } from './catalog.js';
import { RECOMMENDED_SERVICE_CATALOG } from './catalog.js';
import { VAULT_CHECK_ITEM, type BitwardenSurface } from './bitwardenVault.js';
import { backupRepoName, parseGitHubRepo, type GitHubBackupSurface } from './githubBackup.js';

export interface VerifyResult {
  result: 'pass' | 'fail' | 'unknown';
  detail: string;
  /** On a fail: nothing of the service is here at all (no key, not signed in, not installed), as opposed to one that is here but not working. */
  absent?: boolean;
  /** On a fail that is a privacy issue the person must act on (a public backup repository): raised once as an attention item. */
  attention?: { id: string; title: string; text: string };
}

/** What reading `tailscale status --json` gave: no program at all, a program that answered with an error, a reading, or no answer in time. */
export type TailscaleStatusRead =
  | { kind: 'missing' }
  | { kind: 'failed' }
  | { kind: 'timeout' }
  | { kind: 'ok'; stdout: string };

export interface RecipeDeps {
  readSecret: (name: string) => string | null;
  fetch?: typeof fetch;
  /** Tests pass their own reading; the default asks the tailscale program on this machine. */
  tailscaleStatus?: () => Promise<TailscaleStatusRead>;
  /** This machine's Bitwarden CLI, scoped to the agent's own folder. Absent means the recipe can't check. */
  bitwarden?: BitwardenSurface;
  /** GitHub and this agent's state repository, for the private-backup recipe. Absent means the recipe can't check. */
  github?: GitHubBackupSurface;
  /** This agent's name, for things named after it (a backup repository). */
  agentName?: string;
  /** This agent's AI doors, for the second-subscription recipe. Absent means the recipe can't check. */
  aiDoors?: AiDoorSurface;
  /** This agent's Telegram entry and the Bot API, for the Telegram recipe. Absent means the recipe can't check. */
  telegramSetup?: TelegramSetupSurface;
}

/** What a recipe that keeps a copy elsewhere needs to bring it up to date. */
export interface SyncDeps extends RecipeDeps {
  /** The names of the secrets to copy, and a reader for each. Values stay in-process. */
  secretNames: () => string[];
}

export interface SyncResult {
  ok: boolean;
  /** Names copied (never values). */
  copied: string[];
  detail: string;
}

/** What a confirmed no with "switch it off" has to work with. */
export interface StopDeps extends RecipeDeps {
  deleteSecret: (name: string) => void;
  /** True only on positive evidence that this machine's own setup made the service work here (its key, or its sign-in). Never assumed. */
  setUpHere: boolean;
  /** Tests pass their own; the default runs `tailscale logout` on this machine. */
  tailscaleLogout?: () => Promise<boolean>;
  /** True when the check before setup found nothing of the service here, so a sign-in on this machine is setup's own. */
  absentBefore?: boolean;
  /** Turns the agent's git backup off in its config, the switch older versions read too (spec: a no to GitHub sets gitBackup.enabled: false). */
  disableGitBackup?: () => void;
}

/** `stopped` false means the service is still on; `changed` says whether anything on this machine was undone; `detail` is for the person, in plain words. */
export interface StopResult {
  stopped: boolean;
  changed: boolean;
  detail: string;
}

export interface SetupRecipe {
  id: string;
  service: string;
  /** The one secret this recipe may store, through POST /recommended-services/:id/key. Null when it stores none. */
  secretName: string | null;
  brief: (context: { port: number }) => string;
  verify: (deps: RecipeDeps) => Promise<VerifyResult>;
  /**
   * Switches the service off on this machine after the person confirmed a no with "switch it off"
   * (the spec's `shutdown: authorized`). Undoes only what setup did here, never the person's own.
   */
  stop: (deps: StopDeps) => Promise<StopResult>;
  /** For a service that keeps a copy of something elsewhere: write the copy. Values never leave the process. */
  sync?: (deps: SyncDeps) => Promise<SyncResult>;
  /** True when the copy is of the agent's SECRETS, so the confirm page lists their names before the yes (spec: "the confirm page lists the secrets copied"). */
  listsCopies?: boolean;
}

/** Exported so tests can check every recipe carries the shared rules. */
export const RULES = (service: string, port: number): string => `
Rules that apply whatever you find:
- This job is entirely yours until the check below passes. The person only approves decisions, such as a payment, or supplies a credential. They never open a browser, fetch a key, visit a provider's site, run a command, edit a file or follow steps.
- If a provider's flow has changed from what this says, research it and adapt. Routine failures are yours to diagnose, retry and repair, quietly.
- Credentials only ever come through a one-time Secret Drop link, never chat or a file. Ask for one thing at a time, in plain words.
- If you have to hold a key or sign-in code for a moment, or a picture of one, keep it in your session's private temporary folder, never a shared one, and delete it as soon as it's used.
- Whose account is the person's choice: you can fully manage their own accounts, use accounts of your own, or both. Follow what they have said. If they haven't said, ask once and present both as good options.
- Never open an account on a disposable or temporary email address, because the account is lost when that inbox goes. If you have no lasting address to use, say so and ask for the smallest thing you need.
- Close any browser window you opened as soon as you're done with it. A no can end this session without warning, and whatever is still open stays open.
- Talk to the person in this conversation's topic, $INSTAR_TELEGRAM_TOPIC. It is yours for this job, and replies there reach you.
- No spending and no permission grants without their yes. Nothing checks your browser clicks, so this is on you: stop and ask before any page that charges or grants.
- Their yes to this service is not a yes to the provider's terms. Before you tick, click or sign anything that accepts terms of service, an agreement or a contract, stop and ask them in this topic. Say in plain words what it is and what stands out in it, such as binding arbitration, giving up class actions, auto-renewal, a minimum term or charges after a trial, and ask for a yes or no. Only their yes in this conversation lets you accept. If they say not now, hold as below. A banner that only sets cookie preferences is not an agreement.
- Your calls to this server need the header "Authorization: Bearer $INSTAR_AUTH_TOKEN".
- Just before you activate or store anything, read GET http://localhost:${port}/recommended-services and find this service. If grantedHere is false, the person has said no or this machine isn't authorized: stop, change nothing more, and end.
- When you think it works, call POST http://localhost:${port}/recommended-services/${service}/verify with the header "X-Instar-Request: 1". Only result "pass" means done. Then tell the person, in one plain message, that it works and what it means for them.
- If the person says not now to something this job needs, tell them plainly where that leaves things, then call POST http://localhost:${port}/recommended-services/${service}/hold with the header "X-Instar-Request: 1" and stop. Nothing restarts you after that, and their next message reaches you here.
- If you run out of options, tell them what you tried in plain words, and name the smallest thing you need. Never hand it back as steps.
`;

export const SETUP_RECIPES: readonly SetupRecipe[] = Object.freeze([
  {
    id: 'jev-v1',
    service: 'jev',
    secretName: 'typesafe_api_key',
    brief: ({ port }) => `The person said yes to Jev from TypeSafe. Set it up.

What's known, as of 2026-11-04: the console at console.typesafe.ai offers "Sign in or create an account through Google or your email". API keys have been reported under API Keys in that console. Reaching it needs a normal browser, because plain fetches were refused. Use the agent's browser profiles (GET http://localhost:${port}/playwright-profiles) and the normal-chrome browser when automation is refused.

Store the key as a plain text body, and don't print it:
curl -s -X POST http://localhost:${port}/recommended-services/jev/key -H "Authorization: Bearer $INSTAR_AUTH_TOKEN" -H "X-Instar-Request: 1" -H "Content-Type: text/plain" --data-binary @-
It refuses to replace a key that was here before setup started. Your own key can be corrected until it passes.

As of 2026-11-05 a new account opens at no cost, but TypeSafe refuses to create a key until the account has credits, so say that early. Ask for a yes to the smallest top-up and a cap. A TypeSafe credit code avoids a card. Before anything costs money, confirm the current price with the person. Features that use Jev turn on separately as each is proven, so don't promise the efficiency gains yet.
${RULES('jev', port)}`,
    verify: async ({ readSecret, fetch: doFetch = fetch }) => {
      const key = readSecret('typesafe_api_key');
      if (!key) return { result: 'fail', absent: true, detail: 'No key is stored yet.' };
      try {
        const res = await doFetch('https://api.typesafe.ai/v1/models', { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) });
        if (res.ok) return { result: 'pass', detail: 'TypeSafe accepted the key.' };
        if (res.status === 401 || res.status === 403) return { result: 'fail', detail: `TypeSafe refused the key (${res.status}).` };
        return { result: 'unknown', detail: `TypeSafe answered ${res.status}.` };
      } catch {
        return { result: 'unknown', detail: 'TypeSafe could not be reached.' };
      }
    },
    // The key is what makes Jev work here, so removing it switches Jev off for every feature at once. Like
    // Tailscale, setup undoes only its own work: a key that was here before setup is the person's, and stays.
    // The TypeSafe account and its credits are the person's too.
    stop: async ({ readSecret, deleteSecret, setUpHere }) => {
      if (!readSecret('typesafe_api_key')) return { stopped: true, changed: false, detail: 'Jev was not switched on here, so there was nothing to switch off.' };
      if (!setUpHere) return { stopped: true, changed: false, detail: "The TypeSafe key on this machine was yours before I set anything up, so I've left it in place and will just stop relying on Jev. Say the word and I'll remove it for you." };
      deleteSecret('typesafe_api_key');
      return { stopped: true, changed: true, detail: 'Jev is switched off on this machine: its key is removed, so nothing here uses it any more. The TypeSafe account and any credits on it stay yours; say the word and I\'ll close them.' };
    },
  },
  {
    id: 'voice-v1',
    service: 'voice-transcription',
    secretName: VOICE_TRANSCRIPTION_SECRET,
    brief: ({ port }) => `The person said yes to voice transcription. Set it up, so the agent understands their voice notes.

What it is: a Groq or OpenAI key the agent's server uses to turn a voice note into text. The audio of each voice note goes to that provider; nothing else does.

Whose account: present both as good options and never recommend against either. (1) The person's own Groq or OpenAI account: you sign in to it and manage it for them, or they give you a key for it, either way through one Secret Drop, never in chat. (2) An account of the agent's own, which you create and run yourself.

What's known, as of 2026-11-07:
- Groq: console.groq.com, sign in with Google, GitHub or email; a free tier with daily limits; keys are made under API Keys and start with gsk_. Groq is the default: it is faster and has a free tier.
- OpenAI: platform.openai.com, keys under API keys, start with sk-; it charges per minute of audio and needs billing set up first. Confirm the current price with the person before anything costs money.
- These pages need a normal browser. Use the agent's browser profiles (GET http://localhost:${port}/playwright-profiles) and the normal-chrome browser when automation is refused.

Store the key as a plain text body, and don't print it:
curl -s -X POST http://localhost:${port}/recommended-services/voice-transcription/key -H "Authorization: Bearer $INSTAR_AUTH_TOKEN" -H "X-Instar-Request: 1" -H "Content-Type: text/plain" --data-binary @-
It refuses to replace a key that was here before setup started. The check below proves the provider accepts the key and offers its transcription model. When it passes, tell the person their voice notes now work and invite them to send one.
${RULES('voice-transcription', port)}`,
    verify: async ({ readSecret, fetch: doFetch = fetch }) => {
      // The check tests the key transcription will actually use: one the person put in the server's environment
      // answers first (it already works here), then the key setup stored.
      const stored = readSecret(VOICE_TRANSCRIPTION_SECRET);
      const resolved = resolveTranscriptionProvider({ storedKey: () => stored });
      if (!stored && !resolved) return { result: 'fail', absent: true, detail: 'No voice transcription key is stored yet.' };
      if (!resolved) return { result: 'fail', detail: "The stored key isn't a Groq (gsk_) or OpenAI (sk-) key." };
      const vendor = resolved.name === 'groq' ? 'Groq' : 'OpenAI';
      try {
        const res = await doFetch(`${resolved.baseUrl}/models`, { headers: { Authorization: `Bearer ${resolved.apiKey}` }, signal: AbortSignal.timeout(15_000) });
        if (res.status === 401 || res.status === 403) return { result: 'fail', detail: `${vendor} refused the key (${res.status}).` };
        if (!res.ok) return { result: 'unknown', detail: `${vendor} answered ${res.status}.` };
        const body = await res.json().catch(() => null) as { data?: Array<{ id?: unknown }> } | null;
        const models = Array.isArray(body?.data) ? body!.data.map((m) => m?.id) : [];
        if (!models.includes(resolved.model)) return { result: 'fail', detail: `${vendor} accepted the key but does not offer ${resolved.model} to it.` };
        return { result: 'pass', detail: `${vendor} accepted the key and offers ${resolved.model}, so voice notes are transcribed here.` };
      } catch {
        return { result: 'unknown', detail: `${vendor} could not be reached.` };
      }
    },
    // The stored key is what makes transcription work through this setup, so removing it switches it off here.
    // A key the person put in the server's environment is theirs and stays; so does the provider account.
    stop: async ({ readSecret, deleteSecret, setUpHere }) => {
      if (!readSecret(VOICE_TRANSCRIPTION_SECRET)) return { stopped: true, changed: false, detail: 'Voice transcription was not switched on here through setup, so there was nothing to switch off.' };
      if (!setUpHere) return { stopped: true, changed: false, detail: "The voice transcription key on this machine was yours before I set anything up, so I've left it in place. Say the word and I'll remove it for you." };
      deleteSecret(VOICE_TRANSCRIPTION_SECRET);
      return { stopped: true, changed: true, detail: "Voice transcription is switched off on this machine: its key is removed, so voice notes are no longer sent anywhere. The provider account stays yours; say the word and I'll close it." };
    },
  },
  {
    id: 'second-door-v1',
    service: 'second-ai-door',
    // The sign-in is the person's own tap on the provider's link; there is no key for this recipe to keep.
    secretName: null,
    brief: ({ port }) => `The person said yes to a second AI subscription. Set it up, so this agent has a second provider to work on when its main one is down or out of quota.

What it means here: a second "door", a provider other than this agent's main one, signed in on this machine and switched on for this agent. Today the doors are Claude (Claude Code) and Codex (ChatGPT's Codex CLI).

What's known, as of 2026-11-08:
- Check first: call the check below. If it passes, a second provider is already signed in here: call the server step below once, say so, and change nothing else.
- If the second door's program isn't installed, install it yourself without administrator rights (npm install -g @openai/codex or @anthropic-ai/claude-code into the user's npm prefix).
- Signing in is the person's own tap. For Codex, start "codex login --device-auth" in the background with a time limit and read the link and one-time code it prints; for Claude, "claude auth login" prints a link. Send the person the link (and the code) in one plain message: one tap signs this machine in with their own account. If they have no subscription with that provider yet, say what it costs and ask for their yes before anything is bought; buying it is their decision.
- Never sign this machine out of a door, and never sign in with credentials or a browser login you already hold: the login is shared by every agent this machine user runs.
- When the door is signed in, ask the server to list it in this agent's settings:
curl -s -X POST http://localhost:${port}/recommended-services/second-ai-door/sync -H "Authorization: Bearer $INSTAR_AUTH_TOKEN" -H "X-Instar-Request: 1"
Then call the check. When it passes, tell the person plainly what they now have: a second provider this agent can work on, so when the main one is down or out of quota they can ask you to move a conversation onto it (for example "use Codex here"). Don't promise that a running conversation moves by itself; it doesn't.
${RULES('second-ai-door', port)}`,
    verify: async ({ aiDoors }) => {
      if (!aiDoors) return { result: 'unknown', detail: "This server can't read its AI doors." };
      // The capability is a second provider this agent can move a conversation onto: installed and signed in on
      // this machine. Whether it is also listed in this agent's settings is the server's step (sync), not the test.
      let unknown = false;
      for (const door of secondDoorCandidates(aiDoors.enabled())) {
        if (!aiDoors.installed(door)) continue;
        const v = await aiDoors.signedIn(door);
        if (v === 'signed-in') return { result: 'pass', detail: `${DOOR_NAMES[door]} is installed and signed in on this machine, so this agent can move a conversation onto it.` };
        if (v === 'unknown') unknown = true;
      }
      return unknown
        ? { result: 'unknown', detail: "The second provider's sign-in could not be read." }
        : { result: 'fail', absent: true, detail: `No second AI provider is signed in on this machine (this agent's main one is ${DOOR_NAMES[mainDoor(aiDoors.enabled())]}).` };
    },
    // The server's part: list a signed-in second door in this agent's settings, so the dashboard's provider
    // choice and the internal fallback chain (read at boot) include it. Nothing to do when the agent lists no
    // providers (everything is allowed) or already lists it.
    sync: async ({ aiDoors }) => {
      if (!aiDoors) return { ok: false, copied: [], detail: "This server can't read its AI doors." };
      for (const door of secondDoorCandidates(aiDoors.enabled())) {
        if (!aiDoors.installed(door)) continue;
        if ((await aiDoors.signedIn(door)) !== 'signed-in') continue;
        const added = aiDoors.enable(door);
        return { ok: true, copied: [door], detail: added
          ? `${DOOR_NAMES[door]} is now listed in this agent's settings; its internal checks can fall back to it from the next restart.`
          : `${DOOR_NAMES[door]} is already allowed in this agent's settings.` };
      }
      return { ok: false, copied: [], detail: 'No second AI provider is signed in on this machine yet, so nothing changed.' };
    },
    // Switching off undoes only what setup changed: it takes back a door setup listed in this agent's settings.
    // The sign-in is the machine user's, shared with every agent here, and the subscription is the person's; both stay.
    stop: async ({ aiDoors, setUpHere }) => {
      if (!aiDoors) return { stopped: false, changed: false, detail: "This server can't change its AI doors, so nothing was switched off." };
      // A door setup listed is always taken back (the surface remembers which), even when the sign-in was here first.
      const removed = secondDoorCandidates(aiDoors.enabled()).filter((d) => aiDoors.disable(d));
      const signIn = setUpHere
        ? 'It stays signed in on this machine, which other agents may share, and your subscription stays yours; say the word if you want either ended.'
        : 'Its sign-in on this machine was there before I set anything up, so it stays as it was.';
      return { stopped: true, changed: removed.length > 0, detail: removed.length
        ? `${removed.map((d) => DOOR_NAMES[d]).join(' and ')} is taken back out of this agent's settings, and I won't move work there. ${signIn}`
        : `I won't move work to the second provider any more. ${signIn}` };
    },
  },
  {
    id: 'telegram-v1',
    service: 'telegram',
    // The person's own Telegram login is the credential, and it stays in their browser session; the bot token the
    // recipe produces is written into this agent's messaging config, not the vault's named secrets.
    secretName: null,
    brief: ({ port }) => `The person said yes to Telegram. Set it up: a bot of this agent's own and a group with topics, so they can reach the agent from their phone and get its messages there.

What's known, as of 2026-11-08:
- Check first: call the check below. If it passes, Telegram already works here: say so and change nothing.
- If $INSTAR_TELEGRAM_TOPIC is empty, this agent has no Telegram yet, so this session has no topic: the person sees it in the dashboard's session list. Write to them there in plain words, and ask for anything secret only through a Secret Drop link. Wherever the rules below say "this topic", read "this session".
- Everything happens in the person's own Telegram, signed in by them, in a normal browser the agent drives (the agent's browser profiles: GET http://localhost:${port}/playwright-profiles; the normal-chrome browser when automation is refused). Open https://web.telegram.org/k/ and start "Log in by phone number". The person's phone number and the login code Telegram sends them are credentials: ask for each through one Secret Drop, never in chat, and type them yourself. Telegram's terms are theirs already; nothing new is accepted.
- With BotFather (@BotFather, the verified one): /newbot; display name = this agent's name; username = a lower-case form of it ending in "bot" (append digits if taken, up to five tries). If BotFather says the account has the most bots Telegram allows (20), stop: tell the person in one sentence that Telegram can't be added until a bot is freed, and that the dashboard and the Instar app still work. Never delete any of their bots.
- BotFather's reply holds the token. Never print it, never put it in a command line or a web address, and never call the Bot API yourself (each shell is fresh, so a variable does not survive, and a token in a URL lands in the transcript). Read it straight from the page into the one call below, through the browser tool's stdin wrapper. Then: /setprivacy → Disable (so the bot reads group messages); /setjoingroups → Enable.
- Create a new group named "<person> + <agent name>", add the bot, then turn on Topics in the group's settings (that makes it a supergroup with threads). Make the bot an administrator. The group's id is in the browser's address bar once it is open (web.telegram.org/k/#-100…); that -100… number is the chat id.
- Then hand the channel to the server, with the token as the body and the chat id in the header, and don't print either:
curl -s -X POST http://localhost:${port}/recommended-services/telegram/key -H "Authorization: Bearer $INSTAR_AUTH_TOKEN" -H "X-Instar-Request: 1" -H "X-Telegram-Chat-Id: <chat id>" -H "Content-Type: text/plain" --data-binary @-
The server itself proves the token and the group with the Bot API (it answers telegram-refused with the reason if they don't), stores the entry, asks for a planned restart so the new channel starts polling, and the check passes. Then sign the browser out of Telegram Web (Settings → Devices → log out this device): the person's login must not stay in a browser profile the agent holds. Tell the person their Telegram is ready and that the agent will greet them there after it restarts.
${RULES('telegram', port)}`,
    verify: async ({ telegramSetup }) => {
      if (!telegramSetup) return { result: 'unknown', detail: "This server can't read its Telegram setup." };
      const entry = telegramSetup.configured();
      if (!entry) return { result: 'fail', absent: true, detail: 'No Telegram bot is set up for this agent.' };
      if (!entry.enabled) return { result: 'fail', detail: 'Telegram is set up but switched off for this agent.' };
      const probe = await telegramSetup.probe(entry.token, entry.chatId);
      if (probe === 'ok') return { result: 'pass', detail: 'The bot answers and the group with topics is reachable, so Telegram works here.' };
      if (probe === 'unknown') return { result: 'unknown', detail: 'Telegram did not answer.' };
      if (probe === 'token-refused') return { result: 'fail', detail: 'Telegram refused the bot token.' };
      if (probe === 'chat-unreachable') return { result: 'fail', detail: "The bot can't reach the group." };
      return { result: 'fail', detail: 'The group has no topics turned on.' };
    },
    // Switching off disables this agent's entry; the person's bot and group stay theirs, and the entry stays in the
    // config so a later yes needs no new bot. The routes hold this until another way in works (`wayIn`).
    stop: async ({ telegramSetup, setUpHere }) => {
      if (!telegramSetup) return { stopped: false, changed: false, detail: "This server can't change its Telegram setup, so nothing was switched off." };
      if (!setUpHere) return { stopped: true, changed: false, detail: "Telegram on this agent was yours before I set anything up, so I've left it as it was." };
      const entry = telegramSetup.configured();
      if (!entry || !entry.enabled) return { stopped: true, changed: false, detail: 'Telegram was not switched on here, so there was nothing to switch off.' };
      telegramSetup.disable();
      telegramSetup.requestRestart('Telegram switched off by the owner');
      return { stopped: true, changed: true, detail: 'Telegram is switched off for this agent: it stops reading and sending there after its next restart. Your bot and group stay yours; say the word and I’ll remove them.' };
    },
  },
  {
    id: 'tailscale-v1',
    service: 'tailscale',
    // Tailscale's sign-in is the person's own tap on a link. There is no key for this recipe to keep,
    // and it must never use one: see the brief.
    secretName: null,
    brief: ({ port }) => `The person said yes to Tailscale. Set it up on this machine.

What it gives them: a private address for reaching this agent from their own devices, and the strongest link between this agent's machines. If it can't be finished, nothing breaks: the agent stays reachable through its backup, which is Cloudflare, the local network, or messaging, which needs no address. Say that plainly if you stop.

What's known, as of 2026-11-06:
- Check first. Run "tailscale status --json" (on a Mac the program may also be at /Applications/Tailscale.app/Contents/MacOS/Tailscale). If BackendState is "Running", this machine is already on a tailnet: call the check below and change nothing.
- Never sign this machine out, switch it to another tailnet, or change an existing device or the tailnet's access rules. If it is signed in to a tailnet the person doesn't want, stop and ask.
- If Tailscale isn't installed, install it yourself. On a Mac, Homebrew ("brew install tailscale", then run its tailscaled) needs no administrator rights; the Tailscale app needs an administrator. On Linux the official installer (https://tailscale.com/install.sh) needs sudo. Try what works without rights before asking for any.
- On Linux, a non-root user also needs operator rights before it can sign in. The command is "sudo tailscale set --operator=<user>" (the same one the installer gives). If you can't get rights yourself, work through the alternatives first, such as running tailscaled in userspace mode under this user with its own state folder and socket. Only if none works, name the one thing you need from the person.
- Sign-in: start "tailscale up" (or "tailscale login") in the background with a time limit, and read the sign-in link it prints (https://login.tailscale.com/...). Send the person that link in one plain message: one tap signs this machine in to their Tailscale with their own Google, GitHub or other login, and if they have no account yet, that tap makes one. That tap is how they supply their own credential, which the rules below allow, and it is the one thing only they can do. Say it as one tap, never as steps.
- Never sign in with an auth key, a stored credential, or a browser login you already hold, even if one is offered or you find one. The person's own tap is what makes this their network.
- If the link expires before they tap, start a fresh one and send it, saying the old one no longer works. If Tailscale reports the device needs approval by the tailnet's administrator, tell the person that in one plain sentence; that approval is theirs to give.
- When "tailscale status --json" shows BackendState "Running", call the check below. Don't show addresses, device names or account names in your messages beyond what the person needs.
${RULES('tailscale', port)}`,
    verify: async ({ tailscaleStatus = readTailscaleStatus }) => {
      const read = await tailscaleStatus();
      if (read.kind === 'missing') return { result: 'fail', absent: true, detail: "Tailscale isn't installed on this machine." };
      if (read.kind === 'failed') return { result: 'fail', detail: "Tailscale isn't running on this machine." };
      if (read.kind === 'timeout') return { result: 'unknown', detail: 'Tailscale did not answer in time.' };
      return judgeTailscaleStatus(read.stdout);
    },
    // Setup never signs a machine out that it didn't sign in (see the brief). So a switch-off signs
    // out only when this machine's setup did the sign-in; a Tailscale the person already had stays.
    stop: async ({ setUpHere, tailscaleStatus = readTailscaleStatus, tailscaleLogout = runTailscaleLogout }) => {
      if (!setUpHere) return { stopped: true, changed: false, detail: "Tailscale was already yours before I set anything up, so I've left it exactly as it was. I just won't rely on it." };
      const before = await tailscaleStatus();
      if (before.kind === 'missing') return { stopped: true, changed: false, detail: "Tailscale isn't installed on this machine, so there was nothing to switch off." };
      if (before.kind !== 'ok' || judgeTailscaleStatus(before.stdout).result !== 'pass') return { stopped: true, changed: false, detail: 'This machine was not signed in to Tailscale, so there was nothing to switch off.' };
      if (!(await tailscaleLogout())) return { stopped: false, changed: false, detail: 'I tried to sign this machine out of Tailscale and it refused. It is still signed in.' };
      const after = await tailscaleStatus();
      const stillIn = after.kind === 'ok' && judgeTailscaleStatus(after.stdout).result === 'pass';
      return stillIn
        ? { stopped: false, changed: false, detail: 'I asked Tailscale to sign this machine out, but it still shows as signed in.' }
        : { stopped: true, changed: true, detail: 'This machine is signed out of Tailscale. Your Tailscale account and your other devices are untouched.' };
    },
  },
  {
    id: 'bitwarden-v1',
    service: 'bitwarden',
    listsCopies: true,
    // The vault's master password, so this server can open the vault later to keep the copy fresh and to check it.
    secretName: 'bitwarden_master_password',
    brief: ({ port }) => `The person said yes to Bitwarden. Set it up on this machine.

What it gives them: a copy of this agent's own secrets (its tokens, PIN and keys) in a Bitwarden vault, in a folder of the agent's own, so they survive losing this machine. Only that folder is ever touched. The copy is written by this server, never by you. The ONE value you handle is the Bitwarden login (email and master password), and only on the path Secret Drop -> a shell variable -> the two commands below. You never read, print, store or move any of the agent's own secrets.

What's known, as of 2026-11-07:
- The Bitwarden CLI is "bw". Check "bw --version". If it's missing, install it yourself without administrator rights where you can, somewhere this server also finds it: Homebrew ("brew install bitwarden-cli") on a Mac; otherwise "npm install -g @bitwarden/cli" under this user's Node (nvm or ~/.npm-global), or the standalone binary from Bitwarden's GitHub releases (bitwarden/clients, the "bw-macos" / "bw-linux" zip) placed in ~/.local/bin. The server looks in those places and in /usr/local/bin; a "bw" anywhere else is invisible to it.
- Check "bw status --raw" first. If this machine is already logged in to a Bitwarden account, don't run "bw login" again (it refuses with "already logged in"): say whose account it is, ask before using it if the person hasn't said, and then only the master password is needed.
- Whose account: the person can use their own Bitwarden account, or you can open a free account of the agent's own. Both are good. For their own account, ask for their Bitwarden email and master password through one Secret Drop link (two fields), never in chat. For an account of the agent's own, you need a lasting email address the agent owns; if there is none, say so and ask for the smallest thing you need. Bitwarden's free plan is enough and costs nothing; stop and ask before any page that charges or that accepts terms, per the rules below.
- Read the dropped credential straight into shell variables from the Secret Drop retrieve route, one field each (the route answers {"values": {...}}): BW_EMAIL="$(curl -s -X POST ... | jq -r '.values.email')" and BW_PASSWORD="$(curl -s -X POST ... | jq -r '.values.password')", never through echo, cat or a file, and never print either. Log in with "bw login <email> --passwordenv BW_PASSWORD --raw", with the master password in that environment variable of that one command only. Never put a password on a command line, and never write it to a file. If the account has two-step login, bw asks for the code and would wait forever: pass it instead with "--method <n> --code <code>" (0 = authenticator app, 1 = email), with the code from the person through Secret Drop. You don't need to unlock the vault yourself: this server does every read and write.
- Store the master password with the key route, piping it from the same shell variable (printf '%s' "$BW_PASSWORD" | curl ...), never typed into a command:
curl -s -X POST http://localhost:${port}/recommended-services/bitwarden/key -H "Authorization: Bearer $INSTAR_AUTH_TOKEN" -H "X-Instar-Request: 1" -H "Content-Type: text/plain" --data-binary @-
Spaces inside a passphrase are fine. It refuses to replace a password that was here before setup started.
- Then ask this server to write the copy; it reads the agent's secrets itself and puts each one in the folder "instar/<agent name>" as a Secure Note:
curl -s -X POST http://localhost:${port}/recommended-services/bitwarden/sync -H "Authorization: Bearer $INSTAR_AUTH_TOKEN" -H "X-Instar-Request: 1"
The answer lists the names copied, never values. Tell the person those names in plain words.
- Then call the check below. It passes when the folder is readable with the stored password and holds the agent's marker item.
- The copy is kept fresh by this server from then on. Nothing else of the person's vault is read or changed.
${RULES('bitwarden', port)}`,
    verify: async ({ readSecret, bitwarden }) => {
      if (!bitwarden) return { result: 'unknown', detail: "This server can't reach Bitwarden's program." };
      const status = bitwarden.status();
      // A program that did not answer says nothing: never "not logged in", which would start setup over a working vault.
      if (status === null) return { result: 'unknown', detail: "Bitwarden's program did not answer." };
      if (!status.installed) return { result: 'fail', absent: true, detail: "Bitwarden's program isn't installed on this machine." };
      if (!status.loggedIn) return { result: 'fail', absent: true, detail: 'This machine is not logged in to Bitwarden.' };
      const password = readSecret('bitwarden_master_password');
      if (!password) return { result: 'fail', detail: 'No master password is stored yet, so the vault can\'t be opened from here.' };
      if (!bitwarden.unlock(password)) return { result: 'fail', detail: 'Bitwarden refused the stored master password.' };
      const names = bitwarden.itemNames();
      if (names === null) return { result: 'unknown', detail: "The agent's folder in Bitwarden could not be read." };
      if (!names.includes(VAULT_CHECK_ITEM)) return { result: 'fail', detail: "The agent's folder in Bitwarden doesn't hold its copy yet." };
      const copies = names.filter((n) => n !== VAULT_CHECK_ITEM).length;
      return { result: 'pass', detail: `Bitwarden holds a copy of this agent's secrets (${copies} item${copies === 1 ? '' : 's'}) in its own folder.` };
    },
    sync: async ({ readSecret, bitwarden, secretNames }) => {
      if (!bitwarden) return { ok: false, copied: [], detail: "This server can't reach Bitwarden's program." };
      const status = bitwarden.status();
      if (status === null) return { ok: false, copied: [], detail: "Bitwarden's program did not answer." };
      if (!status.installed || !status.loggedIn) return { ok: false, copied: [], detail: 'This machine is not logged in to Bitwarden.' };
      const password = readSecret('bitwarden_master_password');
      if (!password) return { ok: false, copied: [], detail: 'No master password is stored yet.' };
      if (!bitwarden.unlock(password)) return { ok: false, copied: [], detail: 'Bitwarden refused the stored master password.' };
      const copied: string[] = [];
      const failed: string[] = [];
      for (const name of secretNames()) {
        const value = readSecret(name);
        if (!value) continue;
        (bitwarden.put(name, value) ? copied : failed).push(name);
      }
      const marker = bitwarden.put(VAULT_CHECK_ITEM, `instar copy, written ${new Date().toISOString()}`);
      if (!marker) failed.push(VAULT_CHECK_ITEM);
      const ok = failed.length === 0;
      return { ok, copied, detail: ok ? `${copied.length} secret${copied.length === 1 ? '' : 's'} copied to the agent's folder in Bitwarden.` : `${copied.length} copied; ${failed.length} could not be written.` };
    },
    // The stored master password is what lets this machine open the vault, so removing it switches the copying
    // off here. The copy itself is in the person's vault and stays; so does a login that was theirs before setup.
    stop: async ({ readSecret, deleteSecret, setUpHere, absentBefore, bitwarden }) => {
      if (!setUpHere) return { stopped: true, changed: false, detail: "Bitwarden on this machine was yours before I set anything up, so I've left it as it was and will just stop copying to it." };
      let changed = false;
      if (readSecret('bitwarden_master_password')) {
        deleteSecret('bitwarden_master_password');
        changed = true;
      }
      if (absentBefore && bitwarden && bitwarden.status()?.loggedIn) {
        if (!bitwarden.logout()) return { stopped: false, changed, detail: 'I removed my copy of the master password, but Bitwarden refused to sign this machine out. It is still signed in.' };
        changed = true;
      }
      return { stopped: true, changed, detail: changed
        ? "Bitwarden copying is switched off on this machine: the master password is gone from here" + (absentBefore ? ' and the machine is signed out' : '') + ". The copies already in your Bitwarden folder stay. If you want them gone too, tell me and I'll ask for the master password once to delete them."
        : 'Bitwarden copying was not switched on here, so there was nothing to switch off.' };
    },
  },
  {
    id: 'github-v1',
    service: 'github-state-backup',
    // A GitHub token that can create and push to a private repository. Stored so this server can push and check on its own.
    secretName: 'github_backup_token',
    brief: ({ port }) => `The person said yes to GitHub private backup. Set it up on this machine.

What it gives them: a copy of this agent's memory, settings and identity files (never its secrets: the state folder's ignore list keeps config.json and the secrets folder out) in a PRIVATE repository on GitHub, so they survive losing this machine. The repository is created and pushed by this server, never by you. The ONE value you handle is a GitHub token, and only on the path Secret Drop -> a shell variable -> the key route. You never run git against the agent's state folder yourself.

What's known, as of 2026-11-07:
- Whose account: the person's own GitHub account, or an account of the agent's own if it already has one (a GitHub token in the agent's vault means it does; ask before using it). Both are good; say so and let them choose.
- For the person's account, the credential is a personal access token that can create a repository and push to it (classic scope "repo", or a fine-grained token with "Administration: write" and "Contents: write" on the account). Ask for it through one Secret Drop link, with one plain sentence on what kind of token; it never goes in chat. If they would rather not make a token, offer the agent's own account instead, or stop and hold.
- Read the dropped token straight into a shell variable from the Secret Drop retrieve route (the route answers {"values": {...}}): GH_TOKEN="$(curl -s -X POST ... | jq -r '.values.token')", never through echo, cat or a file, and never print it.
- Store it with the key route, piping it from that variable (printf '%s' "$GH_TOKEN" | curl ...), never typed into a command:
curl -s -X POST http://localhost:${port}/recommended-services/github-state-backup/key -H "Authorization: Bearer $INSTAR_AUTH_TOKEN" -H "X-Instar-Request: 1" -H "Content-Type: text/plain" --data-binary @-
It refuses to replace a token that was here before setup started.
- Then ask this server to make the backup; it creates the private repository "instar-<agent name>-state" under the token's account if it doesn't exist, refuses to push to a repository that is not private, and pushes the state folder:
curl -s -X POST http://localhost:${port}/recommended-services/github-state-backup/sync -H "Authorization: Bearer $INSTAR_AUTH_TOKEN" -H "X-Instar-Request: 1"
The answer names the repository (owner/name), nothing secret. Tell the person that name and that it is private.
- Then call the check below. It passes when GitHub says the repository is private and the copy on GitHub matches what this machine has.
- The copy is kept fresh by this server from then on. If GitHub says the repository has become public, the check fails and the person is told once; nothing is pushed to a public repository.
${RULES('github-state-backup', port)}`,
    verify: async ({ readSecret, github, agentName }) => {
      if (!github) return { result: 'unknown', detail: "This server can't reach GitHub or its own state folder." };
      const token = readSecret('github_backup_token');
      const remote = github.currentRemote();
      const fullName = remote ? parseGitHubRepo(remote) : null;
      if (!token) return { result: 'fail', absent: !fullName, detail: fullName ? 'A backup repository is set, but no token is stored to check it with.' : 'No GitHub token is stored yet, and no backup repository is set.' };
      const owner = await github.tokenOwner(token);
      if (owner === undefined) return { result: 'unknown', detail: 'GitHub did not answer.' };
      if (owner === null) return { result: 'fail', detail: 'GitHub refused the stored token.' };
      const target = fullName ?? `${owner}/${backupRepoName(agentName ?? 'agent')}`;
      const repo = await github.repo(token, target);
      if (repo === undefined) return { result: 'unknown', detail: 'GitHub did not answer.' };
      if (repo === null) return { result: 'fail', absent: !fullName, detail: `The backup repository ${target} does not exist yet.` };
      if (!repo.private) {
        return {
          result: 'fail',
          detail: `The backup repository ${repo.fullName} is PUBLIC, so nothing is pushed to it.`,
          attention: { id: `recommended-service-public-repo:${repo.fullName}`, title: 'Your agent\'s backup repository is public', text: `The GitHub repository ${repo.fullName} that holds this agent's backup is public. Make it private in the repository's settings (Settings → General → Danger Zone → Change visibility), and the backup resumes on the next check. Nothing is pushed to it while it is public.` },
        };
      }
      const [local, remoteHead] = [github.localHead(), await github.remoteHead(token, repo.cloneUrl)];
      if (remoteHead === undefined) return { result: 'unknown', detail: 'The repository could not be reached to compare the copy.' };
      if (!local) return { result: 'fail', detail: 'This machine has no state repository yet.' };
      if (remoteHead !== local) return { result: 'fail', detail: `The copy on GitHub is behind this machine (${remoteHead ? 'different' : 'empty'}).` };
      return { result: 'pass', detail: `The private repository ${repo.fullName} holds this agent's backup, matching this machine.` };
    },
    sync: async ({ readSecret, github, agentName }) => {
      if (!github) return { ok: false, copied: [], detail: "This server can't reach GitHub or its own state folder." };
      const token = readSecret('github_backup_token');
      if (!token) return { ok: false, copied: [], detail: 'No GitHub token is stored yet.' };
      const owner = await github.tokenOwner(token);
      if (!owner) return { ok: false, copied: [], detail: owner === undefined ? 'GitHub did not answer.' : 'GitHub refused the stored token.' };
      const remote = github.currentRemote();
      const target = (remote && parseGitHubRepo(remote)) ?? `${owner}/${backupRepoName(agentName ?? 'agent')}`;
      let repo = await github.repo(token, target);
      if (repo === undefined) return { ok: false, copied: [], detail: 'GitHub did not answer.' };
      let created = false;
      if (repo === null) {
        if (remote && parseGitHubRepo(remote)) return { ok: false, copied: [], detail: `The repository ${target} this machine points at does not exist or is not reachable with this token.` };
        repo = await github.createPrivateRepo(token, backupRepoName(agentName ?? 'agent'), `${agentName ?? 'agent'}: Instar agent state backup (private)`);
        if (!repo) return { ok: false, copied: [], detail: 'GitHub refused to create the private repository.' };
        created = true;
      }
      // Never push to a repository that is not private: this is the person's memory and settings.
      if (!repo.private) return { ok: false, copied: [], detail: `The repository ${repo.fullName} is public, so nothing was pushed.` };
      let pushed = github.pushState(token, repo.cloneUrl);
      if (!pushed && created) {
        // A repository GitHub has just created can refuse its first push for a moment (seen in the live proof). One more try, once.
        await new Promise((resolve) => setTimeout(resolve, GITHUB_FIRST_PUSH_RETRY_MS));
        pushed = github.pushState(token, repo.cloneUrl);
      }
      if (!pushed) return { ok: false, copied: [repo.fullName], detail: `The push to ${repo.fullName} failed.` };
      return { ok: true, copied: [repo.fullName], detail: `The state folder is pushed to the private repository ${repo.fullName}.` };
    },
    // The stored token is what lets this machine push and check, so removing it switches the backup off here, and the
    // config switch older versions read is turned off too. The repository is the person's and stays.
    stop: async ({ readSecret, deleteSecret, setUpHere, disableGitBackup }) => {
      if (!setUpHere) return { stopped: true, changed: false, detail: "The GitHub backup on this machine was yours before I set anything up, so I've left it as it was and will just stop relying on it." };
      let changed = false;
      if (readSecret('github_backup_token')) {
        deleteSecret('github_backup_token');
        changed = true;
      }
      try { disableGitBackup?.(); } catch { /* @silent-fallback-ok: the token is gone, so nothing can push; the switch is a courtesy for older versions */ }
      return { stopped: true, changed, detail: changed
        ? "GitHub backup is switched off on this machine: the token is gone from here and automatic pushes are off. The private repository and what is in it stay yours. If you want it gone too, tell me and I'll ask for a token once to delete it."
        : 'GitHub backup was not switched on here, so there was nothing to switch off.' };
    },
  },
]);

/** How long the GitHub recipe waits before its one retry of the first push to a repository it just created. */
export const GITHUB_FIRST_PUSH_RETRY_MS = 3000;

const TAILSCALE_PROGRAMS = ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale'];

/**
 * Reads this machine's Tailscale state. The program on PATH comes first, so the person's own choice of
 * install wins; the Mac app and the usual install folders follow, since on a Mac it is often not on PATH.
 */
export async function readTailscaleStatus(programs: readonly string[] = TAILSCALE_PROGRAMS): Promise<TailscaleStatusRead> {
  let sawFailure = false;
  for (const program of programs) {
    const outcome = await new Promise<TailscaleStatusRead>((resolve) => {
      execFile(program, ['status', '--json'], { timeout: 10_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
        if (!err) return resolve({ kind: 'ok', stdout: String(stdout) });
        const e = err as NodeJS.ErrnoException & { killed?: boolean };
        if (e.code === 'ENOENT' || e.code === 'EACCES') return resolve({ kind: 'missing' });
        if (e.killed) return resolve({ kind: 'timeout' });
        // `tailscale status --json` still prints the state when it exits non-zero for a stopped or signed-out node.
        if (String(stdout ?? '').trim().startsWith('{')) return resolve({ kind: 'ok', stdout: String(stdout) });
        resolve({ kind: 'failed' });
      });
    });
    if (outcome.kind === 'ok' || outcome.kind === 'timeout') return outcome;
    if (outcome.kind === 'failed') sawFailure = true;
  }
  return sawFailure ? { kind: 'failed' } : { kind: 'missing' };
}

/** Signs this machine out with the first tailscale program that answers. True when the command succeeded. */
export async function runTailscaleLogout(programs: readonly string[] = TAILSCALE_PROGRAMS): Promise<boolean> {
  for (const program of programs) {
    const outcome = await new Promise<'ok' | 'missing' | 'failed'>((resolve) => {
      execFile(program, ['logout'], { timeout: 20_000 }, (err) => {
        if (!err) return resolve('ok');
        const e = err as NodeJS.ErrnoException;
        resolve(e.code === 'ENOENT' || e.code === 'EACCES' ? 'missing' : 'failed');
      });
    });
    if (outcome === 'ok') return true;
    if (outcome === 'failed') return false;
  }
  return false;
}

/** Pass only when this machine is signed in and online. The detail names no address, device or account. */
export function judgeTailscaleStatus(raw: string): VerifyResult {
  let body: { BackendState?: unknown; Self?: { Online?: unknown; TailscaleIPs?: unknown } };
  try {
    body = JSON.parse(raw);
  } catch {
    // @silent-fallback-ok: an unreadable answer is reported as unknown, never as a pass
    return { result: 'unknown', detail: "Tailscale's answer could not be read." };
  }
  const state = typeof body?.BackendState === 'string' ? body.BackendState : null;
  if (state === null) return { result: 'unknown', detail: "Tailscale's answer could not be read." };
  if (state === 'Running') {
    const ips = Array.isArray(body.Self?.TailscaleIPs) ? body.Self.TailscaleIPs : [];
    if (ips.length === 0) return { result: 'fail', detail: 'Tailscale is running but this machine has no private address yet.' };
    if (body.Self?.Online === false) return { result: 'fail', detail: "This machine is signed in to Tailscale but isn't online." };
    return { result: 'pass', detail: 'This machine is signed in to Tailscale and online.' };
  }
  if (state === 'NeedsLogin') return { result: 'fail', absent: true, detail: 'This machine is not signed in to Tailscale yet.' };
  if (state === 'NeedsMachineAuth') return { result: 'fail', detail: "This machine is waiting for the tailnet's administrator to approve it." };
  if (state === 'Stopped') return { result: 'fail', detail: 'Tailscale is installed but switched off on this machine.' };
  return { result: 'fail', detail: `Tailscale is not ready on this machine (${state}).` };
}

export function recipeFor(row: CatalogRow): SetupRecipe | null {
  return SETUP_RECIPES.find((r) => r.id === row.setupRecipe) ?? null;
}

/**
 * The catalog this agent sees: recipes it has chosen to prove become available here, and nowhere else.
 * `allowed` answers true only on a throwaway agent or the development agent, so one stray config value on
 * a fleet agent can't offer an unproven recipe to a real person.
 */
export function catalogWithProving(proving: readonly string[] | undefined, allowed: () => boolean): readonly CatalogRow[] {
  if (!proving?.length || !allowed()) return RECOMMENDED_SERVICE_CATALOG;
  return RECOMMENDED_SERVICE_CATALOG.map((row) => {
    const recipe = SETUP_RECIPES.find((r) => r.service === row.id && proving.includes(r.id));
    return recipe ? { ...row, setupRecipe: recipe.id } : row;
  });
}
