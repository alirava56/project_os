-- Application logins have no private schema access. FORCE also applies these
-- policies to non-superuser owners, permitting just the effective table owner
-- (including fixed definer lookups). These three tables are provisioned locally.
ALTER TABLE projectos_private.scope_key ENABLE ROW LEVEL SECURITY;
ALTER TABLE projectos_private.scope_key FORCE ROW LEVEL SECURITY;
CREATE POLICY key_owner ON projectos_private.scope_key USING (
  current_user::regrole::oid=(SELECT relowner FROM pg_class WHERE oid='projectos_private.scope_key'::regclass)
);
ALTER TABLE projectos_private.monitor_logins ENABLE ROW LEVEL SECURITY;
ALTER TABLE projectos_private.monitor_logins FORCE ROW LEVEL SECURITY;
CREATE POLICY monitor_binding_owner ON projectos_private.monitor_logins USING (
  current_user::regrole::oid=(SELECT relowner FROM pg_class WHERE oid='projectos_private.monitor_logins'::regclass)
);
ALTER TABLE projectos_private.reminder_logins ENABLE ROW LEVEL SECURITY;
ALTER TABLE projectos_private.reminder_logins FORCE ROW LEVEL SECURITY;
CREATE POLICY reminder_binding_owner ON projectos_private.reminder_logins USING (
  current_user::regrole::oid=(SELECT relowner FROM pg_class WHERE oid='projectos_private.reminder_logins'::regclass)
);

-- Retry details are only needed by the delivery process, which already uses a
-- per-login workspace policy. Runtime uses the outbox state and never reads leases.
DO $$
DECLARE target name;
BEGIN
  FOR target IN SELECT DISTINCT r.rolname FROM pg_class c
    CROSS JOIN LATERAL aclexplode(c.relacl) a JOIN pg_roles r ON r.oid=a.grantee
    WHERE c.oid='public.sessions'::regclass AND a.privilege_type='INSERT' AND a.grantee<>c.relowner
  LOOP
    EXECUTE format('REVOKE SELECT ON public.delivery_retries,public.worker_heartbeats FROM %I',target);
    EXECUTE format('REVOKE SELECT,INSERT,UPDATE ON public.notification_outbox FROM %I',target);
  END LOOP;
END
$$;

CREATE FUNCTION public.projectos_cancel_incident_outbox(alert text) RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
  UPDATE public.notification_outbox o SET state='cancelled'
  WHERE alert ~ '^(auto|monitor)-[a-f0-9]{28}$'
    AND o.workspace_id=(SELECT public.projectos_verified_workspace())
    AND o.state IN ('pending','retrying','sending')
    AND (o.id='tg-'||alert OR o.id='email-'||alert OR o.id LIKE 'tg-'||alert||'-%' OR o.id LIKE 'email-'||alert||'-%')
    AND EXISTS (SELECT 1 FROM public.records r WHERE r.workspace_id=o.workspace_id AND r.kind='incidents' AND r.id=alert
      AND public.projectos_can_write_record(r.kind,r.project_id,r.payload))
$$;

CREATE FUNCTION public.projectos_retire_deadline(record_kind text,record_id text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE workspace text := public.projectos_verified_workspace();
DECLARE source public.records%ROWTYPE;
DECLARE category text;
DECLARE deadline text;
DECLARE legacy text;
DECLARE target text;
BEGIN
  IF record_kind NOT IN ('tasks','resources') THEN RETURN; END IF;
  SELECT * INTO source FROM public.records r WHERE r.workspace_id=workspace AND r.kind=record_kind AND r.id=record_id
    AND public.projectos_can_write_record(r.kind,r.project_id,r.payload);
  IF NOT FOUND THEN RETURN; END IF;
  IF record_kind='resources' THEN
    category := 'تمدید';
    deadline := source.payload::jsonb->>'expires';
  ELSIF source.payload::jsonb->>'status'<>'done' AND source.payload::jsonb ? 'noticeDays' THEN
    category := 'یادآوری';
    deadline := source.payload::jsonb->>'due';
  END IF;
  IF deadline IS NULL THEN RETURN; END IF;
  legacy := workspace || '|' || category || '|' || record_id || '|' || deadline;
  FOR target IN SELECT 'auto-' || left(encode(public.digest(legacy || '|' || record_kind,'sha256'),'hex'),28)
    UNION ALL SELECT 'auto-' || left(encode(public.digest(legacy,'sha256'),'hex'),28)
      WHERE EXISTS (SELECT 1 FROM public.notification_outbox WHERE workspace_id=workspace
        AND id='auto-' || left(encode(public.digest(legacy,'sha256'),'hex'),28) AND reminder_id=record_kind || ':' || record_id)
  LOOP
    DELETE FROM public.records r WHERE r.workspace_id=workspace AND r.kind='incidents' AND r.id=target
      AND r.project_id=source.project_id AND r.payload::jsonb->>'source'='زمان‌بند داخلی · ثبت خودکار';
    UPDATE public.notification_outbox o SET state='cancelled' WHERE o.workspace_id=workspace
      AND o.state IN ('pending','retrying','sending','available')
      AND (o.id IN (target,'tg-'||target,'email-'||target) OR o.id LIKE 'tg-'||target||'-%' OR o.id LIKE 'email-'||target||'-%');
  END LOOP;
END
$$;

-- The webhook records its configured delivery and can only mark the repository
-- pending. Interactive sync retains its independently authorized snapshot access.
CREATE OR REPLACE FUNCTION public.projectos_integration_project(project text, repository text, writing boolean)
RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT COALESCE(CASE claims->>'role'
    WHEN 'owner' THEN true
    WHEN 'viewer' THEN NOT writing AND (claims->'projects'='null'::jsonb OR claims->'projects' ? project)
    WHEN 'editor' THEN NOT writing AND (claims->'projects'='null'::jsonb OR claims->'projects' ? project)
    ELSE false END,false)
  FROM (SELECT public.projectos_document_scope() AS claims) AS scope
$$;
CREATE FUNCTION public.projectos_record_github_delivery(delivery text,digest text,event text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE scope jsonb := public.projectos_document_scope();
DECLARE workspace text := public.projectos_verified_workspace();
DECLARE project text := scope->'projects'->>0;
DECLARE repository text := scope->>'repository';
DECLARE checked timestamptz := statement_timestamp();
BEGIN
  IF scope->>'role' IS DISTINCT FROM 'github' OR project IS NULL OR repository IS NULL
    OR delivery !~ '^[0-9a-fA-F-]{20,64}$' OR digest !~ '^[0-9a-f]{64}$'
    OR event NOT IN ('issues','release','deployment_status','push')
    OR NOT EXISTS (SELECT 1 FROM public.records WHERE workspace_id=workspace AND kind='projects' AND id=project)
  THEN RETURN false; END IF;
  INSERT INTO public.github_deliveries(workspace_id,project_id,repo,delivery_id,payload_hash,event_type,received_at)
    VALUES(workspace,project,repository,delivery,digest,event,checked) ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO public.github_snapshots(workspace_id,project_id,repo,checked_at,status,payload)
    VALUES(workspace,project,repository,checked,'pending_refresh',
      jsonb_build_object('repository',repository,'state','pending_refresh','checkedAt',NULL)::text)
    ON CONFLICT(workspace_id,project_id,repo) DO UPDATE SET checked_at=excluded.checked_at,status=excluded.status
      WHERE public.github_snapshots.checked_at<=excluded.checked_at;
  RETURN true;
END
$$;
