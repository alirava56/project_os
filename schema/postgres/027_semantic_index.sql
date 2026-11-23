CREATE TABLE public.semantic_index (
  workspace_id text NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  document_id text NOT NULL,
  revision bigint NOT NULL,
  model text NOT NULL CHECK (model='multilingual-e5-base-v1'),
  vectors jsonb NOT NULL CHECK (jsonb_typeof(vectors)='array' AND jsonb_array_length(vectors) BETWEEN 1 AND 24
    AND octet_length(vectors::text)<350000),
  PRIMARY KEY(workspace_id,document_id,model)
);
ALTER TABLE public.semantic_index ENABLE ROW LEVEL SECURITY;
CREATE POLICY semantic_read_permit ON public.semantic_index FOR SELECT USING (true);
CREATE POLICY semantic_read ON public.semantic_index AS RESTRICTIVE FOR SELECT USING (
  workspace_id=(SELECT public.projectos_verified_workspace()) AND EXISTS (
    SELECT 1 FROM public.projectos_records r WHERE r.workspace_id=semantic_index.workspace_id AND r.id=semantic_index.document_id
      AND r.kind='docs' AND r.record_version=semantic_index.revision
  )
);
CREATE POLICY semantic_write ON public.semantic_index FOR ALL USING (
  workspace_id=(SELECT public.projectos_verified_workspace()) AND public.projectos_document_scope()->>'role'='owner'
) WITH CHECK (
  workspace_id=(SELECT public.projectos_verified_workspace()) AND public.projectos_document_scope()->>'role'='owner'
  AND EXISTS (SELECT 1 FROM public.projectos_records r WHERE r.workspace_id=semantic_index.workspace_id
    AND r.kind='docs' AND r.id=semantic_index.document_id AND r.record_version=semantic_index.revision)
);
CREATE FUNCTION projectos_private.discard_old_embeddings() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  DELETE FROM public.semantic_index i WHERE i.workspace_id=OLD.workspace_id AND i.document_id=OLD.id
    AND (TG_OP='DELETE' OR i.revision<>NEW.record_version);
  RETURN NULL;
END
$$;
CREATE TRIGGER discard_old_semantic_vectors AFTER DELETE OR UPDATE OF record_version ON public.records
FOR EACH ROW WHEN (OLD.kind='docs') EXECUTE FUNCTION projectos_private.discard_old_embeddings();
DO $$
DECLARE target name;
BEGIN
  FOR target IN SELECT DISTINCT r.rolname FROM pg_class c
    CROSS JOIN LATERAL aclexplode(c.relacl) a JOIN pg_roles r ON r.oid=a.grantee
    WHERE c.oid='public.sessions'::regclass AND a.privilege_type='INSERT' AND a.grantee<>c.relowner
  LOOP
    EXECUTE format('GRANT SELECT,INSERT,UPDATE ON public.semantic_index TO %I',target);
  END LOOP;
END
$$;
