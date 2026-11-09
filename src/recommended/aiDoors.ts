/**
 * What the second-AI-subscription recipe needs (docs/specs/recommended-services.md, catalog row
 * second-ai-door; install-experience.md section 5, AI doors): which doors this agent has switched on,
 * which are signed in on this machine, and a way to switch one on or off for this agent only.
 *
 * A door's sign-in lives in the machine user's home, shared by every agent that user runs, so this module
 * never signs a door in or out. Signing in is the person's own tap, which the setup session arranges;
 * switching a door on or off here changes only this agent's `enabledFrameworks`.
 */
import type { InstallDoor } from '../commands/setup-wizard/state-machine.js';
import type { SignedInVerdict } from '../install/doors.js';

export const AI_DOORS: readonly InstallDoor[] = ['claude-code', 'codex-cli'];

export const DOOR_NAMES: Record<InstallDoor, string> = { 'claude-code': 'Claude', 'codex-cli': 'Codex (ChatGPT)' };

export interface AiDoorSurface {
  /** This agent's switched-on frameworks, in order; the first is its main one. */
  enabled(): string[];
  /** Whether the door's program is installed on this machine. */
  installed(door: InstallDoor): boolean;
  /** One live, read-only, free call (install-experience.md section 5). */
  signedIn(door: InstallDoor): Promise<SignedInVerdict>;
  /**
   * Lists the door in this agent's settings, after the main one. True only when this call added it (and it is
   * remembered as setup's); false when the agent lists no providers (all allowed) or already lists it.
   */
  enable(door: InstallDoor): boolean;
  /** Takes the door back out of this agent's settings, only if setup added it. True when it did. Never the main door. */
  disable(door: InstallDoor): boolean;
}

/** The agent's main door: its first switched-on framework, or Claude when none is listed (the default shape). */
export function mainDoor(enabled: readonly string[]): InstallDoor {
  const first = enabled[0];
  return first === 'codex-cli' ? 'codex-cli' : 'claude-code';
}

/** The doors that could be this agent's second one: every known door except the main one. */
export function secondDoorCandidates(enabled: readonly string[]): InstallDoor[] {
  const main = mainDoor(enabled);
  return AI_DOORS.filter((d) => d !== main);
}

/** A new enabled list with the door added after the main one, or null when nothing changes (no list means every provider is allowed). */
export function withDoor(enabled: readonly string[], door: InstallDoor): string[] | null {
  if (!enabled.length || enabled.includes(door)) return null;
  return [...enabled, door];
}

/** A new enabled list without the door. The main door is never removed. */
export function withoutDoor(enabled: readonly string[], door: InstallDoor): string[] {
  if (mainDoor(enabled) === door) return [...enabled];
  return enabled.filter((d) => d !== door);
}
