# The message box hint fits on a phone

When you open one of your agent's sessions on the dashboard, there is a box at the bottom where you type a message to that session. Inside the empty box there is a faint hint telling you what the box is for. Until now that hint said "Type a message…". On a phone the box is narrow, because the paper-clip button, the Keys button and the Send button sit next to it in the same row. The hint did not fit on one line, so it wrapped onto a second line, and because the box is only one line tall, the second half of the hint was cut off. What you actually saw was "Type a" with the bottom of some letters peeking out underneath. It looked broken, even though typing worked fine.

This change does two small things. First, the hint is shortened to "Message…", which fits comfortably on a phone. Second, the hint is told never to wrap: if a screen is ever so narrow that even the short version does not fit, it now ends with three dots on a single line instead of spilling onto a hidden second line.

Nothing else changes. Typing, sending, attaching files and the Keys tray all behave exactly as before. The label that screen readers announce for the box ("Message to the session") is unchanged. There is no data involved and nothing to migrate, so undoing it is just reverting the two lines.
