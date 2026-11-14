# When a person stops setup, setup stays stopped

## What this is

After you say yes to a recommended service, your agent runs a session that sets it up. If that session dies, a regular check restarts it, a limited number of times, because a crash shouldn't quietly end the job.

The second live test of Jev showed a hole in that. When a person's message stopped the session, the check treated it like a crash and started the session again within seconds. So a real "stop" would not have held during setup.

## What changes

A stop by the person now puts setup on hold. That covers an emergency stop in Telegram or Slack, including Slack through the app, and ending the session from the dashboard. While it's on hold, the regular check doesn't restart the session and sends no "setup is stuck" notice.

A setup session can also put itself on hold. If the person says "not now" to something the job needs, such as paying for credits, the session says where that leaves things and holds. Otherwise it would be restarted later and might ask again.

A hold ends in one of three ways. The person says yes again on the service's page. The person says no, which ends setup. Or the check passes. A plain reply in the conversation also brings the session back, the way any conversation resumes, though the check won't restart it if it dies again.

The hold route asks for no PIN because it grants nothing. All it can do is stop a restart. It refuses on any agent that isn't proving a recipe, so nothing changes on real agents.

## Two smaller fixes from the same test

The Jev offer now says up front that TypeSafe needs credits added before it gives out a key, so it needs a card or a credit code. The test found that a new account can't create a key at a balance of zero. The offer used to say only that use is paid at a small cost per call.

The rule about holding a key in a private folder now also covers sign-in codes and pictures of either, because the session put a sign-in code in a shared folder for a few seconds.

## A bug the review found along the way

A reply brings a setup session back under a different name, and setup state kept the old one. So a later yes could start a second session on the same job, and a later no couldn't stop the running one. State now follows the conversation, so it always finds the session that's really running.

## What this doesn't fix

The emergency-stop check itself treated a plain "No, don't add credits" as a stop. That's a separate bug, filed on its own. With this change, a false stop like that stays stopped until the person writes again, where before it recovered by accident. That is the right way round: a stop that doesn't hold is the worse failure.

A session killed some other way, such as the reaper or a crash, still gets the limited restarts.

## What you need to decide

Nothing. Setup stays off on real agents.
