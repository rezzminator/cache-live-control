// Runs as a direct child of Claude Code: process.ppid is the reader's liveness identity.
import { mkdir, readdir, writeFile, rename, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
const [action, directory, sessionId, text] = process.argv.slice(2);
let temporary;
let path = `${directory}/${sessionId}.json`;
try {
  if (!directory || !isAbsolute(directory)) throw new Error('state directory must be absolute');
  if (!sessionId || !/^[a-zA-Z0-9_-]+$/.test(sessionId)) throw new Error('invalid session id');
  path = join(directory, sessionId + '.json');
  if (action === 'delete') {
    try { await unlink(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    // A writer killed mid-write (its run timeout, an abrupt exit) leaves its temporary behind; the session's end sweeps them.
    let names = [];
    try { names = await readdir(directory); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (const name of names.filter(name => name.startsWith(`.${sessionId}.`) && name.endsWith('.tmp'))) {
      try { await unlink(join(directory, name)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  } else if (action === 'write') {
    const value = JSON.parse(text);
    if (value.v !== 1 || value.sessionId !== sessionId) throw new Error('invalid state identity');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    temporary = join(directory, `.${sessionId}.${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify({ ...value, pid: process.ppid }) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
    temporary = undefined;
  } else throw new Error('invalid state operation');
} catch (error) {
  console.error(`keep-warm state ${path}: ${error.stack ?? String(error)}`);
  process.exitCode = 1;
} finally {
  if (temporary) {
    try { await unlink(temporary); }
    catch (error) { if (error.code !== 'ENOENT') { console.error(`keep-warm state ${temporary}: cleanup failed: ${error.stack ?? String(error)}`); process.exitCode = 1; } }
  }
}
