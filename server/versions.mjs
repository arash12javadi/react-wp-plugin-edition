/**
 * Version ordering, in one place because two modules need it and neither may own the other.
 *
 * `server/updateCenter.mjs` compares what this site runs against a release, and
 * `server/githubReleases.mjs` picks the newest tag out of a release list. Those two files import each
 * other's neighbours (`updateCenter` → `githubReleases` for a direct check), so the comparison itself
 * lives here: a copy of "is `2.10.0` newer than `2.9.9`" is exactly the kind of duplication that ends
 * with one screen offering a downgrade.
 *
 * The rules, and why each one is written the way it is:
 *
 *   - Version segments are compared **numerically**, so `1.10.0` sorts above `1.9.0`. String order
 *     would put `1.10.0` first, which is a downgrade wearing a newer number.
 *   - A **pre-release sorts below** its own release: `2.0.0-rc.1` is older than `2.0.0`, because the
 *     release ships after the candidate.
 *   - `isVersion` is the gate in front of both: `nightly`, `latest` and a `package.json`'s missing
 *     field are refused rather than parsed into `0.0.0`.
 *
 * Plain ESM with no `node:` imports, like `server/updateCenter.mjs` and `server/githubReleases.mjs`:
 * the same file is bundled into the Vercel function by `vite.api.config.mjs` and imported directly by
 * `server.mjs`.
 */

const trimmed = (value) => (typeof value === 'string' ? value.trim() : '');

/**
 * A version as `[major, minor, patch, build]` plus its pre-release tag.
 *
 * Kept identical to `compareVersions` in `src/lib/updates.ts`: the server decides whether an update
 * exists and the browser writes the badge, and a disagreement between the two would show "up to date"
 * next to an Update Now button.
 *
 * @param {unknown} value
 * @returns {{ parts: number[], pre: string }}
 */
export const parseVersion = (value) => {
  const [core, pre = ''] = String(value ?? '').trim().replace(/^v/i, '').split('-', 2);
  return { parts: core.split('.').map((part) => Number.parseInt(part, 10) || 0), pre };
};

/**
 * `-1`, `0` or `1`, as a sort comparator.
 *
 * @param {unknown} a
 * @param {unknown} b
 */
export const compareVersions = (a, b) => {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (let index = 0; index < Math.max(left.parts.length, right.parts.length); index += 1) {
    const difference = (left.parts[index] || 0) - (right.parts[index] || 0);
    if (difference !== 0) return Math.sign(difference);
  }
  if (left.pre === right.pre) return 0;
  // No tag outranks any tag: 2.0.0 ships after 2.0.0-rc.1.
  if (!left.pre) return 1;
  if (!right.pre) return -1;
  return left.pre < right.pre ? -1 : 1;
};

/** True for something `compareVersions` can sort. */
export const isVersion = (value) => /^\d+(?:\.\d+){0,3}(?:[-+][0-9A-Za-z.-]+)?$/.test(trimmed(value));
