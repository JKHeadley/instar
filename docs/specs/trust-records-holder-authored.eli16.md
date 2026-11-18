# Only the computer in charge can give permissions (ELI16)

The agent can run on several computers, and one of them is in charge of approvals. They share a notebook of permission records: "the owner approved this action", "this phone may approve things". Right now the computer in charge believes every page in that notebook, even pages another computer wrote. So a stolen laptop still linked to the agent could write "the owner approved this" and the agent would act on it.

The fix is simple: a page that gives permission only counts on the computer that wrote it. A page that takes permission away, or marks one as already used, counts from any of the agent's computers, because believing it can only make the agent more careful.

The cost: when a different computer takes charge, it has not written any permissions yet, so it asks the owner again the next time something needs approval, and asks once more before trusting the owner's phone or chat for approvals. That happens rarely, and it is never silent: if another computer writes a permission page it had no business writing, the owner is told.
