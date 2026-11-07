/**
 * Signed licence revocations: how the vendor takes back a key that leaked or was refunded, and how a
 * site learns of it without trusting the network.
 *
 * **The list.** `{ version: 1, issuedAt, serials: [...], signature }`. The signature is Ed25519 (the same
 * private key that mints licences) over `RWPREV1|<issuedAt>|<serials sorted, comma-joined>`, verified with
 * the public key every site carries. A list that does not verify is ignored whole, so a man in the middle
 * or a compromised mirror can neither revoke a valid key nor suppress a revocation that was already held.
 *
 * **Offline first.** A site fetches the list at most once every 24 hours, through `centralFetch` (never a
 * bare `fetch` to react-wp.com: the apex answers 308 to www), with `If-None-Match` so an unchanged list
 * costs a 304. If the fetch fails, the last *verified* list stays in force - in memory and, when the host
 * can write, in `data/license-revocations.json` - so an outage of the vendor never locks a valid key and
 * never unlocks a revoked one. A list older than the one already held (`issuedAt` going backwards) is
 * refused, so replaying an old response cannot un-revoke a key.
 *
 * What this cannot do: a site that has never reached the vendor holds no list, and so revokes nothing.
 * Revocation is best effort for a site that is online at least once a day, which is the honest promise.
 */
import { createHash } from 'node:crypto';
import { centralFetch } from './centralFetch.mjs';
import { readJsonState, writeJsonState } from './licenseStore.mjs';
import { licensePrivateKey, signPayload, verifyPayload } from './licenseCrypto.mjs';

export const REVOCATION_LIST_VERSION = 1;
export const REVOCATION_URL_ENV = 'RWP_LICENSE_REVOCATION_URL';
export const DEFAULT_REVOCATION_URL = 'https://react-wp.com/api/v1/licenses/revoked';
export const REVOCATION_REFRESH_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;
const STATE_FILE = 'license-revocations.json';
const SERIAL_PATTERN = /^[0-9A-HJKMNP-TV-Z]{12}$/;

const str = (value) => (typeof value === 'string' ? value.trim() : '');

/** What the signature covers. Sorted so the same set always signs the same bytes. */
export const revocationPayload = ({ issuedAt, serials }) =>
  `RWPREV${REVOCATION_LIST_VERSION}|${issuedAt}|${[...serials].sort().join(',')}`;

const cleanSerials = (serials) => [...new Set(
  (Array.isArray(serials) ? serials : []).map((serial) => str(serial).toUpperCase()).filter((serial) => SERIAL_PATTERN.test(serial)),
)].sort();

/** The list the vendor publishes. Needs the private key: only the licence-selling deployment has it. */
export const signRevocationList = ({ serials, now = new Date(), privateKey } = {}) => {
  const clean = cleanSerials(serials);
  const issuedAt = now.toISOString();
  return {
    version: REVOCATION_LIST_VERSION,
    issuedAt,
    serials: clean,
    signature: signPayload(revocationPayload({ issuedAt, serials: clean }), licensePrivateKey(privateKey)),
  };
};

/** True when the signing key is configured here, so the route can say "this deployment is not the vendor". */
export const canSignRevocations = (privateKey) => Boolean(licensePrivateKey(privateKey));

/** The verified serials of a list, or `null` when it is malformed, unsigned or tampered with. */
export const verifyRevocationList = (list, publicKey) => {
  if (!list || typeof list !== 'object' || list.version !== REVOCATION_LIST_VERSION) return null;
  const issuedAt = str(list.issuedAt);
  if (!issuedAt || Number.isNaN(Date.parse(issuedAt)) || !Array.isArray(list.serials)) return null;
  // Every entry must be a well-formed serial: a list that smuggles other text is a list nobody signed.
  const serials = cleanSerials(list.serials);
  if (serials.length !== list.serials.length) return null;
  if (verifyPayload(revocationPayload({ issuedAt, serials }), str(list.signature), publicKey) !== 'ok') return null;
  return { issuedAt, serials };
};

const state = {
  serials: new Set(),
  issuedAt: '',
  etag: '',
  checkedAt: 0,
  loadedFromDisk: false,
  inflight: null,
};

const loadFromDisk = () => {
  if (state.loadedFromDisk) return;
  state.loadedFromDisk = true;
  const saved = readJsonState(STATE_FILE);
  // Re-verified on load: a hand-edited file is not trusted any more than a response.
  const verified = saved ? verifyRevocationList(saved.list, undefined) : null;
  if (verified) {
    state.serials = new Set(verified.serials);
    state.issuedAt = verified.issuedAt;
    state.etag = str(saved.etag);
  }
};

/** The serials currently revoked, as far as this site has verified. Synchronous. */
export const revokedSerials = () => {
  loadFromDisk();
  return state.serials;
};

/** Forget everything held in memory (tests). `disk: true` also forgets that the file was read. */
export const resetRevocations = () => {
  state.serials = new Set();
  state.issuedAt = '';
  state.etag = '';
  state.checkedAt = 0;
  state.inflight = null;
  state.loadedFromDisk = true;
};

/**
 * Takes a list the platform returned. Returns `{ applied, reason }`; nothing changes unless it applied.
 * `publicKey` is injectable for tests; production uses the one built into the code.
 */
export const applyRevocationList = (list, { publicKey, etag = '' } = {}) => {
  loadFromDisk();
  const verified = verifyRevocationList(list, publicKey);
  if (!verified) return { applied: false, reason: 'The revocation list did not verify against this site\'s public key, so it was ignored.' };
  if (state.issuedAt && Date.parse(verified.issuedAt) < Date.parse(state.issuedAt)) {
    return { applied: false, reason: 'The revocation list is older than the one already held, so it was ignored.' };
  }
  state.serials = new Set(verified.serials);
  state.issuedAt = verified.issuedAt;
  state.etag = etag;
  writeJsonState(STATE_FILE, { list: { ...list, serials: verified.serials }, etag });
  return { applied: true, reason: '' };
};

/**
 * Fetches the list when it is due. Never throws and never locks anything: a failure is logged (no key is
 * ever in the message) and the held list stays.
 *
 * @param {object} [options]
 * @param {boolean} [options.force]      Ignore the 24 h interval.
 * @param {Date}    [options.now]        Injectable clock.
 * @param {typeof fetch} [options.fetchImpl]
 * @param {string}  [options.url]
 * @param {string}  [options.publicKey]
 */
export const refreshRevocations = async ({ force = false, now = new Date(), fetchImpl, url, publicKey } = {}) => {
  loadFromDisk();
  if (state.inflight) return state.inflight;
  if (!force && state.checkedAt && now.getTime() - state.checkedAt < REVOCATION_REFRESH_MS) {
    return { fetched: false, reason: 'not due' };
  }
  const target = str(url) || str(process.env?.[REVOCATION_URL_ENV]) || DEFAULT_REVOCATION_URL;
  state.inflight = (async () => {
    try {
      const headers = { Accept: 'application/json' };
      if (state.etag) headers['If-None-Match'] = state.etag;
      const response = await centralFetch(
        target,
        { method: 'GET', headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
        { fetchImpl: fetchImpl || fetch },
      );
      // Counted as a check even when it failed: a vendor outage must cost one request a day, not one per
      // page view. The held list keeps answering meanwhile.
      state.checkedAt = now.getTime();
      if (response.status === 304) return { fetched: true, changed: false, reason: '' };
      if (!response.ok) {
        console.error(`License revocation list not refreshed: the platform answered HTTP ${response.status}. Keeping the last verified list.`);
        return { fetched: false, reason: `HTTP ${response.status}` };
      }
      const list = await response.json();
      const result = applyRevocationList(list, { publicKey, etag: str(response.headers?.get?.('etag')) });
      if (!result.applied) console.error(`License revocation list not applied: ${result.reason}`);
      return { fetched: true, changed: result.applied, reason: result.reason };
    } catch (error) {
      state.checkedAt = now.getTime();
      console.error(`License revocation list not refreshed: ${error instanceof Error ? error.message : 'request failed'}. Keeping the last verified list.`);
      return { fetched: false, reason: 'request failed' };
    } finally {
      state.inflight = null;
    }
  })();
  return state.inflight;
};

/**
 * Called before a gated request. The first call in a process waits (bounded) so a cold serverless
 * instance does not serve one request with an empty list; every later call returns at once and lets a due
 * refresh run in the background.
 */
export const ensureRevocations = async (options = {}) => {
  loadFromDisk();
  const due = !state.checkedAt || (options.now || new Date()).getTime() - state.checkedAt >= REVOCATION_REFRESH_MS;
  if (!due && !state.inflight) return;
  const pending = refreshRevocations(options);
  if (!state.checkedAt) await Promise.race([pending, new Promise((resolve) => setTimeout(resolve, 3000))]);
};

/** `ETag` for a published list: a hash of the signed body, so an unchanged list answers 304. */
export const revocationEtag = (list) => `"${createHash('sha256').update(JSON.stringify(list)).digest('hex').slice(0, 32)}"`;
