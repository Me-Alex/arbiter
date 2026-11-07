import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  MIN_PASSWORD_LENGTH,
  MAX_PASSWORD_LENGTH,
  hashPassword,
  verifyPassword,
  burnPasswordTime,
  assertPasswordAcceptable,
  signSession,
  verifySessionToken,
  createSession,
  parseCookies,
  readSessionToken,
  serializeSessionCookie,
  serializeClearedSessionCookie,
  authenticateRequest,
  identityPaths,
  loadUsers,
  saveUsers,
  normalizeEmail,
  isValidEmail,
  findUserByEmail,
  createUser,
  publicUser,
  bumpSessionEpoch,
  loadOrCreateSessionSecret,
} from '../src/shared/identity.mjs';

const SECRET = 'k'.repeat(43);
const GOOD_PASSWORD = 'correct horse battery staple';

function flipLastChar(value) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const last = value[value.length - 1];
  const index = alphabet.indexOf(last);
  const replacement = alphabet[(index + 1) % alphabet.length];
  return value.slice(0, -1) + replacement;
}

async function withDataDir(t) {
  const dir = await fsp.mkdtemp(join(tmpdir(), 'arbiter-identity-'));
  t.after(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });
  return dir;
}

// ---------------------------------------------------------------- passwords

test('hashPassword refuses a password shorter than the minimum, so a weak one can never be stored', async () => {
  await assert.rejects(
    hashPassword('short'),
    /must be at least 12 characters/,
  );
});

test('hashPassword refuses a value that is not a string', async () => {
  await assert.rejects(hashPassword(undefined), /must be a string/);
  await assert.rejects(hashPassword(1234567890123), /must be a string/);
});

test('hashPassword refuses an oversized password rather than spending unbounded CPU', async () => {
  await assert.rejects(
    hashPassword('x'.repeat(MAX_PASSWORD_LENGTH + 1)),
    /must be at most 1024 characters/,
  );
});

test('assertPasswordAcceptable accepts exactly the minimum length', () => {
  assert.doesNotThrow(() => assertPasswordAcceptable('a'.repeat(MIN_PASSWORD_LENGTH)));
  assert.throws(() => assertPasswordAcceptable('a'.repeat(MIN_PASSWORD_LENGTH - 1)), /at least/);
});

test('a correct password verifies and a wrong one does not', async () => {
  const stored = await hashPassword(GOOD_PASSWORD);
  assert.equal(await verifyPassword(GOOD_PASSWORD, stored), true);
  assert.equal(await verifyPassword(`${GOOD_PASSWORD} `, stored), false);
  assert.equal(await verifyPassword(GOOD_PASSWORD.slice(0, -1), stored), false);
  assert.equal(await verifyPassword('', stored), false);
});

test('the same password hashes differently every time, because the salt is random', async () => {
  const first = await hashPassword(GOOD_PASSWORD);
  const second = await hashPassword(GOOD_PASSWORD);
  assert.notEqual(first, second);
  assert.equal(await verifyPassword(GOOD_PASSWORD, first), true);
  assert.equal(await verifyPassword(GOOD_PASSWORD, second), true);
});

test('the stored record carries its own parameters, so the cost factor can be raised later without breaking old rows', async () => {
  const stored = await hashPassword(GOOD_PASSWORD);
  assert.match(stored, /^scrypt\$32768\$8\$1\$[A-Za-z0-9+/]+={0,2}\$[A-Za-z0-9+/]+={0,2}$/);
});

test('a malformed or hostile record never authenticates and never throws', async () => {
  const cases = [
    '',
    null,
    undefined,
    42,
    'plaintextpassword',
    'bcrypt$32768$8$1$c2FsdA==$a2V5',
    'scrypt$32768$8$c2FsdA==$a2V5',
    // N not a power of two
    'scrypt$30000$8$1$c2FsdHNhbHRzYWx0c2E=$a2V5a2V5a2V5a2V5',
    // absurd work factor: refuse instead of stalling for seconds
    `scrypt$${1 << 21}$8$1$c2FsdHNhbHRzYWx0c2E=$a2V5a2V5a2V5a2V5`,
    // base64 that is not base64
    'scrypt$32768$8$1$!!!!$a2V5a2V5a2V5a2V5',
    // empty salt
    'scrypt$32768$8$1$$a2V5a2V5a2V5a2V5',
  ];
  for (const stored of cases) {
    assert.equal(await verifyPassword(GOOD_PASSWORD, stored), false, `should reject: ${String(stored)}`);
  }
});

test('a hash whose key was edited does not authenticate', async () => {
  const stored = await hashPassword(GOOD_PASSWORD);
  const parts = stored.split('$');
  const key = Buffer.from(parts[5], 'base64');
  key[0] ^= 0xff;
  parts[5] = key.toString('base64');
  assert.equal(await verifyPassword(GOOD_PASSWORD, parts.join('$')), false);
});

test('a hash whose salt was edited does not authenticate', async () => {
  const stored = await hashPassword(GOOD_PASSWORD);
  const parts = stored.split('$');
  const salt = Buffer.from(parts[4], 'base64');
  salt[0] ^= 0x01;
  parts[4] = salt.toString('base64');
  assert.equal(await verifyPassword(GOOD_PASSWORD, parts.join('$')), false);
});

test('burnPasswordTime resolves for any input so a missing account cannot be detected by its failure mode', async () => {
  await assert.doesNotReject(burnPasswordTime(undefined));
  await assert.doesNotReject(burnPasswordTime(''));
  await assert.doesNotReject(burnPasswordTime('x'.repeat(5000)));
});

// ------------------------------------------------------------------ sessions

test('a signed session round-trips with the user id, epoch and expiry', () => {
  const token = createSession({ id: 'u1', sessionEpoch: 3 }, SECRET, { now: 1000, ttlMs: 5000 });
  const payload = verifySessionToken(token, SECRET, 2000);
  assert.equal(payload.uid, 'u1');
  assert.equal(payload.ep, 3);
  assert.equal(payload.iat, 1000);
  assert.equal(payload.exp, 6000);
});

test('SESSION_TTL_MS is seven days', () => {
  assert.equal(SESSION_TTL_MS, 7 * 24 * 60 * 60 * 1000);
});

test('an expired token is refused at the boundary', () => {
  const token = createSession({ id: 'u1', sessionEpoch: 0 }, SECRET, { now: 1000, ttlMs: 5000 });
  assert.ok(verifySessionToken(token, SECRET, 5999));
  assert.equal(verifySessionToken(token, SECRET, 6000), null);
  assert.equal(verifySessionToken(token, SECRET, 10_000), null);
});

test('a tampered payload or signature is refused', () => {
  const token = createSession({ id: 'u1', sessionEpoch: 0 }, SECRET, { now: 1000, ttlMs: 5000 });
  const dot = token.indexOf('.');
  const body = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  assert.equal(verifySessionToken(`${flipLastChar(body)}.${signature}`, SECRET, 2000), null);
  assert.equal(verifySessionToken(`${body}.${flipLastChar(signature)}`, SECRET, 2000), null);
  assert.equal(verifySessionToken(token, 'z'.repeat(43), 2000), null);
});

test('a token with the wrong shape is refused', () => {
  const future = Date.now() + 10_000;
  const shapes = [
    '',
    'no-dot-at-all',
    `.${'a'.repeat(43)}`,
    `${'a'.repeat(43)}.`,
    'a.b.c',
    'x'.repeat(3000),
    null,
    undefined,
    12345,
  ];
  for (const shape of shapes) {
    assert.equal(verifySessionToken(shape, SECRET, future), null, `should reject: ${String(shape)}`);
  }
});

test('a payload missing its user id, epoch or expiry is refused even though the signature is genuine', () => {
  const future = Date.now() + 10_000;
  const noUid = signSession({ ep: 0, exp: future }, SECRET);
  const noEpoch = signSession({ uid: 'u1', exp: future }, SECRET);
  const noExp = signSession({ uid: 'u1', ep: 0 }, SECRET);
  const emptyUid = signSession({ uid: '', ep: 0, exp: future }, SECRET);
  const negativeEpoch = signSession({ uid: 'u1', ep: -1, exp: future }, SECRET);
  const notAnObject = signSession(['u1'], SECRET);
  for (const token of [noUid, noEpoch, noExp, emptyUid, negativeEpoch, notAnObject]) {
    assert.equal(verifySessionToken(token, SECRET, future), null);
  }
});

test('signSession refuses a secret too short to be a secret', () => {
  assert.throws(() => signSession({ uid: 'u1' }, 'short'), /at least 32 characters/);
});

// ------------------------------------------------------------------- cookies

test('the session cookie is HttpOnly, SameSite=Lax and path-wide', () => {
  const value = serializeSessionCookie('body.signature');
  assert.ok(value.startsWith(`${SESSION_COOKIE}=body.signature`));
  assert.match(value, /; HttpOnly/);
  assert.match(value, /; SameSite=Lax/);
  assert.match(value, /; Path=\//);
  assert.match(value, /; Max-Age=\d+/);
});

test('Secure is added only when asked, so a loopback HTTP site can still hold a session', () => {
  assert.doesNotMatch(serializeSessionCookie('t'), /Secure/);
  assert.match(serializeSessionCookie('t', { secure: true }), /; Secure/);
});

test('the cleared cookie expires immediately', () => {
  const value = serializeClearedSessionCookie();
  assert.match(value, /Max-Age=0/);
  assert.ok(value.startsWith(`${SESSION_COOKIE}=;`));
});

test('readSessionToken pulls our cookie out of a crowded header', () => {
  assert.equal(readSessionToken({ headers: { cookie: 'a=1; arbiter_session=body.sig; z=2' } }), 'body.sig');
  assert.equal(readSessionToken({ headers: { cookie: `theme=dark; ${SESSION_COOKIE}=body.sig` } }), 'body.sig');
  assert.equal(readSessionToken({ headers: { cookie: `theme=dark; ${SESSION_COOKIE}=` } }), null);
  assert.equal(readSessionToken({ headers: { cookie: 'theme=dark' } }), null);
  assert.equal(readSessionToken({ headers: {} }), null);
  assert.equal(readSessionToken({}), null);
});

test('parseCookies keeps repeated names last and tolerates quoted values', () => {
  const cookies = parseCookies('a=1; a=2; b="quoted"; noequals; =orphan');
  assert.equal(cookies.a, '2');
  assert.equal(cookies.b, 'quoted');
  assert.equal(Object.prototype.hasOwnProperty.call(cookies, 'noequals'), false);
});

// -------------------------------------------------------------- authentication

test('authenticateRequest accepts a genuine cookie', () => {
  const user = { id: 'u1', sessionEpoch: 2, role: 'member', disabledAt: null };
  const token = createSession(user, SECRET);
  const req = { headers: { cookie: `${SESSION_COOKIE}=${token}` } };
  const result = authenticateRequest(req, { users: [user], secret: SECRET });
  assert.equal(result.user.id, 'u1');
});

test('no cookie means no user', () => {
  const user = { id: 'u1', sessionEpoch: 0, role: 'member' };
  assert.equal(authenticateRequest({ headers: {} }, { users: [user], secret: SECRET }), null);
  assert.equal(authenticateRequest({}, { users: [user], secret: SECRET }), null);
});

test('a disabled account is not authenticated even with a genuine cookie', () => {
  const user = { id: 'u1', sessionEpoch: 0, role: 'member', disabledAt: '2026-01-01T00:00:00.000Z' };
  const token = createSession(user, SECRET);
  const req = { headers: { cookie: `${SESSION_COOKIE}=${token}` } };
  assert.equal(authenticateRequest(req, { users: [user], secret: SECRET }), null);
});

test('bumping the session epoch invalidates cookies already issued', () => {
  const user = { id: 'u1', sessionEpoch: 0, role: 'member', disabledAt: null };
  const token = createSession(user, SECRET);
  const req = { headers: { cookie: `${SESSION_COOKIE}=${token}` } };
  assert.ok(authenticateRequest(req, { users: [user], secret: SECRET }));
  bumpSessionEpoch(user);
  assert.equal(authenticateRequest(req, { users: [user], secret: SECRET }), null);
});

test('a token for a user who no longer exists is not authenticated', () => {
  const user = { id: 'u1', sessionEpoch: 0, role: 'member' };
  const token = createSession(user, SECRET);
  const req = { headers: { cookie: `${SESSION_COOKIE}=${token}` } };
  assert.equal(authenticateRequest(req, { users: [], secret: SECRET }), null);
});

test('an expired cookie is refused by authenticateRequest', () => {
  const user = { id: 'u1', sessionEpoch: 0, role: 'member' };
  const now = 1_000_000;
  const token = createSession(user, SECRET, { now, ttlMs: 1000 });
  const req = { headers: { cookie: `${SESSION_COOKIE}=${token}` } };
  assert.ok(authenticateRequest(req, { users: [user], secret: SECRET, now: now + 500 }));
  assert.equal(authenticateRequest(req, { users: [user], secret: SECRET, now: now + 5000 }), null);
});

// ----------------------------------------------------------------- the store

test('createUser normalises the email and starts with a live session epoch', async () => {
  const passwordHash = await hashPassword(GOOD_PASSWORD);
  const user = createUser({ email: '  Some@Example.COM ', displayName: ' Sam ', passwordHash });
  assert.equal(user.email, 'some@example.com');
  assert.equal(user.displayName, 'Sam');
  assert.equal(user.role, 'member');
  assert.equal(user.sessionEpoch, 0);
  assert.equal(user.disabledAt, null);
  assert.match(user.id, /^[0-9a-f-]{36}$/);
});

test('createUser refuses an invalid email, an unknown role and an unhashed password', async () => {
  const passwordHash = await hashPassword(GOOD_PASSWORD);
  assert.throws(() => createUser({ email: 'not-an-email', passwordHash }), /valid email/);
  assert.throws(() => createUser({ email: 'a@b.co', passwordHash, role: 'superuser' }), /unknown role/);
  assert.throws(() => createUser({ email: 'a@b.co', passwordHash: 'plaintext' }), /hashed password/);
  assert.throws(() => createUser({ email: 'a@b.co', passwordHash: '' }), /hashed password/);
});

test('the stored record never carries the plaintext password', async () => {
  const passwordHash = await hashPassword(GOOD_PASSWORD);
  const user = createUser({ email: 'a@b.co', passwordHash });
  const serialized = JSON.stringify(user);
  assert.equal(serialized.includes(GOOD_PASSWORD), false);
});

test('publicUser drops the password hash', async () => {
  const passwordHash = await hashPassword(GOOD_PASSWORD);
  const user = createUser({ email: 'a@b.co', passwordHash });
  const safe = publicUser(user);
  assert.equal(safe.passwordHash, undefined);
  assert.equal(safe.email, 'a@b.co');
  assert.equal(safe.role, 'member');
});

test('findUserByEmail is case- and whitespace-insensitive', async () => {
  const passwordHash = await hashPassword(GOOD_PASSWORD);
  const user = createUser({ email: 'Case@Test.com', passwordHash });
  assert.equal(findUserByEmail([user], '  case@test.COM '), user);
  assert.equal(findUserByEmail([user], 'other@test.com'), null);
  assert.equal(findUserByEmail(null, 'case@test.com'), null);
});

test('email validation rejects the shapes that cannot be real', () => {
  assert.equal(isValidEmail('a@b.co'), true);
  assert.equal(isValidEmail('A@B.CO'), true);
  assert.equal(isValidEmail(''), false);
  assert.equal(isValidEmail('no-at-sign.com'), false);
  assert.equal(isValidEmail('no@tld'), false);
  assert.equal(isValidEmail('spaces in@b.co'), false);
  assert.equal(normalizeEmail('  MiXeD@Case.COM  '), 'mixed@case.com');
});

test('the store lives under the data directory', () => {
  const paths = identityPaths('/data/arbiter');
  assert.equal(paths.dir, join('/data/arbiter', 'identity'));
  assert.equal(paths.users, join('/data/arbiter', 'identity', 'users.json'));
  assert.equal(paths.secret, join('/data/arbiter', 'identity', 'session.key'));
});

test('an absent store is an empty store, and a saved one round-trips', async (t) => {
  const dir = await withDataDir(t);
  assert.deepEqual(await loadUsers(dir), []);
  const user = createUser({ email: 'a@b.co', passwordHash: await hashPassword(GOOD_PASSWORD) });
  await saveUsers(dir, [user]);
  const loaded = await loadUsers(dir);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].id, user.id);
  assert.equal(await verifyPassword(GOOD_PASSWORD, loaded[0].passwordHash), true);
});

test('a record that could never authenticate is dropped instead of half-trusted', async (t) => {
  const dir = await withDataDir(t);
  const good = createUser({ email: 'good@b.co', passwordHash: await hashPassword(GOOD_PASSWORD) });
  const noHash = { ...good, id: 'other-id', email: 'nohash@b.co', passwordHash: '' };
  const badRole = { ...good, id: 'third-id', email: 'role@b.co', role: 'superuser' };
  await fsp.mkdir(identityPaths(dir).dir, { recursive: true });
  await fsp.writeFile(identityPaths(dir).users, JSON.stringify([good, noHash, badRole]), 'utf8');
  const loaded = await loadUsers(dir);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].email, 'good@b.co');
});

test('a corrupt user store is loud, not silently empty', async (t) => {
  const dir = await withDataDir(t);
  await fsp.mkdir(identityPaths(dir).dir, { recursive: true });
  await fsp.writeFile(identityPaths(dir).users, '{ this is not json', 'utf8');
  await assert.rejects(loadUsers(dir));

  await fsp.writeFile(identityPaths(dir).users, '{"users":[]}', 'utf8');
  await assert.rejects(loadUsers(dir), /must be a JSON array/);
});

test('the session secret is generated once and then reused', async (t) => {
  const dir = await withDataDir(t);
  const first = await loadOrCreateSessionSecret(dir);
  const second = await loadOrCreateSessionSecret(dir);
  assert.equal(first, second);
  assert.ok(first.length >= 43);
});

test('a short secret file is refused rather than silently rotated', async (t) => {
  const dir = await withDataDir(t);
  await fsp.mkdir(identityPaths(dir).dir, { recursive: true });
  await fsp.writeFile(identityPaths(dir).secret, 'too-short', 'utf8');
  await assert.rejects(loadOrCreateSessionSecret(dir), /corrupt or too short/);
});

test('a generated secret is actually usable for signing', async (t) => {
  const dir = await withDataDir(t);
  const secret = await loadOrCreateSessionSecret(dir);
  const token = createSession({ id: 'u1', sessionEpoch: 0 }, secret);
  assert.ok(verifySessionToken(token, secret));
});
