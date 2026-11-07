/**
 * A tiny best-effort JSON file under `data/` for the two things a licence check keeps between restarts:
 * the last verified revocation list and the last good licence verdict (the grace cache).
 *
 * Best effort on purpose. A host with a read-only filesystem (Vercel) simply has no persistence, and every
 * caller already works from memory first; a write or read that fails is swallowed, because a licence file
 * that cannot be written must never take a plugin route down. Nothing stored here is a secret: a licence
 * key is already in the `options` table, and a revocation list is public.
 *
 * `RWP_DATA_DIR` moves the folder (the same directory `data/react-wp-config.json` lives in by default).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const dataDir = () => path.resolve(process.env.RWP_DATA_DIR || path.join(process.cwd(), 'data'));

/** The parsed file, or `null` when it is missing, unreadable or not JSON. */
export const readJsonState = (name) => {
  try {
    return JSON.parse(readFileSync(path.join(dataDir(), name), 'utf8'));
  } catch {
    return null;
  }
};

/** Writes the file; returns whether it landed. */
export const writeJsonState = (name, value) => {
  try {
    mkdirSync(dataDir(), { recursive: true });
    writeFileSync(path.join(dataDir(), name), JSON.stringify(value), 'utf8');
    return true;
  } catch {
    return false;
  }
};
