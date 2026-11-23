CREATE TABLE projectos_private.monitor_logins (
  login oid PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE
);
CREATE TABLE projectos_private.reminder_logins (
  login oid PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE
);

CREATE FUNCTION public.projectos_monitor_workspace() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT workspace_id FROM projectos_private.monitor_logins
  WHERE login=(session_user::regrole)::oid
$$;
CREATE FUNCTION public.projectos_reminder_workspace() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT workspace_id FROM projectos_private.reminder_logins
  WHERE login=(session_user::regrole)::oid
$$;

-- Project claims are verified against the same transaction and workspace as the base policy.
CREATE POLICY record_project_read ON records AS RESTRICTIVE FOR SELECT USING (
  (SELECT public.projectos_monitor_workspace()) IS NOT NULL
  OR (SELECT public.projectos_reminder_workspace()) IS NOT NULL
  OR CASE (SELECT public.projectos_document_scope()->>'role')
    WHEN 'invitation' THEN kind = 'projects'
      AND (SELECT public.projectos_document_scope()->'projects') ? project_id
    WHEN 'github' THEN kind = 'projects'
      AND (SELECT public.projectos_document_scope()->'projects') ? project_id
    WHEN 'agent' THEN kind = 'resources'
      AND (SELECT public.projectos_document_scope()->'resources') ? id
    WHEN 'owner' THEN true
    ELSE (SELECT public.projectos_document_scope()->>'role') IN ('editor','viewer')
      AND kind <> 'secrets'
      AND NOT (kind='incidents' AND (payload::jsonb->>'source') IS NOT DISTINCT FROM 'زمان‌بند داخلی · چرخش اعتبارنامه')
      AND (
        kind = 'preferences'
        OR (SELECT public.projectos_document_scope()->'projects') = 'null'::jsonb
        OR (SELECT public.projectos_document_scope()->'projects') ? project_id
        OR (kind='resources' AND (payload::jsonb->'linkedProjectIds') ?|
          ARRAY(SELECT jsonb_array_elements_text(CASE
            WHEN jsonb_typeof(public.projectos_document_scope()->'projects')='array'
            THEN public.projectos_document_scope()->'projects' ELSE '[]'::jsonb END)))
      )
  END
);

CREATE FUNCTION public.projectos_can_write_record(record_kind text, record_project text, record_payload text)
RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT COALESCE(
    claims->>'role'='owner'
    OR (claims->>'role'='editor' AND record_kind IN ('tasks','docs','reminders','incidents')
      AND (claims->'projects'='null'::jsonb OR claims->'projects' ? record_project)
      AND NOT (record_kind='incidents' AND (record_payload::jsonb->>'source')
        IS NOT DISTINCT FROM 'زمان‌بند داخلی · چرخش اعتبارنامه')),
    false
  ) FROM (SELECT public.projectos_document_scope() AS claims) AS scope
$$;

CREATE POLICY record_project_insert ON records AS RESTRICTIVE FOR INSERT
  WITH CHECK (public.projectos_can_write_record(kind,project_id,payload)
    OR (SELECT public.projectos_monitor_workspace()) IS NOT NULL
    OR (SELECT public.projectos_reminder_workspace()) IS NOT NULL);
CREATE POLICY record_project_update ON records AS RESTRICTIVE FOR UPDATE
  USING (public.projectos_can_write_record(kind,project_id,payload)
    OR ((SELECT public.projectos_reminder_workspace()) IS NOT NULL AND kind='incidents'))
  WITH CHECK (public.projectos_can_write_record(kind,project_id,payload)
    OR ((SELECT public.projectos_reminder_workspace()) IS NOT NULL AND kind='incidents'));
CREATE POLICY record_project_delete ON records AS RESTRICTIVE FOR DELETE
  USING (public.projectos_can_write_record(kind,project_id,payload)
    OR ((SELECT public.projectos_reminder_workspace()) IS NOT NULL AND kind='incidents' AND id LIKE 'auto-%'));
