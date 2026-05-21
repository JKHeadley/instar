# What this PR does — in plain English

## Three bugs from Justin's second real test

He re-ran the wizard on `instar-codey` against v1.2.14 (which had
the buffered-Enter fix). New problems showed up:

1. **The wizard tried to create his user profile but the command
   errored.** I had it calling `npx instar user add -d <dir> ...`
   but `user add` doesn't accept a `-d` flag. It reads the project
   from the current working directory. Result: silent failure, no
   user profile created.

2. **When he typed "Proactive" and "Telegram" as answers (instead
   of "2" and "1"), the wizard accepted them silently** without
   showing him what it picked. The interpreter DID work — both got
   matched correctly — but he had no visual confirmation, so he
   wasn't sure whether the wizard understood his words or was
   about to default to something else.

3. **Telegram setup was completely broken.** The wizard handed off
   to a Codex session that was supposed to walk him through
   creating a bot. But the way Codex's `exec` mode works, the
   session can't actually wait for the user to paste a bot token —
   it's a single-shot, "here's a prompt, generate a response, end".
   So Codex correctly printed manual BotFather instructions and
   asked for the token, then immediately ended. The wizard saw the
   session end successfully and recorded "Telegram is configured!"
   when nothing was actually configured.

## What this PR fixes

### Fix 1: User profile creation

Drop the `-d` flag and just set the spawn's cwd to the project
directory. Same outcome, but uses the flag set the CLI actually
accepts.

### Fix 2: Echo the selected choice

After the wizard validates a multiple-choice answer, it prints
"→ Proactive" (or whatever the resolved label is). The user sees
what got picked. If the wizard misinterpreted, they can Ctrl-C and
restart. No more silent acceptance of word answers.

### Fix 3: Instar-native Telegram setup

The whole Telegram action is rewritten. No more spawning Codex for
it. Now instar walks the user through it directly:

1. Print clear BotFather instructions.
2. Read the bot token via readline. Verify it by calling Telegram's
   `getMe` API. If invalid, ask again (up to 5 times).
3. Print clear "add the bot to a group and send a message"
   instructions. Wait for them to press Enter.
4. Call Telegram's `getUpdates` API to find the chat they were in.
   Extract the chat ID automatically. If nothing comes back, try
   again (up to 4 times).
5. Write the token + chat ID into `.instar/config.json` under
   `messaging[].config`.

Importantly: if ANY of those steps fails, the action records
"Telegram NOT configured" rather than silently lying. The user
gets a clear "you can finish setup later by chatting your agent"
message.

## Why this is more robust

No "session that can't wait for input" failure mode. No dependency
on Playwright being available. No reliance on Codex correctly
interpreting a complex multi-step instruction. Just clear prompts,
direct API calls, and explicit success/failure paths.

## What doesn't change

- The hybrid wizard architecture is the same. State machine still
  owns the flow. Codex still generates the warm narrative paragraphs
  for the conversational steps.
- The Claude wizard path is untouched.
- WhatsApp and Slack still print a "configure later" pointer; their
  native flows come in a follow-up.
- The agent's runtime is still whatever the user picked.
