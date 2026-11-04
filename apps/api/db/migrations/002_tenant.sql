-- Tenant data with row-level security (D-008, D-011).

-- Current tenant from the transaction-local setting; NULL when unset or reset to ''.
CREATE FUNCTION app_current_tenant() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$;
GRANT EXECUTE ON FUNCTION app_current_tenant() TO sentinel_app;

CREATE TABLE tenant (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Global user identity. Holds no tenant data; tenancy is in membership.
CREATE TABLE app_user (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email               text NOT NULL CHECK (email = lower(email)),
  name                text NOT NULL,
  password_hash       text,
  google_sub          text UNIQUE,
  failed_login_count  integer NOT NULL DEFAULT 0,
  locked_until        timestamptz,
  last_login_at       timestamptz,
  disabled_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX app_user_email_idx ON app_user (email);

CREATE TABLE membership (
  tenant_id   uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
  role        text NOT NULL CHECK (role IN ('owner', 'admin', 'assessor', 'viewer')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);
CREATE INDEX membership_user_idx ON membership (user_id);

CREATE TABLE refresh_token (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL,
  user_id      uuid NOT NULL,
  family_id    uuid NOT NULL,
  token_hash   text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  replaced_by  uuid,
  ip           text,
  user_agent   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, user_id) REFERENCES membership (tenant_id, user_id) ON DELETE CASCADE
);
CREATE INDEX refresh_token_family_idx ON refresh_token (tenant_id, family_id);

CREATE TABLE client (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  name        text NOT NULL,
  industry    text,
  notes       text,
  created_by  uuid REFERENCES app_user (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

-- Composite foreign keys keep children in their parent's tenant: FK checks bypass RLS,
-- so a plain FK on id alone would let a row reference another tenant's parent.
CREATE TABLE site (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  client_id   uuid NOT NULL,
  name        text NOT NULL,
  address     text,
  site_type   text,
  created_by  uuid REFERENCES app_user (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, client_id) REFERENCES client (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX site_client_idx ON site (tenant_id, client_id);

CREATE TABLE area (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL,
  site_id      uuid NOT NULL,
  name         text NOT NULL,
  description  text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, site_id) REFERENCES site (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE assessment (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  site_id          uuid NOT NULL,
  title            text NOT NULL,
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'in_progress', 'in_review', 'complete', 'archived')),
  scheduled_for    date,
  library_version  text REFERENCES library_release (version),
  created_by       uuid REFERENCES app_user (id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, site_id) REFERENCES site (tenant_id, id)
);
CREATE INDEX assessment_site_idx ON assessment (tenant_id, site_id);

CREATE TABLE assessment_framework (
  tenant_id      uuid NOT NULL,
  assessment_id  uuid NOT NULL,
  framework_id   text NOT NULL,
  version        text NOT NULL,
  PRIMARY KEY (assessment_id, framework_id),
  FOREIGN KEY (tenant_id, assessment_id) REFERENCES assessment (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (framework_id, version) REFERENCES framework_version (framework_id, version)
);

-- Append-only. tenant_id is NULL only for auth events that cannot be tied to a tenant
-- (for example a failed login for an unknown email); those rows are invisible to the app role.
CREATE TABLE audit_log (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid REFERENCES tenant (id) ON DELETE CASCADE,
  at             timestamptz NOT NULL DEFAULT now(),
  actor_user_id  uuid,
  actor_email    text,
  action         text NOT NULL,
  entity_type    text,
  entity_id      text,
  ip             text,
  user_agent     text,
  details        jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX audit_log_tenant_at_idx ON audit_log (tenant_id, at DESC);

-- Row-level security: enabled and forced (applies to the table owner too).
ALTER TABLE tenant ENABLE ROW LEVEL SECURITY;               ALTER TABLE tenant FORCE ROW LEVEL SECURITY;
ALTER TABLE app_user ENABLE ROW LEVEL SECURITY;             ALTER TABLE app_user FORCE ROW LEVEL SECURITY;
ALTER TABLE membership ENABLE ROW LEVEL SECURITY;           ALTER TABLE membership FORCE ROW LEVEL SECURITY;
ALTER TABLE refresh_token ENABLE ROW LEVEL SECURITY;        ALTER TABLE refresh_token FORCE ROW LEVEL SECURITY;
ALTER TABLE client ENABLE ROW LEVEL SECURITY;               ALTER TABLE client FORCE ROW LEVEL SECURITY;
ALTER TABLE site ENABLE ROW LEVEL SECURITY;                 ALTER TABLE site FORCE ROW LEVEL SECURITY;
ALTER TABLE area ENABLE ROW LEVEL SECURITY;                 ALTER TABLE area FORCE ROW LEVEL SECURITY;
ALTER TABLE assessment ENABLE ROW LEVEL SECURITY;           ALTER TABLE assessment FORCE ROW LEVEL SECURITY;
ALTER TABLE assessment_framework ENABLE ROW LEVEL SECURITY; ALTER TABLE assessment_framework FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;            ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;

-- Tenant isolation, for every role (including the owner when it writes tenant data).
CREATE POLICY tenant_isolation ON tenant USING (id = app_current_tenant()) WITH CHECK (id = app_current_tenant());
CREATE POLICY tenant_isolation ON membership USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY tenant_isolation ON refresh_token USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY tenant_isolation ON client USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY tenant_isolation ON site USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY tenant_isolation ON area USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY tenant_isolation ON assessment USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY tenant_isolation ON assessment_framework USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY tenant_isolation_read ON audit_log FOR SELECT USING (tenant_id = app_current_tenant());
CREATE POLICY tenant_isolation_insert ON audit_log FOR INSERT WITH CHECK (tenant_id = app_current_tenant());

-- app_user: the app role sees only users who are members of the current tenant.
CREATE POLICY member_of_current_tenant ON app_user FOR SELECT TO sentinel_app
  USING (EXISTS (SELECT 1 FROM membership m WHERE m.user_id = app_user.id));

-- Owner-only policies, used by migrations, the seed loader, and the SECURITY DEFINER auth
-- functions in 003 (login happens before a tenant is known). The app role never gets these.
CREATE POLICY owner_all ON app_user TO sentinel_owner USING (true) WITH CHECK (true);
CREATE POLICY owner_read ON tenant FOR SELECT TO sentinel_owner USING (true);
CREATE POLICY owner_read ON membership FOR SELECT TO sentinel_owner USING (true);
CREATE POLICY owner_read ON refresh_token FOR SELECT TO sentinel_owner USING (true);
CREATE POLICY owner_unscoped_insert ON audit_log FOR INSERT TO sentinel_owner WITH CHECK (tenant_id IS NULL);

-- App role privileges. audit_log: INSERT and SELECT only. app_user: non-secret columns only.
GRANT SELECT ON tenant, membership TO sentinel_app;
GRANT SELECT (id, email, name, disabled_at, created_at) ON app_user TO sentinel_app;
GRANT SELECT, INSERT, UPDATE ON refresh_token TO sentinel_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON client, site, area, assessment, assessment_framework TO sentinel_app;
GRANT SELECT, INSERT ON audit_log TO sentinel_app;
