import fs from 'node:fs';
// This deliberately unreliable test leaves a process-owned resource for its neighbour.
fs.writeFileSync(process.env.FIRST_PART_NEIGHBOUR_FILE, String(process.pid));
