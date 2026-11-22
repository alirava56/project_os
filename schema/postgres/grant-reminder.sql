\set ON_ERROR_STOP on
BEGIN;
SELECT set_config('projectos.install_reminder_role', :'reminder_role', true),
       set_config('projectos.install_reminder_workspace', :'workspace_id', true);
DO $$
DECLARE target text := current_setting('projectos.install_reminder_role');
DECLARE target_oid oid;
DECLARE workspace text := current_setting('projectos.install_reminder_workspace');
BEGIN
  SELECT r.oid INTO target_oid FROM pg_roles r
  WHERE r.rolname=target AND r.rolcanlogin
    AND NOT (r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication)
    AND NOT EXISTS (SELECT 1 FROM pg_auth_members WHERE member=r.oid)
    AND NOT EXISTS (SELECT 1 FROM pg_class WHERE relowner=r.oid)
    AND NOT has_schema_privilege(r.oid,'public','CREATE')
    AND NOT has_column_privilege(r.oid,'public.users','email','SELECT')
    AND NOT has_table_privilege(r.oid,'public.monitor_observations','SELECT')
    AND NOT has_column_privilege(r.oid,'public.notification_outbox','delivered_at','UPDATE');
  IF target_oid IS NULL THEN RAISE EXCEPTION 'Expected a dedicated reminder login'; END IF;
  INSERT INTO projectos_private.reminder_logins(login,workspace_id) VALUES(target_oid,workspace)
    ON CONFLICT(login) DO UPDATE SET workspace_id=excluded.workspace_id;
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.workspaces',target);
  EXECUTE format('CREATE POLICY %I ON public.workspaces AS RESTRICTIVE TO %I
    USING (id=public.projectos_reminder_workspace())',target,target);
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.notification_outbox',target);
  EXECUTE format('CREATE POLICY %I ON public.notification_outbox AS RESTRICTIVE TO %I
    USING (workspace_id=public.projectos_reminder_workspace())',target,target);
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.delivery_retries',target);
  EXECUTE format('CREATE POLICY %I ON public.delivery_retries AS RESTRICTIVE TO %I
    USING (EXISTS (SELECT 1 FROM public.notification_outbox o WHERE o.id=notification_id))',target,target);
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.worker_heartbeats',target);
  EXECUTE format('CREATE POLICY %I ON public.worker_heartbeats AS RESTRICTIVE TO %I
    USING (public.projectos_reminder_workspace() IS NOT NULL AND name=%L)',target,target,'reminders');
END $$;
GRANT USAGE ON SCHEMA public TO :"reminder_role";
GRANT SELECT (id,version,name), UPDATE (version) ON workspaces TO :"reminder_role";
GRANT SELECT (workspace_id,id,kind,payload), INSERT, DELETE ON records TO :"reminder_role";
GRANT UPDATE (payload,updated_at,record_version) ON records TO :"reminder_role";
GRANT SELECT, INSERT ON notification_outbox TO :"reminder_role";
GRANT UPDATE (state) ON notification_outbox TO :"reminder_role";
GRANT SELECT (notification_id,attempts) ON delivery_retries TO :"reminder_role";
GRANT SELECT, INSERT ON worker_heartbeats TO :"reminder_role";
GRANT UPDATE (checked_at) ON worker_heartbeats TO :"reminder_role";
GRANT EXECUTE ON FUNCTION public.projectos_rotation_deadlines() TO :"reminder_role";
COMMIT;
