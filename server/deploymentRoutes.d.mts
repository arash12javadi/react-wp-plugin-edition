/** Types for `server/deploymentRoutes.mjs` — the GitHub & Vercel routes shared by both engines. */

export function ownsDeploymentPath(pathname: string): boolean;

export function handleDeploymentRequest(options: {
  method: string;
  pathname: string;
  query?: Record<string, string>;
  headers: Record<string, string | undefined>;
  body?: Record<string, unknown>;
  config: Record<string, unknown>;
  siteConfig?: Record<string, unknown>;
  env?: Record<string, string | undefined>;
  authorize: (token: string) => Promise<{ ok: boolean; status?: number; error?: string }>;
  installedVersion?: () => Promise<string>;
  fetchImpl?: typeof fetch;
}): Promise<{ status: number; body: Record<string, unknown> } | null>;
