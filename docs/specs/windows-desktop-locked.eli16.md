# Windows Remote Desktop: a locked PC now says it is locked

Justin opened Remote Desktop to Mama PC, a Windows machine, and saw its lock screen. When he clicked, the picture went blank, and after a few tries the session closed. There was also no way to type the PC's PIN.

Here is what was happening. Instar's helper on Windows runs inside the signed-in person's session, the same way any normal program does. When Windows is locked, it first shows a lock picture (the photo with the clock). That picture sits on the normal screen, so the helper thought everything was fine and let a session start. The first click lifted the picture, and Windows switched to its separate sign-in screen. Windows deliberately lets no ordinary program see or type into that screen, which is a security rule, so the helper suddenly had nothing to show, the picture went blank, and its safety check ended the session about two seconds later. The viewer then just said the session ended, without saying why.

What changes: the helper now asks Windows directly whether the PC is locked. It only believes the answer when two separate signs agree: Windows' own "this session is locked" flag, and the sign-in screen program actually running. Requiring both means a wrong reading can never block a PC that is really unlocked. When the PC is locked, Remote Desktop shows Mama as not available, with a plain sentence: "This Windows PC is locked. Remote desktop cannot unlock Windows yet: sign in at the PC, then tap Retry." If the PC locks during a session, the session ends at once and the viewer shows that same sentence instead of a blank screen.

What does not change: who may connect, the PIN, Stop, the red banner, video, clicks and typing on an unlocked PC. Locked machines were already meant to show as unavailable; Windows just was not detecting it.

What this does not do: it does not unlock Windows remotely. Doing that safely needs a different kind of helper that runs as a system service, and that is a separate decision.

One more fix found while checking the iPhone app: when one machine showed another machine's "not ready" sentence, it cut it after 160 letters, so the Mac Mini's sentence ended mid-word ("… The Ins"). Each sentence now arrives whole, up to 800 letters, which covers the longest one Instar writes.
