# One file that connects a Windows PC to your agent: the short version

## What this is

Justin wants the simplest possible way to let his agent use a Windows computer: open one link on the PC, run one file, done. Today there is no way at all unless the agent already lives on that PC.

This spec describes one small program, "Instar Connect". It is the same file for everyone and holds no secrets. The agent tells the person to type instar.sh/pc on their PC; that downloads it. The person runs it and chooses "full use of this PC" or picks individual permissions. They scan the QR code with the Instar app on their iPhone or Android phone. The PC then shows which agent and whose agent it is, with a plain warning that no support person will ever ask for this, and after a few seconds they click Connect. Then they approve on the phone with Face ID or a fingerprint. From then on the agent can run programs, move files, look at the screen and, when nobody is using the PC, type and click.

## What already exists and what is new

The phone approval and the sealed hand-off between phone and computer already exist for Macs and are reused. The code that takes screenshots and types on Windows already exists and is reused. What is new: the Windows program, a new kind of device that can be controlled by the agent but has no power over the agent, a connection that the PC opens outward (so the PC opens no door to the internet), and agent commands for using the PC.

## The safeguards, plainly

- The file is harmless on its own: a copy only ever connects to the agent of whoever approves it on their own phone, and the PC shows which agent before it connects.
- The PC checks that commands really come from the agent it paired with.
- A connected PC cannot read your conversations or approve anything on your agent.
- Only your own conversations with the agent can use your PC; sharing a PC with other people is not part of the first version.
- It never asks for administrator rights. It tells you plainly that "run commands" means full control as you.
- A tray icon shows when the agent is working, with a Stop button.
- Every action is logged for you to see. Removing it is one click on the PC, the normal Windows uninstall, or removing it from your phone, and it deletes everything it created.

## What you need to decide

Approving this spec approves the design. Separately, before anything is published, Justin gets one plain request about signing the file so Windows shows a trusted name: about US$10 a month through Microsoft's signing service, published under his name like the Mac app, plus a one-time ID check. The first real test on his PC does not wait for that. The agent needs an address the PC can reach: a permanent web address, or simply being on the same home network as the PC. An agent that has neither is told plainly and offered its usual address setup. It ships switched off and is tried first on Justin's own PCs, including a freshly wiped one.
