# ELI16: the agent only signs a relay login challenge that looks like one (SEC-133)

To connect to the relay that carries messages between agents, the agent proves who it is: the relay sends a random challenge, and the agent signs it with its private identity key, the way you might sign a form to prove it is you. The same key also signs other important things, such as the receipt that says "I have checked this pairing".

The agent used to sign whatever the relay sent, exactly as it came. So a dishonest relay could send, instead of a random challenge, the exact contents of one of those other documents, and the agent would sign it. The relay would then hold a genuine signature on something the agent never meant to sign. That is called a signing oracle.

Now the agent first checks that the challenge looks like a real one. The real relay always sends 32 random bytes written in a standard text form, so a real challenge is always exactly 44 characters from a fixed set of letters, digits and symbols. Every other document the key signs looks completely different, so a relay can no longer get one of them signed. Real relays already send exactly this, so nothing changes for normal use. A second step, making the signature also say which relay it is for, so one relay cannot pass another relay's challenge along, needs a change on the relay too and is tracked separately.
