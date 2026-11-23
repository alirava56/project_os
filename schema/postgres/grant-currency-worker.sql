\set ON_ERROR_STOP on
BEGIN;
SELECT pg_advisory_xact_lock(3804521);
SELECT set_config('projectos.install_currency_login', :'worker_role',true),
    set_config('projectos.install_currency_workspace', :'workspace_id',true),
    set_config('projectos.install_currency_projects', :'project_ids',true),
    set_config('projectos.install_currency_interval', :'interval_seconds',true),
    set_config('projectos.install_currency_enabled', :'enabled',true);
DO $$
DECLARE login_name name := current_setting('projectos.install_currency_login');
DECLARE workspace text := current_setting('projectos.install_currency_workspace');
DECLARE ids text[] := ARRAY(SELECT DISTINCT jsonb_array_elements_text(current_setting('projectos.install_currency_projects')::jsonb));
DECLARE login_id oid;
BEGIN
  SELECT r.oid INTO login_id FROM pg_roles r WHERE r.rolname=login_name AND r.rolcanlogin
    AND NOT (r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication)
    AND NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid)
    AND NOT has_schema_privilege(r.oid,'public','CREATE')
    AND NOT has_column_privilege(r.oid,'public.records','payload','SELECT');
  IF login_id IS NULL OR EXISTS(SELECT 1 FROM unnest(ids) AS item(id)
    WHERE NOT EXISTS(SELECT 1 FROM public.records p WHERE p.workspace_id=workspace AND p.kind='projects' AND p.id=item.id))
  THEN RAISE EXCEPTION 'Invalid currency worker binding'; END IF;
  INSERT INTO projectos_private.currency_schedules(workspace_id,login,database_oid,projects,interval_seconds,enabled)
  VALUES(workspace,login_id,(SELECT oid FROM pg_database WHERE datname=current_database()),ids,
    current_setting('projectos.install_currency_interval')::int,current_setting('projectos.install_currency_enabled')::boolean)
  ON CONFLICT(workspace_id) DO UPDATE SET login=excluded.login,projects=excluded.projects,database_oid=excluded.database_oid,
    interval_seconds=excluded.interval_seconds,enabled=excluded.enabled,lease=NULL,lease_until=NULL,attempts=0;
END
$$;
GRANT USAGE ON SCHEMA public TO :"worker_role";
GRANT EXECUTE ON FUNCTION public.projectos_currency_claim(text,uuid),
  public.projectos_currency_settle(text,uuid,text,text,timestamptz,integer) TO :"worker_role";
COMMIT;
