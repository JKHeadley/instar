# Mesh Self-Heal Graduation — ELI16 Overview

## What's the problem?

Imagine you have two machines: Laptop and Mini. Laptop crashes. Your Telegram notifications go unanswered. But wait — Mini is right there! Why isn't it picking up the work?

The answer: Laptop is still holding the lease (the "you're in charge" badge), and Mini doesn't want to step on Laptop's toes by taking over conversations. So your stuff just sits there until Laptop comes back. That could be minutes. That could be hours.

Also, when Laptop *does* come back and is healthy, Mini never hands back the conversations it picked up. So now both machines think they're in charge of different conversations, and you get weird bouncing and duplication.

This is the opposite of seamless.

## What does this fix?

This spec makes the agent **self-healing**. When one machine goes dark, the other **automatically takes over** and serves your conversations. When the dark machine comes back, **automatically hands back** the conversations it picked up. All without you doing anything.

It's like having two office desks: if one is broken, your coworker covers for you without asking. When your desk is fixed, they hand your work back.

## How does it work?

There are two pieces:

**Piece 1: Stale-Owner Release.** If Laptop is the "leader" but hasn't checked in for 5 minutes, and all attempts to reach it fail, Mini says: "I'm going to assume Laptop is genuinely dead and take over." But it's smart — it checks multiple ways to reach Laptop (network, backup network, etc.) before deciding it's gone.

**Piece 2: Lease Hand-Back.** Once Laptop is back and healthy (checked in at least twice, reachable on multiple networks), Mini says: "Welcome back, Laptop. Here's the work I covered for you." And hands back the conversations.

## What does the user experience?

**Before:** Machine dies → all your conversations go silent → you notice after a while and have to manually move them. Machine recovers → conversations are scattered, bouncing between machines.

**After:** Machine dies → conversations automatically move to the healthy machine → you keep working without interruption. Machine recovers → conversations automatically hand back → everything is where it should be.

Zero downtime. Zero manual intervention. The agent just handles it.

## Why does this matter?

Goal B is "the agent spans multiple machines seamlessly." But seamless means **no single point of failure**. If Laptop dies, your work shouldn't die with it. And if Laptop comes back, the agent should clean up automatically, not leave a mess for you to untangle.

This is infrastructure-level reliability. It's what makes multi-machine feel like one machine.
