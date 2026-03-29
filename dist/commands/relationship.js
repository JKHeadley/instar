/**
 * `instar relationship list|import|export` — Manage relationship records.
 *
 * PROP-166: Unified Identity Bridge — Portal People-Registry + Instar RelationshipManager
 */
import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import { loadConfig, ensureStateDir } from '../core/Config.js';
import { RelationshipManager } from '../core/RelationshipManager.js';
function getRelationshipsManager() {
    const config = loadConfig();
    ensureStateDir(config.stateDir);
    const relConfig = config.relationships;
    if (!relConfig) {
        console.log(pc.yellow('Relationships not configured.'));
        console.log('Add to .instar/config.json:');
        console.log(pc.dim('  "relationships": { "relationshipsDir": ".instar/relationships", "maxRecentInteractions": 50 }'));
        return null;
    }
    return new RelationshipManager(relConfig);
}
export async function listRelationships(options) {
    const manager = getRelationshipsManager();
    if (!manager)
        return;
    const sortBy = (['significance', 'recent', 'name'].includes(options.sort || '')
        ? options.sort
        : 'significance');
    const all = manager.getAll(sortBy);
    if (all.length === 0) {
        console.log(pc.dim('No relationships tracked yet.'));
        return;
    }
    console.log(pc.bold(`\nRelationships (${all.length}):\n`));
    for (const r of all) {
        const channels = r.channels.map(c => `${c.type}:${c.identifier}`).join(', ');
        const sig = '★'.repeat(Math.min(5, Math.round(r.significance / 2))) +
            '☆'.repeat(Math.max(0, 5 - Math.round(r.significance / 2)));
        console.log(`  ${pc.bold(r.name)} ${pc.dim(`(${r.significance}/10)`)} ${sig}`);
        console.log(`    Channels: ${pc.dim(channels)}`);
        console.log(`    Interactions: ${r.interactionCount}  Themes: ${r.themes.slice(0, 3).join(', ') || 'none'}`);
        console.log(`    First: ${r.firstInteraction.slice(0, 10)}  Last: ${r.lastInteraction.slice(0, 10)}`);
        console.log();
    }
}
export async function importRelationships(options) {
    const manager = getRelationshipsManager();
    if (!manager)
        return;
    const filePath = path.resolve(options.file);
    if (!fs.existsSync(filePath)) {
        console.log(pc.red(`File not found: ${filePath}`));
        process.exit(1);
    }
    let records;
    try {
        records = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    }
    catch (err) {
        console.log(pc.red(`Failed to parse ${filePath}: ${err}`));
        process.exit(1);
    }
    if (!Array.isArray(records)) {
        console.log(pc.red('Expected a JSON array of relationship records'));
        process.exit(1);
    }
    let created = 0;
    let updated = 0;
    let skipped = 0;
    for (const rec of records) {
        const name = rec.name;
        const channels = (rec.channels || []);
        if (!name || !channels.length) {
            skipped++;
            continue;
        }
        // Try to resolve by any channel
        let existing = null;
        for (const channel of channels) {
            existing = manager.resolveByChannel(channel);
            if (existing)
                break;
        }
        if (options.dryRun) {
            console.log(`  ${existing ? 'UPDATE' : 'CREATE'} ${name} (${channels.map(c => `${c.type}:${c.identifier}`).join(', ')})`);
            if (existing)
                updated++;
            else
                created++;
            continue;
        }
        if (existing) {
            // Update: link any new channels, update notes if richer
            for (const channel of channels) {
                manager.linkChannel(existing.id, channel);
            }
            const importNotes = rec.notes;
            if (importNotes && importNotes.length > (existing.notes || '').length) {
                manager.updateNotes(existing.id, importNotes);
            }
            updated++;
        }
        else {
            // Create: use first channel to create, then link the rest
            const record = manager.findOrCreate(name, channels[0]);
            for (let i = 1; i < channels.length; i++) {
                manager.linkChannel(record.id, channels[i]);
            }
            // Set notes
            if (rec.notes) {
                manager.updateNotes(record.id, rec.notes);
            }
            // Import themes via interaction recording
            const themes = (rec.themes || []);
            if (themes.length > 0) {
                manager.recordInteraction(record.id, {
                    timestamp: new Date().toISOString(),
                    channel: channels[0].type,
                    summary: `Imported from Portal people-registry with ${themes.length} themes`,
                    topics: themes,
                });
            }
            created++;
        }
    }
    if (options.dryRun) {
        console.log(pc.yellow(`\n  DRY RUN — no changes made`));
    }
    console.log(`\n${pc.green('Import complete:')}`);
    console.log(`  Created: ${pc.bold(String(created))}`);
    console.log(`  Updated: ${pc.bold(String(updated))}`);
    console.log(`  Skipped: ${pc.dim(String(skipped))}`);
}
export async function exportRelationships(options) {
    const manager = getRelationshipsManager();
    if (!manager)
        return;
    const minSig = parseFloat(options.minSignificance || '0');
    const all = manager.getAll('significance').filter(r => r.significance >= minSig);
    if (all.length === 0) {
        console.log(pc.dim('No relationships to export.'));
        return;
    }
    const output = JSON.stringify(all, null, 2);
    if (options.file) {
        const filePath = path.resolve(options.file);
        fs.writeFileSync(filePath, output);
        console.log(pc.green(`Exported ${all.length} relationships to ${filePath}`));
        console.log(pc.dim(`  To import in Portal: python3 .claude/scripts/update-people-registry.py --import-from-instar ${filePath}`));
    }
    else {
        console.log(output);
    }
}
//# sourceMappingURL=relationship.js.map