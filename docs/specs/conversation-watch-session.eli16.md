# Conversations: a "Watch the session" link on each conversation

## What this is

On November 14 Justin asked for the dashboard's conversation page to match the Instar app, starting with a way to jump from a conversation to the session that is answering it. The app has an Open session button for this. The dashboard's conversation page had nothing, so you had to go to the Sessions page and hunt for the right row. A first version was written that day but never saved, so it is rebuilt here.

## What changes

When you open a Telegram or app conversation on the dashboard, a line under its title now says whether a session is running for it. When one is, the line has a "Watch the session" link and says which machine it runs on and how long ago it started, for example "Running on Mac Studio, started 3 h ago." The link opens that session on the Sessions page, where you can watch and type into it. When nothing is running, the line says so: "No session is running for this conversation right now. The next message in it starts one." When the session list can't be read, it says it couldn't check.

The line uses the same session list the Sessions page already reads, so the link always lands on a row that page shows. A session on another machine opens through that page's existing support for other machines. If a conversation somehow runs on two machines at once, the line says so. No new server route is added.

## The Chats page gets the same line

The dashboard has two conversation views. The Conversations view described above has never been switched on on any of Justin's machines, so the view people can actually use is Chats, which can already read and reply. The same "Watch the session" line now appears at the top of an open conversation in Chats too.

## The Conversations door opens Chats while the other view is off

Since November 16 the dashboard has opened on the Conversations view by default, so on every machine it greeted people with "Conversations is not switched on here yet." The console now asks the server whether that view is switched on. When the server says it is off, the Conversations door and the first page open Chats instead. If someone still lands on the switched-off view, it explains that Chats shows the same conversations and offers an "Open Chats" button instead of a dead end. When the view is released, or when the server's answer is unclear, the door behaves exactly as before.

## What it does not do yet

Slack conversations don't get the line yet, because their sessions are matched differently. That is on the list of remaining differences from the app.

## What you need to decide

Nothing. Undoing the commit removes the line.
