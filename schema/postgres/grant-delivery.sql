\set ON_ERROR_STOP on
BEGIN;
SELECT set_config('projectos.install_delivery_role', :'delivery_role', true),
       set_config('projectos.install_delivery_workspace', :'workspace_id', true);
DO $$
DECLARE target name := current_setting('projectos.install_delivery_role');
DECLARE workspace text := current_setting('projectos.install_delivery_workspace');
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles r WHERE r.rolname=target AND r.rolcanlogin
      AND NOT (r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication)
      AND NOT EXISTS (SELECT 1 FROM pg_auth_members WHERE member=r.oid)
      AND NOT has_schema_privilege(r.oid,'public','CREATE')
      AND NOT EXISTS (SELECT 1 FROM pg_class WHERE relowner=r.oid)
      AND NOT has_column_privilege(r.oid,'public.records','payload','SELECT')
      AND NOT has_column_privilege(r.oid,'public.users','email','SELECT')
  ) OR NOT EXISTS (SELECT 1 FROM public.workspaces WHERE id=workspace) THEN
    RAISE EXCEPTION 'Expected a new dedicated delivery login and existing workspace';
  END IF;
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.notification_outbox',target);
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.delivery_retries',target);
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.worker_heartbeats',target);
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.workspaces',target);
  EXECUTE format('CREATE POLICY %I ON public.notification_outbox AS RESTRICTIVE TO %I USING (workspace_id = %L)',
    target, target, workspace);
  EXECUTE format('CREATE POLICY %I ON public.delivery_retries AS RESTRICTIVE TO %I USING
    (EXISTS (SELECT 1 FROM public.notification_outbox o WHERE o.id = notification_id))',target,target);
  EXECUTE format('CREATE POLICY %I ON public.worker_heartbeats AS RESTRICTIVE TO %I USING (name = %L)',
    target,target,'delivery');
  EXECUTE format('CREATE POLICY %I ON public.workspaces AS RESTRICTIVE TO %I USING (id = %L)',
    target,target,workspace);
END $$;
GRANT USAGE ON SCHEMA public TO :"delivery_role";
GRANT SELECT (id) ON workspaces TO :"delivery_role";
GRANT SELECT ON notification_outbox, delivery_retries TO :"delivery_role";
GRANT UPDATE (state, delivered_at) ON notification_outbox TO :"delivery_role";
GRANT INSERT, UPDATE ON delivery_retries TO :"delivery_role";
GRANT SELECT, INSERT ON worker_heartbeats TO :"delivery_role";
GRANT UPDATE (checked_at) ON worker_heartbeats TO :"delivery_role";
COMMIT;
