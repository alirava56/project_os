CREATE FUNCTION public.projectos_integration_project(project text, repository text, writing boolean)
RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT COALESCE(CASE claims->>'role'
    WHEN 'owner' THEN true
    WHEN 'github' THEN claims->>'repository'=repository AND claims->'projects' ? project
    WHEN 'viewer' THEN NOT writing AND (claims->'projects'='null'::jsonb OR claims->'projects' ? project)
    WHEN 'editor' THEN NOT writing AND (claims->'projects'='null'::jsonb OR claims->'projects' ? project)
    ELSE false END,false)
  FROM (SELECT public.projectos_document_scope() AS claims) AS scope
$$;

ALTER TABLE github_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY github_snapshot_read ON github_snapshots FOR SELECT USING (
  workspace_id=(SELECT public.projectos_verified_workspace())
  AND public.projectos_integration_project(project_id,repo,false)
);
CREATE POLICY github_snapshot_insert ON github_snapshots FOR INSERT WITH CHECK (
  workspace_id=(SELECT public.projectos_verified_workspace())
  AND public.projectos_integration_project(project_id,repo,true)
);
CREATE POLICY github_snapshot_update ON github_snapshots FOR UPDATE USING (
  workspace_id=(SELECT public.projectos_verified_workspace())
  AND public.projectos_integration_project(project_id,repo,true)
);

ALTER TABLE github_deliveries ENABLE ROW LEVEL SECURITY;
CREATE POLICY github_delivery_scope ON github_deliveries USING (
  workspace_id=(SELECT public.projectos_verified_workspace())
  AND public.projectos_integration_project(project_id,repo,true)
);

ALTER TABLE vault_checks ENABLE ROW LEVEL SECURITY;
CREATE POLICY vault_owner_scope ON vault_checks USING (
  workspace_id=(SELECT public.projectos_verified_workspace())
  AND (SELECT public.projectos_document_scope()->>'role')='owner'
  AND EXISTS (SELECT 1 FROM records r WHERE r.workspace_id=vault_checks.workspace_id
    AND r.kind='secrets' AND r.id=vault_checks.ref_id)
);

ALTER TABLE machine_observations ENABLE ROW LEVEL SECURITY;
CREATE POLICY machine_read_scope ON machine_observations FOR SELECT USING (
  workspace_id=(SELECT public.projectos_verified_workspace())
  AND EXISTS (SELECT 1 FROM records r WHERE r.workspace_id=machine_observations.workspace_id
    AND r.kind='resources' AND r.id=machine_observations.resource_id)
);
CREATE POLICY machine_agent_ingest ON machine_observations FOR INSERT WITH CHECK (
  workspace_id=(SELECT public.projectos_verified_workspace())
  AND (SELECT public.projectos_document_scope()->>'role')='agent'
  AND (SELECT public.projectos_document_scope()->'resources') ? resource_id
  AND EXISTS (SELECT 1 FROM records r WHERE r.workspace_id=machine_observations.workspace_id
    AND r.kind='resources' AND r.id=machine_observations.resource_id)
);

CREATE POLICY https_observation_read ON monitor_observations AS RESTRICTIVE FOR SELECT USING (
  workspace_id=(SELECT public.projectos_monitor_workspace())
  OR (workspace_id=(SELECT public.projectos_verified_workspace())
    AND EXISTS (SELECT 1 FROM records r WHERE r.workspace_id=monitor_observations.workspace_id
      AND r.kind='resources' AND r.id=monitor_observations.resource_id))
);
