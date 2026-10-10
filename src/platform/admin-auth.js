import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { encodePassword, verifyPasswordAsync } from '../auth.js';
import { checkPassword } from '../accounts.js';
import { ApiError } from '../http.js';
import { recordAudit } from './platform-db.js';
import { matchingTotpStep, newTotpSecret } from './totp.js';

const hash = (text) => createHash('sha256').update(text).digest('hex');
const DUMMY_HASH = encodePassword(randomBytes(32).toString('base64url'));
const RESTRICTED_MS = 5 * 60_000, IDLE_MS = 30 * 60_000, ABSOLUTE_MS = 4 * 60 * 60_000;
const denied = () => new ApiError(401, 'UNAUTHORIZED', 'Sign-in failed.');
const token = () => randomBytes(32).toString('base64url');
const iso = (stamp) => new Date(stamp).toISOString();
const context = (id) => `PLATFORM_TOTP:${id}`;
export function platformCookie(value, maxAge, name = 'platform_session') {
  return `${name}=${value}; HttpOnly; SameSite=Strict; Secure; Path=/api/v1/platform; Max-Age=${maxAge}`;
}
export function platformCookieFrom(request, name = 'platform_session') {
  const values = (request.headers.get('cookie') || '').split(';').map((part) => part.trim()).filter((part) => part.startsWith(`${name}=`));
  return values.length === 1 ? values[0].slice(name.length + 1) : null;
}
export function requirePlatformCsrf(request, csrf) {
  const sent = request.headers.get('x-csrf-token');
  const expected = Buffer.from(csrf), actual = Buffer.from(sent || '');
  if (typeof sent !== 'string' || actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new ApiError(403, 'FORBIDDEN', 'CSRF token is required.');
  }
}

export function createAdminAuth({ platform, secretBox, clock = Date.now }) {
  const stamp = () => iso(clock());
  const audit = (actor, action) => recordAudit(platform, { actor, action });
  async function createSession(adminId, stage) {
    const sessionToken = token(), csrfToken = token(), now = clock();
    const duration = stage === 'FULL' ? IDLE_MS : RESTRICTED_MS;
    await platform.run('DELETE FROM platform_session WHERE expires_at <= ? OR absolute_expires_at <= ?', iso(now), iso(now));
    await platform.run(`INSERT INTO platform_session(token_hash, admin_id, csrf_token, stage, expires_at, absolute_expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`, hash(sessionToken), adminId, csrfToken, stage, iso(now + duration), iso(now + (stage === 'FULL' ? ABSOLUTE_MS : duration)), iso(now));
    return { token: sessionToken, csrfToken, stage, maxAge: stage === 'FULL' ? ABSOLUTE_MS / 1000 : duration / 1000 };
  }
  async function session(sessionToken, full = false) {
    if (!sessionToken || !/^[A-Za-z0-9_-]{43}$/.test(sessionToken)) throw denied();
    const row = await platform.get(`SELECT s.*, a.username, a.totp_enabled, a.locked_until FROM platform_session s
      JOIN platform_admin a ON a.id = s.admin_id WHERE s.token_hash = ?`, hash(sessionToken));
    if (!row || row.expires_at <= stamp() || row.absolute_expires_at <= stamp() || (row.locked_until && row.locked_until > stamp())) throw denied();
    if (full && row.stage !== 'FULL') throw new ApiError(403, 'TOTP_REQUIRED', 'Confirm your authenticator first.');
    if (row.stage === 'FULL') await platform.run('UPDATE platform_session SET expires_at = ? WHERE token_hash = ?', iso(Math.min(clock() + IDLE_MS, Date.parse(row.absolute_expires_at))), row.token_hash);
    return row;
  }
  async function fail(admin) {
    if (admin) {
      const attempts = admin.locked_until && admin.locked_until <= stamp() ? 1 : admin.failed_attempts + 1;
      await platform.run('UPDATE platform_admin SET failed_attempts = ?, locked_until = ?, updated_at = ? WHERE id = ?', attempts,
        attempts >= 5 ? iso(clock() + 15 * 60_000) : null, stamp(), admin.id);
    }
    await audit(admin?.username || 'unknown', 'LOGIN_FAILED');
    return null;
  }
  async function recoveryCodes(adminId) {
    await platform.run('DELETE FROM platform_recovery_code WHERE admin_id = ?', adminId);
    const codes = [];
    for (let i = 0; i < 10; i++) {
      const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      const value = [...randomBytes(10)].map((byte) => alphabet[byte & 31]).join('');
      codes.push(`${value.slice(0, 5)}-${value.slice(5)}`);
      await platform.run('INSERT INTO platform_recovery_code(id, admin_id, code_hash, created_at) VALUES (?, ?, ?, ?)', randomUUID(), adminId, hash(value), stamp());
    }
    return codes;
  }
  return {
    session,
    async bootstrap(username, password) {
      checkPassword(password, 'password', username);
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/.test(username)) throw new Error('Invalid platform administrator username.');
      await platform.transaction(async () => {
        if (await platform.get('SELECT 1 AS found FROM platform_admin LIMIT 1')) return;
        await platform.run('INSERT INTO platform_admin(id, username, username_key, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
          randomUUID(), username, username.toLowerCase(), encodePassword(password), stamp(), stamp());
        await audit('host', 'ADMIN_BOOTSTRAP');
      });
    },
    loginChallenge() {
      const csrfToken = token();
      const sealed = secretBox.seal(JSON.stringify({ csrfToken, expires: clock() + RESTRICTED_MS }), 'PLATFORM_LOGIN');
      return { csrfToken, cookie: platformCookie(`${sealed.keyId}.${sealed.sealed.toString('base64url')}`, 300, 'platform_login') };
    },
    verifyLoginChallenge(request) {
      try {
        const raw = platformCookieFrom(request, 'platform_login');
        if (!raw || raw.length > 1024) throw new Error();
        const [keyId, sealed] = raw.split('.');
        const value = JSON.parse(secretBox.open(Buffer.from(sealed, 'base64url'), keyId, 'PLATFORM_LOGIN'));
        if (!Number.isFinite(value.expires) || value.expires <= clock() || typeof value.csrfToken !== 'string') throw new Error();
        requirePlatformCsrf(request, value.csrfToken);
      } catch { throw new ApiError(403, 'FORBIDDEN', 'Refresh the sign-in page.'); }
    },
    async password(username, password) {
      const result = await platform.transaction(async () => {
        const admin = typeof username === 'string' && username.length <= 64
          ? await platform.get('SELECT * FROM platform_admin WHERE username_key = ?', username.toLowerCase()) : null;
        const ok = await verifyPasswordAsync(typeof password === 'string' && password.length <= 256 ? password : '', admin?.password_hash || DUMMY_HASH);
        if (admin?.locked_until && admin.locked_until > stamp()) { await audit(admin.username, 'LOGIN_FAILED'); return null; }
        if (!ok || !admin) return fail(admin);
        // Only a completed second-factor sign-in clears failures. Knowing the password must not reset TOTP lockout.
        await audit(admin.username, 'LOGIN');
        return { ...await createSession(admin.id, 'PASSWORD'), totpEnabled: admin.totp_enabled === 1 };
      });
      if (!result) throw denied();
      return result;
    },
    async enrol(sessionToken) {
      return platform.transaction(async () => {
        const s = await session(sessionToken), admin = await platform.get('SELECT * FROM platform_admin WHERE id = ?', s.admin_id);
        if (s.stage !== 'PASSWORD' || admin.totp_enabled === 1) throw new ApiError(409, 'ALREADY_ENROLLED', 'Authenticator already enrolled.');
        if (!admin.totp_secret_sealed) {
          const sealed = secretBox.seal(newTotpSecret(), context(admin.id));
          await platform.run('UPDATE platform_admin SET totp_secret_sealed = ?, totp_key_id = ?, updated_at = ? WHERE id = ? AND totp_enabled = 0', sealed.sealed, sealed.keyId, stamp(), admin.id);
          admin.totp_secret_sealed = sealed.sealed; admin.totp_key_id = sealed.keyId;
        }
        const secret = secretBox.open(admin.totp_secret_sealed, admin.totp_key_id, context(admin.id));
        const issuer = 'Online Shopping';
        return { setupKey: secret, issuer, account: admin.username, uri: `otpauth://totp/${encodeURIComponent(`${issuer}:${admin.username}`)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30` };
      });
    },
    async confirm(sessionToken, input) {
      const result = await platform.transaction(async () => {
        const s = await session(sessionToken), admin = await platform.get('SELECT * FROM platform_admin WHERE id = ?', s.admin_id);
        if (s.stage !== 'PASSWORD') throw new ApiError(409, 'INVALID_STAGE', 'Start a new sign-in.');
        let action = 'LOGIN', step = null;
        if (input.recoveryCode && admin.totp_enabled === 1) {
          const code = typeof input.recoveryCode === 'string' ? input.recoveryCode.toUpperCase().replace('-', '') : '';
          if (!/^[A-HJ-NP-Z2-9]{10}$/.test(code)) return fail(admin);
          const recovery = await platform.get('SELECT id FROM platform_recovery_code WHERE admin_id = ? AND code_hash = ? AND used_at IS NULL', admin.id, hash(code));
          if (!recovery) return fail(admin);
          await platform.run('UPDATE platform_recovery_code SET used_at = ? WHERE id = ? AND used_at IS NULL', stamp(), recovery.id);
          action = 'RECOVERY_USED';
        } else {
          if (!admin.totp_secret_sealed) return fail(admin);
          step = matchingTotpStep(secretBox.open(admin.totp_secret_sealed, admin.totp_key_id, context(admin.id)), input.code, clock(), admin.totp_last_step);
          if (step === null) return fail(admin);
          if (admin.totp_enabled === 0) action = 'TOTP_ENROLLED';
          await platform.run('UPDATE platform_admin SET totp_enabled = 1, totp_last_step = ? WHERE id = ? AND COALESCE(totp_last_step, -1) < ?', step, admin.id, step);
        }
        await platform.run('UPDATE platform_admin SET failed_attempts = 0, locked_until = NULL, updated_at = ? WHERE id = ?', stamp(), admin.id);
        await platform.run('DELETE FROM platform_session WHERE token_hash = ?', s.token_hash);
        const codes = action === 'TOTP_ENROLLED' ? await recoveryCodes(admin.id) : null;
        await audit(admin.username, action);
        return { ...await createSession(admin.id, 'FULL'), ...(codes ? { recoveryCodes: codes } : {}) };
      });
      if (!result) throw denied();
      return result;
    },
    async logout(sessionToken) {
      await platform.transaction(async () => { const s = await session(sessionToken); await platform.run('DELETE FROM platform_session WHERE token_hash = ?', s.token_hash); await audit(s.username, 'LOGOUT'); });
    },
    async changePassword(sessionToken, input) {
      await platform.transaction(async () => {
        const s = await session(sessionToken, true), admin = await platform.get('SELECT * FROM platform_admin WHERE id = ?', s.admin_id);
        if (typeof input.currentPassword !== 'string' || input.currentPassword.length > 256 || !await verifyPasswordAsync(input.currentPassword, admin.password_hash)) throw new ApiError(403, 'WRONG_PASSWORD', 'The current password is not correct.');
        checkPassword(input.newPassword, 'newPassword', admin.username);
        if (input.currentPassword === input.newPassword) throw new ApiError(400, 'INVALID_INPUT', 'Choose a different password.');
        await platform.run('UPDATE platform_admin SET password_hash = ?, updated_at = ? WHERE id = ?', encodePassword(input.newPassword), stamp(), admin.id);
        await platform.run('DELETE FROM platform_session WHERE admin_id = ? AND token_hash <> ?', admin.id, s.token_hash);
        await audit(admin.username, 'PASSWORD_CHANGED');
      });
      return { changed: true };
    },
    async regenerateRecovery(sessionToken, password) {
      return platform.transaction(async () => {
        const s = await session(sessionToken, true), admin = await platform.get('SELECT * FROM platform_admin WHERE id = ?', s.admin_id);
        if (typeof password !== 'string' || password.length > 256 || !await verifyPasswordAsync(password, admin.password_hash)) throw new ApiError(403, 'WRONG_PASSWORD', 'The current password is not correct.');
        const codes = await recoveryCodes(admin.id); await audit(admin.username, 'RECOVERY_REGENERATED');
        return { recoveryCodes: codes };
      });
    },
    async reset(password) {
      await platform.transaction(async () => {
        const admin = await platform.get('SELECT * FROM platform_admin LIMIT 1');
        if (!admin) throw new Error('Platform administrator not found.');
        checkPassword(password, 'password', admin.username);
        await platform.run(`UPDATE platform_admin SET password_hash = ?, totp_secret_sealed = NULL, totp_key_id = NULL, totp_enabled = 0,
          totp_last_step = NULL, failed_attempts = 0, locked_until = NULL, updated_at = ? WHERE id = ?`, encodePassword(password), stamp(), admin.id);
        await platform.run('DELETE FROM platform_session'); await platform.run('DELETE FROM platform_recovery_code'); await audit('host', 'ADMIN_RESET');
      });
    },
  };
}
