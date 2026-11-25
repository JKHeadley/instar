// Load the worktree's binding directly so ancestor dependencies cannot mask a missing install.
const path = require('node:path');
try {
  const Database = require(path.resolve('node_modules/better-sqlite3'));
  new Database(':memory:').close();
} catch (error) {
  console.error(`Worktree SQLite check failed with Node ${process.version} (ABI ${process.versions.modules}) at ${process.execPath}: ${error.message}`);
  process.exitCode = 1;
}
