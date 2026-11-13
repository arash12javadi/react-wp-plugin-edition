/**
 * WordPress's WP_Error, as RWP_Error, with the same method names (snake_case) so ported code reads
 * the same. Functions that can fail return one instead of throwing, exactly as in WordPress:
 *
 *   const result = await rwp_insert_post({ ... }, true);
 *   if (rwp_is_wp_error(result)) console.error(result.get_error_message());
 */
import { doAction } from '../../core/hooks';

type ErrorData = unknown;

export class RWP_Error {
  errors: Record<string, string[]> = {};

  error_data: Record<string, ErrorData> = {};

  private additional_data: Record<string, ErrorData[]> = {};

  constructor(code: string | number = '', message = '', data: ErrorData = '') {
    if (code === '' || code === undefined) return;
    this.add(code, message, data);
  }

  get_error_codes(): string[] {
    return Object.keys(this.errors);
  }

  get_error_code(): string | number {
    return this.get_error_codes()[0] ?? '';
  }

  get_error_messages(code: string | number = ''): string[] {
    if (code === '') return Object.values(this.errors).flat();
    return this.errors[String(code)] ?? [];
  }

  get_error_message(code: string | number = ''): string {
    const key = code === '' ? this.get_error_code() : code;
    return this.get_error_messages(key)[0] ?? '';
  }

  get_error_data(code: string | number = ''): ErrorData {
    const key = String(code === '' ? this.get_error_code() : code);
    return this.error_data[key];
  }

  has_errors(): boolean {
    return this.get_error_codes().length > 0;
  }

  add(code: string | number, message: string, data: ErrorData = ''): void {
    const key = String(code);
    (this.errors[key] ||= []).push(message);
    if (data !== '' && data !== undefined) {
      this.add_data(data, key);
    }
    doAction('rwp_error_added', key, message, data, this);
  }

  add_data(data: ErrorData, code: string | number = ''): void {
    const key = String(code === '' ? this.get_error_code() : code);
    if (key in this.error_data) (this.additional_data[key] ||= []).push(this.error_data[key]);
    this.error_data[key] = data;
  }

  remove(code: string | number): void {
    const key = String(code);
    delete this.errors[key];
    delete this.error_data[key];
    delete this.additional_data[key];
  }

  /** Copies every error of `error` into this one. */
  merge_from(error: RWP_Error): void {
    for (const code of error.get_error_codes()) {
      for (const message of error.get_error_messages(code)) this.add(code, message);
      const data = error.get_error_data(code);
      if (data !== undefined) this.add_data(data, code);
    }
  }
}

/** Whether a value is an RWP_Error. */
export function rwp_is_wp_error(thing: unknown): thing is RWP_Error {
  return thing instanceof RWP_Error;
}
