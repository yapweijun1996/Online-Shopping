import { storageKey } from './storage-scope.js';
import { t, translate } from '../shared/i18n.js';

const KEY = 'online-shopping-profile-v1';
export function localPhoneInput(value, code) {
  const digits = String(value || '').replace(/\D/g, '');
  const prefix = code.replace('+', '');
  return (digits.startsWith(prefix) ? digits.slice(prefix.length) : digits).replace(/^0/, '');
}
export function normalizeProfile(value) {
  if (!value || typeof value !== 'object') throw new TypeError('profileRequired');
  const fullName = typeof value.fullName === 'string' ? value.fullName.trim() : '';
  const code = value.code === '+65' ? '+65' : '+60';
  const raw = typeof value.phone === 'string' ? value.phone.trim() : '';
  const email = typeof value.email === 'string' ? value.email.trim() : '';
  if (!fullName || fullName.length > 120 || /[\u0000-\u001f\u007f]/.test(fullName)) throw new TypeError('profileNameInvalid');
  if (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email) || email.includes('..'))) throw new TypeError('profileEmailInvalid');
  let phone = '';
  if (raw) {
    if (raw.length > 32 || !/^\+?[0-9 ()-]+$/.test(raw)) throw new TypeError('profilePhoneInvalid');
    const digits = raw.replace(/[^0-9]/g, '');
    phone = `${code}${localPhoneInput(digits, code)}`;
    if (code === '+60' ? !/^\+60(?:11\d{8}|1[02346789]\d{7})$/.test(phone) : !/^\+65[3689]\d{7}$/.test(phone)) {
      throw new TypeError('profilePhoneInvalid');
    }
  }
  if (!phone && !email) throw new TypeError('profileContactRequired');
  return { fullName, code: phone.startsWith('+65') ? '+65' : phone.startsWith('+60') ? '+60' : code, phone, email };
}

export function profileForCountry(profile, country) {
  if (!profile) return null;
  const code = country === 'SG' ? '+65' : '+60';
  if (profile.phone && !profile.phone.startsWith(code)) return null;
  try { return normalizeProfile(profile); } catch { return null; }
}

function readSavedProfile(saved) {
  try { return normalizeProfile(saved); } catch {
    // Keep older, once-accepted numbers visible for correction without unlocking checkout.
    if (!saved || typeof saved !== 'object' || typeof saved.fullName !== 'string' ||
        !saved.fullName.trim() || saved.fullName.length > 120 || /[\u0000-\u001f\u007f]/.test(saved.fullName) ||
        !/^\+(?:60[1-9]\d{7,9}|65[3689]\d{7})$/.test(saved.phone || '') ||
        typeof saved.email !== 'string' || saved.email.length > 254 ||
        (saved.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(saved.email))) return null;
    return { fullName: saved.fullName.trim(), code: saved.phone.startsWith('+65') ? '+65' : '+60', phone: saved.phone, email: saved.email };
  }
}

export function createProfileStore(storage) {
  let value = null;
  try { value = readSavedProfile(JSON.parse(storage?.getItem(storageKey(KEY)) || 'null')); } catch { /* An incomplete profile cannot unlock checkout. */ }
  return {
    get: () => value ? { ...value } : null,
    save(input) {
      const next = normalizeProfile(input);
      // Do not claim persistence when browser storage is blocked.
      if (!storage) throw new Error('profileSaveFailed');
      try { storage.setItem(storageKey(KEY), JSON.stringify(next)); } catch { throw new Error('profileSaveFailed'); }
      value = next;
      return { ...value };
    },
  };
}

export function mountProfile({ onSaved }) {
  let storage;
  try { storage = localStorage; } catch { /* Save will report storage unavailable. */ }
  const store = createProfileStore(storage);
  const form = document.getElementById('profile-form');
  const status = document.getElementById('profile-status');
  let statusKey = '';
  let baseline = null;
  let country = 'MY';
  const snapshot = () => JSON.stringify([...new FormData(form)]);
  const controls = Object.fromEntries(['fullName', 'code', 'phone', 'email'].map((key) => [key, form.elements.namedItem(key)]));
  const prefix = document.getElementById('profile-phone-prefix');
  const currentCode = () => country === 'SG' ? '+65' : '+60';
  const dirty = () => baseline !== null && baseline !== snapshot();
  function show() {
    if (dirty()) return;
    const profile = store.get() || { fullName: '', code: '+60', phone: '', email: '' };
    controls.fullName.value = profile.fullName;
    controls.code.value = currentCode();
    controls.phone.value = profile.phone && profile.code !== currentCode() ? profile.phone : localPhoneInput(profile.phone, currentCode());
    controls.email.value = profile.email;
    baseline = snapshot();
    statusKey = profile.phone && !profileForCountry(profile, country) ?
      (profile.code !== currentCode() ? 'profileCountryMismatch' : 'profilePhoneInvalid') : '';
    status.textContent = statusKey ? t(statusKey) : '';
  }
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    try {
      store.save({ fullName: controls.fullName.value, code: currentCode(), phone: controls.phone.value, email: controls.email.value });
      baseline = snapshot();
      statusKey = 'profileSaved';
      onSaved();
    } catch (error) {
      statusKey = error.message;
    }
    status.textContent = t(statusKey);
  });
  controls.phone.addEventListener('blur', () => {
    if (controls.phone.value.trim().startsWith('+') &&
        !controls.phone.value.replace(/\D/g, '').startsWith(currentCode().slice(1))) return;
    controls.phone.value = localPhoneInput(controls.phone.value, currentCode());
  });
  return {
    isDirty: dirty,
    get: () => profileForCountry(store.get(), country),
    show,
    setCountry(next) {
      const selected = next === 'SG' ? 'SG' : 'MY';
      if (selected === country) return;
      const hadDraft = dirty();
      country = selected;
      controls.code.value = currentCode();
      prefix.textContent = `${country} ${currentCode()}`;
      if (!hadDraft) { baseline = null; show(); }
    },
    refreshLocale() { translate(form); status.textContent = statusKey ? t(statusKey) : ''; },
  };
}
