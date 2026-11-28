# Measuring how Remote Desktop really feels

To know whether Remote Desktop feels like AnyDesk, someone has to open a real session and measure it. This small script does that the same way each time. It signs in to the dashboard with the PIN, opens one chosen machine, and times how long until the first picture shows. It then scrolls a little, down and back up the same amount so nothing is left moved, and times how long each scroll takes to show on screen. Finally it scrolls steadily for three seconds to see how many pictures arrive and how big the gaps are. It always presses Stop at the end, and it prints only numbers, never the PIN or anything on the screen. A view-only mode watches without sending any input at all.

Why it exists: the viewer's own Speed button shows these numbers to a person, but a promised measurement needs a repeatable run whose results can be posted. The script runs on the machine that hosts the dashboard, so the PIN never has to be copied anywhere else.

Since the first Studio reading, it also counts what the browser's video decoder did, and asks the server why the session left the fast video format. Together these tell whether the Mac failed to send fast video or the browser failed to show it.
