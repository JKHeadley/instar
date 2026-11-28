# Make Plan Approval Requests Understandable

The Plans page asks a person to approve individual steps in a project. Before this change, the visible list said only that a numbered round was waiting for an OK. The model already knew the step name, but the list renderer did not display that explanation. A person had to open the project and interpret its internal round number to understand the request.

This repair puts the work being approved into the visible list subtitle and into the approval panel. A named step says “Review and approve: Restore lost conversation names”. An unnamed step says “Review and approve step 1”. The button says “Approve step 1”, and the panel explains that approval gives permission without starting work by itself. Existing progress information and any failure to load details remain visible.

This is a small, reversible presentation change. It does not decide which projects require approval, approve anything automatically, schedule work, change the request body, or change who may act. Projects added only for tracking still do not ask for an unscheduled launch. Existing endpoint authentication and acknowledgement behavior remain authoritative.

Focused tests cover the visible list and panel, named and unnamed work, missing project details, tracking-only projects, and the acknowledgement sent after the real button is clicked. A separate reviewer checked the wiring and preservation of permission behavior. Full shared verification and release remain required before this repair is described as live. Reverting the code restores the previous words without a state migration.
