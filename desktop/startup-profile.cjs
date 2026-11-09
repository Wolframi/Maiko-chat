const fs = require('node:fs');

// Opt in from the profiling launcher; ordinary starts do no profiling I/O.
const filename = process.env.MAIKO_DESKTOP_PROFILE;
let writes = Promise.resolve();
function mark(event, detail = {}) {
  if (!filename) return;
  const entry = { event, at: Date.now(), processMs: process.uptime() * 1000, ...detail };
  writes = writes.then(() => fs.promises.appendFile(filename, JSON.stringify(entry) + '\n')).catch(() => {});
}
module.exports = { mark, flush: () => writes };
