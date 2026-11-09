/** Which release this host runs: the `.rwp-version` record, the deploy pin, the installer's record, then package.json. */
export function installedVersionFor(input?: { saas?: string; fallback?: string; env?: Record<string, string | undefined> }): Promise<string>;
