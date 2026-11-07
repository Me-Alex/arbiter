import { createHmac, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { readJson, writeJsonAtomic } from './atomic-write.mjs';

/**
 * Identity primitives: password hashing, signed session cookies, and the
 * on-disk user store.
 *
 * Nothing here talks HTTP. The router decides which requests need a session;
 * this module only answers "is this password right", "is this cookie ours and
 * still valid", and "who is this user". Keeping the transport out means the
 * whole identity surface is unit-testable without a listening socket.
 *
 * Threat notes:
 * - Passwords use scrypt (memory-hard), never a bare hash. The cost factor is
 *   raised on purpose: a login attempt costs ~30-60 ms of CPU.
 * - Sessions are stateless: an HMAC-signed payload, so there is no session
 *   table to leak and nothing to garbage-collect. Revocation is a per-user
 *   counter (`sessionEpoch`) that invalidates every cookie already issued.
 * - Failures are uniform. `verifyPassword` and `burnPasswordTime` do the same
 *   work whether or not the account exists, so timing cannot confirm a
 *   registered email.
 * - Corrupt state is loud, not silently forgiving: a malformed password record
 *   refuses to authenticate, and a half-written secret throws instead of
 *   quietly regenerating (which would log everyone out mid-site).
 *
 * @module identity
 */

/** Name of the session cookie. */
export const SESSION_COOKIE = 'arbiter_session';

/** Default session lifetime: seven days. Revocation is explicit, not timeout-based. */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Shortest accepted password. Length is the only rule we can honestly enforce. */
export const MIN_PASSWORD_LENGTH = 12;

/** Longest accepted password, so hashing cannot be used as a CPU amplifier. */
export const MAX_PASSWORD_LENGTH = 1024;

/** Longest cookie value we are willing to parse. */
const MAX_TOKEN_LENGTH = 2048;

const SCRYPT_N = 1 << 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SALT_BYTES = 16;
const KEY_BYTES = 64;

/**
 * scrypt needs ~128 * N * r bytes of memory (32 MiB at these parameters), which
 * is exactly node's default ceiling, so the default must be raised or every
 * call fails with ERR_CRYPTO_INVALID_SCRYPT_PARAMS.
 */
function maxmemFor(N, r) {
  return 128 * N * r * 2;
}

function parsePasswordHash(stored) {
  if (typeof stored !== 'string' || stored.length === 0) return null;
  const parts = stored.split('$');
  if (parts.length !== 6) return null;
  const [scheme, rawN, rawR, rawP, rawSalt, rawKey] = parts;
  if (scheme !== 'scrypt') return null;
  const N = Number(rawN);
  const r = Number(rawR);
  const p = Number(rawP);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return null;
  if (N < 2 || r < 1 || p < 1) return null;
  // A record that asks for an absurd work factor is corrupt or hostile; refuse
  // it rather than stall the event loop for seconds per attempt.
  if (N > 1 << 20 || r > 32 || p > 16) return null;
  if ((N & (N - 1)) !== 0) return null;
  const salt = decodeBase64Strict(rawSalt);
  const key = decodeBase64Strict(rawKey);
  if (!salt || !key || salt.length === 0 || key.length === 0) return null;
  return { N, r, p, salt, key };
}

/**
 * Decode standard base64, rejecting anything that is not cleanly encoded.
 * `Buffer.from(str, 'base64')` silently skips invalid characters, which would
 * let two different strings decode to the same bytes.
 */
function decodeBase64Strict(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  const buf = Buffer.from(value, 'base64');
  if (buf.length === 0) return null;
  if (buf.toString('base64').replace(/=+$/, '') !== value.replace(/=+$/, '')) return null;
  return buf;
}

function scryptAsync(password, salt, keylen, N, r, p) {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      keylen,
      { N, r, p, maxmem: maxmemFor(N, r) },
      (err, derived) => {
        if (err) reject(err);
        else resolve(derived);
      },
    );
  });
}

/**
 * Reject a password we would be lying to call protected.
 *
 * @param {unknown} password
 * @throws {Error} code `EWEAKPASSWORD` when the value is unusable.
 */
export function assertPasswordAcceptable(password) {
  if (typeof password !== 'string') {
    const err = new Error('password must be a string');
    err.code = 'EWEAKPASSWORD';
    throw err;
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    const err = new Error(`password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    err.code = 'EWEAKPASSWORD';
    throw err;
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    const err = new Error(`password must be at most ${MAX_PASSWORD_LENGTH} characters`);
    err.code = 'EWEAKPASSWORD';
    throw err;
  }
}

/**
 * Hash a password with a fresh random salt.
 *
 * @param {string} password
 * @returns {Promise<string>} `scrypt$N$r$p$salt$key`
 */
export async function hashPassword(password) {
  assertPasswordAcceptable(password);
  const salt = randomBytes(SALT_BYTES);
  const key = await scryptAsync(password, salt, KEY_BYTES, SCRYPT_N, SCRYPT_R, SCRYPT_P);
  return ['scrypt', SCRYPT_N, SCRYPT_R, SCRYPT_P, salt.toString('base64'), key.toString('base64')].join('$');
}

/**
 * Verify a password against a stored record. Never throws on bad input: an
 * unparseable record simply does not authenticate.
 *
 * @param {string} password
 * @param {string} stored
 * @returns {Promise<boolean>}
 */
export async function verifyPassword(password, stored) {
  const parsed = parsePasswordHash(stored);
  if (!parsed) return false;
  if (typeof password !== 'string' || password.length === 0) return false;
  if (password.length > MAX_PASSWORD_LENGTH) return false;
  let derived;
  try {
    derived = await scryptAsync(password, parsed.salt, parsed.key.length, parsed.N, parsed.r, parsed.p);
  } catch {
    return false;
  }
  if (derived.length !== parsed.key.length) return false;
  return timingSafeEqual(derived, parsed.key);
}

/**
 * Spend the same CPU a real verification costs, without a record to compare.
 *
 * Login handlers call this when no user matches, so "unknown email" and "wrong
 * password" behave identically from the outside.
 *
 * @param {string} password
 */
export async function burnPasswordTime(password) {
  const candidate = typeof password === 'string' && password.length > 0
    ? password.slice(0, MAX_PASSWORD_LENGTH)
    : 'no-password-supplied';
  // A fixed salt is fine here: nothing is stored or compared, the point is the
  // cost of deriving a key, not the secrecy of the derivation.
  await scryptAsync(candidate, Buffer.alloc(SALT_BYTES, 7), KEY_BYTES, SCRYPT_N, SCRYPT_R, SCRYPT_P)
    .catch(() => Buffer.alloc(0));
}

function constantTimeStringEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function signBody(body, secret) {
  return createHmac('sha256', secret).update(body, 'utf8').digest('base64url');
}

/**
 * Serialise and sign a session payload.
 *
 * @param {object} payload
 * @param {string} secret
 * @returns {string} `<base64url json>.<hmac>`
 */
export function signSession(payload, secret) {
  if (typeof secret !== 'string' || secret.length < 32) {
    const err = new Error('session secret must be at least 32 characters');
    err.code = 'EWEAKSECRET';
    throw err;
  }
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${body}.${signBody(body, secret)}`;
}

/**
 * Verify a session token's signature, shape and expiry.
 *
 * @param {string}  token
 * @param {string}  secret
 * @param {number}  [now=Date.now()]
 * @returns {object|null} The payload when genuine, otherwise null.
 */
export function verifySessionToken(token, secret, now = Date.now()) {
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) return null;
  if (typeof secret !== 'string' || secret.length === 0) return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  if (dot !== token.lastIndexOf('.')) return null;
  const body = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  if (!constantTimeStringEqual(signature, signBody(body, secret))) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  if (typeof payload.uid !== 'string' || payload.uid.length === 0) return null;
  if (!Number.isInteger(payload.ep) || payload.ep < 0) return null;
  if (!Number.isFinite(payload.exp) || payload.exp <= now) return null;
  return payload;
}

/**
 * Build a session token for a user.
 *
 * @param {object} user
 * @param {string} secret
 * @param {{ now?: number, ttlMs?: number }} [options]
 * @returns {string}
 */
export function createSession(user, secret, { now = Date.now(), ttlMs = SESSION_TTL_MS } = {}) {
  return signSession(
    { uid: user.id, ep: user.sessionEpoch || 0, iat: now, exp: now + ttlMs },
    secret,
  );
}

/**
 * Parse a Cookie header into name/value pairs. Later duplicates win, matching
 * how browsers send an overridden cookie.
 *
 * @param {string|undefined} header
 * @returns {Record<string, string>}
 */
export function parseCookies(header) {
  const out = Object.create(null);
  if (typeof header !== 'string' || header.length === 0) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    if (!name) continue;
    let value = part.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1);
    }
    out[name] = value;
  }
  return out;
}

/**
 * Read this module's session cookie out of a request.
 *
 * @param {{ headers?: Record<string, string|string[]|undefined> }} req
 * @returns {string|null}
 */
export function readSessionToken(req) {
  const header = req && req.headers ? req.headers.cookie : undefined;
  const raw = Array.isArray(header) ? header.join('; ') : header;
  const cookies = parseCookies(raw);
  const token = cookies[SESSION_COOKIE];
  return typeof token === 'string' && token.length > 0 ? token : null;
}

/**
 * Build a Set-Cookie value for a session.
 *
 * `Secure` is only set off-loopback: a loopback site served over plain HTTP must
 * still be able to hold a session, and claiming `Secure` there would silently
 * drop the cookie.
 *
 * @param {string} token
 * @param {{ secure?: boolean, maxAgeSeconds?: number }} [options]
 * @returns {string}
 */
export function serializeSessionCookie(token, { secure = false, maxAgeSeconds = Math.floor(SESSION_TTL_MS / 1000) } = {}) {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/**
 * Build the Set-Cookie value that clears a session.
 *
 * @returns {string}
 */
export function serializeClearedSessionCookie() {
  return serializeSessionCookie('', { maxAgeSeconds: 0 });
}

/**
 * Resolve the user a request is authenticated as.
 *
 * A token is only good when its signature holds AND the account still exists,
 * is not disabled, and has not had its session epoch bumped. Any one of those
 * failing means "not logged in", never "logged in as somebody weaker".
 *
 * @param {{ headers?: Record<string, string|string[]|undefined> }} req
 * @param {{ users: object[], secret: string, now?: number }} options
 * @returns {{ user: object, payload: object }|null}
 */
export function authenticateRequest(req, { users, secret, now = Date.now() } = {}) {
  if (!Array.isArray(users) || typeof secret !== 'string') return null;
  const token = readSessionToken(req);
  if (!token) return null;
  const payload = verifySessionToken(token, secret, now);
  if (!payload) return null;
  const user = users.find((candidate) => candidate && candidate.id === payload.uid);
  if (!user) return null;
  if (user.disabledAt) return null;
  if ((user.sessionEpoch || 0) !== payload.ep) return null;
  return { user, payload };
}

/**
 * @param {string} dataDir
 * @returns {{ dir: string, users: string, secret: string }}
 */
export function identityPaths(dataDir) {
  const dir = join(dataDir, 'identity');
  return { dir, users: join(dir, 'users.json'), secret: join(dir, 'session.key') };
}

/**
 * Load the user store. A missing file is an empty store; a corrupt one throws,
 * because silently returning no users would look exactly like "nobody is
 * registered" and hide the damage.
 *
 * @param {string} dataDir
 * @returns {Promise<object[]>}
 */
export async function loadUsers(dataDir) {
  const raw = await readJson(identityPaths(dataDir).users, []);
  if (!Array.isArray(raw)) {
    const err = new Error('identity store must be a JSON array');
    err.code = 'EIDENTITYSTORE';
    throw err;
  }
  return raw.filter(isUsableUserRecord);
}

function isUsableUserRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
  if (typeof record.id !== 'string' || record.id.length === 0) return false;
  if (typeof record.email !== 'string' || record.email.length === 0) return false;
  if (typeof record.passwordHash !== 'string' || record.passwordHash.length === 0) return false;
  if (record.role !== 'operator' && record.role !== 'member') return false;
  return true;
}

/**
 * @param {string} dataDir
 * @param {object[]} users
 */
export async function saveUsers(dataDir, users) {
  await writeJsonAtomic(identityPaths(dataDir).users, users);
}

/**
 * @param {string} email
 * @returns {string}
 */
export function normalizeEmail(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

/**
 * @param {string} email
 * @returns {boolean}
 */
export function isValidEmail(email) {
  const value = normalizeEmail(email);
  if (value.length < 5 || value.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/**
 * Look a user up by email, case-insensitively.
 *
 * @param {object[]} users
 * @param {string}   email
 * @returns {object|null}
 */
export function findUserByEmail(users, email) {
  if (!Array.isArray(users)) return null;
  const wanted = normalizeEmail(email);
  if (!wanted) return null;
  return users.find((user) => normalizeEmail(user && user.email) === wanted) || null;
}

/**
 * Build a user record. The caller supplies the already-hashed password so this
 * stays synchronous and cannot be tricked into storing a plaintext value.
 *
 * @param {{ email: string, displayName?: string, role?: 'operator'|'member', passwordHash: string }} input
 * @returns {object}
 */
export function createUser({ email, displayName = '', role = 'member', passwordHash }) {
  if (!isValidEmail(email)) {
    const err = new Error('a valid email is required');
    err.code = 'EBADIDENTITY';
    throw err;
  }
  if (role !== 'operator' && role !== 'member') {
    const err = new Error(`unknown role: ${String(role)}`);
    err.code = 'EBADIDENTITY';
    throw err;
  }
  if (typeof passwordHash !== 'string' || !parsePasswordHash(passwordHash)) {
    const err = new Error('a hashed password is required');
    err.code = 'EBADIDENTITY';
    throw err;
  }
  return {
    id: randomUUID(),
    email: normalizeEmail(email),
    displayName: typeof displayName === 'string' ? displayName.trim() : '',
    role,
    passwordHash,
    sessionEpoch: 0,
    createdAt: new Date().toISOString(),
    disabledAt: null,
  };
}

/**
 * The shape safe to hand to a client or a log: no password hash, ever.
 *
 * @param {object} user
 * @returns {object}
 */
export function publicUser(user) {
  if (!user || typeof user !== 'object') return null;
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName || '',
    role: user.role,
    sessionEpoch: user.sessionEpoch || 0,
    createdAt: user.createdAt || null,
    disabledAt: user.disabledAt || null,
  };
}

/**
 * Invalidate every session already issued to a user.
 *
 * @param {object} user
 * @returns {object} The same record, mutated.
 */
export function bumpSessionEpoch(user) {
  user.sessionEpoch = (user.sessionEpoch || 0) + 1;
  return user;
}

/**
 * Read the HMAC secret, creating it on first run.
 *
 * Refuses to invent a replacement for an existing-but-unusable file: rotating
 * the secret silently would log out every user without a trace.
 *
 * @param {string} dataDir
 * @returns {Promise<string>}
 */
export async function loadOrCreateSessionSecret(dataDir) {
  const paths = identityPaths(dataDir);
  await fs.mkdir(paths.dir, { recursive: true });
  let existing = null;
  try {
    existing = (await fs.readFile(paths.secret, 'utf8')).trim();
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  if (existing !== null) {
    if (existing.length < 32) {
      const err = new Error(`session secret at ${paths.secret} is corrupt or too short; delete it to regenerate`);
      err.code = 'ECORRUPTSECRET';
      throw err;
    }
    return existing;
  }
  const generated = randomBytes(32).toString('base64url');
  try {
    await fs.writeFile(paths.secret, generated, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return generated;
  } catch (err) {
    if (err.code === 'EEXIST') {
      const raced = (await fs.readFile(paths.secret, 'utf8')).trim();
      if (raced.length >= 32) return raced;
    }
    throw err;
  }
}
