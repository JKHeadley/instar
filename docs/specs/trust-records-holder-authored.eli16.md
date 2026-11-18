# Only the computer in charge can give permissions (ELI16)

The agent can run on several computers, and one of them is in charge of approvals. They share a notebook of permission records: "the owner approved this action", "this phone may approve things", "the owner lets me do this kind of thing alone". Right now the computer in charge believes every page in that notebook, even pages another computer wrote. So a stolen laptop still linked to the agent could write "the owner approved this" and the agent would act on it.

The fix is simple: a page that gives permission only counts on the computer that wrote it, and only while that computer has stayed in charge without a break. A page that takes permission away, or marks one as already used, counts from any of the agent's computers, because believing it can only make the agent more careful.

The cost: whenever a different computer takes charge, every earlier permission stops counting, including on a computer that was in charge before and comes back. The agent asks the owner again the next time each thing is needed, and says plainly that it moved and why it is asking. If the same computer just dozes off and picks up again with nobody else in charge in between, nothing is lost. Everything is asked once more when this version is first installed on an agent with more than one computer.

An earlier version tried to carry the owner's answers safely across a change of computer. Each review round found a new gap in that carrying, so it was cut: there is no carrying at all now, only asking again.

Two details make this hold up. If two computers ever briefly both believed they were in charge, that moment counts as a change of computer, so nothing approved before it can be used twice. And when you take a permission away on any of the agent's computers, it is removed everywhere, including on the computer in charge, because taking away is the one kind of page every computer believes.

