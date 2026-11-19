# Instar Connect or the Windows desktop app? A side-by-side

Written 2026-11-18 for Justin's question (topic 141385, 15:55 PST): "why would this ever be preferred over just using the Instar desktop app to pair/install an agent to the machine instead?" Nothing is built. The Connect spec stays unapproved.

**Sources read:** the Mac app's code on the Studio (`apps/instar-ios/InstarMac`: `MacAddAgent.swift`, `MacQRPairing.swift`, `MacAgentCreator.swift`), the Windows app plan (version 2, reviewed), the Native Windows plan, the Studio's Windows lane (`.instar/lanes/windows-app/`: the Mac-to-Windows parity queue and the test-PC zip), the coordination file, and the mac-qr-pairing spec. The Windows app's own code and its live parity file are on the Mama PC. I could not open them from the M5: that machine has no file route, and its session transcripts show only tool names. The Windows app is a screen-by-screen copy of the Mac app, so the Mac code and the reviewed plan describe what it does. One check is still open: confirming against the Mama PC copy that the Windows app has no third door.

## 1. What the desktop app does today

The app has two doors under "Add an agent", on the Mac and in the Windows plan (rows 1 to 4):

- **"Create a new agent".** It installs a complete new agent on this computer. On Windows that agent runs inside WSL, which needs an administrator prompt and a restart, and some PCs cannot run WSL at all. A no-WSL mode is planned (Native Windows Instar) but not built. The plan says that until this is done, "the Windows app is for people who already have an agent on another machine."
- **"Pair an agent you have"** (code, link or QR). The computer becomes an **owner device**: a window into an agent that runs somewhere else. You can chat and approve there, but the agent cannot see or use this computer.

**The key question: can the app add a PC to an existing agent without creating a new agent there? No.** Neither door does it. The only way to add a PC as one of an agent's machines today is `instar pair` / `instar join`, which needs a terminal, Node and the full agent install. The Remote Desktop companion only serves an agent that runs on the same PC. The Mac-to-Windows parity queue has no entry for this either.

## 2. What Connect adds that the desktop app does not

- **The agent can use the PC:** it can run programs and use files, or only look (see the screen and read files).
- **The PC gets no authority over the agent.** It is a new restricted kind of device, not an owner device. The agent drives that PC as the person, so if the PC were an owner device, the agent could act as an owner on its own server.
- **Admission only by the owner's Face ID** on their phone, with warnings against someone on the phone talking them through it.
- **No install and no administrator rights:** one small file, a tray icon, and a remover.
- **None of the agent's own secrets or state on the PC.** That is the difference from joining the PC as a full agent machine.

## 3. The cases only a separate file covers, and how common they are

These are my estimates for Justin's users (colleagues who are not technical). I have no usage data.

| Case | Does an app mode cover it? | How common |
|---|---|---|
| No administrator rights | Yes. The app installs per user without an admin prompt; only Create needs admin, for WSL | Common (work laptops), but no reason for a second program |
| A PC that cannot run the agent (no WSL, old or weak) | Yes. Using a PC needs no agent on it | Fairly common until native Windows exists; no reason for a second program |
| Look only | Yes, as a choice inside the mode | Occasional |
| Short-term help, then remove | Yes, with a heavier install and removal | Rare |
| Someone else's PC (a parent's, a friend's) | Partly. Installing a full app on someone else's PC is heavy and leaves more behind | Rare |
| Needed before the Windows app ships | **Only the separate file** | Real today; it ends when the app ships |

Only two advantages are left for the separate file: **it is small and installs nothing, which matters on someone else's PC**, and **it does not wait for the Windows app**. Every other case comes from the shared design (the restricted device kind, Face ID admission, look only), not from being a separate program.

## 4. The alternative: a connect-only mode inside the desktop app

A third door in "Add an agent": **"Let my agent use this PC"**, with the same design (restricted device kind, home machine, Face ID approval, full control or look only, remove). The costs:

- **It waits for the Windows app.** The plan puts the app 4 to 6 weeks from matching the Mac, and that estimate is not yet measured.
- **The two keys must stay apart.** The command handler needs its own process and its own device key, never the app's owner key. A bug at that boundary would give the agent owner powers. The separate file avoids this by having no owner key at all.
- **On someone else's PC the app must start in connect-only mode:** it never offers owner pairing there and shows no chats.
- **It is a bigger download and leaves more behind** on a borrowed PC.
- **It saves a second program's overhead:** its own signing, updater, release approval, download page and support explanations. The Connect spec spends a large share of its text on its own updater and Justin's tap for each release.
- **It is the same on either form:** on a PC where the owner's app is signed in and the agent has full control, the agent can use that app as the owner, except for anything that must be finished on the phone. That is a property of the PC, not of the packaging.

## 5. Recommendation

**Build Connect's design as a mode of the Windows desktop app ("Let my agent use this PC"), not as a second program.** Keep the separate one-file download as a later packaging option, only if real requests for borrowed PCs appear.

Why:
1. Justin's premise is right about packaging but wrong about the facts: the desktop app cannot do this today. So the question is where the new door goes, and one program is easier to explain to colleagues who are not technical.
2. For those users, the cases only a separate file covers (someone else's PC, short-term help) are the rare ones. The common ones (no admin rights, a PC without WSL, look only) work in the app.
3. It saves a second signing, updater, release-approval and download path.
4. The safety design does not change: the restricted device kind, the owner's Face ID approval, the home machine and look only all move into the app unchanged. Only the front door changes.

The cost, said plainly: Windows users wait for the desktop app instead of getting a file sooner.

## What changes if Justin agrees

The spec is revised so the PC side ships as a mode of the Windows desktop app. The server side (the restricted device kind, the approval route and the stores) stays as converged. The changed spec goes back through review, then to Justin for approval. It becomes a row in the Windows app plan, owned by the Windows app lane.
