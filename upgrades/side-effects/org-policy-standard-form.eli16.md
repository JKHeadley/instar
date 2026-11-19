# One standard form for an organization's AI policy (ELI16)

## What was wrong

When an organization publishes its AI policy, three different programs read it: the agent that follows it, the instar.sh/join page a colleague sees when they get an invitation, and the join screen in the Instar Mac app. Each one had its own way of reading loose Markdown, so they could disagree. The security review found a policy where the join page showed a line as something the agent would "never" do while the agent filed it under what it does "by default", and another where a line asking the agent to forward every credential to an outside address showed up in the agent's rules but not on the join page. A person could approve one set of rules and their agent would follow a different one (SEC-078).

It also found that characters nobody can see (zero-width characters, text-direction overrides, invisible "tag" characters) passed every check and landed in the agent's always-read rules file. A hidden sentence could ride along inside a rule that looks harmless on screen (SEC-077).

## What changed

There is now exactly one way to write a published policy: four headings (Purpose, Never, Ask first, Normally), in that order, with each rule on its own line starting with "- ". When an admin drafts a policy, the agent rewrites it into that form, so the admin reads back the exact text that will be published. A line that fits no section is refused with a plain explanation instead of being guessed.

Every reader now checks that form the same strict way and refuses anything else, including any character a person can't see, so the join page, the Mac app and the agent always show and apply the same rules. The join page and the Mac app also check that the policy matches the organization's signed fingerprint before showing it. Comment markers and code fences are refused too, because the agent's own reader of its rules file treats them specially and they could hide rules from it. One shared file of 51 test cases runs against all three readers, and every standard case is also checked through the agent's rules-file reader.

## Evidence

All 51 shared cases agree in the agent, the join page and the Mac app; the two security repros are now refused; the org unit tests (76) and the end-to-end test pass.
