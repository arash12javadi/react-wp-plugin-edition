/**
 * Small, shared pieces of payment code: minor units, form encoding, canonical JSON, constant-time comparison, and the error
 * every gateway throws. Used by the built-in gateways and available to gateway plugins.
 */
import { timingSafeEqual } from 'node:crypto';

/** An error a route can answer with: `status` is the HTTP status, the message is safe to show the site owner. */
export class GatewayError extends Error {
  constructor(status, message, code = 'gateway') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// https://docs.stripe.com/currencies#zero-decimal (the same lists PayPal and most processors use)
const ZERO_DECIMAL = new Set(['BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF']);
const THREE_DECIMAL = new Set(['BHD', 'JOD', 'KWD', 'OMR', 'TND']);

/** How many decimals a currency has (2 unless it is a zero- or three-decimal currency). */
export const currencyExponent = (currency) => {
  const code = String(currency || '').toUpperCase();
  return ZERO_DECIMAL.has(code) ? 0 : THREE_DECIMAL.has(code) ? 3 : 2;
};

/** An amount in minor units (cents). Three-decimal currencies are rounded to a multiple of 10, as Stripe requires. */
export const toMinorUnits = (amount, currency) => {
  const exponent = currencyExponent(currency);
  const minor = Math.round(Number(amount) * 10 ** exponent);
  return exponent === 3 ? Math.round(minor / 10) * 10 : minor;
};

export const fromMinorUnits = (minor, currency) => Number(minor) / 10 ** currencyExponent(currency);

/** `a[b][c]=…` pairs for an application/x-www-form-urlencoded body (Stripe's style), arrays as `a[0]`. */
export const encodeForm = (value, prefix = '', pairs = []) => {
  if (value === undefined || value === null) return pairs;
  if (Array.isArray(value)) {
    value.forEach((inner, index) => encodeForm(inner, `${prefix}[${index}]`, pairs));
  } else if (typeof value === 'object') {
    Object.entries(value).forEach(([key, inner]) => encodeForm(inner, prefix ? `${prefix}[${key}]` : key, pairs));
  } else {
    pairs.push([prefix, String(value)]);
  }
  return pairs;
};

/** JSON with every object's keys sorted, at every depth (what NOWPayments signs). */
export const canonicalJson = (value) => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
};

/** Compares a hex signature with an expected digest (Buffer) in constant time. False for anything malformed. */
export const sameHex = (givenHex, expected) => {
  const text = String(givenHex || '');
  if (!/^[0-9a-f]+$/i.test(text)) return false;
  const given = Buffer.from(text, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
};

/** The raw body as text, whatever the host handed over (Buffer, Uint8Array or string). */
export const bodyText = (rawBody) => (typeof rawBody === 'string' ? rawBody : Buffer.from(rawBody || '').toString('utf8'));

/** A header, whatever its case. */
export const headerOf = (headers, name) => {
  const wanted = String(name).toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) {
    if (key.toLowerCase() === wanted) return Array.isArray(value) ? String(value[0] || '') : String(value || '');
  }
  return '';
};
