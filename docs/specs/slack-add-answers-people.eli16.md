# Slack setup that lets people actually talk to the agent (plain-English overview)

When someone connects their Instar agent to Slack, they run `instar add slack`, paste two tokens, and expect to message the agent in Slack. On a fresh test server today, that did not work, for three separate reasons, and none of them said anything to the person.

First, the setup decided who the agent is allowed to listen to by asking Slack "who am I?" with the agent's own bot token. Slack answered with the bot's own identity, so the agent was set up to listen only to itself. Every real person's message was quietly ignored. Now the setup looks at who is in the workspace and suggests the right person: the only person there, or the workspace owner. You press Enter to accept, or type someone else's Slack member id. The bot itself can never be picked, and if nobody is chosen, the setup says plainly that the agent will ignore Slack until someone is named.

Second, the Slack app recipe the setup prints did not switch on the bot's Messages tab, so Slack would not let anyone send the agent a direct message. The recipe now switches it on.

Third, the small script the agent uses to answer in Slack is only put in place when the agent is first created or updated, and only if Slack was already set up then. Adding Slack later left it missing, so the agent refused to answer every Slack message until its next update. The setup now puts that script in place itself and warns if it can't.

For agents already set up the old way, the agent now says clearly at start-up when the only "person" it listens to is its own bot, and tells the owner to run `instar add slack` again. It does not change anyone's settings on its own. The missing script already arrives with the next update.

What already existed: the Slack adapter, its strict allowlist (no list, no answers), and the script installer used at creation and update. What is new: the person-picking step, the Messages tab in the recipe, installing the script at the moment Slack is added, and the start-up warning. Nothing to decide beyond whether these defaults are right: suggesting the sole person or the owner, and letting the installer type others.
