<!-- bump: patch -->

## What Changed

The phone's Machines rows no longer say "this one" or "(this machine)". Each row reads the same whichever machine answers: "Live · load normal", with a small "leading" tag on the leading machine. `GET /mobile/machines` rows gain `evidenceLine`, the detail sentence that names the machine doing the checking ("Checked 3 s ago by Mac Studio."). `GET /mobile/resources` now covers every machine. It adds `combined` (one line plus the busiest machine) and `machines[]` (each machine's CPU, memory, busiest sessions, session count and version). Each peer is read through `?scope=local`, which never fans out. A machine that does not answer is "not answering", never zeros. The top-level fields are unchanged for older phones. The dashboard's Machines page drops the "this one" tag. Every machine card and sheet shows its resource use from the same read, and each sheet links to Remote desktop for that machine.

## What to Tell Your User

The Machines screen in the app now reads the same no matter which of your machines is answering. It shows each machine's status in a few words, with "leading" on the machine in charge. Resource usage now covers all your machines, with a total at the top. Tap any machine to see what is using it, its version, and a button to open its Remote Desktop.

## Summary of New Capabilities

- Resource usage for every machine on the phone and the dashboard (`GET /mobile/resources` → `combined`, `machines[]`)
- `GET /mobile/resources?scope=local`: one machine's own answer (the peer read)
- `evidenceLine` on `GET /mobile/machines` rows

## Evidence

Unit tests cover:
- the same wording whichever machine answers;
- the evidence line;
- the combined summary, with a silent machine carrying no numbers;
- stale readings;
- the allowlist re-read of a peer's answer;
- the dashboard page in a DOM.

Integration tests cover the pooled answer over the signed phone path, and that `?scope=local` never fans out. End-to-end, on a production boot both scopes answer and machine rows never say "this machine". The app's unit and UI tests drive the Machines, Resource usage and machine detail screens with sample data.
