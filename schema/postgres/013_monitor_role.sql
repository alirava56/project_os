ALTER POLICY records_workspace_scope ON records
  USING (workspace_id = (SELECT public.projectos_verified_workspace())
    OR workspace_id = (SELECT public.projectos_monitor_workspace())
    OR workspace_id = (SELECT public.projectos_reminder_workspace()))
  WITH CHECK (workspace_id = (SELECT public.projectos_verified_workspace())
    OR workspace_id = (SELECT public.projectos_monitor_workspace())
    OR workspace_id = (SELECT public.projectos_reminder_workspace()));

CREATE POLICY monitor_record_boundary ON records AS RESTRICTIVE USING (
  (SELECT public.projectos_monitor_workspace()) IS NULL OR kind IN ('resources','preferences','incidents')
) WITH CHECK (
  (SELECT public.projectos_monitor_workspace()) IS NULL OR (kind='incidents' AND id LIKE 'monitor-%')
);

ALTER TABLE monitor_observations ENABLE ROW LEVEL SECURITY;
CREATE POLICY monitor_observation_boundary ON monitor_observations USING (
  (SELECT public.projectos_monitor_workspace()) IS NULL
  OR workspace_id = (SELECT public.projectos_monitor_workspace())
) WITH CHECK (
  (SELECT public.projectos_monitor_workspace()) IS NULL
  OR (workspace_id = (SELECT public.projectos_monitor_workspace()) AND source='https' AND EXISTS (
    SELECT 1 FROM records r WHERE r.workspace_id=monitor_observations.workspace_id
      AND r.kind='resources' AND r.id=monitor_observations.resource_id
  ))
);
