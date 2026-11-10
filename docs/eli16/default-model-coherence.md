# Machines that disagree on the default model now raise an alarm

Echo runs on several machines at once, and a conversation (a Telegram topic) can be placed on any of them. When a topic has no model chosen for it, the machine it lands on decides the model from its own setting, the "default model". On 9 November that setting said Opus 5.5 on the Studio and the Mac Mini, but it was empty on Mama PC and the Laptop. An empty setting means Claude starts with whatever its login defaults to, which was Fable 5.1. So topic 141133, which should have run on Opus 5.5, ran on Fable 5.1 after it was placed on Mama PC, and its replies were correctly tagged "Fable 5.1".

The tag was telling the truth. The real fault was that nothing noticed the machines disagreed. Instar already has a guard that compares important settings across an agent's machines and raises one plain alarm when they drift apart, with a "fix it" reply. This change adds the default model for Claude Code and for Codex to the settings that guard compares. If one machine has Opus 5.5 and another has nothing or a different model, the operator now sees "my machines have drifted apart" naming the machines and the model, instead of finding out from a reply tag.

The alarm only reports; it never blocks a session. The two machines that were missing the setting were set to Opus 5.5 by hand, so topic 141133 now runs on Opus 5.5.
