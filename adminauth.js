'use strict';
/**
 * Comptes personnels de l'administration : mot de passe (scrypt), double authentification TOTP (RFC 6238),
 * rôles (propriétaire / lecture seule / comptable), sessions, verrouillage après échecs, alerte e-mail de connexion.
 * La clé de secours ADMIN_API_KEY (en-tête x-admin-key) reste valable et équivaut à « propriétaire ».
 */
const crypto = require('crypto');

/* ---------- mots de passe ---------- */
const scrypt = (pw, salt, n = 16384) => new Promise((res, rej) => crypto.scrypt(pw, salt, 64, { N: n, maxmem: 64 * 1024 * 1024 }, (e, k) => (e ? rej(e) : res(k))));
async function hashPassword(pw) { const salt = crypto.randomBytes(16); const k = await scrypt(String(pw), salt); return `scrypt$16384$${salt.toString('hex')}$${k.toString('hex')}`; }
async function verifyPassword(pw, stored) {
  const [alg, n, salt, hash] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !salt || !hash) { await scrypt('x', Buffer.alloc(16)).catch(() => {}); return false; }   // durée comparable pour un compte inconnu
  const k = await scrypt(String(pw), Buffer.from(salt, 'hex'), +n), h = Buffer.from(hash, 'hex');
  return k.length === h.length && crypto.timingSafeEqual(k, h);
}
const strongEnough = (pw, email) => typeof pw === 'string' && pw.length >= 12 && pw.length <= 200 && pw.toLowerCase() !== String(email || '').toLowerCase();
const tempPassword = () => { const A = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'; const b = crypto.randomBytes(16); let s = ''; for (let i = 0; i < 16; i++) s += A[b[i] % A.length]; return s; };

/* ---------- TOTP ---------- */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const b32encode = (buf) => { let bits = '', out = ''; for (const x of buf) bits += x.toString(2).padStart(8, '0'); for (let i = 0; i < bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)]; return out; };
const b32decode = (s) => { let bits = ''; for (const c of String(s).replace(/[\s=]/g, '').toUpperCase()) { const v = B32.indexOf(c); if (v < 0) throw new Error('base32'); bits += v.toString(2).padStart(5, '0'); } const out = []; for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2)); return Buffer.from(out); };
function hotp(secretB32, counter, digits = 6) {
  const c = Buffer.alloc(8); c.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', b32decode(secretB32)).update(c).digest(), o = h[h.length - 1] & 15;
  const code = ((h[o] & 0x7f) << 24 | h[o + 1] << 16 | h[o + 2] << 8 | h[o + 3]) % 10 ** digits;
  return String(code).padStart(digits, '0');
}
const totpStep = (t = Date.now()) => Math.floor(t / 30000);
/** Renvoie le pas (step) valide ou null. Fenêtre ±1 pas (±30 s). */
function verifyTotp(secretB32, code, t = Date.now()) {
  const c = String(code || '').replace(/\s/g, ''); if (!/^\d{6}$/.test(c)) return null;
  const s = totpStep(t);
  for (const d of [0, -1, 1]) { const a = Buffer.from(hotp(secretB32, s + d)), b = Buffer.from(c); if (crypto.timingSafeEqual(a, b)) return s + d; }
  return null;
}
const newSecret = () => b32encode(crypto.randomBytes(20));

/* ---------- permissions ---------- */
const ROLES = ['owner', 'viewer', 'accountant'];
const EXPORTS_PERSONAL = ['/marketing/export', '/accounting/export', '/accounting/monthly'];
function can(role, method, rel) {
  if (/^\/auth(\/|$)/.test(rel)) return true;
  if (role === 'owner') return true;
  if (/^\/team(\/|$)/.test(rel)) return false;
  if (role === 'viewer') return method === 'GET' && !EXPORTS_PERSONAL.some((p) => rel === p || rel.startsWith(p + '/'));
  if (role === 'accountant') return (/^\/accounting(\/|$)/.test(rel) && (method === 'GET' || method === 'POST')) || (method === 'GET' && /^\/(orders|stats|charts)(\/|$)/.test(rel));
  return false;
}

module.exports = function createAdminAuth({ supabase, mailer, env = process.env, nowIso = () => new Date().toISOString(), log = console, sessionHours = 12 }) {
  const sha = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
  const encKey = () => crypto.createHash('sha256').update('totp|' + (env.ADMIN_ENC_KEY || env.ADMIN_API_KEY || '')).digest();
  const enc = (plain) => { const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', encKey(), iv); const x = Buffer.concat([c.update(plain, 'utf8'), c.final()]); return 'v1.' + [iv, c.getAuthTag(), x].map((b) => b.toString('base64')).join('.'); };
  const dec = (s) => { const [v, iv, tag, x] = String(s || '').split('.'); if (v !== 'v1') throw new Error('secret illisible'); const d = crypto.createDecipheriv('aes-256-gcm', encKey(), Buffer.from(iv, 'base64')); d.setAuthTag(Buffer.from(tag, 'base64')); return Buffer.concat([d.update(Buffer.from(x, 'base64')), d.final()]).toString('utf8'); };
  const require2fa = () => env.ADMIN_REQUIRE_2FA === '1';
  const MAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  const pub = (u) => ({ id: u.id, email: u.email, name: u.name || '', role: u.role, totpEnabled: !!u.totp_enabled, mustChange: !!u.must_change, active: u.active !== false, lastLoginAt: u.last_login_at || null, locked: !!(u.locked_until && Date.parse(u.locked_until) > Date.now()) });
  const restricted = (u) => !!u.must_change || (require2fa() && !u.totp_enabled);
  const alert = (key, kind, to, tpl) => (mailer && to ? mailer.send({ key, kind, to, tpl }) : null);

  async function newSession(user, ip) {
    const token = crypto.randomBytes(32).toString('hex'), exp = new Date(Date.now() + sessionHours * 3600e3).toISOString();
    await supabase.from('admin_sessions').insert({ token_hash: sha(token), user_id: user.id, created_at: nowIso(), expires_at: exp, ip: String(ip || '').slice(0, 60) });
    await supabase.from('admin_sessions').delete().lt('expires_at', nowIso());                     // ménage des sessions expirées
    return { token, expiresAt: exp };
  }
  const revokeAll = (userId, exceptHash) => supabase.from('admin_sessions').delete().eq('user_id', userId).then(async () => {}, () => {});

  /** Identifie l'appelant : session personnelle (Bearer) ou clé de secours. */
  async function authenticate(req) {
    const h = String(req.headers.authorization || '');
    if (/^Bearer\s+/i.test(h)) {
      const tok = h.replace(/^Bearer\s+/i, '').trim();
      const { data: s } = await supabase.from('admin_sessions').select('*').eq('token_hash', sha(tok)).maybeSingle();
      if (!s || Date.parse(s.expires_at) < Date.now()) return { status: 401, error: 'SESSION_EXPIRED' };
      const { data: u } = await supabase.from('admin_users').select('*').eq('id', s.user_id).maybeSingle();
      if (!u || u.active === false) return { status: 401, error: 'SESSION_EXPIRED' };
      return { actor: u.email, role: u.role, userId: u.id, via: 'account', restricted: restricted(u), tokenHash: s.token_hash, user: u };
    }
    const key = env.ADMIN_API_KEY;
    if (req.headers['x-admin-key'] !== undefined) {
      if (!key || key.length < 32) return { status: 503, error: 'ADMIN_DISABLED' };
      const a = Buffer.from(String(req.headers['x-admin-key'] || '')), b = Buffer.from(key);
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) return { actor: String(req.headers['x-admin-actor'] || 'admin').replace(/[\u0000-\u001f]/g, ' ').slice(0, 60), role: 'owner', userId: null, via: 'key', restricted: false };
    }
    if (!key || key.length < 32) return { status: 503, error: 'ADMIN_DISABLED' };
    return { status: 401, error: 'Non autorisé.' };
  }

  async function login(req, res, next) {
    try {
      const b = req.body || {}, email = String(b.email || '').trim().toLowerCase(), pw = String(b.password || ''), code = b.code;
      if (!MAIL.test(email) || !pw) return res.status(400).json({ error: 'CREDENTIALS_REQUIRED' });
      const { data: u } = await supabase.from('admin_users').select('*').eq('email', email).maybeSingle();
      if (!u || u.active === false) { await verifyPassword(pw, null); return res.status(401).json({ error: 'INVALID_CREDENTIALS' }); }
      if (u.locked_until && Date.parse(u.locked_until) > Date.now()) return res.status(423).json({ error: 'LOCKED', until: u.locked_until });
      const fail = async (error) => {
        const n = (u.failed_count || 0) + 1, lock = n >= 5;
        await supabase.from('admin_users').update({ failed_count: lock ? 0 : n, locked_until: lock ? new Date(Date.now() + 15 * 60e3).toISOString() : null }).eq('id', u.id);
        if (lock) { alert('admin_locked:' + u.id + ':' + Date.now(), 'admin_locked', [u.email, env.ADMIN_EMAIL].filter(Boolean), mailer.T.adminLocked({ email: u.email, ip: req.ip })); return res.status(423).json({ error: 'LOCKED', until: new Date(Date.now() + 15 * 60e3).toISOString() }); }
        return res.status(401).json({ error, left: 5 - n });
      };
      if (!(await verifyPassword(pw, u.pass_hash))) return fail('INVALID_CREDENTIALS');
      if (u.totp_enabled) {
        if (!code) return res.json({ needCode: true });
        let step = null; try { step = verifyTotp(dec(u.totp_secret), code); } catch (e) { step = null; }
        if (step == null || (u.last_totp_step != null && step <= u.last_totp_step)) return fail('INVALID_CODE');   // un code ne sert qu'une fois
        await supabase.from('admin_users').update({ last_totp_step: step }).eq('id', u.id);
      }
      await supabase.from('admin_users').update({ failed_count: 0, locked_until: null, last_login_at: nowIso() }).eq('id', u.id);
      const s = await newSession(u, req.ip);
      alert('admin_login:' + u.id + ':' + Date.now(), 'admin_login', u.email, mailer.T.adminLogin({ email: u.email, ip: req.ip, at: nowIso() }));
      res.json({ ...s, user: pub(u), restricted: restricted(u) });
    } catch (e) { next(e); }
  }

  /** Routes protégées /auth/* et /team/* (le contrôle d'accès est fait avant, par authenticate + can). */
  function mount(r, json, audit) {
    const needAccount = (req, res) => { if (req.admin.via !== 'account') { res.status(400).json({ error: 'KEY_ACCOUNT', message: 'Cette action concerne un compte personnel.' }); return false; } return true; };
    r.get('/api/admin/auth/me', (req, res) => {
      const a = req.admin;
      res.json({ via: a.via, email: a.via === 'account' ? a.user.email : null, name: a.via === 'account' ? a.user.name || '' : a.actor, role: a.role, totpEnabled: a.via === 'account' ? !!a.user.totp_enabled : null, mustChange: a.via === 'account' ? !!a.user.must_change : false, restricted: a.restricted, require2fa: require2fa() });
    });
    r.post('/api/admin/auth/logout', async (req, res, next) => { try { if (req.admin.tokenHash) await supabase.from('admin_sessions').delete().eq('token_hash', req.admin.tokenHash); res.json({ ok: true }); } catch (e) { next(e); } });
    r.post('/api/admin/auth/password', json, async (req, res, next) => {
      try {
        if (!needAccount(req, res)) return; const u = req.admin.user, b = req.body || {};
        if (!(await verifyPassword(String(b.current || ''), u.pass_hash))) return res.status(401).json({ error: 'INVALID_CREDENTIALS' });
        if (!strongEnough(b.newPassword, u.email)) return res.status(400).json({ error: 'PASSWORD_WEAK' });
        if (b.newPassword === b.current) return res.status(400).json({ error: 'PASSWORD_SAME' });
        await supabase.from('admin_users').update({ pass_hash: await hashPassword(b.newPassword), must_change: false }).eq('id', u.id);
        await supabase.from('admin_sessions').delete().eq('user_id', u.id).neq('token_hash', req.admin.tokenHash);
        audit(req, 'admin_password', u.email, {}); res.json({ ok: true });
      } catch (e) { next(e); }
    });
    r.post('/api/admin/auth/2fa/start', json, async (req, res, next) => {
      try {
        if (!needAccount(req, res)) return; const u = req.admin.user;
        if (u.totp_enabled) return res.status(409).json({ error: 'ALREADY_ENABLED' });
        const secret = newSecret(); await supabase.from('admin_users').update({ totp_secret: enc(secret), last_totp_step: null }).eq('id', u.id);
        const issuer = encodeURIComponent(env.BRAND_NAME || 'EuroVin');
        res.json({ secret, otpauth: `otpauth://totp/${issuer}:${encodeURIComponent(u.email)}?secret=${secret}&issuer=${issuer}&digits=6&period=30` });
      } catch (e) { next(e); }
    });
    r.post('/api/admin/auth/2fa/confirm', json, async (req, res, next) => {
      try {
        if (!needAccount(req, res)) return; const u = req.admin.user;
        if (u.totp_enabled || !u.totp_secret) return res.status(409).json({ error: 'NOT_PENDING' });
        let step = null; try { step = verifyTotp(dec(u.totp_secret), (req.body || {}).code); } catch (e) { step = null; }
        if (step == null) return res.status(400).json({ error: 'INVALID_CODE' });
        await supabase.from('admin_users').update({ totp_enabled: true, last_totp_step: step }).eq('id', u.id);
        audit(req, 'admin_2fa_on', u.email, {}); res.json({ ok: true });
      } catch (e) { next(e); }
    });
    r.post('/api/admin/auth/2fa/disable', json, async (req, res, next) => {
      try {
        if (!needAccount(req, res)) return; const u = req.admin.user;
        if (require2fa()) return res.status(409).json({ error: '2FA_REQUIRED', message: 'La double authentification est obligatoire.' });
        if (!(await verifyPassword(String((req.body || {}).password || ''), u.pass_hash))) return res.status(401).json({ error: 'INVALID_CREDENTIALS' });
        await supabase.from('admin_users').update({ totp_enabled: false, totp_secret: null, last_totp_step: null }).eq('id', u.id);
        audit(req, 'admin_2fa_off', u.email, {}); res.json({ ok: true });
      } catch (e) { next(e); }
    });

    // Équipe (propriétaire uniquement, imposé par can()).
    r.get('/api/admin/team', async (req, res, next) => {
      try { const { data, error } = await supabase.from('admin_users').select('*').order('created_at', { ascending: true }).limit(100); if (error) throw error; res.json({ users: (data || []).map(pub), require2fa: require2fa() }); } catch (e) { next(e); }
    });
    r.post('/api/admin/team', json, async (req, res, next) => {
      try {
        const b = req.body || {}, email = String(b.email || '').trim().toLowerCase(), role = b.role, name = String(b.name || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 60);
        if (!MAIL.test(email)) return res.status(400).json({ error: 'EMAIL_INVALID' });
        if (!ROLES.includes(role)) return res.status(400).json({ error: 'ROLE_INVALID' });
        const { data: ex } = await supabase.from('admin_users').select('id').eq('email', email).maybeSingle();
        if (ex) return res.status(409).json({ error: 'EMAIL_EXISTS' });
        const temp = tempPassword();
        const { data, error } = await supabase.from('admin_users').insert({ email, name, role, pass_hash: await hashPassword(temp), must_change: true, active: true, created_at: nowIso() }).select().single();
        if (error) throw error;
        audit(req, 'team_add', email, { role }); res.status(201).json({ user: pub(data), tempPassword: temp });
      } catch (e) { next(e); }
    });
    r.patch('/api/admin/team/:id', json, async (req, res, next) => {
      try {
        const b = req.body || {}, id = req.params.id;
        const { data: u } = await supabase.from('admin_users').select('*').eq('id', id).maybeSingle(); if (!u) return res.status(404).json({ error: 'Introuvable.' });
        const self = req.admin.userId === u.id, patch = {}, out = {};
        if (b.role !== undefined) { if (!ROLES.includes(b.role)) return res.status(400).json({ error: 'ROLE_INVALID' }); if (self && b.role !== u.role) return res.status(409).json({ error: 'SELF' }); patch.role = b.role; }
        if (b.active !== undefined) { if (self && b.active === false) return res.status(409).json({ error: 'SELF' }); patch.active = b.active === true; }
        if (b.resetPassword === true) { const t = tempPassword(); patch.pass_hash = await hashPassword(t); patch.must_change = true; patch.failed_count = 0; patch.locked_until = null; out.tempPassword = t; }
        if (b.reset2fa === true) { patch.totp_enabled = false; patch.totp_secret = null; patch.last_totp_step = null; }
        if (b.unlock === true) { patch.failed_count = 0; patch.locked_until = null; }
        if (!Object.keys(patch).length) return res.status(400).json({ error: 'NOTHING' });
        await supabase.from('admin_users').update(patch).eq('id', id);
        if (patch.active === false || patch.role || patch.pass_hash || b.reset2fa) await revokeAll(id);
        audit(req, 'team_update', u.email, { ...Object.fromEntries(Object.entries(patch).filter(([k]) => ['role', 'active'].includes(k))), resetPassword: !!patch.pass_hash, reset2fa: !!b.reset2fa });
        const { data: after } = await supabase.from('admin_users').select('*').eq('id', id).maybeSingle();
        res.json({ user: pub(after), ...out });
      } catch (e) { next(e); }
    });
  }

  return { authenticate, login, mount, can, pub };
};
Object.assign(module.exports, { hashPassword, verifyPassword, hotp, verifyTotp, totpStep, newSecret, b32encode, b32decode, can, strongEnough, ROLES });
