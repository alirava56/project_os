CREATE OR REPLACE FUNCTION public.projectos_document_scope() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE claims text := current_setting('projectos.document_scope', true);
DECLARE mac text := current_setting('projectos.document_mac', true);
DECLARE workspace text := public.projectos_verified_workspace();
DECLARE scope jsonb;
BEGIN
  IF workspace IS NULL OR claims IS NULL OR length(claims) > 65536
    OR mac IS NULL OR mac !~ '^[0-9a-f]{64}$' THEN RETURN NULL; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM projectos_private.scope_key WHERE singleton
      AND public.hmac(convert_to(pg_backend_pid()::text || ':' ||
        extract(epoch FROM transaction_timestamp())::text || ':docs:' || workspace || ':' || claims,
        'UTF8'), secret, 'sha256') = decode(mac, 'hex')
  ) THEN RETURN NULL; END IF;
  scope := claims::jsonb;
  IF scope->>'role' IN ('owner','editor','viewer') AND NOT EXISTS (
    SELECT 1 FROM public.memberships m WHERE m.workspace_id=workspace AND m.user_id=scope->>'actor'
      AND m.role=scope->>'role'
      AND COALESCE(m.project_ids::jsonb,'null'::jsonb) = scope->'projects'
  ) THEN RETURN NULL; END IF;
  RETURN scope;
END
$$;

ALTER TABLE record_tombstones ADD COLUMN project_id text;
UPDATE record_tombstones t SET project_id=(
  SELECT NULLIF(a.project_id,'') FROM audit_events a
  WHERE a.workspace_id=t.workspace_id AND a.kind=t.kind AND a.record_id=t.id AND a.action='delete'
  ORDER BY a.created_at DESC,a.id DESC LIMIT 1
);
ALTER TABLE record_tombstones ENABLE ROW LEVEL SECURITY;
CREATE POLICY tombstone_project_scope ON record_tombstones USING (
  workspace_id=(SELECT public.projectos_verified_workspace())
  AND public.projectos_can_write_record(kind,project_id,'{}')
);

CREATE FUNCTION public.projectos_check_record_tombstone(record_kind text,record_id text,expected bigint) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT (SELECT public.projectos_document_scope()->>'role') IN ('owner','editor') AND EXISTS (
    SELECT 1 FROM public.record_tombstones t WHERE t.workspace_id=(SELECT public.projectos_verified_workspace())
      AND t.kind=record_kind AND t.id=record_id AND t.record_version>expected
      AND public.projectos_can_write_record(t.kind,t.project_id,'{}')
  )
$$;

CREATE FUNCTION public.projectos_guard_workspace_update() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE role text := public.projectos_document_scope()->>'role';
BEGIN
  IF current_user=(SELECT relowner::regrole::text FROM pg_class WHERE oid=TG_RELID) THEN RETURN NEW; END IF;
  IF NOT COALESCE(NEW.version=OLD.version+1 AND (
    role='owner' OR (OLD.name=NEW.name AND (
      role='editor' OR OLD.id=public.projectos_monitor_workspace() OR OLD.id=public.projectos_reminder_workspace()
    ))
  ),false) THEN
    RAISE EXCEPTION 'Invalid workspace revision' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER enforce_workspace_update BEFORE UPDATE ON workspaces
  FOR EACH ROW EXECUTE FUNCTION public.projectos_guard_workspace_update();

-- Identity column access identifies the web login. Dedicated automation has no
-- identity grants and remains covered by its own workspace-specific policies.
CREATE POLICY web_workspace_scope ON workspaces AS RESTRICTIVE USING (
  NOT has_column_privilege(current_user,'public.users','email','SELECT')
  OR id=(SELECT public.projectos_verified_workspace())
) WITH CHECK (
  NOT has_column_privilege(current_user,'public.users','email','SELECT')
  OR id=(SELECT public.projectos_verified_workspace())
  OR (id=(SELECT public.projectos_identity_scope()->>'workspaceId')
    AND (SELECT public.projectos_identity_scope()->>'purpose')='bootstrap')
);
CREATE POLICY web_outbox_scope ON notification_outbox AS RESTRICTIVE USING (
  NOT has_column_privilege(current_user,'public.users','email','SELECT')
  OR (workspace_id=(SELECT public.projectos_verified_workspace())
    AND (SELECT public.projectos_document_scope()->>'role') IN ('owner','editor'))
);

CREATE FUNCTION projectos_private.grant_workspace_runtime(target name) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  EXECUTE format('REVOKE INSERT, UPDATE ON public.workspaces FROM %I',target);
  EXECUTE format('GRANT INSERT(id,name,created_at), UPDATE(version,name) ON public.workspaces TO %I',target);
END
$$;
DO $$
DECLARE target name;
BEGIN
  FOR target IN SELECT DISTINCT r.rolname FROM pg_class c
    CROSS JOIN LATERAL aclexplode(c.relacl) a JOIN pg_roles r ON r.oid=a.grantee
    WHERE c.oid='public.sessions'::regclass AND a.privilege_type='INSERT' AND a.grantee<>c.relowner
  LOOP
    PERFORM projectos_private.grant_workspace_runtime(target);
  END LOOP;
END
$$;
