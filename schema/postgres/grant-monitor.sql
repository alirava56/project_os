\set ON_ERROR_STOP on
BEGIN;
SELECT pg_advisory_xact_lock(3804521);
SELECT set_config('projectos.install_monitor_role', :'monitor_role', true),
       set_config('projectos.install_monitor_workspace', :'workspace_id', true);
DO $$
DECLARE target text := current_setting('projectos.install_monitor_role');
DECLARE target_oid oid;
DECLARE workspace text := current_setting('projectos.install_monitor_workspace');
BEGIN
  SELECT r.oid INTO target_oid FROM pg_roles r
  WHERE r.rolname=target AND r.rolcanlogin
    AND NOT (r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication)
    AND NOT EXISTS (SELECT 1 FROM pg_auth_members WHERE member=r.oid)
    AND NOT EXISTS (SELECT 1 FROM pg_class WHERE relowner=r.oid)
    AND NOT has_schema_privilege(r.oid,'public','CREATE')
    AND NOT has_column_privilege(r.oid,'public.users','email','SELECT')
    AND NOT has_table_privilege(r.oid,'public.notification_outbox','SELECT');
  IF target_oid IS NULL THEN RAISE EXCEPTION 'Expected a dedicated monitor login'; END IF;
  INSERT INTO projectos_private.monitor_logins(login,workspace_id) VALUES(target_oid,workspace)
    ON CONFLICT(login) DO UPDATE SET workspace_id=excluded.workspace_id;
  -- The role-specific guard remains even if the registry row is deleted.
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.workspaces',target);
  EXECUTE format('CREATE POLICY %I ON public.workspaces AS RESTRICTIVE TO %I
    USING (id=public.projectos_monitor_workspace())',target,target);
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.monitor_observations',target);
  EXECUTE format('CREATE POLICY %I ON public.monitor_observations AS RESTRICTIVE TO %I
    USING (workspace_id=public.projectos_monitor_workspace())',target,target);
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.worker_heartbeats',target);
  EXECUTE format('CREATE POLICY %I ON public.worker_heartbeats AS RESTRICTIVE TO %I
    USING (public.projectos_monitor_workspace() IS NOT NULL AND name=%L)',target,target,'monitors');
END $$;
GRANT USAGE ON SCHEMA public TO :"monitor_role";
GRANT SELECT (id,version,name), UPDATE (version) ON workspaces TO :"monitor_role";
GRANT SELECT (id,workspace_id,kind,payload), INSERT ON records TO :"monitor_role";
GRANT SELECT, INSERT ON monitor_observations TO :"monitor_role";
GRANT USAGE ON SEQUENCE monitor_observations_id_seq TO :"monitor_role";
GRANT SELECT, INSERT ON worker_heartbeats TO :"monitor_role";
GRANT UPDATE (checked_at) ON worker_heartbeats TO :"monitor_role";
COMMIT;
