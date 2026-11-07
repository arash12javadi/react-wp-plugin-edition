/**
 * The cryptography shared by plugin licences (`server/pluginLicense.mjs`) and the signed revocation list
 * (`server/licenseRevocations.mjs`): Ed25519 over `node:crypto`, and the Crockford base32 a signature is
 * written in.
 *
 * **Who holds what.** The PRIVATE key exists only on the deployment that sells licences (react-wp.com),
 * as `PLUGIN_LICENSE_PRIVATE_KEY`; nothing in this repository, in a client's repository or in a browser
 * bundle contains it. The PUBLIC key ships with every site (`PLUGIN_LICENSE_PUBLIC_KEY` below, or the
 * `PLUGIN_LICENSE_PUBLIC_KEY` environment variable on a deployment that must trust another vendor), so a
 * site can verify a key and can never mint one.
 *
 * Both keys are base64 DER (SPKI for the public one, PKCS#8 for the private one) so each is one line that
 * survives an environment-variable field. Generate a pair with `node server/pluginLicense.mjs keygen`.
 *
 * Plain ESM with nothing but `node:crypto`, so it runs under `npm start`, on Vercel and in a test.
 */
import {
  createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign as edSign, verify as edVerify,
} from 'node:crypto';

/**
 * The vendor's public key, base64 SPKI DER. EMPTY until the owner pastes the public half of the pair
 * `keygen` printed: with no key here (and none in `PLUGIN_LICENSE_PUBLIC_KEY`) no licence verifies and the
 * sold plugins stay locked, which is the safe direction. The value is not a secret; it is meant to be
 * committed.
 */
export const BUILT_IN_PUBLIC_KEY = 'MCowBQYDK2VwAyEAZ79db97A/I+yXzXeKkGFfci15dt824tqr7zPOQO6HFg=';

export const PLUGIN_LICENSE_PUBLIC_KEY_ENV = 'PLUGIN_LICENSE_PUBLIC_KEY';
export const PLUGIN_LICENSE_PRIVATE_KEY_ENV = 'PLUGIN_LICENSE_PRIVATE_KEY';

/** Crockford base32: no I, L, O or U, so a signature cannot be misread as a word. */
export const BASE32_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const str = (value) => (typeof value === 'string' ? value.trim() : '');

/** `buffer` in Crockford base32, padded with zero bits to a whole character. */
export const base32Encode = (buffer) => {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buffer) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
};

/**
 * The bytes a base32 string stands for, or `null` when it is not canonical: a character outside the
 * alphabet, a length that does not fit `byteLength`, or non-zero padding bits. Refusing the padding is what
 * keeps one signature from having several spellings.
 */
export const base32Decode = (text, byteLength) => {
  const input = str(text).toUpperCase();
  if (!input || Math.ceil((byteLength * 8) / 5) !== input.length) return null;
  const out = Buffer.alloc(byteLength);
  let bits = 0;
  let value = 0;
  let index = 0;
  for (const character of input) {
    const digit = BASE32_ALPHABET.indexOf(character);
    if (digit < 0) return null;
    value = ((value << 5) | digit) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out[index] = (value >>> (bits - 8)) & 255;
      index += 1;
      bits -= 8;
    }
  }
  return bits > 0 && (value & ((1 << bits) - 1)) !== 0 ? null : out;
};

/** An Ed25519 signature is 64 bytes: 103 base32 characters. */
export const SIGNATURE_BYTES = 64;
export const SIGNATURE_CHARS = Math.ceil((SIGNATURE_BYTES * 8) / 5);

/** A new key pair, both halves as one-line base64 DER. The private half is printed once and never kept. */
export const generateLicenseKeyPair = () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
  };
};

/** A random serial: 12 base32 characters (60 bits), unique enough that two keys never share one. */
export const newLicenseSerial = () => base32Encode(randomBytes(8)).slice(0, 12);

/**
 * The public key in force: the argument, then the environment, then the one built into the code.
 *
 * An argument that is a string is final, even an empty one: `''` means "no key", so everything is
 * unverifiable and the sold plugins stay locked. Only `undefined` falls through to the environment and the
 * built-in key. Without this a test (or a caller) asking for "no key" silently got the built-in one.
 */
export const licensePublicKey = (override) => {
  if (typeof override === 'string') return override.trim();
  return str(typeof process !== 'undefined' ? process.env?.[PLUGIN_LICENSE_PUBLIC_KEY_ENV] : '') || BUILT_IN_PUBLIC_KEY;
};

/** The private key in force: the argument or the environment. There is no default, by design. */
export const licensePrivateKey = (override) =>
  str(override) || str(typeof process !== 'undefined' ? process.env?.[PLUGIN_LICENSE_PRIVATE_KEY_ENV] : '');

/** Signs `payload`; throws a sentence naming the missing configuration when there is no private key. */
export const signPayload = (payload, privateKeyB64) => {
  const material = licensePrivateKey(privateKeyB64);
  if (!material) {
    throw new Error(`Signing a license needs ${PLUGIN_LICENSE_PRIVATE_KEY_ENV}, which only the deployment that sells licenses holds. Generate a pair with "node server/pluginLicense.mjs keygen" and set it there; a site never needs it.`);
  }
  let key;
  try {
    key = createPrivateKey({ key: Buffer.from(material, 'base64'), format: 'der', type: 'pkcs8' });
  } catch {
    throw new Error(`${PLUGIN_LICENSE_PRIVATE_KEY_ENV} is not a base64 PKCS#8 Ed25519 key. Generate one with "node server/pluginLicense.mjs keygen".`);
  }
  return base32Encode(edSign(null, Buffer.from(payload, 'utf8'), key));
};

/**
 * `'ok'`, `'bad'` (the signature does not match) or `'no-key'` (this build has no usable public key, so
 * nothing can be verified). Never throws: a malformed key or signature is `'bad'` / `'no-key'`.
 */
export const verifyPayload = (payload, signatureB32, publicKeyB64) => {
  const material = licensePublicKey(publicKeyB64);
  if (!material) return 'no-key';
  let key;
  try {
    key = createPublicKey({ key: Buffer.from(material, 'base64'), format: 'der', type: 'spki' });
  } catch {
    return 'no-key';
  }
  const signature = base32Decode(signatureB32, SIGNATURE_BYTES);
  if (!signature) return 'bad';
  try {
    return edVerify(null, Buffer.from(payload, 'utf8'), key, signature) ? 'ok' : 'bad';
  } catch {
    return 'bad';
  }
};
