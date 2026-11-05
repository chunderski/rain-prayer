-- Phase 3: risk inputs and snapshots, report narrative, Google connection and exports.
--
-- Same rules as 002 and 004: every tenant table has tenant_id, RLS enabled and forced, a
-- tenant_isolation policy with WITH CHECK, and composite (tenant_id, parent_id) foreign keys
-- (FK checks bypass RLS, see D-020).

-- ---------------------------------------------------------------- risk

-- Assessor inherent-risk inputs per threat scenario (scenario ids come from the versioned
-- scenario library in packages/risk, so they are text, not a foreign key).
CREATE TABLE scenario_input (
  tenant_id      uuid NOT NULL,
  assessment_id  uuid NOT NULL,
  scenario_id    text NOT NULL CHECK (scenario_id ~ '^[a-z][a-z0-9-]{1,40}$'),
  likelihood     integer NOT NULL CHECK (likelihood BETWEEN 1 AND 5),
  impact         integer NOT NULL CHECK (impact BETWEEN 1 AND 5),
  rationale      text CHECK (length(rationale) <= 2000),
  excluded       boolean NOT NULL DEFAULT false,
  updated_by     uuid,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (assessment_id, scenario_id),
  FOREIGN KEY (tenant_id, assessment_id) REFERENCES assessment (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX scenario_input_tenant_idx ON scenario_input (tenant_id, assessment_id);

-- Frozen RiskResult taken when an assessment is completed; the newest row is authoritative.
-- Reopening keeps old snapshots as history; completing again adds a new one.
CREATE TABLE risk_snapshot (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  assessment_id   uuid NOT NULL,
  method_version  text NOT NULL,
  result          jsonb NOT NULL,
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, assessment_id) REFERENCES assessment (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX risk_snapshot_assessment_idx ON risk_snapshot (tenant_id, assessment_id, created_at DESC);

-- ---------------------------------------------------------------- narrative

-- One row per report section. ai_draft text is never rendered into a preview or an export.
CREATE TABLE narrative (
  tenant_id       uuid NOT NULL,
  assessment_id   uuid NOT NULL,
  section         text NOT NULL CHECK (section IN ('executive_summary', 'methodology', 'key_findings', 'recommendations')),
  text            text NOT NULL CHECK (length(text) <= 20000),
  status          text NOT NULL CHECK (status IN ('ai_draft', 'edited', 'approved')),
  model           text,
  prompt_version  text,
  updated_by      uuid,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  approved_by     uuid,
  approved_at     timestamptz,
  PRIMARY KEY (assessment_id, section),
  CHECK ((status = 'approved') = (approved_by IS NOT NULL)),
  FOREIGN KEY (tenant_id, assessment_id) REFERENCES assessment (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX narrative_tenant_idx ON narrative (tenant_id, assessment_id);

-- ---------------------------------------------------------------- Google

-- One Google connection per tenant. The refresh token is AES-256-GCM encrypted with
-- GOOGLE_TOKEN_KEY (AAD = tenant id); the app never returns these columns to clients.
CREATE TABLE google_connection (
  tenant_id       uuid PRIMARY KEY REFERENCES tenant (id) ON DELETE CASCADE,
  refresh_token   bytea NOT NULL,
  iv              bytea NOT NULL CHECK (length(iv) = 12),
  tag             bytea NOT NULL CHECK (length(tag) = 16),
  key_version     integer NOT NULL DEFAULT 1,
  email           text,
  scopes          text[] NOT NULL,
  connected_by    uuid NOT NULL,
  connected_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, connected_by) REFERENCES membership (tenant_id, user_id) ON DELETE CASCADE
);

-- Single-use OAuth connect attempts, bound to the admin who started them (state hash only).
CREATE TABLE google_oauth_state (
  tenant_id   uuid NOT NULL,
  state_hash  text PRIMARY KEY CHECK (state_hash ~ '^[0-9a-f]{64}$'),
  user_id     uuid NOT NULL,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, user_id) REFERENCES membership (tenant_id, user_id) ON DELETE CASCADE
);

-- Drive folders this app created (drive.file scope only sees app-created files), reused across exports.
CREATE TABLE google_folder (
  tenant_id   uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  path        text NOT NULL CHECK (length(path) <= 2000),
  folder_id   text NOT NULL CHECK (folder_id ~ '^[A-Za-z0-9_-]{1,200}$'),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, path)
);

CREATE TABLE export_job (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  assessment_id     uuid NOT NULL,
  targets           text[] NOT NULL CHECK (cardinality(targets) BETWEEN 1 AND 3 AND targets <@ ARRAY['docs', 'sheets', 'drive']),
  status            text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  results           jsonb NOT NULL DEFAULT '[]',
  -- Resumable progress (created Drive ids) so a retried job never creates duplicates.
  state             jsonb NOT NULL DEFAULT '{}',
  template_version  text NOT NULL,
  attempts          integer NOT NULL DEFAULT 0,
  created_by        uuid NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  started_at        timestamptz,
  finished_at       timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, assessment_id) REFERENCES assessment (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX export_job_assessment_idx ON export_job (tenant_id, assessment_id, created_at DESC);
CREATE INDEX export_job_open_idx ON export_job (tenant_id, created_at) WHERE status IN ('queued', 'running');

-- ---------------------------------------------------------------- row-level security

ALTER TABLE scenario_input ENABLE ROW LEVEL SECURITY;     ALTER TABLE scenario_input FORCE ROW LEVEL SECURITY;
ALTER TABLE risk_snapshot ENABLE ROW LEVEL SECURITY;      ALTER TABLE risk_snapshot FORCE ROW LEVEL SECURITY;
ALTER TABLE narrative ENABLE ROW LEVEL SECURITY;          ALTER TABLE narrative FORCE ROW LEVEL SECURITY;
ALTER TABLE google_connection ENABLE ROW LEVEL SECURITY;  ALTER TABLE google_connection FORCE ROW LEVEL SECURITY;
ALTER TABLE google_oauth_state ENABLE ROW LEVEL SECURITY; ALTER TABLE google_oauth_state FORCE ROW LEVEL SECURITY;
ALTER TABLE google_folder ENABLE ROW LEVEL SECURITY;      ALTER TABLE google_folder FORCE ROW LEVEL SECURITY;
ALTER TABLE export_job ENABLE ROW LEVEL SECURITY;         ALTER TABLE export_job FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON scenario_input USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
-- Snapshots are append-only for the app role.
CREATE POLICY tenant_isolation_read ON risk_snapshot FOR SELECT USING (tenant_id = app_current_tenant());
CREATE POLICY tenant_isolation_insert ON risk_snapshot FOR INSERT WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY tenant_isolation ON narrative USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY tenant_isolation ON google_connection USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY tenant_isolation ON google_oauth_state USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY tenant_isolation ON google_folder USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY tenant_isolation ON export_job USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

-- ---------------------------------------------------------------- grants

GRANT SELECT, INSERT, UPDATE, DELETE ON scenario_input, narrative, google_connection, google_oauth_state, google_folder TO sentinel_app;
GRANT SELECT, INSERT ON risk_snapshot TO sentinel_app;
GRANT SELECT, INSERT, UPDATE ON export_job TO sentinel_app;
