require('dotenv').config();
const express = require('express');
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');

const app       = express();
const PORT      = process.env.PORT    || 3100;
const DATA_FILE = process.env.DB_PATH || './data.json';

// MySQL pool — only created when DATABASE_URL is provided (production)
let pool = null;
if (process.env.DATABASE_URL) {
  const mysql = require('mysql2/promise');
  pool = mysql.createPool(process.env.DATABASE_URL);
}

// Hosts in SETUP.md (nginx, cPanel/Plesk, Railway/Fly/Render) all sit behind a
// proxy. Needed so req.secure and req.ip reflect the real client connection.
app.set('trust proxy', 1);

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Math.random().toString(36) occasionally yields a short string (0.5 -> "i"),
// which produced 1-character ids. Fixed width, from a real random source.
const uid = () => crypto.randomBytes(6).toString('hex');

// ─── Seed data ────────────────────────────────────────────────────────────────
// name is bilingual — { en, zh } — so a meeting or group can display in either
// language without being recreated. The seed only ships an English string on
// both sides; a real admin fills in the other language from the UI.
const bilingual = (s) => ({ en: s, zh: s });
const SEED = {
  meetings: [
    { id:'m1', name:bilingual("Lord's Meeting"),      dayOfWeek:0 },
    { id:'m2', name:bilingual('Small Group Meeting'), dayOfWeek:5 },
  ],
  groups: [
    { id:'g1', name:bilingual('Worship Team'), meetingIds:['m1'], memberIds:['p1','p2','p3'] },
    { id:'g2', name:bilingual('Youth Group'),  meetingIds:['m1'], memberIds:['p4','p5','p6'] },
    { id:'g3', name:bilingual('Alpha Group'),  meetingIds:['m2'], memberIds:['p1','p3','p5'] },
    { id:'g4', name:bilingual('Beta Group'),   meetingIds:['m2'], memberIds:['p2','p4','p6'] },
  ],
  people: [
    { id:'p1', firstName:'John',    lastName:'Doe',      phone:'555-0101' },
    { id:'p2', firstName:'Jane',    lastName:'Smith',    phone:'555-0102' },
    { id:'p3', firstName:'Robert',  lastName:'Johnson',  phone:'555-0103' },
    { id:'p4', firstName:'Emily',   lastName:'Davis',    phone:'555-0104' },
    { id:'p5', firstName:'Michael', lastName:'Wilson',   phone:'555-0105' },
    { id:'p6', firstName:'Sarah',   lastName:'Martinez', phone:'555-0106' },
  ],
  attendance: [],
};

// ─── Persistence helpers ──────────────────────────────────────────────────────
async function initDb() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_store (
      id   INT  PRIMARY KEY DEFAULT 1,
      data JSON NOT NULL
    )
  `);
}

async function load() {
  if (pool) {
    const [rows] = await pool.query('SELECT data FROM app_store WHERE id = 1');
    if (rows.length) {
      const data = rows[0].data;
      return typeof data === 'string' ? JSON.parse(data) : data;
    }
    return JSON.parse(JSON.stringify(SEED));
  }
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return JSON.parse(JSON.stringify(SEED));
  }
}

async function persist(data) {
  if (pool) {
    await pool.query(
      'INSERT INTO app_store (id, data) VALUES (1, ?) ON DUPLICATE KEY UPDATE data = VALUES(data)',
      [JSON.stringify(data)]
    );
    return;
  }
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// ─── In-memory store ──────────────────────────────────────────────────────────
let store;

// ─── Write path ───────────────────────────────────────────────────────────────
// Errors thrown with this are reported to the client; anything else becomes a
// generic 500 so internal details stay server-side.
class HttpError extends Error {
  constructor(status, message, details) { super(message); this.status = status; this.details = details; }
}

// Wraps an async handler so a rejected promise reaches the error middleware.
// Without this, Express 4 leaves the rejection unhandled and Node exits — one
// failed write would take the whole server down for everyone.
const route = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// All writes go through here, one at a time. The mutation is applied to a copy
// which is persisted before being swapped in, so a failed write leaves the
// in-memory store exactly as it was rather than silently diverging from disk.
// Serializing also stops two overlapping requests from clobbering each other:
// each mutator sees the previous one's result.
let writeQueue = Promise.resolve();

function commit(mutate) {
  const done = writeQueue.then(async () => {
    const next   = structuredClone(store);
    const result = mutate(next);
    await persist(next);
    store = next;
    return result;
  });
  // Swallow failures for the queue's own chain only — `done` still rejects for
  // the caller, but a rejection here must not poison later commits.
  writeQueue = done.then(() => {}, () => {});
  return done;
}

// ─── Auth ─────────────────────────────────────────────────────────────────────
// Four roles, each a superset of the one before it. All enforced here on the
// server — the client can hide buttons but cannot grant itself anything.
//
//   pending  nothing at all — just registered, waiting for an admin
//   viewer   read-only — see meetings, groups, rosters and attendance history,
//              but cannot record, change or delete an attendance record
//   super    + record attendance, create/rename/delete groups, manage who is
//              in them, create and edit people, CSV import
//   admin    + archive people, create/delete meetings, manage accounts
//
// A person is archived rather than deleted, so archiving rewrites what history
// shows — that stays with admins. Meetings are the top-level structure, so those
// stay with admins too.
const ROLES = ['pending', 'viewer', 'super', 'admin'];
const rank  = (role) => ROLES.indexOf(role);

// Each person has their own account. Roles are assigned by admins, so there is
// no such thing as a "super user password" — there are many super users, each
// with their own credentials.
//
// Anyone may register, but a new account starts as 'pending' and can see nothing
// until an admin gives it a role. That keeps sign-up open without publishing the
// roster (and everyone's phone number) to whoever finds the URL.
//
// ADMIN_PASSWORD is a break-glass admin login that works with no account at all,
// so losing every admin account is recoverable.
const IS_PROD        = process.env.NODE_ENV === 'production' || !!process.env.DATABASE_URL;
const COOKIE_NAME    = 'at_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;   // 30 days
const DEV_ADMIN_PASSWORD = 'admin1234';

function resolveAuth() {
  const missing = ['ADMIN_PASSWORD', 'SESSION_SECRET'].filter(k => !process.env[k]);
  if (missing.length && IS_PROD) {
    console.error(
      `\nRefusing to start: missing required environment variable(s): ${missing.join(', ')}.\n` +
      `Set them in your host's environment settings — see SETUP.md → Authentication.\n`
    );
    process.exit(1);
  }
  if (missing.length) {
    console.warn(
      `\n⚠  DEVELOPMENT AUTH DEFAULTS IN USE — ${missing.join(', ')} not set.\n` +
      `   admin password: "${DEV_ADMIN_PASSWORD}"  (break-glass admin sign-in)\n` +
      `   Sessions reset on restart. Never deploy without setting these.\n`
    );
  }
  return {
    adminPassword: process.env.ADMIN_PASSWORD || DEV_ADMIN_PASSWORD,
    secret:        process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  };
}
const AUTH = resolveAuth();

// Constant-time comparison. Both sides are hashed first so that equal-length
// buffers are always compared and no information leaks via input length.
function passwordMatches(input, expected) {
  if (typeof input !== 'string' || !input) return false;
  const a = crypto.createHash('sha256').update(input).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

// ─── Account passwords ────────────────────────────────────────────────────────
// scrypt with a per-user salt. Deliberately slow, so a stolen data.json does not
// hand over everyone's password. Async so a login doesn't block the event loop.
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const MIN_PASSWORD_LENGTH = 8;

const derive = (password, salt) => new Promise((resolve, reject) =>
  crypto.scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p },
    (err, key) => (err ? reject(err) : resolve(key.toString('hex'))))
);

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: await derive(password, salt) };
}

async function verifyPassword(password, user) {
  if (typeof password !== 'string' || !password || !user || !user.salt || !user.hash) return false;
  const candidate = Buffer.from(await derive(password, user.salt), 'hex');
  const expected  = Buffer.from(user.hash, 'hex');
  if (candidate.length !== expected.length) return false;
  return crypto.timingSafeEqual(candidate, expected);
}

// Usernames are matched case-insensitively but displayed as typed.
const normaliseUsername = (u) => String(u || '').trim().toLowerCase();
const findUser   = (data, username) => (data.users || []).find(u => u.username === normaliseUsername(username));
const findUserId = (data, id) => (data.users || []).find(u => u.id === id);

// Never send salt/hash to a client, not even to an admin.
const publicUser = (u) => ({
  id: u.id, username: u.username, displayName: u.displayName || u.username,
  role: u.role, active: u.active !== false, createdAt: u.createdAt || null,
});

// A user's own "focus groups" — which groups float to the top of a meeting's
// group list for them, everything else collapsed under "Others". Purely a
// personal display preference, not a permission: it never limits which groups
// a user can actually see or record attendance for.
const focusGroupIds = (u) => (u && Array.isArray(u.focusGroupIds)) ? u.focusGroupIds : [];

// A super/admin's own pick of groups for the "Overall Attendance Trend" chart
// in History — personal to that account, like focusGroupIds above, not a
// shared app setting. Every super/admin sets up their own; nothing here
// restricts what they can see or record.
const trendGroupIds = (u) => (u && Array.isArray(u.trendGroupIds)) ? u.trendGroupIds : [];

// Which half of a name leads every roster for this user — 'last' (the default,
// how printed member lists read) or 'first'. Personal like the two above: it
// reorders what they see and nothing else.
const MEMBER_SORTS = ['last', 'first'];
const memberSort = (u) => (u && MEMBER_SORTS.includes(u.memberSort)) ? u.memberSort : 'last';

function validateCredentials(username, password) {
  const name = normaliseUsername(username);
  if (!/^[a-z0-9._-]{3,32}$/.test(name)) {
    throw new HttpError(400, 'Username must be 3-32 characters, using letters, numbers, dot, dash or underscore.');
  }
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new HttpError(400, `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  return name;
}

// Stateless signed session token: base64url(payload).hmac — no server-side
// session table needed, which keeps the single-JSON-blob storage model intact.
const signPayload = (payload) =>
  crypto.createHmac('sha256', AUTH.secret).update(payload).digest('base64url');

const sign = (payload) => {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${signPayload(body)}`;
};

// Account sessions carry the user id and a session version, never the role — the
// role is read from the store on every request, so promoting, demoting or
// deactivating someone takes effect immediately instead of 30 days from now.
// Bumping the user's sessionVersion (on password change) invalidates their old
// cookies without touching anyone else's.
const issueUserToken = (user) =>
  sign({ uid: user.id, sv: user.sessionVersion || 1, exp: Date.now() + SESSION_TTL_MS });

// The break-glass session is bound to a fingerprint of ADMIN_PASSWORD, so
// rotating that env var immediately invalidates any outstanding one.
const adminFingerprint = () =>
  crypto.createHash('sha256').update(AUTH.adminPassword).digest('hex').slice(0, 16);

const issueBreakGlassToken = () =>
  sign({ bg: adminFingerprint(), exp: Date.now() + SESSION_TTL_MS });

// Verifies the signature and expiry only. Resolving a uid to a live role is
// resolveSession's job, because that needs the store.
function readToken(token) {
  if (typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot < 1) return null;
  const body = token.slice(0, dot);
  const sig  = Buffer.from(token.slice(dot + 1));
  const want = Buffer.from(signPayload(body));
  if (sig.length !== want.length || !crypto.timingSafeEqual(sig, want)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

// Turns a cookie into { role, userId, username, breakGlass } or null. Reading the
// role from the store on every request is what makes a role change or a
// deactivation take effect at once.
function resolveSession(req) {
  const payload = readToken(readCookie(req, COOKIE_NAME));
  if (!payload) return null;

  if (payload.bg) {
    // Constant-time compare so the fingerprint can't be probed byte by byte.
    const a = Buffer.from(String(payload.bg));
    const b = Buffer.from(adminFingerprint());
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    return { role: 'admin', userId: null, username: 'break-glass admin', breakGlass: true, focusGroupIds: [], trendGroupIds: [], memberSort: 'last' };
  }

  if (typeof payload.uid !== 'string') return null;
  const user = findUserId(store, payload.uid);
  if (!user || user.active === false) return null;
  if ((user.sessionVersion || 1) !== payload.sv) return null;
  if (!ROLES.includes(user.role)) return null;
  return {
    role: user.role, userId: user.id,
    username: user.displayName || user.username, breakGlass: false,
    focusGroupIds: focusGroupIds(user),
    trendGroupIds: trendGroupIds(user),
    memberSort:    memberSort(user),
  };
}

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

function setSessionCookie(req, res, token) {
  res.setHeader('Set-Cookie', [
    `${COOKIE_NAME}=${token}`,
    'Path=/', 'HttpOnly', 'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
    ...(req.secure ? ['Secure'] : []),
  ].join('; '));
}

function clearSessionCookie(req, res) {
  res.setHeader('Set-Cookie', [
    `${COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0',
    ...(req.secure ? ['Secure'] : []),
  ].join('; '));
}

// ─── Login throttling ─────────────────────────────────────────────────────────
const LOGIN_MAX_ATTEMPTS = 10;
const LOGIN_WINDOW_MS    = 15 * 60 * 1000;
const loginAttempts      = new Map();   // ip -> { count, first }

function pruneAttempts(now) {
  for (const [ip, rec] of loginAttempts) {
    if (now - rec.first > LOGIN_WINDOW_MS) loginAttempts.delete(ip);
  }
}

function loginBlocked(ip) {
  const rec = loginAttempts.get(ip);
  if (!rec) return false;
  if (Date.now() - rec.first > LOGIN_WINDOW_MS) { loginAttempts.delete(ip); return false; }
  return rec.count >= LOGIN_MAX_ATTEMPTS;
}

function noteLoginFailure(ip) {
  const now = Date.now();
  if (loginAttempts.size > 5000) pruneAttempts(now);
  const rec = loginAttempts.get(ip);
  if (!rec || now - rec.first > LOGIN_WINDOW_MS) loginAttempts.set(ip, { count: 1, first: now });
  else rec.count++;
}

// ─── Auth middleware ──────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const session = resolveSession(req);
  if (!session) return res.status(401).json({ error: 'Not signed in' });
  req.session = session;
  next();
}

// Roles are ordered, so one check covers "this role or anything above it".
const DENIED = {
  viewer: 'Your account is waiting for an admin to give you access.',
  super:  'Super user access required',
  admin:  'Admin access required',
};
function atLeast(role) {
  const needed = rank(role);
  return (req, res, next) => {
    if (rank(req.session.role) < needed) return res.status(403).json({ error: DENIED[role] });
    next();
  };
}
// A pending account is signed in but has no access to anything yet, so even
// reading data has to clear this bar.
const requireViewer = atLeast('viewer');
const requireSuper  = atLeast('super');
const requireAdmin  = atLeast('admin');

// ─── Auth routes (public — must precede requireAuth) ──────────────────────────
// Reports current role so the client can render the right screen on load.
// Always 200 so the client can tell "signed out" from "server unreachable".
app.get('/api/session', (req, res) => {
  const session = resolveSession(req);
  res.json({
    authenticated: !!session,
    role:          session ? session.role : null,
    username:      session ? session.username : null,
    breakGlass:    session ? session.breakGlass : false,
    focusGroupIds: session ? session.focusGroupIds : [],
    trendGroupIds: session ? session.trendGroupIds : [],
    memberSort:    session ? session.memberSort : 'last',
  });
});

// Sign in with an account. The same generic message covers "no such user",
// "wrong password" and "deactivated", so the endpoint can't be used to discover
// which usernames exist.
app.post('/api/login', route(async (req, res) => {
  const ip = req.ip || 'unknown';
  if (loginBlocked(ip)) throw new HttpError(429, 'Too many failed attempts. Try again in 15 minutes.');

  const { username, password } = req.body || {};
  const user = findUser(store, username);
  const okPassword = await verifyPassword(password, user);

  if (!user || !okPassword || user.active === false) {
    noteLoginFailure(ip);
    throw new HttpError(401, 'Incorrect username or password');
  }
  loginAttempts.delete(ip);
  setSessionCookie(req, res, issueUserToken(user));
  res.json({
    role: user.role, username: user.displayName || user.username,
    focusGroupIds: focusGroupIds(user), trendGroupIds: trendGroupIds(user),
    memberSort: memberSort(user),
  });
}));

// Open registration: anyone may create an account. It lands as 'pending', which
// grants nothing until an admin assigns a role, so an open sign-up form never
// exposes the roster. Never trust a role sent by the client.
app.post('/api/register', route(async (req, res) => {
  const { username, password, displayName } = req.body || {};
  const name = validateCredentials(username, password);
  const { salt, hash } = await hashPassword(password);

  const created = await commit(s => {
    s.users = s.users || [];
    if (s.users.some(u => u.username === name)) {
      throw new HttpError(409, 'That username is already taken.');
    }
    const user = {
      id: uid(), username: name,
      displayName: String(displayName || username).trim().slice(0, 60) || name,
      salt, hash, role: 'pending', active: true,
      sessionVersion: 1, createdAt: new Date().toISOString(),
    };
    s.users.push(user);
    return user;
  });

  setSessionCookie(req, res, issueUserToken(created));
  res.json({ role: created.role, username: created.displayName, focusGroupIds: [], trendGroupIds: [], memberSort: 'last' });
}));

// Break-glass: signs in as an admin using ADMIN_PASSWORD with no account at all,
// so losing every admin account is still recoverable.
app.post('/api/login/break-glass', route(async (req, res) => {
  const ip = req.ip || 'unknown';
  if (loginBlocked(ip)) throw new HttpError(429, 'Too many failed attempts. Try again in 15 minutes.');

  if (!passwordMatches((req.body || {}).password, AUTH.adminPassword)) {
    noteLoginFailure(ip);
    throw new HttpError(401, 'Incorrect admin password');
  }
  loginAttempts.delete(ip);
  setSessionCookie(req, res, issueBreakGlassToken());
  res.json({ role: 'admin', username: 'break-glass admin', breakGlass: true, focusGroupIds: [], trendGroupIds: [], memberSort: 'last' });
}));

app.post('/api/logout', (req, res) => {
  clearSessionCookie(req, res);
  res.json({ ok: true });
});

// Everything past this point requires a valid session.
app.use('/api', requireAuth);

// ─── GET /api/data ────────────────────────────────────────────────────────────
// Explicit allow-list. `store` also holds `users`, and returning it wholesale
// would hand every signed-in viewer the salts and password hashes.
app.get('/api/data', requireViewer, (req, res) => res.json({
  meetings:   store.meetings,
  groups:     store.groups,
  people:     store.people,
  attendance: store.attendance,
}));

// ─── Users (admin only) ───────────────────────────────────────────────────────
// Everything here goes through publicUser, so no salt or hash ever leaves.
const countActiveAdmins = (data, excludeId) =>
  (data.users || []).filter(u => u.role === 'admin' && u.active !== false && u.id !== excludeId).length;

// Losing the last admin would leave nobody able to assign roles. Break-glass
// would still work, but silently painting yourself into that corner is a trap.
function assertNotLastAdmin(data, user, what) {
  if (user.role === 'admin' && user.active !== false && countActiveAdmins(data, user.id) === 0) {
    throw new HttpError(400, `${user.username} is the only active admin — promote someone else before you ${what}.`);
  }
}

app.get('/api/users', requireAdmin, (req, res) => {
  const users = (store.users || []).map(publicUser)
    .sort((a, b) => a.username.localeCompare(b.username));
  res.json({ users, self: req.session.userId, breakGlass: req.session.breakGlass });
});

// Admins can also create accounts directly, for anyone who can't self-register.
app.post('/api/users', requireAdmin, route(async (req, res) => {
  const { username, password, displayName, role = 'viewer' } = req.body || {};
  if (!ROLES.includes(role)) throw new HttpError(400, 'Unknown role');
  const name = validateCredentials(username, password);
  const { salt, hash } = await hashPassword(password);

  const id = await commit(s => {
    s.users = s.users || [];
    if (s.users.some(u => u.username === name)) throw new HttpError(409, 'That username is already taken.');
    const user = {
      id: uid(), username: name,
      displayName: String(displayName || username).trim().slice(0, 60) || name,
      salt, hash, role, active: true,
      sessionVersion: 1, createdAt: new Date().toISOString(),
    };
    s.users.push(user);
    return user.id;
  });
  res.json({ id });
}));

// Change role and/or activation.
app.patch('/api/users/:id', requireAdmin, route(async (req, res) => {
  const { role, active } = req.body || {};
  if (role !== undefined && !ROLES.includes(role)) throw new HttpError(400, 'Unknown role');
  if (active !== undefined && typeof active !== 'boolean') throw new HttpError(400, 'active must be true or false');

  await commit(s => {
    const user = findUserId(s, req.params.id);
    if (!user) throw new HttpError(404, 'User not found');

    const losingAdmin = (role !== undefined && role !== 'admin') || active === false;
    if (losingAdmin) {
      assertNotLastAdmin(s, user, role !== undefined && role !== 'admin' ? 'change their role' : 'deactivate them');
    }
    // An admin demoting or deactivating themselves would end their own session
    // mid-action. Allowed, but never for the last one — guarded above.
    if (role !== undefined)   user.role = role;
    if (active !== undefined) user.active = active;
    // Deactivating must take effect now, not whenever their cookie expires.
    if (active === false) user.sessionVersion = (user.sessionVersion || 1) + 1;
  });
  res.json({ ok: true });
}));

// Admin resets someone's password; signs that person out everywhere.
app.post('/api/users/:id/password', requireAdmin, route(async (req, res) => {
  const { password } = req.body || {};
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new HttpError(400, `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  const { salt, hash } = await hashPassword(password);
  await commit(s => {
    const user = findUserId(s, req.params.id);
    if (!user) throw new HttpError(404, 'User not found');
    user.salt = salt;
    user.hash = hash;
    user.sessionVersion = (user.sessionVersion || 1) + 1;
  });
  res.json({ ok: true });
}));

app.delete('/api/users/:id', requireAdmin, route(async (req, res) => {
  await commit(s => {
    const user = findUserId(s, req.params.id);
    if (!user) throw new HttpError(404, 'User not found');
    assertNotLastAdmin(s, user, 'delete them');
    s.users = s.users.filter(u => u.id !== req.params.id);
  });
  res.json({ ok: true });
}));

// ─── Own account ──────────────────────────────────────────────────────────────
// Requires the current password, so a borrowed unlocked screen can't be used to
// lock the real owner out. Break-glass has no account to change.
app.post('/api/me/password', route(async (req, res) => {
  if (req.session.breakGlass) {
    throw new HttpError(400, 'The break-glass admin has no account. Change ADMIN_PASSWORD in your host settings instead.');
  }
  const { currentPassword, newPassword } = req.body || {};
  if (typeof newPassword !== 'string' || newPassword.length < MIN_PASSWORD_LENGTH) {
    throw new HttpError(400, `New password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  const me = findUserId(store, req.session.userId);
  if (!me) throw new HttpError(404, 'User not found');
  if (!await verifyPassword(currentPassword, me)) throw new HttpError(401, 'Current password is incorrect');

  const { salt, hash } = await hashPassword(newPassword);
  const token = await commit(s => {
    const user = findUserId(s, req.session.userId);
    if (!user) throw new HttpError(404, 'User not found');
    user.salt = salt;
    user.hash = hash;
    user.sessionVersion = (user.sessionVersion || 1) + 1;
    return issueUserToken(user);
  });
  // Every other session for this account is now invalid; keep this one signed in.
  setSessionCookie(req, res, token);
  res.json({ ok: true });
}));

// Personal display preference: which groups float to the top of a meeting's
// group list for this user, everything else collapsed under "Others" until
// expanded. This never restricts what a user can see or record attendance
// for — every viewer still gets every group from GET /api/data.
app.patch('/api/me/focus-groups', requireViewer, route(async (req, res) => {
  if (req.session.breakGlass) {
    throw new HttpError(400, 'The break-glass admin has no account to save a preference against.');
  }
  const { groupIds } = req.body || {};
  if (!Array.isArray(groupIds) || groupIds.some(id => typeof id !== 'string')) {
    throw new HttpError(400, 'groupIds must be an array of strings');
  }
  const saved = await commit(s => {
    const user = findUserId(s, req.session.userId);
    if (!user) throw new HttpError(404, 'User not found');
    // Silently drop anything stale (a deleted group) rather than rejecting
    // the whole save — the client only ever sends ids it currently sees.
    const known = new Set(s.groups.map(g => g.id));
    user.focusGroupIds = [...new Set(groupIds)].filter(id => known.has(id));
    return user.focusGroupIds;
  });
  res.json({ focusGroupIds: saved });
}));

// A super/admin's own pick of groups for the "Overall Attendance Trend" chart
// in History — personal to their account, like focus-groups above, not a
// shared app setting. Each super/admin sets up their own; it never restricts
// what they can see or record.
app.patch('/api/me/trend-groups', requireSuper, route(async (req, res) => {
  if (req.session.breakGlass) {
    throw new HttpError(400, 'The break-glass admin has no account to save a preference against.');
  }
  const { groupIds } = req.body || {};
  if (!Array.isArray(groupIds) || groupIds.some(id => typeof id !== 'string')) {
    throw new HttpError(400, 'groupIds must be an array of strings');
  }
  const saved = await commit(s => {
    const user = findUserId(s, req.session.userId);
    if (!user) throw new HttpError(404, 'User not found');
    const known = new Set(s.groups.map(g => g.id));
    user.trendGroupIds = [...new Set(groupIds)].filter(id => known.has(id));
    return user.trendGroupIds;
  });
  res.json({ trendGroupIds: saved });
}));

// Which half of a name leads every roster for this user. Any signed-in account
// may set it — it changes the order they read, never what they can see.
app.patch('/api/me/member-sort', requireViewer, route(async (req, res) => {
  if (req.session.breakGlass) {
    throw new HttpError(400, 'The break-glass admin has no account to save a preference against.');
  }
  const { sort } = req.body || {};
  if (!MEMBER_SORTS.includes(sort)) {
    throw new HttpError(400, `sort must be one of: ${MEMBER_SORTS.join(', ')}`);
  }
  await commit(s => {
    const user = findUserId(s, req.session.userId);
    if (!user) throw new HttpError(404, 'User not found');
    user.memberSort = sort;
  });
  res.json({ memberSort: sort });
}));

// A meeting or group name is bilingual — { en, zh } — so it displays correctly
// under either language toggle without being recreated per language. Only one
// side is required; if the other is blank it mirrors the side that was given,
// so nothing ever renders empty. Editing later can fill in the missing side.
function normalizeBilingualName(name) {
  const en = String((name && name.en) || '').trim();
  const zh = String((name && name.zh) || '').trim();
  if (!en && !zh) return null;
  return { en: en || zh, zh: zh || en };
}

// ─── Meetings ─────────────────────────────────────────────────────────────────
// A meeting either falls on a fixed weekday or floats anywhere inside the week
// — small groups pick their own night — in which case dayOfWeek is null and the
// app reports the meeting by week instead of by date.
function parseDayOfWeek(dayOfWeek) {
  if (dayOfWeek == null || dayOfWeek === '') return null;
  const day = Number(dayOfWeek);
  if (!Number.isInteger(day) || day < 0 || day > 6) {
    throw new HttpError(400, 'dayOfWeek must be null, or a whole number from 0 (Sunday) to 6 (Saturday)');
  }
  return day;
}

app.post('/api/meetings', requireAdmin, route(async (req, res) => {
  const { name, dayOfWeek } = req.body || {};
  const day = parseDayOfWeek(dayOfWeek);
  const bilingualName = normalizeBilingualName(name);
  if (!bilingualName) throw new HttpError(400, 'name required');
  const id = await commit(s => {
    const meeting = { id: uid(), name: bilingualName, dayOfWeek: day };
    s.meetings.push(meeting);
    return meeting.id;
  });
  res.json({ id });
}));

app.put('/api/meetings/:id', requireAdmin, route(async (req, res) => {
  const { name, dayOfWeek } = req.body || {};
  const day = parseDayOfWeek(dayOfWeek);
  const bilingualName = normalizeBilingualName(name);
  if (!bilingualName) throw new HttpError(400, 'name required');
  await commit(s => {
    if (!s.meetings.some(m => m.id === req.params.id)) throw new HttpError(404, 'Meeting not found');
    s.meetings = s.meetings.map(m =>
      m.id === req.params.id ? { ...m, name: bilingualName, dayOfWeek: day } : m
    );
  });
  res.json({ ok: true });
}));

app.delete('/api/meetings/:id', requireAdmin, route(async (req, res) => {
  const { id } = req.params;
  await commit(s => {
    // A group can serve several meetings, so deleting one meeting only drops
    // that meeting from the group's list. A group left with no meetings at all
    // is removed too, along with its attendance history for this meeting.
    const unassigned = s.groups.map(g => ({ ...g, meetingIds: (g.meetingIds || []).filter(mid => mid !== id) }));
    const droppedGroupIds = unassigned.filter(g => g.meetingIds.length === 0).map(g => g.id);
    s.meetings   = s.meetings.filter(m => m.id !== id);
    s.groups     = unassigned.filter(g => g.meetingIds.length > 0);
    s.attendance = s.attendance.filter(a => a.meetingId !== id && !droppedGroupIds.includes(a.groupId));
  });
  res.json({ ok: true });
}));

// ─── Groups ───────────────────────────────────────────────────────────────────
// A group can be assigned to any number of meetings, so there is never a need
// to create the same group again for another meeting — assign the one group
// to both. A person still belongs to at most one group *per meeting* — someone
// can be on the Sunday worship team and in a Friday small group, but not in two
// Friday groups. Checked inside the commit so a concurrent write can't slip past it.
function assertNoMeetingConflict(data, memberIds, meetingIds, exceptGroupId) {
  for (const pid of memberIds) {
    const conflict = data.groups.find(g =>
      g.id !== exceptGroupId &&
      (g.meetingIds || []).some(mid => meetingIds.includes(mid)) &&
      (g.memberIds || []).includes(pid)
    );
    if (conflict) {
      const person = data.people.find(p => p.id === pid);
      const who = person ? `${person.firstName} ${person.lastName}` : 'That person';
      throw new HttpError(400, `${who} is already in "${conflict.name.en || conflict.name.zh}" for this meeting`);
    }
  }
}

function validateMeetingIds(s, meetingIds) {
  if (!Array.isArray(meetingIds) || meetingIds.length === 0) {
    throw new HttpError(400, 'meetingIds must be a non-empty array');
  }
  if (meetingIds.some(mid => !s.meetings.some(m => m.id === mid))) {
    throw new HttpError(400, 'Unknown meeting');
  }
}

app.post('/api/groups', requireSuper, route(async (req, res) => {
  const { name, meetingIds, memberIds = [] } = req.body || {};
  const bilingualName = normalizeBilingualName(name);
  if (!bilingualName) throw new HttpError(400, 'name required');
  if (!Array.isArray(memberIds)) throw new HttpError(400, 'memberIds must be an array');
  const id = await commit(s => {
    validateMeetingIds(s, meetingIds);
    assertNoMeetingConflict(s, memberIds, meetingIds, null);
    const group = { id: uid(), name: bilingualName, meetingIds, memberIds };
    s.groups.push(group);
    return group.id;
  });
  res.json({ id });
}));

app.put('/api/groups/:id', requireSuper, route(async (req, res) => {
  const { name, meetingIds, memberIds = [] } = req.body || {};
  const bilingualName = normalizeBilingualName(name);
  if (!bilingualName) throw new HttpError(400, 'name required');
  if (!Array.isArray(memberIds)) throw new HttpError(400, 'memberIds must be an array');
  await commit(s => {
    const existing = s.groups.find(g => g.id === req.params.id);
    if (!existing) throw new HttpError(404, 'Group not found');
    validateMeetingIds(s, meetingIds);
    assertNoMeetingConflict(s, memberIds, meetingIds, req.params.id);
    s.groups = s.groups.map(g =>
      g.id === req.params.id ? { ...g, name: bilingualName, meetingIds, memberIds } : g
    );
  });
  res.json({ ok: true });
}));

app.delete('/api/groups/:id', requireSuper, route(async (req, res) => {
  const { id } = req.params;
  await commit(s => {
    s.groups     = s.groups.filter(g => g.id !== id);
    s.attendance = s.attendance.filter(a => a.groupId !== id);
  });
  res.json({ ok: true });
}));

// ─── People ───────────────────────────────────────────────────────────────────
app.post('/api/people', requireSuper, route(async (req, res) => {
  const { firstName, lastName, phone = '' } = req.body || {};
  if (!firstName || !lastName) throw new HttpError(400, 'firstName and lastName required');
  const id = await commit(s => {
    const person = { id: uid(), firstName: String(firstName), lastName: String(lastName), phone: String(phone) };
    s.people.push(person);
    return person.id;
  });
  res.json({ id });
}));

app.put('/api/people/:id', requireSuper, route(async (req, res) => {
  const { firstName, lastName, phone = '' } = req.body || {};
  if (!firstName || !lastName) throw new HttpError(400, 'firstName and lastName required');
  await commit(s => {
    if (!s.people.some(p => p.id === req.params.id)) throw new HttpError(404, 'Person not found');
    s.people = s.people.map(p =>
      p.id === req.params.id
        ? { ...p, firstName: String(firstName), lastName: String(lastName), phone: String(phone) }
        : p
    );
  });
  res.json({ ok: true });
}));

app.post('/api/people/import', requireSuper, route(async (req, res) => {
  const { people = [] } = req.body || {};
  if (!Array.isArray(people)) throw new HttpError(400, 'people must be an array');
  const summary = await commit(s => {
    let added = 0, skipped = 0, groupsUpdated = 0, groupsNotFound = 0;
    for (const row of people) {
      const { firstName, lastName, phone = '', group: groupName } = row || {};
      if (!firstName || !lastName) { skipped++; continue; }
      let person = s.people.find(p =>
        p.firstName.toLowerCase() === String(firstName).toLowerCase() &&
        p.lastName.toLowerCase()  === String(lastName).toLowerCase()
      );
      if (!person) {
        person = { id: uid(), firstName: String(firstName), lastName: String(lastName), phone: String(phone) };
        s.people.push(person);
        added++;
      } else {
        // Re-importing someone who was archived brings them back rather than
        // creating a second person with the same name.
        if (person.archived) { delete person.archived; added++; } else { skipped++; }
      }
      if (groupName) {
        const wanted = String(groupName).toLowerCase();
        const grp = s.groups.find(g => [g.name.en, g.name.zh].some(n => n && n.toLowerCase() === wanted));
        if (grp) {
          grp.memberIds = grp.memberIds || [];
          const clash = s.groups.some(g =>
            g.id !== grp.id &&
            (g.meetingIds || []).some(mid => (grp.meetingIds || []).includes(mid)) &&
            (g.memberIds || []).includes(person.id)
          );
          if (!clash && !grp.memberIds.includes(person.id)) {
            grp.memberIds.push(person.id);
            groupsUpdated++;
          }
        } else {
          groupsNotFound++;
        }
      }
    }
    return { added, skipped, groupsUpdated, groupsNotFound };
  });
  res.json(summary);
}));

// Archive rather than remove. Attendance records keep pointing at this person,
// so past sessions still show their name and their totals stay correct. They
// drop out of every group and out of the pickers the client builds from
// `archived`. Deleting outright would silently rewrite historical percentages.
app.delete('/api/people/:id', requireAdmin, route(async (req, res) => {
  const { id } = req.params;
  await commit(s => {
    if (!s.people.some(p => p.id === id)) throw new HttpError(404, 'Person not found');
    s.people = s.people.map(p => (p.id === id ? { ...p, archived: true } : p));
    s.groups = s.groups.map(g => ({ ...g, memberIds: (g.memberIds || []).filter(m => m !== id) }));
  });
  res.json({ ok: true });
}));

// ─── Attendance ───────────────────────────────────────────────────────────────
// Recording attendance requires super (or admin) — a viewer can see every
// roster and every past session, but cannot record, change or delete one.
// Recording attendance is a blind upsert keyed on (meeting, group, date), so two
// leaders on the same session would overwrite each other with no warning. Callers
// send the `rev` they loaded; a mismatch means someone else saved in the meantime
// and we refuse with 409 plus the current state, rather than silently discarding
// their work. Omitting `rev` is only valid when creating a brand-new session.
app.post('/api/attendance', requireSuper, route(async (req, res) => {
  const { meetingId, groupId, date, records = [], rev } = req.body || {};
  if (!meetingId || !groupId || !date) throw new HttpError(400, 'meetingId, groupId, date required');
  if (rev != null && !Number.isInteger(rev)) throw new HttpError(400, 'rev must be an integer');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    throw new HttpError(400, 'date must be a valid YYYY-MM-DD date');
  }
  if (!Array.isArray(records)) throw new HttpError(400, 'records must be an array');

  const result = await commit(s => {
    const group = s.groups.find(g => g.id === groupId);
    if (!group) throw new HttpError(400, 'Unknown group');
    if (!(group.meetingIds || []).includes(meetingId)) throw new HttpError(400, 'Group does not belong to that meeting');

    // Only current members may be recorded, and only once each. Without this any
    // signed-in user could post arbitrary personIds into a group's history.
    const members = new Set(group.memberIds || []);
    const seen    = new Set();
    const clean   = [];
    for (const r of records) {
      const pid = r && r.personId;
      if (!members.has(pid)) throw new HttpError(400, 'records contain someone who is not in this group');
      if (seen.has(pid)) throw new HttpError(400, 'records contain a duplicate person');
      seen.add(pid);
      clean.push({ personId: pid, present: !!(r && r.present) });
    }

    const idx = s.attendance.findIndex(
      a => a.meetingId === meetingId && a.groupId === groupId && a.date === date
    );
    const current = idx >= 0 ? s.attendance[idx] : null;
    // Records written before revisions existed count as rev 0.
    const currentRev = current ? (current.rev || 0) : 0;

    if (rev == null ? !!current : rev !== currentRev) {
      throw new HttpError(409, 'Someone else saved this session while you were editing it.', {
        conflict: {
          rev:     currentRev,
          records: current ? current.records : [],
        },
      });
    }

    const entry = {
      id: current ? current.id : uid(),
      meetingId, groupId, date,
      records: clean,
      rev: currentRev + 1,
    };
    if (idx >= 0) s.attendance[idx] = entry;
    else s.attendance.push(entry);
    return { id: entry.id, rev: entry.rev };
  });
  res.json(result);
}));

// Edits an existing session in place — used to correct who attended, or to
// move it onto the date it should have been recorded under. Unlike the upsert
// above (keyed on meetingId+groupId+date), this targets one record by id, so
// changing its date moves that record rather than leaving a stale one behind
// on the old date and creating a second one on the new date.
app.patch('/api/attendance/:id', requireSuper, route(async (req, res) => {
  const { date, records = [], rev } = req.body || {};
  if (!date) throw new HttpError(400, 'date required');
  if (!Number.isInteger(rev)) throw new HttpError(400, 'rev must be an integer');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    throw new HttpError(400, 'date must be a valid YYYY-MM-DD date');
  }
  if (!Array.isArray(records)) throw new HttpError(400, 'records must be an array');

  const result = await commit(s => {
    const idx = s.attendance.findIndex(a => a.id === req.params.id);
    if (idx < 0) throw new HttpError(404, 'Attendance record not found');
    const existing = s.attendance[idx];

    const currentRev = existing.rev || 0;
    if (rev !== currentRev) {
      throw new HttpError(409, 'Someone else saved this session while you were editing it.', {
        conflict: { rev: currentRev, records: existing.records },
      });
    }

    const group = s.groups.find(g => g.id === existing.groupId);
    if (!group) throw new HttpError(400, 'Unknown group');

    const members = new Set(group.memberIds || []);
    const seen    = new Set();
    const clean   = [];
    for (const r of records) {
      const pid = r && r.personId;
      if (!members.has(pid)) throw new HttpError(400, 'records contain someone who is not in this group');
      if (seen.has(pid)) throw new HttpError(400, 'records contain a duplicate person');
      seen.add(pid);
      clean.push({ personId: pid, present: !!(r && r.present) });
    }

    // Moving onto a date that already has a recorded session for this same
    // meeting+group would silently merge two sessions into one.
    if (date !== existing.date) {
      const clash = s.attendance.some(a =>
        a.id !== existing.id && a.meetingId === existing.meetingId &&
        a.groupId === existing.groupId && a.date === date
      );
      if (clash) throw new HttpError(400, 'A session already exists on that date for this group.');
    }

    const entry = { ...existing, date, records: clean, rev: currentRev + 1 };
    s.attendance[idx] = entry;
    return { id: entry.id, rev: entry.rev };
  });
  res.json(result);
}));

// Removes a session outright — used to clear a stray or duplicate record left
// behind by a mistaken save, e.g. an old-dated row orphaned before edits moved
// to the by-id PATCH above.
app.delete('/api/attendance/:id', requireSuper, route(async (req, res) => {
  await commit(s => {
    if (!s.attendance.some(a => a.id === req.params.id)) throw new HttpError(404, 'Attendance record not found');
    s.attendance = s.attendance.filter(a => a.id !== req.params.id);
  });
  res.json({ ok: true });
}));

// ─── Unknown API paths ────────────────────────────────────────────────────────
// Answer with JSON rather than falling through to the SPA fallback, which would
// return an HTML page that the client's r.json() cannot parse.
app.all('/api/*', (req, res) => res.status(404).json({ error: 'Unknown endpoint' }));

// ─── SPA fallback ─────────────────────────────────────────────────────────────
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ─── Error handler ────────────────────────────────────────────────────────────
// Last line of defence: every write route funnels rejections here via route(),
// so a failed save returns an error to that one caller instead of crashing the
// process. Only HttpError messages are echoed back.
app.use((err, req, res, next) => {
  const status = err instanceof HttpError ? err.status : 500;
  if (status === 500) console.error(`${req.method} ${req.originalUrl} failed:`, err);
  if (res.headersSent) return next(err);
  res.status(status).json({
    error: status === 500 ? 'Could not save your change. Please try again.' : err.message,
    ...(err instanceof HttpError && err.details ? err.details : {}),
  });
});

// ─── One-time data repair ─────────────────────────────────────────────────────
// Before people were archived instead of deleted, removing someone left their
// attendance records behind with nothing to resolve them to — history then
// showed counts with no names against them (e.g. "3/3 present" listing nobody).
// Recreate those people as archived so the sessions read correctly again.
function repairOrphanedRecords(data) {
  const known   = new Set(data.people.map(p => p.id));
  const missing = new Set();
  for (const entry of data.attendance || []) {
    for (const rec of entry.records || []) {
      if (rec && rec.personId && !known.has(rec.personId)) missing.add(rec.personId);
    }
  }
  if (!missing.size) return false;
  for (const id of missing) {
    // Names are recoverable only for ids that came from the seed; anyone else
    // was created and deleted before archiving existed, so their name is gone.
    const seeded = SEED.people.find(p => p.id === id);
    data.people.push(seeded
      ? { ...seeded, archived: true }
      : { id, firstName: 'Former', lastName: `member (${id.slice(0, 4)})`, phone: '', archived: true });
  }
  console.log(`Repaired ${missing.size} deleted person/people referenced by attendance history (restored as archived).`);
  return true;
}

// Groups used to belong to exactly one meeting via a singular `meetingId`.
// Convert that to the `meetingIds` list a group now carries, so a store
// written before this change still loads correctly.
function migrateGroupMeetingIds(data) {
  let migrated = false;
  data.groups = (data.groups || []).map(g => {
    if (Array.isArray(g.meetingIds)) return g;
    migrated = true;
    const { meetingId, ...rest } = g;
    return { ...rest, meetingIds: meetingId ? [meetingId] : [] };
  });
  return migrated;
}

// Meeting and group names used to be a single string. Mirror that string onto
// both sides of the new { en, zh } shape, so a store written before this
// change still loads with a real name on both language toggles.
function migrateBilingualNames(data) {
  let migrated = false;
  const toBilingual = (name) => {
    if (name && typeof name === 'object') return name;
    migrated = true;
    return { en: String(name || ''), zh: String(name || '') };
  };
  data.meetings = (data.meetings || []).map(m => ({ ...m, name: toBilingual(m.name) }));
  data.groups   = (data.groups   || []).map(g => ({ ...g, name: toBilingual(g.name) }));
  return migrated;
}

// ─── Start ────────────────────────────────────────────────────────────────────
async function start() {
  await initDb();
  store = await load();
  // Tolerate a hand-edited file that's missing a top-level key.
  store = { meetings: [], groups: [], people: [], attendance: [], users: [], ...store };
  if (!Array.isArray(store.users)) store.users = [];
  // Both must run unconditionally — `||` would short-circuit the second once
  // the first finds something to migrate.
  const meetingIdsMigrated = migrateGroupMeetingIds(store);
  const namesMigrated      = migrateBilingualNames(store);
  if (meetingIdsMigrated || namesMigrated) await persist(store);
  if (store.users.length === 0) {
    console.log(
      'No user accounts yet. Sign in with the break-glass admin password (ADMIN_PASSWORD),\n' +
      'then create an admin account for yourself in Admin > Users. Anyone else can register\n' +
      'themselves from the sign-in screen; they stay Pending until you give them a role.'
    );
  }
  if (repairOrphanedRecords(store)) await persist(store);
  app.listen(PORT, () => console.log(`Attendance Tracker running on port ${PORT}`));
}

start().catch(err => { console.error('Failed to start:', err); process.exit(1); });
