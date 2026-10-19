// Per-server settings, kept in a small JSON file so they survive restarts.
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'config.json');

let data = {};
try {
  data = JSON.parse(readFileSync(FILE, 'utf8'));
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
}

function save() {
  mkdirSync(dirname(FILE), { recursive: true });
  // Write to a temp file then rename, so a crash mid-write can't corrupt the config.
  const tmp = `${FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, FILE);
}

export function getGuild(guildId) {
  return data[guildId] ?? null;
}

export function setGuild(guildId, settings) {
  data[guildId] = { ...data[guildId], ...settings };
  save();
  return data[guildId];
}
