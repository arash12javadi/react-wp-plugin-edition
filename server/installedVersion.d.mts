/** Which release this host runs: the `.rwp-version` record, the build's stamped package.json, the owner-only pin, the installer's record, then the unstamped package.json. */
export function installedVersionFor(input?: { saas?: string; fallback?: string; manifest?: object | null; env?: Record<string, string | undefined> }): Promise<string>;
