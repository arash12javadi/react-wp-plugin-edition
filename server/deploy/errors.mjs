/**
 * The one error type the deploy engine throws, and the one property every surface already reads.
 *
 * The engine (`server/deploy/*`) is shared by the SaaS installer, the customer-side plugin jobs and the
 * standalone build worker, so it cannot import `HttpError` from any one of them: a plugin's error class
 * would make the engine unusable outside that plugin, which is the boundary `.clinerules` draws. What
 * the engine needs from an error is exactly one thing — a status a route can return — and that is what
 * `DeployError` carries.
 *
 * Every caller already answers with `Number(error?.status) || 500` (`plugins/rwp-saas-installer/server.mjs`,
 * the plugin routes in `src/server/routes/plugins.ts`), so a `DeployError` needs no translation layer: its
 * `status` and `message` are already what a screen shows. An installer `HttpError` remains a distinct
 * class, because a plugin's own mistakes and the engine's upstream failures are different facts, but both
 * are answered the same way.
 */

/** The status a caught error should be answered with, and the sentence to answer it with. */
export const errorStatus = (error, fallback = 500) => {
  const status = Number(error?.status);
  return Number.isFinite(status) && status >= 400 && status <= 599 ? status : fallback;
};

export class DeployError extends Error {
  /**
   * @param {number} status An HTTP status the caller can return as-is.
   * @param {string} message The sentence a screen shows. Never a stack, never a secret.
   * @param {{ code?: string, details?: Record<string, unknown>, cause?: unknown }} [extra]
   *   `code` is the machine-readable reason (`deployment_failed`, `token_invalid`, …) a job row stores
   *   beside the message, so an operator can group failures without parsing prose.
   */
  constructor(status, message, { code = '', details = null, cause } = {}) {
    super(String(message || 'The deployment failed.'));
    this.name = 'DeployError';
    this.status = errorStatus({ status }, 500);
    this.code = String(code || '');
    this.details = details && typeof details === 'object' ? details : null;
    if (cause !== undefined) this.cause = cause;
  }
}

/** Wraps anything thrown into a `DeployError`, so a caller has one shape to read. */
export const asDeployError = (error, fallbackStatus = 502) => {
  if (error instanceof DeployError) return error;
  return new DeployError(
    errorStatus(error, fallbackStatus),
    error instanceof Error ? error.message : String(error || 'The deployment failed.'),
    { cause: error },
  );
};
