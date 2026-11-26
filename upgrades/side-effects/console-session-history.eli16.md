# Plain overview: full session history in the dashboard

Scrolling up in a session on the dashboard only went back one screen. That's because the
sessions now draw full-screen inside their terminal, and a full-screen program leaves the
terminal no scrollback to remember. The whole conversation is still saved, though: each
session keeps its own record of everything said and every tool it used.

This change adds a History button next to Live on an open session. History shows that
saved record as messages, newest at the bottom, and loads older messages as you scroll up,
all the way to the start. A session running on another machine is read from that machine.
Tool use shows as one short grey line so the conversation stays readable.

Nothing about the live view changes: Live is still the default and still the place to type.
History only reads; it cannot change or delete anything in the session.
