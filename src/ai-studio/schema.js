// AI Studio storage: one sealed seller-owned API key, a daily call cap and a usage ledger (no prompts, images or keys).
export const MIN_DAILY_CALL_CAP = 100;

export function aiStudioSchema(dialect) {
  const blob = dialect === 'postgres' ? 'BYTEA' : 'BLOB';
  return `
CREATE TABLE IF NOT EXISTS ai_studio_credential (
 id INTEGER PRIMARY KEY CHECK (id = 1),
 provider TEXT NOT NULL CHECK (provider = 'OPENAI'),
 sealed ${blob} NOT NULL, key_id TEXT NOT NULL, last4 TEXT NOT NULL CHECK (length(last4) = 4),
 revision INTEGER NOT NULL DEFAULT 1, updated_by TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ai_studio_setting (
 id INTEGER PRIMARY KEY CHECK (id = 1),
 daily_call_cap INTEGER NOT NULL DEFAULT ${MIN_DAILY_CALL_CAP} CHECK (daily_call_cap BETWEEN 1 AND 500),
 key_generation INTEGER NOT NULL DEFAULT 0 CHECK (key_generation >= 0),
 revision INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL
);
INSERT INTO ai_studio_setting (id, updated_at) VALUES (1, '1970-01-01T00:00:00.000Z') ON CONFLICT (id) DO NOTHING;
CREATE TABLE IF NOT EXISTS ai_studio_usage (
 id TEXT PRIMARY KEY, day TEXT NOT NULL,
 kind TEXT NOT NULL CHECK (kind IN ('ANALYZE','IMAGE','REVIEW')),
 actor TEXT NOT NULL, product_id TEXT,
 outcome TEXT NOT NULL CHECK (outcome IN ('PENDING','OK','ERROR','AMBIGUOUS')), created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ai_studio_usage_day ON ai_studio_usage(day);
CREATE TABLE IF NOT EXISTS ai_studio_image (
 id TEXT PRIMARY KEY, product_id TEXT NOT NULL, gallery_image_id TEXT NOT NULL,
 style TEXT NOT NULL CHECK (style IN ('studio','hero','lifestyle','flat_lay','macro','ugc','billboard')),
 verdict TEXT CHECK (verdict IS NULL OR verdict IN ('PASS','WARN','FAIL')), issues_json TEXT NOT NULL DEFAULT '[]',
 created_by TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ai_studio_image_product ON ai_studio_image(product_id);
`;
}

export async function migrateAiStudio(store) {
  await store.exec(aiStudioSchema(store.dialect));
}

export const AI_STUDIO_TABLES = ['ai_studio_credential', 'ai_studio_setting', 'ai_studio_usage', 'ai_studio_image'];

export async function migrateStudioDrafts(store) {
  const blob = store.dialect === 'postgres' ? 'BYTEA' : 'BLOB';
  await store.exec(`
CREATE TABLE IF NOT EXISTS ai_studio_draft (
 id TEXT PRIMARY KEY, product_id TEXT NOT NULL REFERENCES product(id) ON DELETE CASCADE,
 mime TEXT NOT NULL CHECK (mime IN ('image/png','image/jpeg','image/webp')),
 data ${blob} NOT NULL CHECK (length(data) BETWEEN 1 AND 524288),
 style TEXT NOT NULL CHECK (style IN ('studio','hero','lifestyle','flat_lay','macro','ugc','billboard')),
 verdict TEXT CHECK (verdict IS NULL OR verdict IN ('PASS','WARN','FAIL')), issues_json TEXT NOT NULL,
 created_by TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ai_studio_draft_product ON ai_studio_draft(product_id, created_at);
CREATE INDEX IF NOT EXISTS ai_studio_draft_expiry ON ai_studio_draft(expires_at);
`);
  if (store.dialect === 'postgres') await store.exec(`ALTER TABLE ai_studio_setting ALTER COLUMN daily_call_cap SET DEFAULT ${MIN_DAILY_CALL_CAP}`);
  await store.run('UPDATE ai_studio_setting SET daily_call_cap = ?, revision = revision + 1 WHERE daily_call_cap < ?',
    MIN_DAILY_CALL_CAP, MIN_DAILY_CALL_CAP);
}
