export const SEALED_PREFIX: string;
export const SEALED_ROW_SECRETS: Readonly<Record<string, readonly string[]>>;
export function isSealedRowKey(key: unknown): boolean;
export function isSealedValue(value: unknown): boolean;
export class SealedRowError extends Error {
  status: number;
  constructor(status: number, message: string);
}
export function plaintextSecrets(key: string, value: unknown): string[];
export function sealRow<T = Record<string, unknown>>(key: string, value: unknown, env?: Record<string, string | undefined>): T;
export function openRow<T = unknown>(key: string, value: T, env?: Record<string, string | undefined>): T;
