/**
 * `instar user add|list` — Manage user profiles.
 */
import pc from 'picocolors';
import { loadConfig, ensureStateDir } from '../core/Config.js';
import { UserManager } from '../users/UserManager.js';
export async function addUser(options) {
    const config = loadConfig();
    ensureStateDir(config.stateDir);
    const userManager = new UserManager(config.stateDir);
    const channels = [];
    if (options.telegram) {
        channels.push({ type: 'telegram', identifier: options.telegram });
    }
    if (options.email) {
        channels.push({ type: 'email', identifier: options.email });
    }
    if (options.slack) {
        channels.push({ type: 'slack', identifier: options.slack });
    }
    const profile = {
        id: options.id,
        name: options.name,
        channels,
        permissions: options.permissions || ['user'],
        preferences: {},
    };
    userManager.upsertUser(profile);
    console.log(pc.green(`User "${options.name}" (${options.id}) added.`));
    if (channels.length > 0) {
        console.log(`  Channels: ${channels.map(c => `${c.type}:${c.identifier}`).join(', ')}`);
    }
    console.log(`  Permissions: ${profile.permissions.join(', ')}`);
}
export async function listUsers(_options) {
    const config = loadConfig();
    const userManager = new UserManager(config.stateDir);
    const users = userManager.listUsers();
    if (users.length === 0) {
        console.log(pc.dim('No users configured.'));
        console.log(`Add one: ${pc.cyan('instar user add --id justin --name Justin')}`);
        return;
    }
    console.log(pc.bold(`Users (${users.length}):\n`));
    for (const user of users) {
        console.log(`  ${pc.bold(user.name)} (${pc.dim(user.id)})`);
        if (user.channels.length > 0) {
            console.log(`    Channels: ${user.channels.map(c => `${c.type}:${c.identifier}`).join(', ')}`);
        }
        console.log(`    Permissions: ${user.permissions.join(', ')}`);
    }
}
//# sourceMappingURL=user.js.map