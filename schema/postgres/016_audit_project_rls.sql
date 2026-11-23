CREATE POLICY audit_project_read ON audit_events AS RESTRICTIVE FOR SELECT USING (
  (SELECT public.projectos_document_scope()->>'role')='owner'
  OR (
    (SELECT public.projectos_document_scope()->>'role') IN ('editor','viewer') AND kind<>'secrets'
    AND ((SELECT public.projectos_document_scope()->'projects')='null'::jsonb
      OR (SELECT public.projectos_document_scope()->'projects') ? project_id)
  )
);
CREATE POLICY audit_project_insert ON audit_events AS RESTRICTIVE FOR INSERT WITH CHECK (
  actor_id=(SELECT public.projectos_document_scope()->>'actor')
  AND ((SELECT public.projectos_document_scope()->>'role')='owner'
    OR (
      (SELECT public.projectos_document_scope()->>'role')='editor' AND kind IN ('tasks','docs','reminders','incidents')
      AND ((SELECT public.projectos_document_scope()->'projects')='null'::jsonb
        OR (SELECT public.projectos_document_scope()->'projects') ? project_id)
    ))
);

-- Preserve the cross-project document ID reservation without disclosing historical rows.
CREATE FUNCTION public.projectos_document_was_retired(document text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT (SELECT public.projectos_document_scope()->>'role') IN ('owner','editor') AND EXISTS (
    SELECT 1 FROM public.audit_events a WHERE a.workspace_id=(SELECT public.projectos_verified_workspace())
      AND a.kind='docs' AND a.record_id=document AND a.action='delete'
  )
$$;
CREATE INDEX audit_retired_record_idx ON audit_events(workspace_id,kind,record_id) WHERE action='delete';
