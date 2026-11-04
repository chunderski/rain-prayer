-- SECURITY DEFINER functions for the steps that happen before a tenant is known
-- (login lookup, lockout counters, refresh token lookup, unscoped auth audit events).
-- They run as sentinel_owner, expose only what the auth flow needs, and pin search_path.

CREATE FUNCTION auth_find_user(p_email text)
RETURNS TABLE (user_id uuid, email text, name text, password_hash text, google_sub text,
               locked_until timestamptz, memberships jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT u.id, u.email, u.name, u.password_hash, u.google_sub, u.locked_until,
         COALESCE((SELECT jsonb_agg(jsonb_build_object('tenantId', t.id, 'slug', t.slug, 'name', t.name, 'role', m.role)
                                    ORDER BY t.name)
                     FROM membership m JOIN tenant t ON t.id = m.tenant_id
                    WHERE m.user_id = u.id), '[]'::jsonb)
    FROM app_user u
   WHERE u.email = lower(p_email) AND u.disabled_at IS NULL
$$;

-- Records a failed password attempt; locks the account for p_lock_seconds after p_max failures.
-- Returns the lock expiry when this failure triggered a lock, else NULL.
CREATE FUNCTION auth_register_login_failure(p_user uuid, p_max integer, p_lock_seconds integer)
RETURNS timestamptz
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_count integer; v_locked timestamptz;
BEGIN
  UPDATE app_user SET failed_login_count = failed_login_count + 1
   WHERE id = p_user RETURNING failed_login_count INTO v_count;
  IF v_count IS NOT NULL AND v_count >= p_max THEN
    v_locked := now() + make_interval(secs => p_lock_seconds);
    UPDATE app_user SET failed_login_count = 0, locked_until = v_locked WHERE id = p_user;
  END IF;
  RETURN v_locked;
END $$;

CREATE FUNCTION auth_register_login_success(p_user uuid)
RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE app_user SET failed_login_count = 0, locked_until = NULL, last_login_at = now() WHERE id = p_user
$$;

-- Links a Google subject to a user on first Google sign-in. Returns false when the user is
-- already linked to a different Google subject (or the subject belongs to another user).
CREATE FUNCTION auth_link_google_sub(p_user uuid, p_sub text)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_existing text;
BEGIN
  SELECT google_sub INTO v_existing FROM app_user WHERE id = p_user FOR UPDATE;
  IF v_existing IS NOT NULL THEN RETURN v_existing = p_sub; END IF;
  IF EXISTS (SELECT 1 FROM app_user WHERE google_sub = p_sub) THEN RETURN false; END IF;
  UPDATE app_user SET google_sub = p_sub WHERE id = p_user;
  RETURN true;
END $$;

-- Lookup by SHA-256 hash of the opaque refresh token (the caller must hold the token itself).
CREATE FUNCTION auth_find_refresh_token(p_hash text)
RETURNS TABLE (id uuid, tenant_id uuid, user_id uuid, family_id uuid, expires_at timestamptz, revoked_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT r.id, r.tenant_id, r.user_id, r.family_id, r.expires_at, r.revoked_at
    FROM refresh_token r WHERE r.token_hash = p_hash
$$;

-- Auth events with no tenant (unknown email, user without a resolvable tenant).
CREATE FUNCTION auth_log_unscoped_event(p_action text, p_user uuid, p_email text, p_ip text, p_user_agent text, p_details jsonb)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF p_action !~ '^auth\.[a-z_.]+$' THEN
    RAISE EXCEPTION 'auth_log_unscoped_event: only auth.* actions are allowed';
  END IF;
  INSERT INTO audit_log (tenant_id, actor_user_id, actor_email, action, ip, user_agent, details)
  VALUES (NULL, p_user, left(p_email, 254), p_action, left(p_ip, 64), left(p_user_agent, 512), COALESCE(p_details, '{}'::jsonb));
END $$;

REVOKE ALL ON FUNCTION auth_find_user(text), auth_register_login_failure(uuid, integer, integer),
  auth_register_login_success(uuid), auth_link_google_sub(uuid, text), auth_find_refresh_token(text),
  auth_log_unscoped_event(text, uuid, text, text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_find_user(text), auth_register_login_failure(uuid, integer, integer),
  auth_register_login_success(uuid), auth_link_google_sub(uuid, text), auth_find_refresh_token(text),
  auth_log_unscoped_event(text, uuid, text, text, text, jsonb) TO sentinel_app;
