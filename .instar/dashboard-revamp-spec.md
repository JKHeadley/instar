# Dashboard Revamp UX Spec

## Design Principles
1. **Overview → Drill-down**: Every tab starts with a high-level summary, then lets users click into progressively more detail
2. **Plain language**: No jargon. Every metric explained. No "coherence", "surfaced", "quieted"
3. **Self-documenting**: Features explain themselves — no external docs needed
4. **Actionable**: Every view should answer "what can I do here?"
5. **One-line tab descriptions**: Brief subtitle below each tab heading explaining its purpose

## Tab Bar Changes
- "Drop Zone" → "Send Content"
- "Discovery" → "Features"  
- "Systems" → "Health"
- Order: Sessions | Files | Send Content | Jobs | Features | Health

---

## 1. Jobs Tab Revamp

### Overview
- **Tab description**: "Monitor and control your scheduled tasks"
- **Summary cards** (top): Total Jobs, Running Now, Healthy, Failing, Disabled
- **Job list**: 
  - Status dot with tooltip explaining meaning
  - Job name + one-line description (not just slug)
  - Human-readable schedule
  - Last run time + result
  - Sort: Status, Name, Last Run, Schedule
  - Filter chips: All, Running, Healthy, Failing, Disabled

### Detail (click a job)
- **Header**: Job name, description, status badge
- **Status card**:
  - Current status with plain explanation ("This job has failed 3 times in a row")
  - Last run: when, result, how long, error message (full, not truncated)
  - Next run: exact datetime (not relative)
- **Actions**: Run Now (with confirm), Enable/Disable toggle
- **Run history sparkline** with legend: green=success, red=failure, gray=skipped
- **History table**: Time, Result, Duration, Error
- **Configuration** (collapsible section):
  - Schedule: cron + human-readable
  - Model: which AI model this job uses
  - Priority: with explanation of what priority affects
  - Execution: skill/prompt/script + the value
  - Supervision: tier + plain explanation
  - Tags, machine restrictions
  - Gate: what pre-flight check runs (if any)

### API Sources
- `GET /jobs` — job list with state
- `GET /jobs/:slug/history` — run history
- `POST /jobs/:slug/run` — trigger
- `PATCH /jobs/:slug` — update config

---

## 2. Health Tab (was Systems)

### Overview
- **Tab description**: "Your agent's health and running processes"
- **Health banner**: Green checkmark + "All systems healthy" or warning count
- **Uptime**: "Running for 2 days, 14 hours"
- **Issues** (if any): Clear cards with severity icon, description, and what to do
- **Subsystem grid**: Cards with:
  - Status dot (green/orange/red)
  - Name: human-readable
  - Description: one sentence explaining what it does
  - Key metric: plain language ("Recovered 3 sessions today")
  - Click arrow for details

### Detail (click a subsystem)
- **Header**: Name, description, status
- **Metrics**: Each metric shown as a card with label + value + explanation tooltip
- **Components**: List of processes with running/error status
- **Last activity**: "Last active 5 minutes ago"
- **Browsable data**: Click metric cards to see underlying data (e.g., click "Recoveries" to see recovery log)

### Key language changes
- "Interventions" → "Automatic fixes"
- "Coherence Passed/Failed" → "Consistency checks (N passed)"  
- "LLM Overrides" → "AI-assisted decisions"
- "Orphan Processes" → "Cleanup needed"
- "Triages" → "Issue investigations"

### API Sources
- `GET /systems/status` — full system status
- `GET /systems/capability/:id` — subsystem detail

---

## 3. Features Tab (was Discovery)

### Overview
- **Tab description**: "Browse and configure your agent's capabilities"
- **Autonomy Profile** (prominent card at top):
  - Current profile name + icon
  - One-line description of what it means
  - "Change" button → opens profile selector
- **Feature categories** (sections):
  - Communication: Agent Network, Publishing, Feedback
  - Infrastructure: Tunnel, Git Backup, File Viewer, Telemetry
  - Intelligence: Evolution, Autonomous Evolution, Dispatches
  - Safety: Operation Safety, Response Review, Input Guard
- **Each feature card**:
  - Name + one-liner description
  - On/off toggle (directly actionable)
  - Status badge (enabled/disabled)
  - Click for details →

### Detail (click a feature)
- **Header**: Name, category badge, toggle
- **Full description**: Multi-line explanation
- **Data & Privacy**:
  - What data is involved
  - Where it goes
  - How long it's kept
- **Reversibility**: How to undo enabling this
- **Configuration**: Any sub-settings for this feature

### Autonomy Profile Selector (modal/inline)
- 4 profiles shown as cards:
  - cautious: "You approve everything"
  - supervised: "Routine tasks are automatic, you approve important decisions" (recommended)
  - collaborative: "Agent handles most decisions, keeps you informed"
  - autonomous: "Full self-governance, agent handles everything"
- Each card shows what settings it controls
- Selection requires confirmation
- Profile change history viewable

### API Sources
- `GET /features` — all features with state
- `POST /features/:id/transition` — enable/disable
- `GET /autonomy` — current autonomy state
- `POST /autonomy/profile` — change profile
- `GET /autonomy/history` — profile change log
- `GET /capabilities` — full capability list

---

## 4. Sessions Tab Polish

- **Tab description**: "Active agent sessions and their terminals"
- **Better empty state**: "No sessions running. Create one to start working with your agent."
- **Telemetry tags**: Replace "tools used" with "Actions taken", add tooltips
- **"Subagents"** → "Background tasks"
- **Idle display**: "Waiting for input (15 min)" instead of "idle 15m"
- **Terminal default**: "Select a session to view its terminal" instead of "—"
- **Platform labels**: Add text labels alongside emoji

## 5. Send Content Tab (was Drop Zone)

- **Tab description**: "Send text content to a running session"
- **Rename**: "Drop Zone" → "Send Content" 
- **Status labels**: "queued" → "Waiting for session", "notified" → "Delivered"
- **Session selector**: Show session name when auto-selected

## 6. Cross-cutting

- **Tab descriptions**: Subtitle text below heading in every tab
- **Time formatting**: Always show absolute time with relative in parentheses
- **Status colors**: Consistent across all tabs (green=healthy, orange=warning, red=error, gray=disabled, blue=running)
- **Drill-down pattern**: Consistent back button, breadcrumb, and transition everywhere
