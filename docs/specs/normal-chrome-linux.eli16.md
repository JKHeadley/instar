# Normal-Chrome browser skill on Linux: plain-English overview

> The one-line version: an Instar agent on a Linux computer can now drive an ordinary Chrome window the way a person does, by moving the real mouse and keyboard and reading the page the way a screen reader does, with the same safety rules the Mac and Windows versions follow.

## The problem in one breath

Some jobs have to be done as a particular signed-in account: sign-in pages, billing pages, settings and usage pages. Those pages often refuse to work, or behave differently, when they notice an automated browser. Instar already has a way around this on a Mac (it runs small bits of code inside a normal Chrome window) and on Windows (it clicks and types with real input and reads the page through the accessibility system). On Linux it had nothing: every tool stopped with "macOS only" or "Windows only", and the agent had to tell the operator it could not help.

## What we tested

On 3 November 2026 we tried the method on Cirrus, a Linux test computer in the cloud that has a real desktop you can watch over VNC. We started a fresh, empty Chrome profile (no sign-in, public pages only) and showed that a script could:

- open Chrome straight onto a page;
- read the page's address, title and text through the accessibility system;
- type a new address into the address bar and go there;
- find a link or a button by its name, work out where it is on the screen, and click it with the real mouse;
- read the new page back to prove the click worked;
- and that the page saw these clicks as genuine clicks from a person, not as fake ones.

## What went wrong, and what we learned

- **Chrome stayed silent at first.** Starting Chrome with the accessibility flag was not enough; it also needed a setting in its own environment telling it assistive technology is in use. We set that only for this one Chrome, not for the whole desktop.
- **A missing package.** The small library that lets Python read the accessibility system was not installed. It needed an administrator install. The new tool will say exactly which package is missing instead of installing anything itself.
- **A click that hit nothing.** On Wikipedia, a donation banner appeared just after we measured where a link was, and pushed the link down. The click landed on empty space and nothing happened, even though the click "succeeded". The fix is a rule: right before every click, ask the accessibility system "what is under this exact point?" and only click if it is the thing we meant. Then check the result by reading the page's address again.
- **Big pages are slow to read.** Walking every object on a long Wikipedia page took over a second each time, so the tool will only look at the visible page and ask targeted questions.

## What gets built

Two new helper files: a small safety wrapper (the only way an agent uses the tool) and the driver behind it. The wrapper enforces the same rules as on Mac and Windows, plus a few that Linux needs:

- Only act on what the operator asked for, and only on the Chrome window the tool opened (or a popup that same Chrome opened). Before every single keystroke it checks that this window still has the keyboard; if anything else takes focus, it stops mid-word.
- Never send input while the operator is using the computer. While it types or clicks, it listens for any input that did not come from itself, so if the operator touches the mouse or keyboard, even in the middle of a word, the tool stops. Watching over VNC without touching is fine.
- Never use the operator's own Chrome profile: the tool only uses profiles in the agent's own profiles folder.
- Never put typed text on a command line, where other programs could read it, and never print a password or its length. Password fields are never read back.
- Chrome is started with a clean environment, so the agent's own keys and tokens never reach the browser.
- Before typing a password, the box that has the cursor must belong to the website the agent expects. That rule still holds when the box is inside a frame from another site. Sign-in codes that appear in web addresses are blanked out before the agent sees them.
- The agent's own web file viewer can never download a browser profile or the tool's working files.
- A click is reported as "delivered", never as "done". The agent must check the page to see whether the task actually happened.
- It refuses to type while Caps Lock is on, rather than typing a password wrong or switching Caps Lock off behind the operator's back.
- When two agent sessions share one computer, each command says which profile it means, so one session can never type into another session's browser.
- It never quietly creates a new, signed-out profile because of a typo. A new profile has to be asked for on purpose.
- When it closes Chrome at the end of a task and a page asks "leave site?" or has unsaved work, it stops and tells the operator instead of force-quitting.
- Every step has a time limit. If a step times out, the tool refuses to type anything more until the agent has looked at the page again.

## Honest limits

These rules guard against an honest agent making a mistake. They are not a wall against other programs running as the same user: on this kind of Linux desktop, any program on the screen can see keystrokes. If the computer has no password keyring running, Chrome's saved logins are protected only by file permissions, and the tool says so every time it starts Chrome.

## What it cannot do

Unlike the Mac version, it cannot run code inside the page. It can read and click, like Windows. We looked at a browser extension to get that power and decided it is not worth the extra install, risk and visibility. It does not work on "Wayland" desktops (the newer Linux display system), which block one program from typing into another's window. There it refuses clearly and explains the way out. Recent GNOME versions no longer offer the older desktop at all, so on those laptops the agent needs its own separate virtual desktop. It supports Google Chrome only, not Chromium. A server with no screen needs a virtual desktop, as Cirrus has. Nothing yet tidies up Chrome windows the agent forgets to close, so the skill tells the agent to close them at the end of every task.

## How existing agents get it

The normal Instar update installs the two helper files and updates the skill's text and the agent's instructions, the same way the Windows version arrived. That includes agents whose skill text was edited by hand. Nothing runs until an agent uses it. Before release, the whole thing is run again on Cirrus through the real wrapper, including popups, password typing, an operator interrupting, and a forced timeout.
