# No critical data or work is lost when a machine dies: Plain-English Overview

> The one-line version: everything the agent would need after losing a computer is kept on at least one other of the owner's computers, the agent checks this all the time, and once a month it proves it by wiping one computer's copy of the agent and rebuilding it.

## The problem in one breath

On 19 November 2026 the Mac Studio failed a macOS upgrade, would not start, and had to be erased. It was the main computer for two agents, Echo and Luna. Some work was lost for good: the source code of the Instar iPhone and Mac app existed only on that computer, in a code history with no online copy, and about a day and a half of it (builds 107 to 117) is gone. Much more survived only because the dead computer's disk could still be read over a cable: about 3,400 saved changes on 1,489 lines of work that had never been uploaded anywhere. Files the code-history tool never tracked, including five of Echo's custom safety checks, were lost. When the Studio was rebuilt, it had forgotten settings that existed only there. It did not know which Telegram topics were the agent's alerts topics, so it made duplicates. It did not know which phones were paired, or how to test and merge code changes, so no change was merged for about 14 hours. It also had none of the signed-in browser windows the agent uses to reach the owner's Google Drive. The owner's words: "I don't track this, you do."

## What already exists

- **Record sharing between computers.** The agent's computers already copy about 36 kinds of records to each other (Chief of Staff projects, work cards, paired-phone keys and more). The catch: each computer only hands out the records it wrote itself. When a computer dies, the others still hold its records but never pass them on to a new or rebuilt computer.
- **Signed documents.** Documents are signed by the computer that wrote them. A rebuilt computer that never met the dead one has no way to check those signatures, so it kept retrying, about 18 times a second.
- **A list of every kind of saved state** (the "state coherence registry"). It describes 184 kinds of files, but none is marked critical, and nothing checks whether a computer is missing one.
- **Local backups.** These are snapshots of the agent's memory files, kept on the same disk, so they died with it.
- **A disk watcher.** It measures free space and posts to a Disk topic. But a "quiet by default" filter sent its warnings to a feed nobody reads, and counted them as delivered.
- **A work-copy cleaner.** It removes only finished, clean copies of code, it is switched off on most agents, and it cannot see folders it lacks permission to read.
- **Browser sign-in.** A tested procedure exists for each computer to sign in to an account on its own. Nothing checks that every computer that might take over has actually done it.

## What this adds

The biggest change is a **list of every code project the agent owns, with a rule that no work may exist in only one place for more than a day.** Every project the agent owns needs an online home. If one has none, the agent creates a private one in its own GitHub account and invites the owner to it, after first checking that no passwords or keys are in it. Pending invitations are gathered into one request, and the agent moves or deletes a project whenever the owner asks. Nobody else can see them. A project the agent made for a team member is never sent to GitHub; it stays on the owner's own computers. Unfinished work on a public project, such as Instar itself, goes to a private backup copy of that project instead, so nothing unreleased becomes public. It never makes anything public, and it never pushes a project it doesn't own (a copy of someone else's project, say) to GitHub. Within minutes of any new work, it also copies every line of work to the owner's other computers. If something is still in only one place after a day (or after an hour when that computer is at risk, for example low on space), the agent's own fixes have failed, and one plain line goes on the owner's "Needs you" list. It is one line per computer, not one per project.

Secondary changes:

- **A critical list.** Settings that must be the same everywhere (alerts topics, the owner's private group, paired phones, merge settings, notification choices, Chief of Staff records, job history) are marked critical. They are copied to every computer and checked every 15 minutes. A rebuilt computer may not create a new alerts topic until every other computer has said it has none.
- **More things the rebuild lost are on the list too.** Chat history, which came back empty in many Telegram topics, now goes to every computer. Promise numbers can no longer be reused: the rebuild gave old June promises the same numbers as lost November ones. The keys the phone app needs for notifications are checked on every computer, and the owner is asked once if they are missing everywhere. Also covered: the history of the agent's working notes, the second app project (Android) that also had no online copy, the files that track long-running work, and the Apple ID sign-in.
- **Records outlive the computer that wrote them.** Every computer keeps the public keys of computers that have gone, each one vouched for by the computer that let it in, so old signatures can still be checked. The checks that fail are put aside and retried slowly, instead of 18 times a second. Shared records also get a periodic signed "seal". A surviving computer can then pass a dead computer's records on, and the receiver can prove they are genuine. Once a computer is retired, a line is drawn under its records, so a stolen key can't add new ones afterwards.
- **An off-computer backup of each agent's whole folder.** It includes files the code-history tool ignores and unsaved work in every work copy. It is encrypted so that any of the owner's other computers can open it, but nobody else can. A rebuilt computer is given the keys when it rejoins, so it can open the backups it needs. It is copied to another of those computers and test-restored every week. A backup that has never been test-restored doesn't count. It replaces today's hourly, unencrypted Studio-to-Mini copy, which also carries keys that should never leave their computer.
- **A "lives only here" report** for each agent and computer: what would be gone if this computer died right now. It also gives the folder's true size, including parts it can't read, so a 460 GB folder can't hide 375 GB of itself again. A copy of the latest report is kept on the other computers, so after a loss they can say exactly what was lost. A rebuild guide is generated from it for each agent, including Luna.
- **Disk safety.** Work copies get a size limit set by the disk, disk warnings always reach a person, and a warning comes before an operating-system upgrade when space is too low.
- **Browser sign-ins on every computer that may take over**, each signed in on its own and checked by reading the account name on the page.

**A computer that goes quiet is not treated as lost.** A sleeping laptop holding new work is shown as "at risk" on the other computers. Only after it has been gone for hours, or is retired, does the owner hear once which items had their only copy on it.

## The safeguards

**Nothing private becomes public.** Unfinished work is pushed only to a remote that is confirmed private. Otherwise it goes only to the owner's own computers.

**Nothing forged spreads.** A computer passes on another computer's records only with that computer's own signature, and only for records signed before it left. Two conflicting signed versions stop everything at that point and raise an alert.

**Nothing is deleted to make room unless it is safe.** The cleaner removes a work copy only when its saved changes are confirmed on another computer and its unsaved changes are in a backup that passed a restore test.

**The monthly drill can't cause the loss it guards against.** The drill refuses to start if anything lives only on the machine being wiped. The machine being rebuilt can never take charge or create alerts topics. For its first three months the drill rebuilds into a separate practice folder. Real wipes wait until rebuilt computers are recognised by every other computer, a fix being built separately, and even then a real wipe moves the folder aside for a week instead of deleting it.

**Honest limits.** Instar runs as the user and cannot stop Apple's installer. It can warn before an upgrade and make a fresh backup the moment one starts. An agent with only one computer gets an honest "everything lives only here" report; that case is handled by a separate piece of work.

## What ships when

First comes the project list in watch-only mode, because it would have saved the lost app code. Next, copying work off the machine. Then the critical list and its check, which shows today what a rebuilt computer would be missing. After that, sharing those settings, and then passing on a dead computer's records. Then the folder backup with its weekly restore test, which replaces today's manual Studio-to-Mini copy. Then the "lives only here" report, the disk fixes (the disk-warning fix is small and can ship early), and browser sign-in coverage. The monthly drill comes last: practice rebuilds first, then real wipes.

## What you actually need to decide

Nothing new. The owner approved this work in the post-mortem, including the drill on a spare machine. One choice is written into the spec rather than asked: the agent may create a private GitHub repository for any project of its own that has no online home.
