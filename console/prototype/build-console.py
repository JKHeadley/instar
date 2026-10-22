#!/usr/bin/env python3
"""Generate the prototype console's first screen from LIVE agent data.

Design follows console/research/SYNTHESIS.md:
  - convergence 1: show what the agent is doing AND what it is allowed to do,
    together, always visible.
  - the Dots finding: write empty states out in words ("No recent activity")
    rather than omitting them or printing a 0.
  - the failure this research kept hitting: distinguish working / slow /
    quietly-failed. A field we could not read says so; it never renders as fine.
"""
import json, subprocess, html, datetime, sys, os

BASE = "http://127.0.0.1:4040"
CFG = "/home/echo/.instar/agents/echo/.instar/config.json"
OUT = "/home/echo/.instar/agents/echo/.instar/proto-serve/console.html"
AUTH = json.load(open(CFG))["authToken"]

def get(path):
    """Return (data, error). An unreadable source is NEVER silently empty."""
    try:
        r = subprocess.run(
            ["curl", "-s", "--max-time", "30", "-H", f"Authorization: Bearer {AUTH}", BASE + path],
            capture_output=True, text=True, timeout=45)
        if r.returncode != 0:
            return None, f"could not reach the agent ({r.returncode})"
        if not r.stdout.strip():
            return None, "the agent returned nothing"
        return json.loads(r.stdout), None
    except subprocess.TimeoutExpired:
        return None, "the agent did not answer in time"
    except json.JSONDecodeError:
        return None, "the agent's answer was not readable"
    except Exception as e:
        return None, f"unexpected: {type(e).__name__}"

def ago(iso):
    if not iso: return None
    try:
        t = datetime.datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
        secs = (datetime.datetime.now(datetime.timezone.utc) - t).total_seconds()
    except Exception:
        return None
    if secs < 90: return "just now"
    if secs < 5400: return f"{int(secs//60)} min ago"
    if secs < 172800: return f"{int(secs//3600)} hours ago"
    return f"{int(secs//86400)} days ago"

e = html.escape

sessions, s_err = get("/sessions?scope=pool")
commits, c_err = get("/commitments")
guards, g_err = get("/guards?scope=pool")
atten, a_err = get("/attention?scope=pool")
pool, p_err = get("/pool")
health, h_err = get("/health")

# ---- can I actually reach you? --------------------------------------------
def delivery_block():
    """Whether replies are reaching the operator at all.

    This is the section that would have made 2026-10-22 visible on the night it
    happened: 26 replies had already been held and expired undelivered across 11
    days, recorded correctly the whole time, displayed nowhere. An agent that
    cannot reach its operator cannot report that it cannot reach its operator —
    so the count belongs on the screen, not in a log.
    """
    if h_err:
        return '<p class="err">Can\'t tell: ' + e(h_err) + '.</p>'
    hf = ((health or {}).get("telegramOrigin") or {}).get("heldForward") or {}
    count = hf.get("count")
    if count is None:
        return '<p class="empty">No delivery backlog reported.</p>'
    if not count:
        return '<p class="empty">Nothing waiting — replies are reaching you.</p>'
    topics = hf.get("topics") or []
    oldest = hf.get("oldestSince")
    age = ''
    if oldest:
        try:
            hrs = (datetime.datetime.now(datetime.timezone.utc).timestamp() * 1000 - float(oldest)) / 3600000
            age = '%.1f h' % hrs
        except Exception:
            age = ''
    parts = ['<div class="stat alarm"><b>' + str(count) + '</b><span>replies not delivered</span></div>']
    if topics:
        parts.append('<div class="stat"><b>' + str(len(topics)) + '</b><span>conversations</span></div>')
    if age:
        parts.append('<div class="stat warnst"><b>' + e(age) + '</b><span>oldest</span></div>')
    note = ('<p class="note alarmtext">These are written and waiting. They are retried, and some do '
            'get through — but a reply that cannot be handed over in time is deleted, and its text '
            'goes with it.</p>')
    return '<div class="stats">' + "".join(parts) + '</div>' + note

# ---- what needs you, across every machine ---------------------------------
def needs_you():
    """The attention queue across the whole pool.

    Shown near the top because an item nobody sees is an item nobody acts on, and
    pool scope is the point: this machine alone reported 130 open items while the
    fleet held 526. A per-machine view of a multi-machine agent understates the
    backlog by whatever the other machines are carrying.
    """
    if a_err:
        return '<p class="err">Can\'t tell: ' + e(a_err) + '.</p>'
    data = atten or {}
    items = data.get("items", data) if isinstance(data, dict) else (data or [])
    open_ = [i for i in items if str(i.get("status", "")).upper() == "OPEN"]
    meta = data.get("pool") if isinstance(data, dict) else None

    header = ''
    if isinstance(meta, dict):
        failed = meta.get("failed") or []
        if failed:
            header = ('<p class="note alarmtext">Could not reach ' + str(len(failed))
                      + ' machine(s); the counts below are incomplete.</p>')
    if not open_:
        return header + '<p class="empty">Nothing waiting on you.</p>'

    high = [i for i in open_ if str(i.get("priority", "")).upper() in ("HIGH", "URGENT")]
    parts = []
    if high:
        parts.append('<div class="stat alarm"><b>' + str(len(high)) + '</b><span>need you</span></div>')
    parts.append('<div class="stat"><b>' + str(len(open_)) + '</b><span>open in total</span></div>')

    by = {}
    for i in high:
        by[i.get("machineNickname") or "this machine"] = by.get(i.get("machineNickname") or "this machine", 0) + 1
    split = ''
    if len(by) > 1:
        split = ('<p class="note">' + e(", ".join(
            str(k) + ": " + str(v) for k, v in sorted(by.items(), key=lambda kv: -kv[1]))) + '</p>')

    rows = []
    for i in sorted(high, key=lambda x: str(x.get("createdAt") or ""), reverse=True)[:5]:
        when = ago(i.get("createdAt"))
        title = (i.get("title") or "(untitled)").strip()
        where = i.get("machineNickname")
        rows.append(
            '<div class="row"><div class="row-head"><span class="dot bad"></span><strong>'
            + e(title[:105]) + '</strong></div><div class="meta">'
            + (e(when) if when else "time not recorded")
            + (' · ' + e(str(where)) if where else '') + '</div></div>')
    tail = ''
    if len(high) > 5:
        tail = '<p class="note">…and ' + str(len(high) - 5) + ' more marked high.</p>'
    note = ('<p class="note">These accumulated with nowhere to be seen. That is the argument for '
            'this screen: a queue nobody looks at reads exactly like an empty one.</p>')
    return header + '<div class="stats">' + "".join(parts) + '</div>' + split + "".join(rows) + tail + note

# ---- sessions, across every machine ---------------------------------------
def session_rows():
    """Sessions across the whole pool, grouped by machine.

    Uses scope=pool so this answers "what are ALL of my agents doing" rather than
    "what is this one doing" — the question the research says a console must
    answer. A peer that could not be reached is NAMED, never silently omitted:
    an incomplete fleet view that looks complete is the failure this whole screen
    exists to avoid.
    """
    if s_err:
        return '<p class="err">Can\'t tell: ' + e(s_err) + '.</p>'
    data = sessions or {}
    ss = data.get("sessions", data) if isinstance(data, dict) else (data or [])
    live = [s for s in ss if s.get("status") in ("running", "starting")]
    meta = data.get("pool") if isinstance(data, dict) else None

    header = ''
    if isinstance(meta, dict):
        failed = meta.get("failed") or []
        asked, ok = meta.get("peersQueried"), meta.get("peersOk")
        if failed:
            names = ", ".join(str(f.get("machineNickname") or f.get("machineId", "?"))[:18] for f in failed if isinstance(f, dict))
            header = ('<p class="note alarmtext">Could not reach ' + str(len(failed))
                      + ' machine(s): ' + e(names or 'unnamed') + '. What follows is incomplete.</p>')
        elif asked is not None:
            header = ('<p class="note">All ' + str((ok or 0) + 1) + ' machines answered.</p>')

    if not live:
        return header + '<p class="empty">Nothing running on any machine.</p>'

    by = {}
    for s in live:
        by.setdefault(s.get("machineNickname") or (s.get("machineId") or "?")[:10], []).append(s)

    out = [header]
    for machine in sorted(by):
        out.append('<div class="mgroup">' + e(str(machine))
                   + ' <span class="meta">' + str(len(by[machine])) + '</span></div>')
        for s in by[machine]:
            started = ago(s.get("startedAt"))
            bits = []
            if s.get("framework"): bits.append(e(str(s["framework"])))
            if started: bits.append("started " + e(started))
            prompt = (s.get("prompt") or "").strip().replace("\n", " ")
            internal = (not prompt) or prompt.startswith("[") or "/.instar/" in prompt or "bootstrap-" in prompt
            doing = ('<span class="unknown">Not recorded.</span>'
                     if internal else e(prompt[:130] + ("…" if len(prompt) > 130 else "")))
            out.append(
                '<div class="row"><div class="row-head"><span class="dot live"></span><strong>'
                + e(str(s.get("name") or "unnamed")) + '</strong><span class="meta">'
                + " · ".join(bits) + '</span>'
                + ('<span class="pill">protected</span>' if s.get("protected") else '')
                + '</div><div class="doing">' + doing + '</div></div>')
    return "\n".join(out)

# ---- where I'm running ----------------------------------------------------
def machines_block():
    """Which machines exist, and which one currently holds the right to speak.

    This is the view that would have made tonight's lost replies visible: a
    conversation can be assigned to one machine while the right to answer on
    Telegram sits with another, and nothing anywhere said so.
    """
    if p_err:
        return '<p class="err">Can\'t tell: ' + e(p_err) + '.</p>'
    ms = (pool or {}).get("machines", []) if isinstance(pool, dict) else []
    if not ms:
        return '<p class="empty">Only one machine — nothing to coordinate.</p>'
    holder = None
    if isinstance(health, dict):
        holder = (health.get("multiMachine", {}).get("syncStatus", {}) or {}).get("leaseHolder")
    self_id = (pool or {}).get("selfMachineId")
    rows = []
    for m in ms:
        mid = m.get("machineId")
        nick = m.get("nickname") or (mid or "?")[:10]
        tags = []
        if mid and holder and mid == holder:
            tags.append('<span class="pill speak">holds the right to speak</span>')
        if mid and self_id and mid == self_id:
            tags.append('<span class="pill">this machine</span>')
        online = m.get("online")
        dot = 'live' if online else 'bad'
        state = 'online' if online else 'offline'
        skew = m.get("clockSkewStatus")
        if skew and str(skew).lower() not in ("ok", "none", "normal"):
            tags.append('<span class="pill warn">clock ' + e(str(skew)) + '</span>')
        rows.append(
            '<div class="row"><div class="row-head"><span class="dot ' + dot + '"></span><strong>'
            + e(str(nick)) + '</strong><span class="meta">' + state + '</span>'
            + "".join(tags) + '</div></div>')
    note = ''
    if holder and self_id and holder != self_id:
        note = ('<p class="note alarmtext">The machine answering you is not this one. '
                'A reply written here has to be handed over, and if that fails it is held, '
                'retried, and expires after six hours. That is what cost 26 replies.</p>')
    elif holder and self_id and holder == self_id:
        note = '<p class="note">This machine can answer you directly.</p>'
    else:
        note = '<p class="note">Could not determine which machine holds the right to speak.</p>'
    return "".join(rows) + note

# ---- promises -------------------------------------------------------------
def promise_rows():
    if c_err: return f'<p class="err">Can\'t tell: {e(c_err)}.</p>'
    items = commits.get("commitments", commits) if isinstance(commits, dict) else (commits or [])
    open_ = [i for i in items if i.get("status") not in ("delivered", "withdrawn", "cancelled")]
    if not open_:
        return '<p class="empty">No open promises.</p>'
    out = []
    for i in sorted(open_, key=lambda x: str(x.get("createdAt") or ""), reverse=True)[:8]:
        text = (i.get("agentResponse") or "").strip().replace("\n", " ")
        blocked = i.get("blockedOn")
        tag = ""
        if blocked and blocked != "none":
            tag = f'<span class="pill warn">waiting on {e(str(blocked))}</span>'
        when = ago(i.get("createdAt"))
        out.append(f'''<div class="row">
  <div class="doing">{e(text[:190] + ("…" if len(text) > 190 else "")) or "(no text recorded)"}</div>
  <div class="meta">{e(when) if when else "time not recorded"}{tag}</div>
</div>''')
    return "\n".join(out)

# ---- authority, across every machine --------------------------------------
def authority_block():
    """Guard posture for this machine, plus the per-machine gaps across the pool.

    Reads each machine's OWN summary rather than recomputing it. The first version
    of this function did `if guard.effective` — `effective` is a STRING, and "off"
    is truthy in Python, so it rendered 91 guards as on when 54 were off. It was
    caught only because the number looked implausible and the page was looked at.
    That is exactly the failure this console exists to make impossible, committed
    by the console.
    """
    if g_err:
        return '<p class="err">Can\'t tell: ' + e(g_err) + '.</p>'
    if not isinstance(guards, dict) or "summary" not in guards:
        return '<p class="err">Can\'t tell: this agent did not report a guard summary.</p>'
    sm = guards["summary"]
    parts = [
        '<div class="stat"><b>' + str(sm.get("onConfirmed", 0)) + '</b><span>on, confirmed</span></div>',
        '<div class="stat"><b>' + str(sm.get("onUnverified", 0)) + '</b><span>on, unverified</span></div>',
        '<div class="stat"><b>' + str(sm.get("offDarkDefault", 0)) + '</b><span>off by design</span></div>',
    ]
    if sm.get("onDryRun"):
        parts.append('<div class="stat warnst"><b>' + str(sm["onDryRun"]) + '</b><span>watching only</span></div>')
    if sm.get("offDeviant"):
        parts.append('<div class="stat alarm"><b>' + str(sm["offDeviant"]) + '</b><span>off that should be on</span></div>')
    if sm.get("offRuntimeDivergent"):
        parts.append('<div class="stat alarm"><b>' + str(sm["offRuntimeDivergent"]) + '</b><span>says on, isn\'t</span></div>')
    if sm.get("missing"):
        parts.append('<div class="stat warnst"><b>' + str(sm["missing"]) + '</b><span>can\'t tell</span></div>')

    notes = []
    gaps = sm.get("loadBearingGapKeys") or []
    if gaps:
        notes.append('<p class="note alarmtext">Something a critical path depends on is not running here — '
                     + str(len(gaps)) + ': ' + e(", ".join(sorted(gaps)[:3]))
                     + ('…' if len(gaps) > 3 else '') + '</p>')

    # Per-machine gap counts, derived from each peer's own guard rows.
    pool = guards.get("pool") if isinstance(guards, dict) else None
    if isinstance(pool, dict) and isinstance(pool.get("machines"), list):
        per = []
        for m in pool["machines"]:
            rows = m.get("guards")
            if not isinstance(rows, list):
                per.append((m.get("nickname") or "?", None))
                continue
            n = sum(1 for g in rows
                    if g.get("loadBearing") and str(g.get("effective", "")).startswith("off"))
            per.append((m.get("nickname") or "?", n))
        if per:
            txt = ", ".join((str(k) + ": " + ("can't tell" if v is None else str(v))) for k, v in per)
            notes.append('<p class="note">Critical-path gaps on the other machines — ' + e(txt) + '.</p>')
    elif isinstance(pool, dict):
        notes.append('<p class="note">Other machines did not report their guard posture.</p>')

    if sm.get("offRuntimeDivergent"):
        notes.append('<p class="note alarmtext">At least one guard reports itself on while its runtime says '
                     'otherwise. The contradiction is shown rather than resolved in its favour.</p>')
    notes.append('<p class="note">' + str(sm.get("offDarkDefault", 0)) +
                 ' are off because they ship off. Normal, not an alarm.</p>')
    enriched = sm.get("runtimeEnriched")
    if enriched:
        notes.append('<p class="note">Live runtime state could be read for ' + e(str(enriched)) +
                     '; the rest report what they are configured to do, not what they are doing.</p>')
    return '<div class="stats">' + "".join(parts) + '</div>' + "".join(notes)


now = datetime.datetime.now().strftime("%-d %B %Y, %H:%M")
page = f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Echo — console prototype</title>
<style>
:root{{--ground:#0A0E17;--panel:#111828;--line:#1E2838;--ink:#E8EDF5;--dim:#8A94A6;--teal:#6EC6C8;--ok:#4ADE80;--warn:#FBBF24;--bad:#F87171}}
*{{box-sizing:border-box}}
body{{margin:0;background:var(--ground);color:var(--ink);font:16px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:22px 16px 70px;max-width:760px;margin-inline:auto}}
h1{{font-size:21px;margin:0 0 2px}}
.sub{{color:var(--dim);font-size:13.5px;margin-bottom:26px}}
h2{{font-size:13px;letter-spacing:.09em;text-transform:uppercase;color:var(--teal);margin:30px 0 10px;font-weight:600}}
.mgroup{{font-size:12.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--dim);margin:14px 0 7px}}
.row{{background:var(--panel);border:1px solid var(--line);border-radius:11px;padding:13px 15px;margin-bottom:9px}}
.row-head{{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:5px}}
.dot{{width:8px;height:8px;border-radius:50%;flex:0 0 auto}}
.dot.bad{{background:var(--bad);box-shadow:0 0 0 3px rgba(248,113,113,.15)}}
.dot.live{{background:var(--ok);box-shadow:0 0 0 3px rgba(74,222,128,.15)}}
.meta{{color:var(--dim);font-size:13px}}
.doing{{font-size:15px}}
.unknown{{color:var(--dim);font-style:italic}}
.pill{{font-size:11.5px;border:1px solid var(--line);border-radius:999px;padding:1px 8px;color:var(--dim);margin-left:4px}}
.pill.speak{{color:var(--teal);border-color:rgba(110,198,200,.45)}}
.pill.warn{{color:var(--warn);border-color:rgba(251,191,36,.35)}}
.empty{{color:var(--dim);font-size:14.5px;margin:0 0 9px}}
.err{{color:var(--warn);font-size:14.5px;margin:0 0 9px}}
.stats{{display:flex;gap:9px;flex-wrap:wrap;margin-bottom:11px}}
.stat{{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:9px 13px;min-width:92px}}
.stat b{{display:block;font-size:21px;line-height:1.15}}
.stat span{{color:var(--dim);font-size:12.5px}}
.stat.alarm{{border-color:rgba(248,113,113,.45)}} .stat.alarm b{{color:var(--bad)}}
.stat.warnst{{border-color:rgba(251,191,36,.4)}} .stat.warnst b{{color:var(--warn)}}
.note{{color:var(--dim);font-size:13.5px;margin:5px 0}}
.alarmtext{{color:var(--bad)}}
footer{{margin-top:34px;border-top:1px solid var(--line);padding-top:15px;color:var(--dim);font-size:12.5px}}
</style></head><body>
<h1>Echo</h1>
<div class="sub">Console prototype · built from live data, {e(now)}</div>

<h2>Can I reach you</h2>
{delivery_block()}

<h2>What needs you</h2>
{needs_you()}

<h2>What I'm doing</h2>
{session_rows()}

<h2>What I've promised</h2>
{promise_rows()}

<h2>Where I'm running</h2>
{machines_block()}

<h2>What I'm allowed to do</h2>
{authority_block()}

<footer>Prototype — not the live dashboard, nothing here changes anything.
Every number is read from this agent right now; a value that could not be read says so
rather than showing zero.</footer>
</body></html>"""
open(OUT, "w").write(page)
print("wrote", OUT, len(page), "bytes")
