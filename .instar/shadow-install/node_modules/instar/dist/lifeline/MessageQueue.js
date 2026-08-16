/**
 * Message Queue — buffers Telegram messages when the server is down.
 *
 * Messages are persisted to disk so they survive lifeline restarts.
 * When the server comes back, queued messages are replayed in order.
 */
import fs from 'node:fs';
import path from 'node:path';
export class MessageQueue {
    queuePath;
    queue = [];
    constructor(stateDir) {
        this.queuePath = path.join(stateDir, 'lifeline-queue.json');
        this.load();
    }
    /**
     * Add a message to the queue.
     */
    enqueue(msg) {
        this.queue.push(msg);
        this.save();
    }
    /**
     * Get all queued messages and clear the queue.
     */
    drain() {
        const messages = [...this.queue];
        this.queue = [];
        this.save();
        return messages;
    }
    /**
     * Peek at the queue without draining.
     */
    peek() {
        return [...this.queue];
    }
    get length() {
        return this.queue.length;
    }
    load() {
        try {
            if (fs.existsSync(this.queuePath)) {
                const data = JSON.parse(fs.readFileSync(this.queuePath, 'utf-8'));
                this.queue = Array.isArray(data) ? data : [];
            }
        }
        catch {
            this.queue = [];
        }
    }
    save() {
        try {
            const tmpPath = `${this.queuePath}.${process.pid}.tmp`;
            fs.writeFileSync(tmpPath, JSON.stringify(this.queue, null, 2));
            fs.renameSync(tmpPath, this.queuePath);
        }
        catch (err) {
            console.error(`[MessageQueue] Failed to save: ${err}`);
        }
    }
}
//# sourceMappingURL=MessageQueue.js.map