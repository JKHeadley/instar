import fs from 'node:fs';
import assert from 'node:assert/strict';
// This deliberately unreliable test assumes its neighbour ran in this process.
assert.equal(fs.readFileSync(process.env.FIRST_PART_NEIGHBOUR_FILE, 'utf8'), String(process.pid));
