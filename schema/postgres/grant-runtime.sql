\set ON_ERROR_STOP on
BEGIN;

-- Run as the schema owner. Supply an existing dedicated login via -v runtime_role=...
SELECT set_config('projectos.install_runtime_role', :'runtime_role', true);
DO $$
DECLARE target name := current_setting('projectos.install_runtime_role');
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles r WHERE r.rolname = target AND r.rolcanlogin
      AND NOT (r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication)
      AND NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = r.oid)
      AND NOT EXISTS (
        SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relowner = r.oid
      )
      AND NOT has_schema_privilege(r.oid, 'public', 'CREATE')
      AND NOT has_table_privilege(r.oid,'public.delivery_retries','UPDATE')
      AND NOT has_table_privilege(r.oid,'public.monitor_observations','INSERT')
      AND NOT EXISTS(SELECT 1 FROM projectos_private.reminder_logins WHERE login=r.oid)
  ) THEN
    RAISE EXCEPTION 'Expected a dedicated unprivileged ProjectOS login';
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO :"runtime_role";
GRANT SELECT, INSERT, UPDATE ON users, workspaces, workspace_invites, auth_rate_limits, ai_quota,
  vault_checks, github_snapshots, machine_observations TO :"runtime_role";
GRANT SELECT, INSERT, UPDATE, DELETE ON memberships, sessions, records, record_tombstones,
  mfa_recovery_codes TO :"runtime_role";
GRANT SELECT, INSERT ON audit_events, document_versions, github_deliveries TO :"runtime_role";
GRANT SELECT ON monitor_observations TO :"runtime_role";
SELECT projectos_private.grant_identity_runtime(:'runtime_role');
SELECT projectos_private.grant_workspace_runtime(:'runtime_role');
SELECT projectos_private.grant_record_projection(:'runtime_role');

COMMIT;
