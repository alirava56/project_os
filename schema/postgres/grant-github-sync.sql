\set ON_ERROR_STOP on
BEGIN;
SELECT pg_advisory_xact_lock(3804521);
SELECT set_config('projectos.install_github_worker', :'worker_role',true),
  set_config('projectos.install_github_workspace', :'workspace_id',true),
  set_config('projectos.install_github_project', :'project_id',true),
  set_config('projectos.install_github_repo', :'repository',true);
DO $$
DECLARE worker name := current_setting('projectos.install_github_worker');
DECLARE workspace text := current_setting('projectos.install_github_workspace');
DECLARE project text := current_setting('projectos.install_github_project');
DECLARE repository text := current_setting('projectos.install_github_repo');
DECLARE worker_id oid;
BEGIN
  SELECT r.oid INTO worker_id FROM pg_roles r WHERE r.rolname=worker AND r.rolcanlogin
    AND NOT (r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication)
    AND NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid)
    AND NOT has_schema_privilege(r.oid,'public','CREATE')
    AND NOT has_table_privilege(r.oid,'public.github_snapshots','UPDATE')
    AND NOT has_column_privilege(r.oid,'public.records','payload','SELECT');
  IF worker_id IS NULL OR repository !~ '^[a-z0-9][a-z0-9-]{0,38}/[a-z0-9][a-z0-9_.-]{0,99}$'
    OR NOT EXISTS (SELECT 1 FROM public.records r WHERE r.workspace_id=workspace AND r.kind='projects' AND r.id=project)
  THEN RAISE EXCEPTION 'Invalid GitHub worker binding'; END IF;
  INSERT INTO projectos_private.github_sync_bindings(login,database_oid,workspace_id,project_id,repo)
    VALUES(worker_id,(SELECT oid FROM pg_database WHERE datname=current_database()),workspace,project,repository) ON CONFLICT DO NOTHING;
  INSERT INTO projectos_private.github_sync_jobs(workspace_id,project_id,repo)
    VALUES(workspace,project,repository) ON CONFLICT DO NOTHING;
END
$$;
GRANT USAGE ON SCHEMA public TO :"worker_role";
GRANT EXECUTE ON FUNCTION public.projectos_github_claim(text,text,text,uuid),
  public.projectos_github_settle(text,text,text,uuid,text,integer,jsonb,text,integer) TO :"worker_role";
COMMIT;
