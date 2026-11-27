# Remote Desktop can show how fast it feels

Justin asked for Remote Desktop to feel like AnyDesk. Until now nobody could say how close it is, because nothing measured the delay you feel. The machine being viewed already counts the pictures it sends, but not the time from your click to seeing the result.

The viewer now measures that itself. When you click, press a key or scroll, it notes the moment the action leaves your phone or laptop. Plain pointer moves are not timed, because the remote machine does not draw its own pointer, so a move alone rarely changes the picture. When the next new picture of the remote screen is on your screen, it notes that too. The difference is the delay you actually feel: the trip there, the remote machine acting and capturing, the trip back, and decoding. The machine being viewed sends a picture only when its screen changes, so the next picture after an action is normally that action's result. A picture that takes longer than one and a half seconds is not counted as an answer, and an action that changes nothing on screen is counted as unanswered rather than as a delay.

It also measures smoothness: how many pictures a second arrive while the screen is changing, and the longest usual gap between them. A gap of more than half a second counts as a still screen, not a stutter, so a clock ticking on an idle screen does not produce a smoothness figure.

A new Speed button in the controls menu shows the reading at the top of the screen, for example "Delay 80 ms typical, 140 ms at worst, 16 pictures a second while it changes". It says it is still measuring until five actions have been timed. While the remote screen is locked, the password box covers it. It is off until you tap it, it never takes touches meant for the desktop, and it updates once a second.

The numbers stay on the viewing page. Nothing new is sent to the remote machine or the server, and no pictures or keystrokes are recorded. The point is a real figure for each machine and connection, so we can fix the slow part and prove the fix worked.
