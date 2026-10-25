# Normal-Chrome browser method as a built-in skill — plain-English overview

## What this is

Some web tasks have to be done as a particular signed-in person: changing a setting, reading a usage page, pressing a button on an account page. Instar agents usually drive a browser with an automation tool (Playwright). Account pages often notice that and behave differently: they show extra checks, keep buttons disabled, or refuse outright.

On 21 October 2026 Echo worked out a method that gets past this without cheating: open a completely normal Chrome window for each account, and control it with macOS's own scripting system (Apple Events) instead of an automation connection. Echo used it to press six expiring "Reset for free" offers on six Claude accounts. Justin then asked for the method to become something every Instar agent has, not just Echo.

## What already exists

- Instar already keeps a list of browser profiles and which account each one is signed in to.
- Instar already ships "built-in skills" (written procedures an agent can follow) and helper scripts, and refreshes them when an agent updates.
- Echo has the method as its own private skill and four small scripts.

## What is new

- A built-in skill called `/normal-chrome-browser` that every agent receives. It explains the method step by step, and the hard lessons behind each step (for example: aim the commands at one exact Chrome window, or you end up controlling the operator's personal browser).
- Three small helper scripts installed for every agent: one opens a normal Chrome for a profile, one runs a piece of JavaScript in that window, and one runs JavaScript inside the page's own code (needed to understand why a button stays disabled).
- A short note in every agent's instructions saying when to use the skill: whenever a web task has to be done as a signed-in account, or a page refuses the automated browser, and before ever telling the operator "this can't be done in a browser".

## Safeguards

- **Not a disguise.** When Echo first used the method, it got one button to work by pretending the browser window had a person's attention. Reviewers flagged that as the wrong thing to hand every agent, and that part was removed. The shipped skill says plainly that it is not a way to make automation look human: if a page holds a button back until a person is present, the agent explains what the page needs and the operator does that one click. The example in the skill only reads a page.
- **Only inside the agent's own folder.** The scripts refuse any browser profile outside the agent's home, so they can never reach into the operator's personal Chrome.
- **Only what was asked.** The skill says plainly: take only the actions the operator asked for. Reading a page's code is for understanding why it refuses, never for reaching buttons the page does not offer.
- **Normal browser for sign-ins.** Sign-in, billing and account pages always run in a normal browser, and the agent never tries to beat a CAPTCHA or other human check.
- **No secrets in chat or scripts.**
- **Check, don't assume.** After an action the agent reloads the page and reports only what it can see actually changed.
- **Honest about platforms.** The method only works on Macs. Instar also runs on Linux, so each script stops with a clear "macOS only" message there, and the skill says so. A Linux version is named as later work, not pretended.
- **Nothing runs by itself.** These are tools an agent picks up when needed. No new automatic behaviour, timer, or permission is added.

## Testing on the way

While turning Echo's scripts into general ones, tests on throwaway profiles found real problems: the "is it already open?" check matched itself and always said yes; one profile name could be mistaken for another that starts the same way; a brand-new profile ignores the scripting setting the first time; a blocked in-page script could hand back an old answer as if it were new; and a click could land on the wrong page if the tab had moved. All are fixed and covered by tests.

## What you need to decide

Nothing new to approve. Justin already asked for this. One thing to know: the shipped skill is narrower than what Echo did on 21 October. It leaves out the step that faked a person's attention to make a button work, and its example only reads a page. The design follows how Instar already ships skills and scripts, and if it turned out wrong, undoing it means reverting one release; the installed files do nothing on their own.
