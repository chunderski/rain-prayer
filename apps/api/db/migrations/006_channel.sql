-- Phase 4 channel: plan, branding, members and client logins, setup tokens, price book,
-- quote settings, quotes and quote lines.
--
-- Same rules as 002 to 005: every tenant table has tenant_id, RLS enabled and forced, a
-- tenant_isolation policy with WITH CHECK, and composite (tenant_id, parent_id) foreign keys
-- (FK checks bypass RLS, see D-020).

-- ---------------------------------------------------------------- plan (operator only, D-079)

-- The app role has SELECT only on tenant, so the plan can never be changed through the API.
ALTER TABLE tenant ADD COLUMN plan text NOT NULL DEFAULT 'standard' CHECK (plan IN ('standard', 'partner'));

-- ---------------------------------------------------------------- branding

CREATE TABLE tenant_branding (
  tenant_id        uuid PRIMARY KEY REFERENCES tenant (id) ON DELETE CASCADE,
  display_name     text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 80),
  primary_color    text NOT NULL CHECK (primary_color ~ '^#[0-9a-fA-F]{6}$'),
  accent_color     text NOT NULL CHECK (accent_color ~ '^#[0-9a-fA-F]{6}$'),
  report_footer    text NOT NULL DEFAULT '' CHECK (length(report_footer) <= 500),
  contact_email    text CHECK (length(contact_email) <= 254),
  contact_phone    text CHECK (length(contact_phone) <= 40),
  website          text CHECK (length(website) <= 200),
  show_powered_by  boolean NOT NULL DEFAULT true,
  -- Same storage driver as photos; the only key form is tenants/<tenant id>/branding/logo.png.
  logo_key         text CHECK (logo_key ~ '^tenants/[0-9a-f-]{36}/branding/logo\.png$'),
  logo_updated_at  timestamptz,
  updated_by       uuid,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- members and client logins (D-081, D-082)

ALTER TABLE membership DROP CONSTRAINT membership_role_check;
ALTER TABLE membership
  ADD CONSTRAINT membership_role_check CHECK (role IN ('owner', 'admin', 'assessor', 'viewer', 'client_viewer')),
  ADD COLUMN client_id uuid,
  ADD COLUMN status text NOT NULL DEFAULT 'active' CHECK (status IN ('invited', 'active', 'disabled')),
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
  ADD CONSTRAINT membership_client_viewer_check CHECK ((role = 'client_viewer') = (client_id IS NOT NULL)),
  ADD CONSTRAINT membership_client_fk FOREIGN KEY (tenant_id, client_id) REFERENCES client (tenant_id, id) ON DELETE CASCADE;
CREATE INDEX membership_client_idx ON membership (tenant_id, client_id) WHERE client_id IS NOT NULL;

-- Single-use setup links: only the SHA-256 of the token is stored; 72 h expiry is set by the API.
CREATE TABLE member_setup_token (
  token_hash  text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  tenant_id   uuid NOT NULL,
  user_id     uuid NOT NULL,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, user_id) REFERENCES membership (tenant_id, user_id) ON DELETE CASCADE
);
CREATE INDEX member_setup_token_user_idx ON member_setup_token (tenant_id, user_id);

-- ---------------------------------------------------------------- price book and quote settings

CREATE TABLE price_book_item (
  id                  uuid PRIMARY KEY,
  tenant_id           uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  sku                 text NOT NULL CHECK (length(sku) BETWEEN 1 AND 40),
  name                text NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
  description         text NOT NULL DEFAULT '' CHECK (length(description) <= 1000),
  category            text NOT NULL CHECK (category IN ('hardware', 'software', 'labor', 'service', 'subscription')),
  unit                text NOT NULL CHECK (unit IN ('each', 'ft', 'hour', 'lot', 'month', 'year')),
  material_cost       double precision NOT NULL CHECK (material_cost BETWEEN 0 AND 10000000),
  labor_hours         double precision NOT NULL CHECK (labor_hours BETWEEN 0 AND 1000),
  default_margin_pct  double precision NOT NULL CHECK (default_margin_pct BETWEEN 0 AND 95),
  control_ids         text[] NOT NULL DEFAULT '{}' CHECK (cardinality(control_ids) <= 30),
  asset_types         text[] NOT NULL DEFAULT '{}' CHECK (cardinality(asset_types) <= 10),
  tier                text NOT NULL DEFAULT 'any' CHECK (tier IN ('good', 'better', 'best', 'any')),
  active              boolean NOT NULL DEFAULT true,
  -- Imported from the illustrative template; cleared when an admin edits the prices (placeholder badge).
  from_template       boolean NOT NULL DEFAULT false,
  created_by          uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          uuid,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CONSTRAINT price_book_item_sku_key UNIQUE (tenant_id, sku)
);

CREATE TABLE quote_settings (
  tenant_id           uuid PRIMARY KEY REFERENCES tenant (id) ON DELETE CASCADE,
  default_labor_rate  double precision NOT NULL CHECK (default_labor_rate BETWEEN 0 AND 10000000),
  min_margin_pct      double precision NOT NULL CHECK (min_margin_pct BETWEEN 0 AND 95),
  default_terms       text NOT NULL DEFAULT '' CHECK (length(default_terms) <= 4000),
  valid_days          integer NOT NULL CHECK (valid_days BETWEEN 1 AND 365),
  updated_by          uuid,
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- quotes (proposals only, D-078)

CREATE TABLE quote (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  assessment_id     uuid NOT NULL,
  -- Q-<year>-<NNNN>, then Q-<year>-<NNNN>-R2, -R3 for revisions (unique per tenant).
  number            text NOT NULL CHECK (number ~ '^Q-\d{4}-\d{4,}(-R\d+)?$'),
  base_number       text NOT NULL,
  revision          integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  revised_from      uuid,
  status            text NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft', 'pending_approval', 'approved', 'sent', 'accepted', 'declined', 'expired')),
  title             text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  labor_rate        double precision NOT NULL CHECK (labor_rate BETWEEN 0 AND 10000000),
  valid_until       date NOT NULL,
  tiers             text[] NOT NULL CHECK (cardinality(tiers) BETWEEN 1 AND 3 AND tiers <@ ARRAY['good', 'better', 'best']),
  notes             text NOT NULL DEFAULT '' CHECK (length(notes) <= 4000),
  terms             text NOT NULL DEFAULT '' CHECK (length(terms) <= 4000),
  currency          text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  -- Output of quoteTotals (packages/shared, D-080) at the last save; never computed in SQL.
  totals            jsonb NOT NULL DEFAULT '[]',
  min_margin_pct    double precision NOT NULL,
  below_min_margin  boolean NOT NULL DEFAULT false,
  created_by        uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_by        uuid,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  submitted_by      uuid,
  submitted_at      timestamptz,
  approved_by       uuid,
  approved_at       timestamptz,
  sent_by           uuid,
  sent_at           timestamptz,
  responded_at      timestamptz,
  responded_by      text CHECK (length(responded_by) <= 120),
  responded_user_id uuid,
  accepted_tier     text CHECK (accepted_tier IN ('good', 'better', 'best')),
  decline_reason    text CHECK (length(decline_reason) <= 1000),
  UNIQUE (tenant_id, id),
  CONSTRAINT quote_number_key UNIQUE (tenant_id, number),
  FOREIGN KEY (tenant_id, assessment_id) REFERENCES assessment (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, revised_from) REFERENCES quote (tenant_id, id) ON DELETE SET NULL (revised_from)
);
CREATE INDEX quote_assessment_idx ON quote (tenant_id, assessment_id, created_at);

CREATE TABLE quote_line (
  id                  uuid NOT NULL,
  tenant_id           uuid NOT NULL,
  quote_id            uuid NOT NULL,
  finding_id          uuid,
  price_book_item_id  uuid,
  description         text NOT NULL CHECK (length(description) BETWEEN 1 AND 500),
  category            text NOT NULL CHECK (category IN ('hardware', 'software', 'labor', 'service', 'subscription')),
  unit                text NOT NULL CHECK (unit IN ('each', 'ft', 'hour', 'lot', 'month', 'year')),
  quantity            double precision NOT NULL CHECK (quantity BETWEEN 0 AND 100000),
  material_cost       double precision NOT NULL CHECK (material_cost BETWEEN 0 AND 10000000),
  labor_hours         double precision NOT NULL CHECK (labor_hours BETWEEN 0 AND 1000),
  margin_pct          double precision NOT NULL CHECK (margin_pct BETWEEN 0 AND 95),
  tier                text NOT NULL CHECK (tier IN ('good', 'better', 'best', 'all')),
  optional            boolean NOT NULL DEFAULT false,
  needs_pricing       boolean NOT NULL DEFAULT false,
  sort_order          integer NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
  -- Line ids are client-generated; scoping the key to the quote means they can never collide across tenants.
  PRIMARY KEY (quote_id, id),
  FOREIGN KEY (tenant_id, quote_id) REFERENCES quote (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, finding_id) REFERENCES finding (tenant_id, id) ON DELETE SET NULL (finding_id),
  FOREIGN KEY (tenant_id, price_book_item_id) REFERENCES price_book_item (tenant_id, id)
);
CREATE INDEX quote_line_tenant_idx ON quote_line (tenant_id, quote_id);
CREATE INDEX quote_line_item_idx ON quote_line (tenant_id, price_book_item_id) WHERE price_book_item_id IS NOT NULL;

-- ---------------------------------------------------------------- row-level security

ALTER TABLE tenant_branding ENABLE ROW LEVEL SECURITY;    ALTER TABLE tenant_branding FORCE ROW LEVEL SECURITY;
ALTER TABLE member_setup_token ENABLE ROW LEVEL SECURITY; ALTER TABLE member_setup_token FORCE ROW LEVEL SECURITY;
ALTER TABLE price_book_item ENABLE ROW LEVEL SECURITY;    ALTER TABLE price_book_item FORCE ROW LEVEL SECURITY;
ALTER TABLE quote_settings ENABLE ROW LEVEL SECURITY;     ALTER TABLE quote_settings FORCE ROW LEVEL SECURITY;
ALTER TABLE quote ENABLE ROW LEVEL SECURITY;              ALTER TABLE quote FORCE ROW LEVEL SECURITY;
ALTER TABLE quote_line ENABLE ROW LEVEL SECURITY;         ALTER TABLE quote_line FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON tenant_branding USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY tenant_isolation ON member_setup_token USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY tenant_isolation ON price_book_item USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY tenant_isolation ON quote_settings USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY tenant_isolation ON quote USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY tenant_isolation ON quote_line USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
-- The setup-token lookup happens before a tenant is known (SECURITY DEFINER function below).
CREATE POLICY owner_read ON member_setup_token FOR SELECT TO sentinel_owner USING (true);

-- ---------------------------------------------------------------- grants

GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_branding, member_setup_token, price_book_item, quote_settings, quote_line TO sentinel_app;
GRANT SELECT, INSERT, UPDATE ON quote TO sentinel_app;
-- Members: the app may add members and change role, client, and status; never tenant_id or user_id.
GRANT INSERT ON membership TO sentinel_app;
GRANT UPDATE (role, client_id, status, updated_at) ON membership TO sentinel_app;

-- ---------------------------------------------------------------- auth functions

-- Login lookup now reports each membership's status, so disabled and invited memberships are refused.
CREATE OR REPLACE FUNCTION auth_find_user(p_email text)
RETURNS TABLE (user_id uuid, email text, name text, password_hash text, google_sub text,
               locked_until timestamptz, memberships jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT u.id, u.email, u.name, u.password_hash, u.google_sub, u.locked_until,
         COALESCE((SELECT jsonb_agg(jsonb_build_object('tenantId', t.id, 'slug', t.slug, 'name', t.name, 'role', m.role,
                                                       'status', m.status)
                                    ORDER BY t.name)
                     FROM membership m JOIN tenant t ON t.id = m.tenant_id
                    WHERE m.user_id = u.id), '[]'::jsonb)
    FROM app_user u
   WHERE u.email = lower(p_email) AND u.disabled_at IS NULL
$$;

-- Finds or creates the global identity for an invite. Callable only inside a tenant transaction;
-- returns the user id and whether this call created it. Never returns or changes a password.
CREATE FUNCTION member_invite_user(p_email text, p_name text)
RETURNS TABLE (user_id uuid, created boolean)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id uuid;
BEGIN
  IF app_current_tenant() IS NULL THEN RAISE EXCEPTION 'member_invite_user: no tenant context'; END IF;
  INSERT INTO app_user (email, name) VALUES (lower(p_email), left(p_name, 120))
    ON CONFLICT (email) DO NOTHING RETURNING id INTO v_id;
  IF v_id IS NOT NULL THEN RETURN QUERY SELECT v_id, true; RETURN; END IF;
  SELECT id INTO v_id FROM app_user WHERE email = lower(p_email);
  RETURN QUERY SELECT v_id, false;
END $$;

-- Setup-token lookup by hash (the caller must hold the token). "claimable" means the account has no
-- password, no Google link, and no active membership elsewhere, so the link may set its first password;
-- otherwise the person proves the existing password instead (no account takeover through an invite).
CREATE FUNCTION auth_find_setup_token(p_hash text)
RETURNS TABLE (tenant_id uuid, user_id uuid, email text, password_hash text, usable boolean, claimable boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT s.tenant_id, s.user_id, u.email, u.password_hash,
         (s.used_at IS NULL AND s.expires_at > now() AND u.disabled_at IS NULL AND m.status = 'invited') AS usable,
         (u.password_hash IS NULL AND u.google_sub IS NULL AND NOT EXISTS (
            SELECT 1 FROM membership o WHERE o.user_id = u.id AND o.tenant_id <> s.tenant_id AND o.status = 'active')) AS claimable
    FROM member_setup_token s
    JOIN app_user u ON u.id = s.user_id
    JOIN membership m ON m.tenant_id = s.tenant_id AND m.user_id = s.user_id
   WHERE s.token_hash = p_hash
$$;

-- Consumes a setup token exactly once and activates the invited membership. p_password_hash sets the
-- first password and is accepted only while the account is still claimable. Returns NULL when the
-- token is unknown, used, expired, or no longer applicable.
CREATE FUNCTION auth_complete_setup(p_hash text, p_password_hash text)
RETURNS TABLE (tenant_id uuid, user_id uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_tenant uuid; v_user uuid;
BEGIN
  SELECT s.tenant_id, s.user_id INTO v_tenant, v_user FROM member_setup_token s WHERE s.token_hash = p_hash;
  IF v_tenant IS NULL THEN RETURN; END IF;
  PERFORM set_config('app.tenant_id', v_tenant::text, true);
  UPDATE member_setup_token s SET used_at = now()
   WHERE s.token_hash = p_hash AND s.used_at IS NULL AND s.expires_at > now();
  IF NOT FOUND THEN RETURN; END IF;
  IF p_password_hash IS NOT NULL THEN
    UPDATE app_user u SET password_hash = p_password_hash, failed_login_count = 0, locked_until = NULL
     WHERE u.id = v_user AND u.password_hash IS NULL AND u.google_sub IS NULL AND u.disabled_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM membership o WHERE o.user_id = v_user AND o.tenant_id <> v_tenant AND o.status = 'active');
    IF NOT FOUND THEN RAISE EXCEPTION 'auth_complete_setup: account is not claimable'; END IF;
  END IF;
  UPDATE membership m SET status = 'active', updated_at = now()
   WHERE m.tenant_id = v_tenant AND m.user_id = v_user AND m.status = 'invited';
  IF NOT FOUND THEN RAISE EXCEPTION 'auth_complete_setup: membership is not pending'; END IF;
  -- Any other outstanding links for this membership stop working.
  UPDATE member_setup_token s SET used_at = now() WHERE s.tenant_id = v_tenant AND s.user_id = v_user AND s.used_at IS NULL;
  PERFORM set_config('app.tenant_id', '', true);
  RETURN QUERY SELECT v_tenant, v_user;
END $$;

REVOKE ALL ON FUNCTION member_invite_user(text, text), auth_find_setup_token(text), auth_complete_setup(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION member_invite_user(text, text), auth_find_setup_token(text), auth_complete_setup(text, text) TO sentinel_app;
