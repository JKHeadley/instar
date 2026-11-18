# The AI you pick when creating an agent is the AI you get (ELI16)

## What was wrong

When you create an agent in the Instar Mac app, one step asks "Which AI account do you have?" with two choices: Claude or ChatGPT. The app passes that answer to the installer that builds the agent.

The installer has a shortcut so people aren't asked questions it can answer itself: if exactly one AI tool is already installed on the computer, it uses that one and skips the question. That shortcut ran before the installer looked at the answer the app had sent. So on a Mac that already had Claude installed, picking ChatGPT made no difference: the agent was built on Claude. And because Claude was already signed in there, there was no sign-in step either, so the person never saw an account choice at all. Justin hit exactly this while testing on 17 November.

## What changed

The installer now checks for a choice the person already made first. Only when there is no choice does it fall back to the tool it finds on the computer. An answers file that names an AI the installer doesn't know is refused with the list of valid names, instead of being quietly ignored.

## Evidence

The install flow tests pass (50 of 50), including new cases: ChatGPT picked on a computer that only has Claude gives ChatGPT, also when the installer itself runs inside Claude; and an unknown AI name is refused.
