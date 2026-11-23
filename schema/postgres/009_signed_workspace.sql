CREATE SCHEMA projectos_private;
REVOKE ALL ON SCHEMA projectos_private FROM PUBLIC;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE projectos_private.scope_key (
  singleton boolean PRIMARY KEY CHECK (singleton),
  secret bytea NOT NULL CHECK (octet_length(secret) = 32)
);

CREATE FUNCTION public.projectos_verified_workspace() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $$
  SELECT workspace
  FROM projectos_private.scope_key
  CROSS JOIN LATERAL (SELECT NULLIF(current_setting('projectos.workspace', true), '') AS workspace) AS scope
  WHERE singleton AND workspace IS NOT NULL
    AND public.hmac(convert_to(pg_backend_pid()::text || ':' ||
      extract(epoch FROM transaction_timestamp())::text || ':' || workspace, 'UTF8'), secret, 'sha256')
      = decode(CASE WHEN current_setting('projectos.workspace_mac', true) ~ '^[0-9a-f]{64}$'
                    THEN current_setting('projectos.workspace_mac', true) ELSE '' END, 'hex')
$$;

ALTER POLICY records_workspace_scope ON records
  USING (workspace_id = (SELECT public.projectos_verified_workspace()))
  WITH CHECK (workspace_id = (SELECT public.projectos_verified_workspace()));
ALTER POLICY audit_workspace_scope ON audit_events
  USING (workspace_id = (SELECT public.projectos_verified_workspace()))
  WITH CHECK (workspace_id = (SELECT public.projectos_verified_workspace()));
ALTER POLICY document_versions_workspace_scope ON document_versions
  USING (workspace_id = (SELECT public.projectos_verified_workspace()))
  WITH CHECK (workspace_id = (SELECT public.projectos_verified_workspace()));
