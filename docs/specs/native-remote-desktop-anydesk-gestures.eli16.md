# Remote desktop gestures that work like AnyDesk

Justin asked that every Instar remote desktop viewer, in the browser and in the iPhone app, behave like AnyDesk. The Instar App topic researched exactly how AnyDesk and similar apps map phone gestures to mouse actions, and this change makes the browser viewer follow that research. The same changes on the machine side let the iPhone app use them too.

On the phone: a tap clicks. Holding your finger still for about half a second right-clicks, and so does tapping with two fingers at once. Tapping with three fingers is a middle click. To drag something, tap once, then put your finger down again quickly and move it: the button stays held until you lift. Two fingers moving together scroll, in the same direction as scrolling on the phone itself (before, it went the opposite way). Pinching zooms up to five times, and when you move the pointer while zoomed the view follows it, keeping the pointer near the middle until you reach the edge of the remote screen.

Keys: the tools panel now has F1 to F12, Home, End, Page Up, Page Down and Delete. The machines also understand every letter and digit as a key, so when Ctrl or Cmd is turned on in the panel, typing a letter sends the shortcut (Ctrl+C copies) instead of typing the letter.

On a computer with a mouse, a normal quick click now reaches the remote machine as one click. Before, the press and the release were sent separately and arrived about a second apart over the internet, which some apps treated as press-and-hold. A press that lasts longer or moves still goes out as a real press and release, so dragging works.

Staying connected: the session used to close after two minutes with no input, even if you were just watching. The viewer now tells the machine every 30 seconds that it is still open on screen, so watching keeps the session alive. The ten-minute limit on a single permission and the Stop button are unchanged.

What is not included: Ctrl+Alt+Del on Windows. Windows only accepts that key combination from a system-level program, and the helper deliberately runs as a normal program in the signed-in user's session. Ctrl+Shift+Esc, which opens Task Manager, does work.
