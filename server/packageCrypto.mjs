/**
 * Signed plugin packages: the proof a site checks before it commits a paid plugin the platform handed it.
 *
 * A package (the protected zip react-wp.com builds for a buyer) is described by `RWPKG1|plugin|version|
 * domain|sha256|expires`, and that description is signed with Ed25519. A site verifies it with its OWN domain
 * and the sha256 of the bytes it actually downloaded, so a package that was altered, issued for another
 * plugin, version or site, or issued too long ago, does not verify and is never committed.
 *
 * **A different key pair from licences.** `PLUGIN_PACKAGE_PRIVATE_KEY` exists only on react-wp.com. The public
 * half ships with every site (`BUILT_IN_PACKAGE_PUBLIC_KEY`, or the `PLUGIN_PACKAGE_PUBLIC_KEY` environment
 * variable on a deployment that trusts another vendor). Keeping it apart from the licence key means a leaked
 * licence key cannot sign code, and a leaked package key cannot mint licences. Nothing here ever falls back to
 * the licence key: with no package key configured, signing throws and verifying answers `'no-key'`.
 *
 * Generate a pair with `node server/pluginLicense.mjs keygen-package`. Plain ESM over `node:crypto`.
 */
import { createHash, createPrivateKey, sign as edSign } from 'node:crypto';
import { base32Encode, generateLicenseKeyPair, verifyPayload } from './licenseCrypto.mjs';

/**
 * The vendor's package-verification key, base64 SPKI DER. EMPTY until the owner pastes the public half of
 * the pair `keygen-package` printed: with no key a site refuses to install anything automatically, which is
 * the safe direction. It is not a secret and is meant to be committed.
 */
export const BUILT_IN_PACKAGE_PUBLIC_KEY = 'MCowBQYDK2VwAyEAt2eJbB2c4Ka80TrIREGb8hSVftnonJ1IOYVxHInWW3k=';

export const PLUGIN_PACKAGE_PUBLIC_KEY_ENV = 'PLUGIN_PACKAGE_PUBLIC_KEY';
export const PLUGIN_PACKAGE_PRIVATE_KEY_ENV = 'PLUGIN_PACKAGE_PRIVATE_KEY';

/** How long a signed package description may be used after it was issued. */
export const PACKAGE_SIGNATURE_TTL_MS = 10 * 60 * 1000;

const str = (value) => (typeof value === 'string' ? value.trim() : '');
const env = (name) => str(typeof process !== 'undefined' ? process.env?.[name] : '');

export const generatePackageKeyPair = generateLicenseKeyPair;

export const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** The public key in force. A string argument is final, even an empty one (`''` is "no key"). */
export const packagePublicKey = (override) =>
  (typeof override === 'string' ? override.trim() : env(PLUGIN_PACKAGE_PUBLIC_KEY_ENV) || BUILT_IN_PACKAGE_PUBLIC_KEY);

/** The private key in force: the argument or the environment. No default, and never the licence key. */
export const packagePrivateKey = (override) => str(override) || env(PLUGIN_PACKAGE_PRIVATE_KEY_ENV);

/** The exact text that is signed. A `|` inside a field would let one description read as another. */
export const packagePayload = ({ pluginId, version, domain, sha256, exp }) => {
  const fields = [pluginId, version, domain, sha256, exp].map((value) => String(value ?? ''));
  if (fields.some((field) => !field || field.includes('|'))) throw new Error('A package description needs five non-empty fields without "|".');
  return `RWPKG1|${fields.join('|')}`;
};

/**
 * Signs a package description for one site. `exp` is epoch seconds, `now` plus the TTL unless given.
 * Throws a sentence naming the missing configuration when there is no private key.
 */
export const signPackage = ({ pluginId, version, domain, sha256, now = new Date(), privateKey } = {}) => {
  const material = packagePrivateKey(privateKey);
  if (!material) {
    throw new Error(`Signing a package needs ${PLUGIN_PACKAGE_PRIVATE_KEY_ENV}, which only react-wp.com holds. Generate a pair with "node server/pluginLicense.mjs keygen-package" and set it there; a site never needs it.`);
  }
  let key;
  try {
    key = createPrivateKey({ key: Buffer.from(material, 'base64'), format: 'der', type: 'pkcs8' });
  } catch {
    throw new Error(`${PLUGIN_PACKAGE_PRIVATE_KEY_ENV} is not a base64 PKCS#8 Ed25519 key. Generate one with "node server/pluginLicense.mjs keygen-package".`);
  }
  const exp = String(Math.floor((now.getTime() + PACKAGE_SIGNATURE_TTL_MS) / 1000));
  const payload = packagePayload({ pluginId, version, domain, sha256, exp });
  return { exp, sig: base32Encode(edSign(null, Buffer.from(payload, 'utf8'), key)) };
};

/**
 * `'ok'`, `'expired'`, `'bad'` (the description or signature does not match, which includes a different
 * domain, plugin, version or bytes) or `'no-key'` (this build has no package key). Never throws.
 */
export const verifyPackage = ({ pluginId, version, domain, sha256, exp, sig }, { publicKey, now = new Date() } = {}) => {
  let payload;
  try {
    payload = packagePayload({ pluginId, version, domain, sha256, exp });
  } catch {
    return 'bad';
  }
  const verdict = verifyPayload(payload, sig, packagePublicKey(publicKey));
  if (verdict !== 'ok') return verdict;
  const expires = Number(exp);
  return Number.isFinite(expires) && expires * 1000 >= now.getTime() ? 'ok' : 'expired';
};
