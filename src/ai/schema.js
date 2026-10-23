export function aiSchema(dialect) {
  return `
CREATE TABLE IF NOT EXISTS ai_setting (
 id INTEGER PRIMARY KEY CHECK (id = 1),
 enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
 level INTEGER NOT NULL DEFAULT 1 CHECK (level BETWEEN 0 AND 1),
 tone TEXT NOT NULL DEFAULT '' CHECK (length(tone) <= 300),
 business_notes TEXT NOT NULL DEFAULT '' CHECK (length(business_notes) <= 3000),
 daily_token_cap INTEGER NOT NULL DEFAULT 100000 CHECK (daily_token_cap BETWEEN 1000 AND 2000000),
 revision INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL
);
INSERT INTO ai_setting (id, updated_at) VALUES (1,'1970-01-01T00:00:00.000Z') ON CONFLICT (id) DO NOTHING;
CREATE TABLE IF NOT EXISTS ai_usage (
 id TEXT PRIMARY KEY, day TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('SUGGEST')),
 actor TEXT NOT NULL, thread_id TEXT,
 input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
 output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
 outcome TEXT NOT NULL CHECK (outcome IN ('OK','HANDOFF','ERROR','CAP')), created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ai_usage_day ON ai_usage(day);
CREATE TABLE IF NOT EXISTS ai_suggestion_audit (
 id TEXT PRIMARY KEY, actor TEXT NOT NULL, thread_id TEXT NOT NULL, created_at TEXT NOT NULL,
 action TEXT NOT NULL DEFAULT 'SUGGEST' CHECK (action IN ('SUGGEST','SETTINGS_UPDATED'))
);
`;
}

export async function migrateAi(store) {
  await store.exec(aiSchema(store.dialect));
}
