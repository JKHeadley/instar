# Conversations: a "Watch the session" link on each conversation

## What this is

On November 14 Justin asked for the dashboard's conversation page to match the Instar app, starting with a way to jump from a conversation to the session that is answering it. The app has an Open session button for this. The dashboard's conversation page had nothing, so you had to go to the Sessions page and hunt for the right row. A first version was written that day but never saved, so it is rebuilt here.

## What changes

When you open a Telegram or app conversation on the dashboard, a line under its title now says whether a session is running for it. When one is, the line has a "Watch the session" link and says which machine it runs on and how long ago it started, for example "Running on Mac Studio, started 3 h ago." The link opens that session on the Sessions page, where you can watch and type into it. When nothing is running, the line says so: "No session is running for this conversation right now. The next message in it starts one." When the session list can't be read, it says it couldn't check.

The line uses the same session list the Sessions page already reads, so the link always lands on a row that page shows. A session on another machine opens through that page's existing support for other machines. If a conversation somehow runs on two machines at once, the line says so. No new server route is added.

## What it does not do yet

Slack conversations don't get the line yet, because their sessions are matched differently. That is on the list of remaining differences from the app.

## What you need to decide

Nothing. Undoing the commit removes the line.
