-- Phase 2 field capture: areas, assignment, assets, answers, findings, photos, AI suggestions,
-- offline sync (operations, conflicts, change log), tenant settings, absolute session cap.
--
-- Every tenant table: tenant_id, RLS enabled and forced, one tenant_isolation policy with WITH CHECK,
-- composite (tenant_id, parent_id) foreign keys (FK checks bypass RLS, see D-020).
-- Every synced table: version, updated_at, updated_by, deleted_at (tombstone), client_updated_at and
-- field_clock (per-field last-writer timestamps for conflict resolution, see D-031).
-- Change log rows are written by triggers in the same transaction as the change (D-030).

-- ---------------------------------------------------------------- shared trigger functions

-- Bumps version and updated_at on every UPDATE of a synced row.
CREATE FUNCTION field_bump_version() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  NEW.version := OLD.version + 1;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- Per-tenant change counter. The row lock taken by the upsert is held until COMMIT, so change
-- sequence numbers within a tenant commit in order and a pull cursor can never skip a change.
CREATE TABLE change_seq (
  tenant_id  uuid PRIMARY KEY REFERENCES tenant (id) ON DELETE CASCADE,
  last_seq   bigint NOT NULL
);

-- Append-only change log for sync pulls; deleted = true rows are tombstones.
CREATE TABLE change_log (
  tenant_id      uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  seq            bigint NOT NULL,
  entity         text NOT NULL CHECK (entity IN ('area', 'asset', 'answer', 'finding', 'photo_meta')),
  entity_id      uuid NOT NULL,
  version        integer NOT NULL,
  deleted        boolean NOT NULL,
  assessment_id  uuid,
  site_id        uuid,
  changed_by     uuid,
  changed_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, seq)
);
CREATE INDEX change_log_assessment_idx ON change_log (tenant_id, assessment_id, seq);
CREATE INDEX change_log_site_idx ON change_log (tenant_id, site_id, seq) WHERE site_id IS NOT NULL;

-- AFTER INSERT OR UPDATE on a synced table: TG_ARGV[0] is the sync entity name.
CREATE FUNCTION field_change_log() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE v_seq bigint; v_row jsonb := to_jsonb(NEW);
BEGIN
  INSERT INTO change_seq (tenant_id, last_seq) VALUES (NEW.tenant_id, 1)
    ON CONFLICT (tenant_id) DO UPDATE SET last_seq = change_seq.last_seq + 1
    RETURNING last_seq INTO v_seq;
  INSERT INTO change_log (tenant_id, seq, entity, entity_id, version, deleted, assessment_id, site_id, changed_by)
  VALUES (NEW.tenant_id, v_seq, TG_ARGV[0], NEW.id, NEW.version, NEW.deleted_at IS NOT NULL,
          (v_row->>'assessment_id')::uuid, (v_row->>'site_id')::uuid, NEW.updated_by);
  RETURN NULL;
END $$;

-- ---------------------------------------------------------------- tenant settings

CREATE TABLE tenant_settings (
  tenant_id          uuid PRIMARY KEY REFERENCES tenant (id) ON DELETE CASCADE,
  allow_gps          boolean NOT NULL DEFAULT false,
  ai_photo_analysis  boolean NOT NULL DEFAULT true,
  ai_share_context   boolean NOT NULL DEFAULT false,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         uuid
);

-- ---------------------------------------------------------------- areas (extends the Phase 1 table)

ALTER TABLE area
  ADD COLUMN kind text NOT NULL DEFAULT 'other'
    CHECK (kind IN ('exterior', 'perimeter', 'entrance', 'interior', 'restricted', 'parking', 'roof', 'it_room', 'other')),
  ADD COLUMN sort_order integer NOT NULL DEFAULT 0 CHECK (sort_order BETWEEN 0 AND 10000),
  ADD COLUMN version integer NOT NULL DEFAULT 1,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN created_by uuid,
  ADD COLUMN updated_by uuid,
  ADD COLUMN deleted_at timestamptz,
  ADD COLUMN client_updated_at timestamptz,
  ADD COLUMN field_clock jsonb NOT NULL DEFAULT '{}';
CREATE INDEX area_site_idx ON area (tenant_id, site_id, sort_order);

-- ---------------------------------------------------------------- assignment

CREATE TABLE assessment_assessor (
  tenant_id      uuid NOT NULL,
  assessment_id  uuid NOT NULL,
  user_id        uuid NOT NULL,
  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (assessment_id, user_id),
  FOREIGN KEY (tenant_id, assessment_id) REFERENCES assessment (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, user_id) REFERENCES membership (tenant_id, user_id) ON DELETE CASCADE
);
CREATE INDEX assessment_assessor_user_idx ON assessment_assessor (tenant_id, user_id);

-- ---------------------------------------------------------------- assets, answers, findings

CREATE TABLE asset (
  id                 uuid PRIMARY KEY,
  tenant_id          uuid NOT NULL,
  assessment_id      uuid NOT NULL,
  area_id            uuid,
  asset_type         text NOT NULL,
  label              text NOT NULL,
  notes              text,
  version            integer NOT NULL DEFAULT 1,
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         uuid,
  deleted_at         timestamptz,
  client_updated_at  timestamptz,
  field_clock        jsonb NOT NULL DEFAULT '{}',
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, assessment_id) REFERENCES assessment (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, area_id) REFERENCES area (tenant_id, id)
);
CREATE INDEX asset_assessment_idx ON asset (tenant_id, assessment_id);

CREATE TABLE answer (
  id                 uuid PRIMARY KEY,
  tenant_id          uuid NOT NULL,
  assessment_id      uuid NOT NULL,
  question_id        text NOT NULL CHECK (question_id ~ '^Q-[A-Z]{2,5}-\d{3}-\d{2}$'),
  area_id            uuid,
  value              jsonb NOT NULL,
  notes              text,
  answered_at        timestamptz NOT NULL,
  version            integer NOT NULL DEFAULT 1,
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         uuid,
  deleted_at         timestamptz,
  client_updated_at  timestamptz,
  field_clock        jsonb NOT NULL DEFAULT '{}',
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, assessment_id) REFERENCES assessment (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, area_id) REFERENCES area (tenant_id, id)
);
-- One live answer per (assessment, question, area); a NULL area (site-wide) counts as one value.
CREATE UNIQUE INDEX answer_unique_idx ON answer (assessment_id, question_id, area_id) NULLS NOT DISTINCT
  WHERE deleted_at IS NULL;
CREATE INDEX answer_assessment_idx ON answer (tenant_id, assessment_id);

CREATE TABLE finding (
  id                 uuid PRIMARY KEY,
  tenant_id          uuid NOT NULL,
  assessment_id      uuid NOT NULL,
  area_id            uuid,
  asset_id           uuid,
  title              text NOT NULL,
  description        text NOT NULL DEFAULT '',
  recommendation     text,
  severity           text NOT NULL CHECK (severity IN ('info', 'low', 'medium', 'high', 'critical')),
  status             text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'confirmed', 'resolved')),
  source             text NOT NULL DEFAULT 'assessor' CHECK (source IN ('assessor', 'ai_accepted', 'ai_edited')),
  suggestion_id      uuid,
  version            integer NOT NULL DEFAULT 1,
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         uuid,
  deleted_at         timestamptz,
  client_updated_at  timestamptz,
  field_clock        jsonb NOT NULL DEFAULT '{}',
  UNIQUE (tenant_id, id),
  CHECK ((source = 'assessor') = (suggestion_id IS NULL)),
  FOREIGN KEY (tenant_id, assessment_id) REFERENCES assessment (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, area_id) REFERENCES area (tenant_id, id),
  FOREIGN KEY (tenant_id, asset_id) REFERENCES asset (tenant_id, id)
);
CREATE INDEX finding_assessment_idx ON finding (tenant_id, assessment_id);

CREATE TABLE finding_control (
  tenant_id   uuid NOT NULL,
  finding_id  uuid NOT NULL,
  control_id  text NOT NULL CHECK (control_id ~ '^SC-[A-Z]{2,5}-\d{3}$'),
  PRIMARY KEY (finding_id, control_id),
  FOREIGN KEY (tenant_id, finding_id) REFERENCES finding (tenant_id, id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------- photos

CREATE TABLE photo (
  id                 uuid PRIMARY KEY,
  tenant_id          uuid NOT NULL,
  assessment_id      uuid NOT NULL,
  area_id            uuid,
  asset_id           uuid,
  finding_id         uuid,
  asset_type         text,
  severity           text CHECK (severity IN ('info', 'low', 'medium', 'high', 'critical')),
  notes              text,
  captured_at        timestamptz NOT NULL,
  gps                jsonb,
  content_type       text NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp', 'image/heic')),
  byte_size          integer NOT NULL CHECK (byte_size BETWEEN 1 AND 15728640),
  status             text NOT NULL DEFAULT 'pending_upload' CHECK (status IN ('pending_upload', 'stored')),
  sha256             text CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  width              integer,
  height             integer,
  storage_key        text,
  thumb_key          text,
  stored_bytes       integer,
  version            integer NOT NULL DEFAULT 1,
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         uuid,
  deleted_at         timestamptz,
  client_updated_at  timestamptz,
  field_clock        jsonb NOT NULL DEFAULT '{}',
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, assessment_id) REFERENCES assessment (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, area_id) REFERENCES area (tenant_id, id),
  FOREIGN KEY (tenant_id, asset_id) REFERENCES asset (tenant_id, id),
  FOREIGN KEY (tenant_id, finding_id) REFERENCES finding (tenant_id, id)
);
CREATE INDEX photo_assessment_idx ON photo (tenant_id, assessment_id);

CREATE TABLE photo_control (
  tenant_id   uuid NOT NULL,
  photo_id    uuid NOT NULL,
  control_id  text NOT NULL CHECK (control_id ~ '^SC-[A-Z]{2,5}-\d{3}$'),
  PRIMARY KEY (photo_id, control_id),
  FOREIGN KEY (tenant_id, photo_id) REFERENCES photo (tenant_id, id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------- AI suggestions (never final)

CREATE TABLE ai_suggestion (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  assessment_id   uuid NOT NULL,
  photo_id        uuid NOT NULL,
  status          text NOT NULL CHECK (status IN ('pending', 'suggested', 'failed', 'accepted', 'edited', 'rejected')),
  model           text NOT NULL,
  prompt_version  text NOT NULL,
  output          jsonb,
  error           text,
  usage           jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid,
  reviewed_at     timestamptz,
  reviewed_by     uuid,
  review_reason   text,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, assessment_id) REFERENCES assessment (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, photo_id) REFERENCES photo (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX ai_suggestion_photo_idx ON ai_suggestion (tenant_id, photo_id, created_at DESC);

ALTER TABLE finding ADD FOREIGN KEY (tenant_id, suggestion_id) REFERENCES ai_suggestion (tenant_id, id);

-- ---------------------------------------------------------------- sync bookkeeping

-- Idempotency: one row per client operation id; result is what the op returned the first time.
CREATE TABLE sync_operation (
  tenant_id   uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  op_id       uuid NOT NULL,
  user_id     uuid NOT NULL,
  device_id   uuid NOT NULL,
  entity      text NOT NULL,
  entity_id   uuid NOT NULL,
  action      text NOT NULL CHECK (action IN ('upsert', 'delete')),
  status      text NOT NULL CHECK (status IN ('pending', 'applied', 'conflict', 'rejected')),
  result      jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, op_id)
);

-- Losing copies from sync conflicts (append-only).
CREATE TABLE sync_conflict (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  assessment_id   uuid,
  site_id         uuid,
  op_id           uuid NOT NULL,
  user_id         uuid NOT NULL,
  device_id       uuid NOT NULL,
  entity          text NOT NULL,
  entity_id       uuid NOT NULL,
  action          text NOT NULL,
  base_version    integer,
  server_version  integer NOT NULL,
  winner          text NOT NULL CHECK (winner IN ('client', 'server', 'merged')),
  losing          jsonb NOT NULL,
  lost_fields     text[] NOT NULL DEFAULT '{}',
  client_updated_at timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sync_conflict_assessment_idx ON sync_conflict (tenant_id, assessment_id, created_at DESC);

-- ---------------------------------------------------------------- absolute session cap (QA R-5)

ALTER TABLE refresh_token ADD COLUMN session_started_at timestamptz NOT NULL DEFAULT now();

-- ---------------------------------------------------------------- triggers

CREATE TRIGGER area_version BEFORE UPDATE ON area FOR EACH ROW EXECUTE FUNCTION field_bump_version();
CREATE TRIGGER asset_version BEFORE UPDATE ON asset FOR EACH ROW EXECUTE FUNCTION field_bump_version();
CREATE TRIGGER answer_version BEFORE UPDATE ON answer FOR EACH ROW EXECUTE FUNCTION field_bump_version();
CREATE TRIGGER finding_version BEFORE UPDATE ON finding FOR EACH ROW EXECUTE FUNCTION field_bump_version();
CREATE TRIGGER photo_version BEFORE UPDATE ON photo FOR EACH ROW EXECUTE FUNCTION field_bump_version();

CREATE TRIGGER area_change AFTER INSERT OR UPDATE ON area FOR EACH ROW EXECUTE FUNCTION field_change_log('area');
CREATE TRIGGER asset_change AFTER INSERT OR UPDATE ON asset FOR EACH ROW EXECUTE FUNCTION field_change_log('asset');
CREATE TRIGGER answer_change AFTER INSERT OR UPDATE ON answer FOR EACH ROW EXECUTE FUNCTION field_change_log('answer');
CREATE TRIGGER finding_change AFTER INSERT OR UPDATE ON finding FOR EACH ROW EXECUTE FUNCTION field_change_log('finding');
CREATE TRIGGER photo_change AFTER INSERT OR UPDATE ON photo FOR EACH ROW EXECUTE FUNCTION field_change_log('photo_meta');

-- ---------------------------------------------------------------- row-level security

ALTER TABLE change_seq ENABLE ROW LEVEL SECURITY;          ALTER TABLE change_seq FORCE ROW LEVEL SECURITY;
ALTER TABLE change_log ENABLE ROW LEVEL SECURITY;          ALTER TABLE change_log FORCE ROW LEVEL SECURITY;
ALTER TABLE tenant_settings ENABLE ROW LEVEL SECURITY;     ALTER TABLE tenant_settings FORCE ROW LEVEL SECURITY;
ALTER TABLE assessment_assessor ENABLE ROW LEVEL SECURITY; ALTER TABLE assessment_assessor FORCE ROW LEVEL SECURITY;
ALTER TABLE asset ENABLE ROW LEVEL SECURITY;               ALTER TABLE asset FORCE ROW LEVEL SECURITY;
ALTER TABLE answer ENABLE ROW LEVEL SECURITY;              ALTER TABLE answer FORCE ROW LEVEL SECURITY;
ALTER TABLE finding ENABLE ROW LEVEL SECURITY;             ALTER TABLE finding FORCE ROW LEVEL SECURITY;
ALTER TABLE finding_control ENABLE ROW LEVEL SECURITY;     ALTER TABLE finding_control FORCE ROW LEVEL SECURITY;
ALTER TABLE photo ENABLE ROW LEVEL SECURITY;               ALTER TABLE photo FORCE ROW LEVEL SECURITY;
ALTER TABLE photo_control ENABLE ROW LEVEL SECURITY;       ALTER TABLE photo_control FORCE ROW LEVEL SECURITY;
ALTER TABLE ai_suggestion ENABLE ROW LEVEL SECURITY;       ALTER TABLE ai_suggestion FORCE ROW LEVEL SECURITY;
ALTER TABLE sync_operation ENABLE ROW LEVEL SECURITY;      ALTER TABLE sync_operation FORCE ROW LEVEL SECURITY;
ALTER TABLE sync_conflict ENABLE ROW LEVEL SECURITY;       ALTER TABLE sync_conflict FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON change_seq USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY tenant_isolation_read ON change_log FOR SELECT USING (tenant_id = app_current_tenant());
CREATE POLICY tenant_isolation_insert ON change_log FOR INSERT WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY tenant_isolation ON tenant_settings USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY tenant_isolation ON assessment_assessor USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY tenant_isolation ON asset USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY tenant_isolation ON answer USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY tenant_isolation ON finding USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY tenant_isolation ON finding_control USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY tenant_isolation ON photo USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY tenant_isolation ON photo_control USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY tenant_isolation ON ai_suggestion USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY tenant_isolation ON sync_operation USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY tenant_isolation_read ON sync_conflict FOR SELECT USING (tenant_id = app_current_tenant());
CREATE POLICY tenant_isolation_insert ON sync_conflict FOR INSERT WITH CHECK (tenant_id = app_current_tenant());

-- ---------------------------------------------------------------- grants

GRANT SELECT, INSERT, UPDATE ON change_seq, tenant_settings, sync_operation TO sentinel_app;
GRANT SELECT, INSERT ON change_log, sync_conflict TO sentinel_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON assessment_assessor, asset, answer, finding, finding_control,
  photo, photo_control, ai_suggestion TO sentinel_app;
