CREATE FUNCTION public.projectos_identity_scope() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT claims::jsonb FROM projectos_private.scope_key,
    LATERAL (SELECT current_setting('projectos.identity_scope',true) AS claims,
                    current_setting('projectos.identity_mac',true) AS mac) AS context
  WHERE singleton AND length(claims) BETWEEN 2 AND 2048 AND mac ~ '^[0-9a-f]{64}$'
    AND public.hmac(convert_to(pg_backend_pid()::text || ':' ||
      extract(epoch FROM transaction_timestamp())::text || ':identity:' || claims,'UTF8'),secret,'sha256')
      = decode(CASE WHEN mac ~ '^[0-9a-f]{64}$' THEN mac ELSE '' END,'hex')
$$;

CREATE FUNCTION public.projectos_setup_open() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT NOT EXISTS (SELECT 1 FROM public.users)
$$;

CREATE FUNCTION public.projectos_password_credentials()
RETURNS TABLE(id text,password_hash text,salt text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT u.id,u.password_hash,u.salt FROM public.users u
  WHERE (SELECT public.projectos_identity_scope()->>'purpose')='login'
    AND u.email=(SELECT public.projectos_identity_scope()->>'email')
$$;

CREATE FUNCTION public.projectos_mfa_enabled() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT EXISTS (SELECT 1 FROM public.users u
    WHERE (SELECT public.projectos_identity_scope()->>'purpose') IN ('identity','mfa')
      AND u.id=(SELECT public.projectos_identity_scope()->>'userId') AND u.mfa_seed IS NOT NULL)
$$;

CREATE FUNCTION public.projectos_mfa_material()
RETURNS TABLE(seed text,pending text,expires bigint,binding text,"lastStep" bigint,failed integer,locked bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT u.mfa_seed,u.mfa_pending,u.mfa_pending_until,u.mfa_pending_session,
         u.mfa_last_step,u.mfa_failed,u.mfa_locked_until
  FROM public.users u WHERE (SELECT public.projectos_identity_scope()->>'purpose')='mfa'
    AND u.id=(SELECT public.projectos_identity_scope()->>'userId')
$$;

-- These helpers query as the schema owner to avoid recursive membership/user policies.
-- Definer functions use a fixed search path and disclose only their declared projection.
CREATE FUNCTION public.projectos_owner_of(workspace text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT workspace=(SELECT public.projectos_verified_workspace()) AND EXISTS (
    SELECT 1 FROM public.memberships m
    WHERE m.workspace_id=workspace AND m.user_id=(SELECT public.projectos_document_scope()->>'actor')
      AND m.role='owner' AND (SELECT public.projectos_document_scope()->>'role')='owner'
  )
$$;

CREATE FUNCTION public.projectos_directory_user(user_id text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT EXISTS (SELECT 1 FROM public.memberships m WHERE m.user_id=$1
    AND public.projectos_owner_of(m.workspace_id))
$$;

CREATE FUNCTION public.projectos_invited_user(email_address text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT (SELECT public.projectos_identity_scope()->>'purpose')='invite'
    AND EXISTS (SELECT 1 FROM public.workspace_invites i
      WHERE i.token_hash=(SELECT public.projectos_identity_scope()->>'digest')
        AND i.email=email_address AND i.email=(SELECT public.projectos_identity_scope()->>'email')
        AND i.revoked_at IS NULL AND i.redeemed_at IS NULL
        AND i.expires_at > extract(epoch FROM statement_timestamp())*1000)
$$;

CREATE FUNCTION public.projectos_membership_invited(uid text,workspace text,member_role text,grants text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT (SELECT public.projectos_identity_scope()->>'purpose')='invite'
    AND EXISTS (SELECT 1 FROM public.workspace_invites i JOIN public.users u ON u.email=i.email
      WHERE u.id=uid AND i.workspace_id=workspace AND i.role=member_role
        AND i.project_ids::jsonb IS NOT DISTINCT FROM grants::jsonb
        AND i.token_hash=(SELECT public.projectos_identity_scope()->>'digest')
        AND i.email=(SELECT public.projectos_identity_scope()->>'email')
        AND i.revoked_at IS NULL AND i.redeemed_at IS NULL
        AND i.expires_at > extract(epoch FROM statement_timestamp())*1000)
$$;

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
CREATE POLICY identity_user_read ON users FOR SELECT USING (
  (SELECT public.projectos_identity_scope()->>'purpose') IN ('identity','mfa','bootstrap')
    AND id=(SELECT public.projectos_identity_scope()->>'userId')
  OR (SELECT public.projectos_identity_scope()->>'purpose')='login'
    AND email=(SELECT public.projectos_identity_scope()->>'email')
  OR email=(SELECT public.projectos_identity_scope()->>'email') AND public.projectos_invited_user(email)
  OR public.projectos_directory_user(id)
  OR id=(SELECT public.projectos_document_scope()->>'actor')
);
CREATE POLICY identity_user_insert ON users FOR INSERT WITH CHECK (
  (SELECT public.projectos_identity_scope()->>'purpose')='bootstrap'
    AND id=(SELECT public.projectos_identity_scope()->>'userId') AND (SELECT public.projectos_setup_open())
  OR email=(SELECT public.projectos_identity_scope()->>'email') AND public.projectos_invited_user(email)
);
CREATE POLICY identity_user_update ON users FOR UPDATE USING (
  (SELECT public.projectos_identity_scope()->>'purpose')='mfa'
    AND id=(SELECT public.projectos_identity_scope()->>'userId')
  OR (SELECT public.projectos_identity_scope()->>'purpose')='login'
    AND email=(SELECT public.projectos_identity_scope()->>'email')
  OR id=(SELECT public.projectos_document_scope()->>'actor') AND (SELECT public.projectos_document_scope()->>'role')='owner'
);

CREATE FUNCTION public.projectos_guard_user_update() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE purpose text := public.projectos_identity_scope()->>'purpose';
DECLARE fields text[];
BEGIN
  -- Only the table owner performs data maintenance without a request capability.
  IF current_user=(SELECT relowner::regrole::text FROM pg_class WHERE oid=TG_RELID) THEN RETURN NEW; END IF;
  fields := CASE purpose
    WHEN 'login' THEN ARRAY['failed_logins','locked_until']
    WHEN 'mfa' THEN ARRAY['mfa_seed','mfa_pending','mfa_pending_session','mfa_pending_until',
      'mfa_last_step','mfa_failed','mfa_locked_until']
    ELSE ARRAY['display_name']
  END;
  IF to_jsonb(OLD)-fields IS DISTINCT FROM to_jsonb(NEW)-fields THEN
    RAISE EXCEPTION 'Invalid identity update' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER enforce_user_update BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION public.projectos_guard_user_update();

ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
CREATE POLICY membership_read ON memberships FOR SELECT USING (
  (SELECT public.projectos_identity_scope()->>'purpose') IN ('identity','mfa')
    AND user_id=(SELECT public.projectos_identity_scope()->>'userId')
  OR user_id=(SELECT public.projectos_document_scope()->>'actor')
  OR public.projectos_owner_of(workspace_id)
);
CREATE POLICY membership_insert ON memberships FOR INSERT WITH CHECK (
  (SELECT public.projectos_identity_scope()->>'purpose')='bootstrap'
    AND user_id=(SELECT public.projectos_identity_scope()->>'userId')
    AND workspace_id=(SELECT public.projectos_identity_scope()->>'workspaceId') AND role='owner'
  OR public.projectos_membership_invited(user_id,workspace_id,role,project_ids)
);
CREATE POLICY membership_grant ON memberships FOR UPDATE USING (role<>'owner' AND public.projectos_owner_of(workspace_id));
CREATE POLICY membership_revoke ON memberships FOR DELETE USING (role<>'owner' AND public.projectos_owner_of(workspace_id));

ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY session_read ON sessions FOR SELECT USING (
  (SELECT public.projectos_identity_scope()->>'purpose')='session'
    AND token_hash=(SELECT public.projectos_identity_scope()->>'digest')
  OR (SELECT public.projectos_identity_scope()->>'purpose')='mfa'
    AND user_id=(SELECT public.projectos_identity_scope()->>'userId')
);
CREATE POLICY session_insert ON sessions FOR INSERT WITH CHECK (
  (SELECT public.projectos_identity_scope()->>'purpose')='mfa'
    AND user_id=(SELECT public.projectos_identity_scope()->>'userId')
);
CREATE POLICY session_touch ON sessions FOR UPDATE USING (
  (SELECT public.projectos_identity_scope()->>'purpose')='session'
    AND token_hash=(SELECT public.projectos_identity_scope()->>'digest')
);
CREATE POLICY session_revoke ON sessions FOR DELETE USING (
  (SELECT public.projectos_identity_scope()->>'purpose')='session'
    AND token_hash=(SELECT public.projectos_identity_scope()->>'digest')
  OR (SELECT public.projectos_identity_scope()->>'purpose')='mfa'
    AND user_id=(SELECT public.projectos_identity_scope()->>'userId')
);

CREATE FUNCTION public.projectos_session_user(now_ms bigint,idle_before bigint) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE scope jsonb := public.projectos_identity_scope();
DECLARE found_user text;
BEGIN
  IF scope->>'purpose' IS DISTINCT FROM 'session' THEN RETURN NULL; END IF;
  SELECT s.user_id INTO found_user FROM public.sessions s WHERE s.token_hash=scope->>'digest'
    AND s.expires_at>now_ms AND s.last_seen_at>idle_before;
  IF FOUND THEN
    UPDATE public.sessions SET last_seen_at=now_ms WHERE token_hash=scope->>'digest' AND last_seen_at<now_ms-60000;
  END IF;
  RETURN found_user;
END
$$;
CREATE FUNCTION public.projectos_end_session() RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
  DELETE FROM public.sessions WHERE (SELECT public.projectos_identity_scope()->>'purpose')='session'
    AND token_hash=(SELECT public.projectos_identity_scope()->>'digest')
$$;
CREATE FUNCTION public.projectos_session_active(digest text,now_ms bigint,idle_before bigint) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT EXISTS (SELECT 1 FROM public.sessions s
    WHERE (SELECT public.projectos_identity_scope()->>'purpose')='mfa'
      AND s.user_id=(SELECT public.projectos_identity_scope()->>'userId')
      AND s.token_hash=digest AND s.expires_at>now_ms AND s.last_seen_at>idle_before)
$$;
CREATE FUNCTION public.projectos_list_sessions(digest text,now_ms bigint,idle_before bigint)
RETURNS TABLE(id text,"current" boolean,"createdAt" bigint,"expiresAt" bigint,"lastSeenAt" bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT encode(public.digest('projectos:session-reference:' || s.token_hash,'sha256'),'hex'),
    s.token_hash=digest,s.created_at,s.expires_at,s.last_seen_at
  FROM public.sessions s
  WHERE (SELECT public.projectos_identity_scope()->>'purpose')='session-list'
    AND s.user_id=(SELECT public.projectos_identity_scope()->>'userId')
    AND s.expires_at>now_ms AND s.last_seen_at>idle_before
  ORDER BY s.created_at DESC
$$;
CREATE FUNCTION public.projectos_revoke_sessions(digest text,action text,reference text)
RETURNS TABLE(revoked integer,"signedOut" boolean)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
  WITH removed AS (
    DELETE FROM public.sessions s WHERE (SELECT public.projectos_identity_scope()->>'purpose')='mfa'
      AND s.user_id=(SELECT public.projectos_identity_scope()->>'userId')
      AND CASE action WHEN 'revokeAll' THEN true WHEN 'revokeOthers' THEN s.token_hash<>digest
        WHEN 'revokeOne' THEN encode(public.digest('projectos:session-reference:' || s.token_hash,'sha256'),'hex')=reference
        ELSE false END
    RETURNING s.token_hash=digest AS current_removed
  )
  SELECT count(*)::integer,coalesce(bool_or(current_removed),false) FROM removed
$$;

ALTER TABLE workspace_invites ENABLE ROW LEVEL SECURITY;
CREATE POLICY invite_read ON workspace_invites FOR SELECT USING (
  public.projectos_owner_of(workspace_id)
  OR (SELECT public.projectos_identity_scope()->>'purpose')='invite'
    AND token_hash=(SELECT public.projectos_identity_scope()->>'digest')
    AND email=(SELECT public.projectos_identity_scope()->>'email')
);
CREATE POLICY invite_create ON workspace_invites FOR INSERT WITH CHECK (
  public.projectos_owner_of(workspace_id) AND revoked_at IS NULL AND redeemed_at IS NULL
);
CREATE FUNCTION public.projectos_find_invite()
RETURNS TABLE(id text,email text,workspace_id text,role text,project_ids text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT i.id,i.email,i.workspace_id,i.role,i.project_ids FROM public.workspace_invites i
  WHERE (SELECT public.projectos_identity_scope()->>'purpose')='invite'
    AND i.token_hash=(SELECT public.projectos_identity_scope()->>'digest')
    AND i.email=(SELECT public.projectos_identity_scope()->>'email')
    AND i.revoked_at IS NULL AND i.redeemed_at IS NULL
    AND i.expires_at > extract(epoch FROM statement_timestamp())*1000
$$;
CREATE POLICY invite_change ON workspace_invites FOR UPDATE USING (
  revoked_at IS NULL AND redeemed_at IS NULL AND (
    public.projectos_owner_of(workspace_id)
    OR (SELECT public.projectos_identity_scope()->>'purpose')='invite'
      AND token_hash=(SELECT public.projectos_identity_scope()->>'digest')
      AND email=(SELECT public.projectos_identity_scope()->>'email')
  )
) WITH CHECK (
  revoked_at IS NOT NULL AND redeemed_at IS NULL AND public.projectos_owner_of(workspace_id)
  OR redeemed_at IS NOT NULL AND revoked_at IS NULL
    AND (SELECT public.projectos_identity_scope()->>'purpose')='invite'
    AND token_hash=(SELECT public.projectos_identity_scope()->>'digest')
    AND email=(SELECT public.projectos_identity_scope()->>'email')
);

ALTER TABLE mfa_recovery_codes ENABLE ROW LEVEL SECURITY;
CREATE POLICY recovery_subject ON mfa_recovery_codes USING (
  (SELECT public.projectos_identity_scope()->>'purpose')='mfa'
    AND user_id=(SELECT public.projectos_identity_scope()->>'userId')
);
CREATE POLICY recovery_count ON mfa_recovery_codes FOR SELECT USING (
  (SELECT public.projectos_identity_scope()->>'purpose')='identity'
    AND user_id=(SELECT public.projectos_identity_scope()->>'userId')
);
CREATE FUNCTION public.projectos_consume_recovery(digest text) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
  DELETE FROM public.mfa_recovery_codes c
  WHERE (SELECT public.projectos_identity_scope()->>'purpose')='mfa'
    AND c.user_id=(SELECT public.projectos_identity_scope()->>'userId') AND c.code_hash=digest
  RETURNING true
$$;

ALTER TABLE ai_quota ENABLE ROW LEVEL SECURITY;
CREATE POLICY ai_quota_owner ON ai_quota USING (
  (SELECT public.projectos_document_scope()->>'role')='owner'
    AND user_id=(SELECT public.projectos_document_scope()->>'actor')
    AND (SELECT public.projectos_owner_of(public.projectos_verified_workspace()))
);

ALTER TABLE auth_rate_limits ENABLE ROW LEVEL SECURITY;
CREATE POLICY rate_bucket ON auth_rate_limits USING (
  (SELECT public.projectos_identity_scope()->>'purpose')='rate'
    AND scope=(SELECT public.projectos_identity_scope()->>'scope')
    AND bucket=(SELECT public.projectos_identity_scope()->>'bucket')
);

-- This is a provisioning function for the table owner. Existing grants are
-- tightened atomically as part of migration; new logins use grant-runtime.sql.
CREATE FUNCTION projectos_private.grant_identity_runtime(target name) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  EXECUTE format('REVOKE SELECT, INSERT, UPDATE ON public.users, public.workspace_invites FROM %I',target);
  EXECUTE format('REVOKE UPDATE ON public.memberships FROM %I',target);
  EXECUTE format('REVOKE SELECT, UPDATE ON public.sessions FROM %I',target);
  EXECUTE format('REVOKE SELECT ON public.mfa_recovery_codes FROM %I',target);
  EXECUTE format('GRANT SELECT(id,email,display_name,failed_logins,locked_until,mfa_last_step,mfa_failed,mfa_locked_until),
    INSERT(id,email,display_name,password_hash,salt,created_at),
    UPDATE(display_name,failed_logins,locked_until,mfa_seed,mfa_pending,mfa_pending_session,mfa_pending_until,
      mfa_last_step,mfa_failed,mfa_locked_until) ON public.users TO %I',target);
  EXECUTE format('GRANT SELECT(id,workspace_id,email,role,expires_at,created_at,redeemed_at,revoked_at,project_ids),
    INSERT(id,workspace_id,email,role,token_hash,expires_at,created_at,project_ids),
    UPDATE(redeemed_at,revoked_at) ON public.workspace_invites TO %I',target);
  EXECUTE format('GRANT UPDATE(project_ids) ON public.memberships TO %I',target);
  EXECUTE format('GRANT SELECT(user_id,expires_at,last_seen_at) ON public.sessions TO %I',target);
  EXECUTE format('GRANT SELECT(user_id) ON public.mfa_recovery_codes TO %I',target);
END
$$;
DO $$
DECLARE target name;
BEGIN
  FOR target IN SELECT DISTINCT r.rolname FROM pg_class c
    CROSS JOIN LATERAL aclexplode(c.relacl) a
    JOIN pg_roles r ON r.oid=a.grantee
    WHERE c.oid='public.users'::regclass AND a.privilege_type='INSERT' AND a.grantee<>c.relowner
  LOOP
    PERFORM projectos_private.grant_identity_runtime(target);
  END LOOP;
END
$$;
