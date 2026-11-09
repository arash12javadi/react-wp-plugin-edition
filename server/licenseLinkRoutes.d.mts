export function ownsLicenseLinkPath(pathname: string): boolean;

export function handleLicenseLinkRequest(options: {
  method: string;
  pathname: string;
  headers?: Record<string, string | undefined>;
  body?: Record<string, unknown>;
  config?: Record<string, unknown>;
  siteUrl?: string;
  env?: Record<string, string | undefined>;
  authorize: (token: string) => Promise<{ ok: boolean; status?: number; error?: string }>;
  fetchImpl?: typeof fetch;
}): Promise<{ status: number; body: Record<string, unknown> } | null>;
