# ELI16: the agent's quick yes/no judges can no longer be talked into doing things (SEC-172)

Many times a day the agent asks a small AI a quick question, like "does this message need a reply?" Some of those questions include words written by someone else: another agent, a Slack member, a team member.

On some machines those questions go to a set of always-open Claude windows. Those windows could use every tool on the computer, read the agent's own instructions, and remembered up to fifty earlier questions. If someone hid an instruction inside their message, the only thing stopping it was the AI saying no.

Now each window opens with no tools at all, without the agent's instructions, and answers exactly one question before it is closed and replaced by a fresh one. The answers are the same kind as before. The judge simply has nothing it could be talked into using, and nothing from earlier questions to be steered by.
