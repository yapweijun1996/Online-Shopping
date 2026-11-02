// AI Studio storage: one sealed seller-owned API key, a daily call cap and a usage ledger (no prompts, images or keys).
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
 daily_call_cap INTEGER NOT NULL DEFAULT 20 CHECK (daily_call_cap BETWEEN 1 AND 500),
 key_generation INTEGER NOT NULL DEFAULT 0 CHECK (key_generation >= 0),
 revision INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL
);
INSERT INTO ai_studio_setting (id, updated_at) VALUES (1, '1970-01-01T00:00:00.000Z') ON CONFLICT (id) DO NOTHING;
CREATE TABLE IF NOT EXISTS ai_studio_usage (
 id TEXT PRIMARY KEY, day TEXT NOT NULL,
 kind TEXT NOT NULL CHECK (kind IN ('ANALYZE','IMAGE','REVIEW')),
 actor TEXT NOT NULL, product_id TEXT,
 outcome TEXT NOT NULL CHECK (outcome IN ('OK','ERROR','AMBIGUOUS')), created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ai_studio_usage_day ON ai_studio_usage(day);
`;
}

export async function migrateAiStudio(store) {
  await store.exec(aiStudioSchema(store.dialect));
}

export const AI_STUDIO_TABLES = ['ai_studio_credential', 'ai_studio_setting', 'ai_studio_usage'];
