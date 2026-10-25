---
title: Standing an Instar Agent up on a Windows Machine (WSL2)
status: operator runbook
audience: agents and machine operators
---

# Standing an instar agent up on a Windows machine

Instar runs on Windows through WSL2 — it runs as Linux, not as a Windows port. Everything below was performed and verified on a fresh Windows 11 23H2 machine on 2026-08-25; every command here was actually run, and every claim about behaviour is a measurement rather than an expectation.

**Read this first if you are doing it remotely.** Most of the steps are ordinary. The parts that will cost you an afternoon are the ones where something reports success while producing no effect, and they are called out as they arrive.

## What you get, and what you do not

| | |
|---|---|
| **Runs unmodified** | Sessions, jobs, messaging, the server, the scheduler, browser automation. `pnpm install` compiles the native SQLite binding; `pnpm build` and `instar init` need no changes. |
| **Runs Windows programs** | PowerShell and any Windows executable are callable directly from Linux. |
| **Does not get** | The operator's existing Windows browser sessions. Chrome refuses a cross-boundary debug connection, so an agent gets a fresh browser. See §7 for what to do instead. |
| **Costs** | The Windows filesystem is roughly 85× slower from Linux for many small files (measured: 200 files, 13 ms on ext4 vs 1,100 ms on `/mnt/c`). Keep work on the Linux side. |

Native Windows — no WSL — is a re-platform, not a port: sessions live in tmux, which has no Windows equivalent (154 tmux command sites across 40 files, plus the shell scripts that carry every messaging reply path).

## 1. Getting in — what the operator has to do

Exactly two things need a human at the machine, both installers or a paste:

1. **Install Tailscale and sign in.** This is the durable route in; do not rely on a LAN address (see §3).
2. **Enable OpenSSH Server** and install the agent's public key, in an Administrator PowerShell:

```powershell
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
Start-Service sshd
Set-Service -Name sshd -StartupType Automatic
New-NetFirewallRule -Name sshd -DisplayName 'OpenSSH Server' -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22
Set-Content -Path C:\ProgramData\ssh\administrators_authorized_keys -Value "<agent public key>" -Encoding ascii
icacls C:\ProgramData\ssh\administrators_authorized_keys /inheritance:r /grant "Administrators:F" /grant "SYSTEM:F"
```

**The trap:** a fresh Windows install classifies its network as **Public**, and the Public profile drops inbound SSH even with the rule above. The symptom is an *instant* connection refusal on port 22 while other Windows ports hang — a difference that looks like "sshd isn't running" and is not. Fix:

```powershell
Get-NetConnectionProfile | Set-NetConnectionProfile -NetworkCategory Private
```

Verify the network category before diagnosing anything else about sshd. Diagnosing this in the wrong order costs a round-trip with the human for every guess.

## 2. Make Tailscale survive logout — before you reboot anything

```powershell
& "C:\Program Files\Tailscale\tailscale.exe" up --unattended
Set-Service -Name Tailscale -StartupType Automatic
powercfg /change standby-timeout-ac 0
powercfg /hibernate off
```

Without `--unattended`, Tailscale disconnects when nobody is logged in, and a headless machine drops off the network on its next reboot with no way back in. Confirm with `tailscale debug prefs` → `ForceDaemon: True`.

## 3. Do not plan on the local network

The Windows box will often be on a different LAN from the agent's other machines. Windows 11 also randomises the Wi-Fi hardware address per network, so after a reboot the machine appears at a new address with a new MAC and an ARP sweep will not find it. Tailscale gives it a stable name and address; treat that as the only route.

## 4. Install WSL2 and Ubuntu

```powershell
wsl --install -d Ubuntu --no-launch
```

`--no-launch` avoids the interactive first-run user prompt. Then create the agent's user and turn on systemd:

```bash
wsl -d Ubuntu -u root -- bash -lc "
  useradd -m -s /bin/bash -G sudo echo &&
  echo 'echo ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/echo && chmod 440 /etc/sudoers.d/echo
  printf '[user]\ndefault=echo\n[boot]\nsystemd=true\n' > /etc/wsl.conf"
wsl --shutdown
```

systemd matters: it is what lets the agent's own service, and the desktop in §7, be managed rather than hand-started.

## 5. `networkingMode`: use NAT, not mirrored

Mirrored networking is tempting — WSL gets the host's Tailscale address directly, so you can SSH straight into Linux with no forwarding rule. **Do not use it.**

Under mirrored, a TCP connect to a **closed** local port does not return `ECONNREFUSED` — it hangs until timeout. Measured: 6+ seconds under mirrored, 0.1 seconds under NAT. Instar probes local ports constantly ("is my server up?"), so every such check burns its full timeout, and it silently broke an unrelated test hours after the setting was changed.

The obvious suspect is the Hyper-V VM firewall (`DefaultInboundAction: Block`). It is not: setting it to `Allow` and setting `firewall=false` both changed nothing. The networking mode itself is the cause.

A working `%USERPROFILE%\.wslconfig`:

```ini
[wsl2]
networkingMode=NAT
memory=12GB
processors=10
swap=8GB

[experimental]
autoMemoryReclaim=gradual
sparseVhd=true
```

## 6. Keeping WSL alive, and reaching it directly

### The VM shuts down when nobody is attached

WSL terminates the VM shortly after the last session detaches, and **`vmIdleTimeout` does not prevent it** — `-1` and a ten-year value were both tried and the VM still died within a minute. What works is holding a process open, from a Windows scheduled task registered with the **S4U** logon type:

```powershell
$act = New-ScheduledTaskAction -Execute 'C:\Windows\System32\wsl.exe' -Argument '-d Ubuntu -u root -e /usr/bin/sleep infinity'
$trg = New-ScheduledTaskTrigger -AtStartup
$pri = New-ScheduledTaskPrincipal -UserId "$env:COMPUTERNAME\$env:USERNAME" -LogonType S4U -RunLevel Highest
$set = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName 'WSL-Keepalive' -Action $act -Trigger $trg -Principal $pri -Settings $set
```

**S4U is the load-bearing detail.** It grants a logon token without a stored password, which is what makes the task run at boot with nobody logged in. `schtasks /RU <user>` without a password produces a task that only runs while that user is interactively logged on — useless on a headless machine.

### SSH straight into Linux

Run sshd inside WSL on a non-conflicting port (2222 — port 22 belongs to Windows), then forward to it from Windows.

**The trap:** point the forward at WSL's **live NAT address**, never at `127.0.0.1`. A `0.0.0.0` listener also claims `127.0.0.1`, so a proxy targeting loopback forwards to *itself*: connections are accepted and immediately dropped, and the client reports `Connection closed by … port 2222`. It may appear to work at first, if WSL happened to claim the loopback port before the proxy did — which makes it a fault that arrives at the next reboot rather than at setup.

WSL's NAT address changes every boot, so the rule has to be re-resolved. A script plus a scheduled task at startup and every five minutes:

```powershell
$wslIp = (wsl.exe -d Ubuntu -- hostname -I).Trim().Split(' ')[0]
netsh interface portproxy delete v4tov4 listenaddress=0.0.0.0 listenport=2222
netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=2222 connectaddress=$wslIp connectport=2222
```

### Enable lingering, or the agent will not start at boot

```bash
sudo loginctl enable-linger <user>
```

A systemd **user** service only runs while that user holds a login session. Without lingering, `instar autostart install` reports success, `systemctl --user is-enabled` says `enabled`, and the agent still never starts on a machine nobody logs into. Instar ≥ v1.3.1202 attempts this during `autostart install` and reports which of "starts at boot" or "starts at login only" is actually true; on older versions, run it yourself.

## 7. Browsers — what works, and the display problem

Browser automation inside WSL works: real page loads, screenshots, and a persistent profile whose sessions survive a restart (verified by writing a value, closing the browser, reopening from the same profile, and reading it back).

**WSLg — the built-in way to show Linux windows on the Windows desktop — may be broken.** On this machine its compositor segfaults roughly every 100 seconds (`/mnt/wslg/stderr.log`: `terminated with signal 11`), which presents as `Missing X server or $DISPLAY` even though `/tmp/.X11-unix/X0` exists. WSL was already fully up to date; a reboot did not clear it.

> **Sampling note.** A fault on a ~100-second cycle hands you a passing check whenever you happen to look. A single post-reboot `grep -c "signal 11"` returned 0 and a headed browser launch succeeded — both landed in a gap between crashes. Sample the count twice with a gap, or read timestamps, before concluding a periodic fault is fixed.

Two paths that do work:

- **`xvfb-run`** — a virtual screen. Headed browsers run correctly; nobody can watch.
- **A VNC desktop served over the tailnet** — the operator opens it in any browser, including a phone. Better than WSLg for a remote machine, because it does not require sitting at the box.

For the second, run `Xtigervnc` **directly** rather than through the `vncserver` wrapper. WSLg bind-mounts `/tmp/.X11-unix` read-only with mode 777 where X wants 1777, so the unix listener fails and the wrapper kills an otherwise-working server; `-listen tcp` sidesteps it and clients connect via `DISPLAY=127.0.0.1:1`. Run the X server, a window manager and `websockify` as systemd **user** services so they survive a restart, and forward the noVNC port from Windows the same way as §6.

## 8. Verify it is actually unattended

Reboot with nobody logged in and confirm recovery without touching the machine. The check that matters:

```powershell
(Get-CimInstance Win32_ComputerSystem).UserName   # empty means genuinely nobody logged in
```

Then confirm, in order: the tailnet address answers, Windows SSH answers, `wsl -l --running` lists the distro, SSH into WSL answers, `loginctl show-user <user> -p Linger` says `yes`, and the agent's own service is active.

Do this deliberately, early, while a human is still around. Every element of §1, §2 and §6 exists because something in it only fails at the next reboot — which otherwise happens at 3am.
