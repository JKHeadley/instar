# What changes when a Windows browser needs a password?

Instar opens a normal Windows browser for approved sign-in work. The desktop driver and the agent run in different Windows sessions. The old bridge put the input in a temporary file so the other session could read it. This change sends the input straight to the driver through pipes. Windows limits access to the account running the task. The link or password is never a scheduled-task argument, and the bridge records a fixed success message instead of storing the driver’s response.

The browser still has to be the right profile and the driver still checks the active window. If the pipe cannot connect, the bridge fails the call and follows the existing cleanup rules. A failed action whose outcome is uncertain still needs a page check before a retry. Browser history and the provider’s own sign-in requirements are separate from how the bridge carries the input.
