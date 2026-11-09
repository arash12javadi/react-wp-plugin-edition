export const VERSION_PATH: string;
/** The release version (no `v`) a `.rwp-version` text names, or '' when it is not a version. */
export function readVersionRecord(source: unknown): string;
/** The release this build or checkout records as installed, or ''. Never throws. */
export function loadVersionRecord(): Promise<string>;
