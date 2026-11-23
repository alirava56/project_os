CREATE FUNCTION public.projectos_document_scope() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE claims text := current_setting('projectos.document_scope', true);
DECLARE mac text := current_setting('projectos.document_mac', true);
DECLARE workspace text := public.projectos_verified_workspace();
BEGIN
  IF workspace IS NULL OR claims IS NULL OR length(claims) > 65536
    OR mac IS NULL OR mac !~ '^[0-9a-f]{64}$' THEN RETURN NULL; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM projectos_private.scope_key WHERE singleton
      AND public.hmac(convert_to(pg_backend_pid()::text || ':' ||
        extract(epoch FROM transaction_timestamp())::text || ':docs:' || workspace || ':' || claims,
        'UTF8'), secret, 'sha256') = decode(mac, 'hex')
  ) THEN RETURN NULL; END IF;
  RETURN claims::jsonb;
END
$$;

CREATE POLICY document_project_read ON document_versions AS RESTRICTIVE FOR SELECT USING (
  (SELECT public.projectos_document_scope()->'projects') = 'null'::jsonb
  OR (SELECT public.projectos_document_scope()->'projects') ? (payload::jsonb->>'projectId')
);
CREATE POLICY document_project_insert ON document_versions AS RESTRICTIVE FOR INSERT WITH CHECK (
  (SELECT public.projectos_document_scope()->>'role') IN ('owner', 'editor')
  AND ((SELECT public.projectos_document_scope()->'projects') = 'null'::jsonb
    OR (SELECT public.projectos_document_scope()->'projects') ? (payload::jsonb->>'projectId'))
  AND (payload::jsonb->>'id') IS NOT DISTINCT FROM document_id
);
