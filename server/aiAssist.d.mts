/**
 * Types for `server/aiAssist.mjs` — the core AI assistant the classic editor's ✨ button calls.
 *
 * The implementation is plain ESM so `server.mjs` and the bundled Hono app answer the very same paths
 * (see the header of the implementation). This declaration is what lets `src/server/aiAssist.ts` mount
 * the shared handler, and reuse its sentences, with real types.
 */
import type { IntegrationRuntimeConfig } from './integrationsRoutes';

/** The runtime config the shared reader needs — the same subset `integrationsRoutes` names, since both
 * read the one `system_settings` row. */
export type { IntegrationRuntimeConfig };

/** The one path this module answers. */
export const AI_ASSIST_PATH: string;
/** Writing a draft is not administering the site, so the capability is the author's. */
export const ASSIST_CAPABILITY: string;
/** What an author can ask for: task key → the instruction the model is given. */
export const ASSIST_TASKS: Record<string, string>;
/** The tones `task: 'tone'` accepts. */
export const ASSIST_TONES: Record<string, string>;

/** The sentences a refusal carries, so both hosts refuse in the same words. */
export const assistAuthMessages: {
  signedOut: string;
  notInstalled: string;
  invalidSession: string;
  capabilityFailure: (capability: string) => string;
  unreachable: (detail: string) => string;
};

export function ownsAiAssistPath(pathname: string): boolean;

export interface AssistRequestOptions {
  method: string;
  pathname: string;
  headers?: Record<string, string | undefined>;
  body?: Record<string, unknown>;
  config?: IntegrationRuntimeConfig;
  env?: Record<string, string | undefined>;
  /** A reader backed by the engine's own database adapter, where it has one. */
  readSetting?: (key: string) => Promise<unknown>;
  /**
   * Checks the caller may spend the site's AI key on this request. Takes the capability because the
   * shared module owns which one it needs (`ASSIST_CAPABILITY`), not the host.
   */
  authorize?: (
    token: string,
    capability: string,
  ) => Promise<{ ok: boolean; status?: number; error?: string }>;
}

/** The status read (GET) and the one generation (POST); `null` when the verb is not ours. */
export function handleAiAssistRequest(
  options: AssistRequestOptions,
): Promise<{ status: number; body?: Record<string, unknown> } | null>;

/** The pieces the module keeps to itself, spelled out for an ad-hoc check in a Node one-liner. */
export const _internal: {
  validateRequest: (body?: Record<string, unknown>) => unknown;
  validateResponse: (parsed: unknown) => { html: string; summary: string; removed: string[] };
  buildInstructions: (request: {
    task: string;
    tone: string;
    instruction: string;
  }) => string;
  sanitizeAssistantHtml: (raw: string) => { html: string; removed: string[] };
  asBlocks: (html: string) => string;
};
