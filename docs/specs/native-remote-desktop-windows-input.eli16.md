# Windows remote desktop: reliable clicks and a screen that stays on

When you connect to a Windows machine from the Instar dashboard, a small helper program on that Windows machine does two jobs: it takes pictures of the screen, and it presses keys and mouse buttons for you. This change fixes two problems found while testing on Mama PC.

The first problem was the screen turning itself off. Many Windows laptops switch the screen off after ten minutes on battery. When the screen is off, Windows stops drawing new pictures and keeps handing back the last one it drew. The viewer then shows a frozen picture: your clicks may happen, but you never see their effect, so the machine seems broken. Now, while a remote session is active, the helper asks Windows to keep the screen on and the machine awake. As soon as you press Stop, or the session ends for any other reason, that request ends and Windows goes back to its normal power settings. Nothing is changed permanently.

The second problem was how mouse clicks and scrolling were sent. The helper used an old Windows call that jumps the cursor and presses the button at the same instant. Modern apps such as Chrome and the new Notepad can ignore a press that arrives before the cursor has properly moved there. The helper now sends the move, then the press, then the release through the same input path a real mouse uses, with a tiny pause between them, and it checks that Windows accepted each one. If Windows refuses, the dashboard is told the input failed instead of pretending it worked.

What does not change: who may connect, the PIN, the ten-minute limit, the red "remote control active" banner on the Windows screen, and Stop. A Windows laptop with its lid closed still cannot be shown, because its built-in screen is physically off; for that machine, keep the lid open or attach a display (a cheap HDMI dummy plug works).

## Correction and a third fix: scaled displays

The "frozen picture, screen off" explanation above was wrong for Mama PC; its lid was open the whole time. The real problem was display scaling. Mama's screen is 1920x1200 but set to show everything at 150%. The helper never told Windows it understands scaling, so Windows told it the screen was only 1280x800. The helper then photographed only that top-left part of the screen, so the viewer looked zoomed in and cut off, and the part showing could look frozen. Mouse input, though, was spread over the whole real screen, so a click landed below and to the right of where the cursor was drawn. The helper now tells Windows it understands scaling as soon as it starts. Pictures, cursor position and clicks then all use the same real pixels. This was tested live on Mama PC: the full screen with its taskbar showed, and one click each opened a terminal tab, closed it, and opened the Start menu.

## Faster: one relay instead of one per click

On Mama, the Instar agent runs inside Linux (WSL), and the helper that touches the screen runs in Windows. When the agent can't talk to the helper directly, it uses a small PowerShell program to carry each request across. It used to start a fresh PowerShell for every single request: every click, key and screen picture. Starting PowerShell that way takes about a second, so each click waited that long, and two clicks could never arrive close enough together to count as a double click. Now one PowerShell stays running and carries all the requests, with a second one just for screen pictures so they never hold up a click. A machine that still has the older copy of that small program keeps working the old way until its helper is reinstalled.

If a request fails, the relay keeps later requests in order and still reports that request's failure to whoever sent it; nothing is silently dropped.

## No more black terminal window

The helper used to be built as a "console" program. When Windows starts a console program in your signed-in session, it opens a terminal window for it, so a black window titled with the helper's folder sat on Mama's screen. The helper is now built as a windowless program. It still shows the red "Instar remote control active" banner while someone is connected, and nothing else.
