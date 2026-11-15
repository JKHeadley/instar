# Windows Remote Desktop: real video instead of a slideshow

When you use Remote Desktop from the Instar dashboard to look at a Windows machine, a small helper program on that machine copies the screen and sends it to you. Until now it sent a series of still photos (JPEG pictures). On Mama PC that meant only five or six pictures a second, so moving the mouse or scrolling looked choppy, like a slideshow. Macs already send proper video, which is much smoother.

**What changes.** The Windows helper now makes real video, the same kind Macs send (H.264, the format almost every video player understands). It uses the video chip built into the computer when there is one (on Mama PC, the Intel graphics chip), and Windows' own built-in video maker when there isn't. Video is far smaller than a stream of photos, because after the first full picture it only sends what changed: on Mama PC a picture went from about 275 KB to about 20-35 KB while things move, and almost nothing while the screen is still. That matters on Windows machines like Mama PC where the Instar agent lives in a Linux layer (WSL) and every picture has to be carried across into Windows and back, which was the slow part.

The helper also now works on the next picture while the current one is still travelling to you, instead of waiting. The dashboard used to ask every machine for at most 15 pictures a second. Windows video can now ask for up to 20, because the helper on Mama PC can make about 18 to 19 a second; Macs and Linux machines are unchanged. Before this change Mama PC showed about 8.5 to 9 pictures a second in the same test.

**What stays the same.** Who may connect, the PIN, the time limit, the red "remote control active" banner, Stop, and how clicks and typing work are all unchanged. A click is never stuck waiting behind a video picture: the helper checks the request quickly and never makes the mouse and keyboard wait more than a brief moment.

**Safeguards.** If anything about video doesn't work on a particular machine (an old helper, no video maker available, an error), that session quietly goes back to photos, exactly as before. Nothing breaks; it is just choppier. If the helper on the Windows machine is older than the agent, the agent asks for video once, gets told no, and uses photos. And if video ever just stops arriving (the video maker hangs, for example), the session notices within a few seconds and switches to photos rather than leaving you looking at a frozen screen.

**Who gets it.** It is switched on for our own development machines first and switched off for everyone else until it has been measured in real use. It can be turned off on any machine with one setting, and that takes effect right away.

**What you need to decide.** Nothing. This is an improvement that ships switched off for other users; the only open item is Justin trying it on Mama PC and saying whether it feels smooth.
