// Presentation only: provider/business decisions remain in the existing readiness API.
const CHECKS = ['phoneOwnership', 'appSubscription', 'appSecret', 'templates'];
const STATES = new Set(['PASS', 'FAIL', 'UNKNOWN']);
const TEMPLATE_STATES = new Set(['APPROVED', 'PENDING', 'REJECTED', 'MISSING', 'UNKNOWN']);
export function cloudProjection(connection, readiness, availability = 'ready') {
  const connectionStatus = availability !== 'ready' ? 'UNKNOWN' : !connection || ['DISCONNECTED', 'NOT_CONFIGURED'].includes(connection.status) ? 'DISCONNECTED' : ['CONNECTED', 'ERROR'].includes(connection.status) ? connection.status : 'UNKNOWN';
  const connected = connectionStatus === 'CONNECTED';
  const checks = Object.fromEntries(CHECKS.map(id => {
    const entries = Array.isArray(readiness?.checks) ? readiness.checks.filter(check => check?.id === id) : [];
    return [id, connected && entries.length === 1 && STATES.has(entries[0].status) ? entries[0].status : 'UNKNOWN'];
  }));
  const templates = connected && Array.isArray(readiness?.templates) ? readiness.templates.map(item => ({ name: typeof item?.name === 'string' ? item.name : '', language: typeof item?.language === 'string' ? item.language : '', status: TEMPLATE_STATES.has(item?.status) ? item.status : 'UNKNOWN' })) : [];
  const identities = templates.map(item => `${item.name}:${item.language}`);
  if (!templates.length || templates.some(item => !item.name || !item.language) || new Set(identities).size !== identities.length || (checks.templates === 'PASS' && templates.some(item => item.status !== 'APPROVED'))) checks.templates = 'UNKNOWN';
  const counts = Object.fromEntries([...TEMPLATE_STATES].map(status => [status, templates.filter(item => item.status === status).length]));
  const webhook = ['phoneOwnership', 'appSubscription', 'appSecret'].map(id => checks[id]);
  const webhookStatus = webhook.includes('FAIL') ? 'FAIL' : webhook.every(status => status === 'PASS') ? 'PASS' : 'UNKNOWN';
  return { connected, connectionStatus, checks, templates, counts, webhookStatus, templateStatus: checks.templates, nextStep: !connected ? 2 : webhookStatus !== 'PASS' ? 3 : 4, checkedAt: connected && typeof readiness?.checkedAt === 'string' && Number.isFinite(Date.parse(readiness.checkedAt)) ? readiness.checkedAt : null };
}
export function invalidCredentialField(values) {
  for (const [name, min, max] of [['accessToken', 20, 512], ['appSecret', 16, 128]]) if (typeof values[name] !== 'string' || values[name].length < min || values[name].length > max || /[\s\p{Cc}]/u.test(values[name])) return name;
  for (const name of ['phoneNumberId', 'businessAccountId']) if (typeof values[name] !== 'string' || !/^[0-9]{5,32}$/.test(values[name])) return name;
  return null;
}
