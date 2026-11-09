/**
 * The one rule for writing `system_settings.updates_config`, in plain JS so the browser screen and a plain
 * `node --test` can share it.
 *
 * Older versions stored an update-server address, a bearer token and a release channel in this row. Nothing
 * reads them any more (updates come straight from GitHub, and releases are always stable ones), so every
 * save removes them: a token must not outlive the screen that used it.
 */

/** Row keys that nothing reads any more and that every save drops. */
export const LEGACY_UPDATE_CONFIG_KEYS = ['token', 'central_url', 'channel'];

/**
 * The row to store after a save: what was stored, with `patch` applied and the legacy keys gone.
 *
 * @param {unknown} stored the row as read
 * @param {Record<string, unknown>} patch the settings being saved
 * @returns {Record<string, unknown>}
 */
export const nextUpdateConfigRow = (stored, patch) => {
  const next = { ...(stored && typeof stored === 'object' ? stored : {}), ...patch };
  LEGACY_UPDATE_CONFIG_KEYS.forEach((key) => { delete next[key]; });
  return next;
};
