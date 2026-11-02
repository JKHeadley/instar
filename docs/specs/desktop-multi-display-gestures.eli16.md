# Remote desktop: multiple screens and three-finger swipes

Justin tested the iPhone remote desktop on a laptop with three screens. Two things were missing, so this change adds them.

**Screens.** Today a Mac only shows its main screen, and you can only click on that one. A Windows machine squeezes every screen into one tiny picture. After this change the viewer asks the machine which screens it has and gets a friendly name, the resolution, and which one is the main screen. A Screens control lists them, in the browser and in the iPhone app. Tapping one swaps the picture in about a second without reconnecting, without a new PIN, and without touching your ten-minute limit. Clicks land on the screen you are looking at, and the pointer jumps to the middle of that screen. On Windows there is also "All screens", which stays the default so nothing changes unless you choose.

**Swipes.** Three fingers now work like a Mac trackpad. Up opens Mission Control, which shows everything open. Down shows the windows of the current app, or goes back if an overview is already open. Left and right move between desktops (Spaces). The viewer simply sends the keyboard shortcuts a person would press: Control and an arrow key on a Mac. Windows gets the matching shortcuts: Win+Tab for Task View, and Ctrl+Win+arrow to change desktops. The same actions are also buttons in the tools panel.

**The "someone is connected" banner.** On Windows it sat at the top right, right over the close and maximize buttons. It is now a small strip at the bottom right, sized to its text. You can drag it anywhere, from the machine or from the viewer, but it stays on top and cannot leave the screen, because it is the safety signal that someone is connected. On a Mac it is a menu bar item that never covers windows, so it stays as it is.

**Dragging a window with a double tap.** On a phone, tap and then press and hold is how you drag. It used to send a click straight away, then the press, and the computer took that as a double-click, so a window you tried to drag by its title bar maximized instead. Now a single tap waits about a third of a second to see if a second one follows. That means a plain tap clicks slightly later than before, but dragging works, and a real double tap is still a double-click.

**Older machines.** A machine that has not updated yet would treat the new command as an error and end your session. So the viewer asks first, and only sends it if the machine says it understands. If it does not, you see a plain note that the machine needs an update, and everything else keeps working. Safety rules are unchanged: same PIN, same ten-minute grant, same encryption, same Stop button, same one-controller lock. Nothing new is stored, and no new permission is requested.

**Things that can still get in the way.** A Mac can have those shortcuts turned off in System Settings, and the viewer cannot tell, so a swipe would do nothing there. Safari on a phone may grab three fingers for its own undo gesture, which is why the buttons exist. In the iPhone app the swipes should work.

**What has been checked.** Automated tests cover the new messages, the older-machine behaviour, and the server path. The Mac helper is compiled. The Windows helper cannot be compiled on this Mac, so it has not been built at all yet. None of this has been tried on a real screen: a live test on the three-screen laptop and on Mama PC is still needed before anyone should call it working.

**To undo it:** revert the change. Nothing is stored, so nothing needs cleaning up.
