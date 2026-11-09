export const VERSION_PATH: string;
/** The release version (no `v`) a `.rwp-version` text names, or '' when it is not a version. */
export function readVersionRecord(source: unknown): string;
/** The release this build or checkout records as installed, or ''. Never throws. */
export function loadVersionRecord(): Promise<string>;
/** The release a package.json was stamped with by an update (its `rwpRelease` marker repeating `version`), or ''. */
export function readStamp(manifest: unknown): string;
/** The stamp of the package.json beside this code, or ''. Never throws. */
export function loadPackageStamp(): Promise<string>;
/** Records the stamped release as `.rwp-version` where the checkout is writable; never throws, never asks anyone. */
export function ensureVersionRecord(input?: { stamp?: string | null; env?: Record<string, string | undefined>; file?: string | null }): Promise<{ version: string; wrote: boolean }>;
