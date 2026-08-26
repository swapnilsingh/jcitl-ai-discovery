CREATE TABLE IF NOT EXISTS discovery_briefs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  clerk_user_id TEXT NOT NULL,
  user_name TEXT,
  user_email TEXT,
  company_name TEXT,
  context TEXT NOT NULL CHECK (char_length(context) BETWEEN 1 AND 600),
  stage TEXT NOT NULL,
  file_name TEXT,
  file_size INTEGER,
  file_mime_type TEXT,
  file_data BYTEA,
  review_status TEXT NOT NULL DEFAULT 'new',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE discovery_briefs ADD COLUMN IF NOT EXISTS user_name TEXT;
ALTER TABLE discovery_briefs ADD COLUMN IF NOT EXISTS user_email TEXT;
ALTER TABLE discovery_briefs ADD COLUMN IF NOT EXISTS company_name TEXT;
ALTER TABLE discovery_briefs ADD COLUMN IF NOT EXISTS file_mime_type TEXT;
ALTER TABLE discovery_briefs ADD COLUMN IF NOT EXISTS file_data BYTEA;
ALTER TABLE discovery_briefs ADD COLUMN IF NOT EXISTS review_status TEXT NOT NULL DEFAULT 'new';

CREATE INDEX IF NOT EXISTS discovery_briefs_clerk_user_id_idx
  ON discovery_briefs (clerk_user_id);

CREATE TABLE IF NOT EXISTS analyst_users (
  clerk_user_id TEXT PRIMARY KEY,
  user_name TEXT,
  user_email TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  assigned_by_clerk_user_id TEXT
);

CREATE INDEX IF NOT EXISTS analyst_users_active_idx
  ON analyst_users (is_active);

CREATE TABLE IF NOT EXISTS questionnaires (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  brief_id BIGINT NOT NULL REFERENCES discovery_briefs(id) ON DELETE CASCADE,
  clerk_user_id TEXT NOT NULL,
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  questions JSONB NOT NULL CHECK (jsonb_typeof(questions) = 'array'),
  answers JSONB,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'prepared', 'submitted')),
  prepared_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  submitted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS questionnaires_clerk_user_id_idx
  ON questionnaires (clerk_user_id);
