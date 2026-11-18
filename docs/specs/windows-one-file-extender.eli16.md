# One file that connects a Windows PC to your agent: the short version

## What this is

Justin wants the simplest possible way to let his agent use a Windows computer: open one link on the PC, run one file, done. Today there is no way at all unless the agent already lives on that PC.

This spec describes one small program, "Instar Connect". It is the same file for everyone and holds no secrets. The agent sends the person a download link; they run the file on the PC and choose "Full control" (the agent can do anything they can do on that PC) or "Look only" (it can see the screen and read files, nothing more). They scan the QR code with the Instar app on their iPhone. The PC shows which agent and whose agent it is, with a plain warning that no support person will ever ask for this, and after a few seconds they click Connect. Then they approve on the phone with Face ID.

## The two big choices

First, the PC is a new, restricted kind of device. The agent can drive it, but the PC has no power over the agent: it cannot approve anything, read conversations or add devices.

Second, each PC belongs to the one agent machine that paired it. Sessions on the agent's other computers reach the PC by asking that machine. This removed a whole family of problems the earlier drafts had with several machines talking to one PC. The cost: when that machine is off, the PC is unreachable, and if that machine is retired the person runs the same file again and scans once.

## The safeguards, plainly

- The file is harmless on its own: a copy only ever connects to the agent of whoever approves it on their own phone.
- The PC checks that every command really comes from the machine it paired with.
- Moving from "Look only" up to "Full control" needs Face ID on the owner's phone, checked by the PC itself, so the agent cannot raise its own access. Lowering works from the PC, the phone or the web console.
- Only the owner's own conversations with the agent can use the PC. Scheduled jobs cannot, so a hostile email a job reads cannot turn into a command on the PC.
- Against scammers: a warning and a wait before Connect, a stronger warning and longer wait if a remote-control program is running, a notice at every Windows sign-in saying who is connected with a one-click Disconnect, and a pop-up whenever a new agent session starts using the PC.
- It never asks for administrator rights. A tray icon shows when the agent is working, with a Stop button. Every action is logged. Removing it is one click on the PC, the normal Windows uninstall, or removing it from the phone, and it deletes everything it created.

## What you need to decide

Approving this spec approves the design, including one exception to the rules: connecting a PC needs the Instar app, because only a Face ID approval proves a person really agreed to give the agent control of their computer. Separately, before anything is published, Justin gets one plain request about signing the file so Windows shows a trusted name: about US$10 a month through Microsoft's signing service, under his name like the Mac app, plus a one-time ID check. The first real test on his PC does not wait for that. It ships switched off and is tried first on a test agent and on Echo with the Mama PC, then the full-wipe test on Justin's third machine.
