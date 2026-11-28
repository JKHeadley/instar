import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  isProjectAnchorSourceMessage,
  readVerifiedProjectAnchorSource,
  type ProjectAnchorHistoryReader,
  type ProjectAnchorSourceMessage,
  type VerifiedProjectPurposeProposal,
} from './ProjectAnchorRegistry.js';

interface PurposeDesignation {
  projectId: string;
  conversationKey: string;
  source: ProjectAnchorSourceMessage;
  purposeSha256: string;
}

// A release can pin the one Studio grant after operator authorization of the
// exact disclosure. A local file alone cannot activate production proposals.
const STUDIO_PILOT_GRANT: string | undefined = undefined;

export function projectPurposeDesignationDigest(machineId: string, ownerId: number, item: PurposeDesignation): string {
  return createHash('sha256').update(JSON.stringify([
    machineId, ownerId, item.projectId, item.conversationKey, item.source.conversationKey,
    item.source.messageId, item.source.at, item.purposeSha256,
  ])).digest('hex');
}

function readDesignation(file: string): PurposeDesignation | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || !process.getuid || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) return null;
    const buffer = Buffer.alloc(2049);
    const size = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (size > 2048) return null;
    const item = JSON.parse(buffer.toString('utf8', 0, size)) as Partial<PurposeDesignation> | null;
    if (!item || typeof item.projectId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(item.projectId) ||
      typeof item.conversationKey !== 'string' || !/^telegram:[1-9]\d{0,14}$/.test(item.conversationKey) ||
      typeof item.purposeSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.purposeSha256) ||
      !isProjectAnchorSourceMessage(item.source) || new Date(item.source.at).toISOString() !== item.source.at) return null;
    return { projectId: item.projectId, conversationKey: item.conversationKey, source: item.source, purposeSha256: item.purposeSha256 };
  } catch {
    return null; // @silent-fallback-ok — the local pilot is optional and normal recovery remains available.
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function pilotGrantRetired(file: string): boolean {
  try {
    fs.lstatSync(file);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

/** A single local operator-designated proposal. The file supplies coordinates and a digest, never wording. */
export function createProjectPurposePilotReader(
  stateDir: string,
  history: ProjectAnchorHistoryReader | undefined,
  machineId: string | undefined,
  allowedDesignationDigest: string | undefined = STUDIO_PILOT_GRANT,
) {
  if (!allowedDesignationDigest || !machineId) return () => null;
  const file = path.join(stateDir, 'state', 'project-purpose-pilot.json');
  const retired = path.join(stateDir, 'state', 'project-purpose-pilot.retired');
  if (pilotGrantRetired(retired)) return () => null;
  const designation = readDesignation(file);
  const owner = history?.getVerifiedOwner();
  if (!designation || owner === undefined ||
    projectPurposeDesignationDigest(machineId, owner, designation) !== allowedDesignationDigest) return () => null;
  const purpose = readVerifiedProjectAnchorSource(history, designation.source);
  if (!purpose?.trim() || createHash('sha256').update(purpose).digest('hex') !== designation.purposeSha256) return () => null;

  return (project: { id: string }, conversationKey: string): VerifiedProjectPurposeProposal | null => {
    if (designation.projectId !== project.id || designation.conversationKey !== conversationKey ||
      history?.getVerifiedOwner() !== owner || pilotGrantRetired(retired)) return null;
    const item = readDesignation(file);
    if (!item || projectPurposeDesignationDigest(machineId, owner, item) !== allowedDesignationDigest) return null;
    return { projectId: designation.projectId, conversationKey: designation.conversationKey, source: designation.source, purpose };
  };
}
