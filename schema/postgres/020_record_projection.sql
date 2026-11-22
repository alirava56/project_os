-- The view runs with the table owner's read privileges and applies the signed
-- workspace and current project grants before projecting structured relationships.
CREATE VIEW public.projectos_records WITH (security_barrier=true) AS
WITH scope AS MATERIALIZED (
  SELECT public.projectos_verified_workspace() AS workspace,public.projectos_document_scope() AS claims
), visible AS NOT MATERIALIZED (
  SELECT r.*,r.payload::jsonb AS data,s.claims,s.claims->'projects' AS projects
  FROM public.records r CROSS JOIN scope s WHERE r.workspace_id=s.workspace AND CASE s.claims->>'role'
    WHEN 'owner' THEN true
    WHEN 'invitation' THEN r.kind='projects' AND (s.claims->'projects') ? r.project_id
    WHEN 'github' THEN r.kind='projects' AND (s.claims->'projects') ? r.project_id
    WHEN 'agent' THEN r.kind='resources' AND (s.claims->'resources') ? r.id
    ELSE s.claims->>'role' IN ('editor','viewer') AND r.kind<>'secrets'
      AND NOT (r.kind='incidents' AND (r.payload::jsonb->>'source') IS NOT DISTINCT FROM 'زمان‌بند داخلی · چرخش اعتبارنامه')
      AND (r.kind='preferences' OR s.claims->'projects'='null'::jsonb OR (s.claims->'projects') ? r.project_id
        OR (r.kind='resources' AND EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(r.payload::jsonb->'linkedProjectIds')='array'
            THEN r.payload::jsonb->'linkedProjectIds' ELSE '[]'::jsonb END) linked
          WHERE (s.claims->'projects') ? linked
        )))
    END
)
SELECT r.workspace_id,r.kind,r.id,
  CASE WHEN r.claims->>'role'='agent' THEN NULL
    WHEN r.kind='resources' AND r.projects<>'null'::jsonb THEN links.ids->>0
    ELSE r.project_id END AS project_id,
  CASE
    WHEN r.claims->>'role'='agent' THEN jsonb_build_object('id',r.id)::text
    WHEN r.kind='preferences' AND r.claims->>'role'<>'owner' THEN (r.data-'displayName')::text
    WHEN r.projects='null'::jsonb OR r.claims->>'role' IN ('github','invitation') THEN r.payload
    WHEN r.kind='resources' THEN ((r.data - ARRAY['projectId','linkedProjectIds','parentId'])
      || jsonb_build_object('projectId',links.ids->0,'linkedProjectIds',links.ids-0)
      || CASE WHEN EXISTS (SELECT 1 FROM visible p WHERE p.kind='resources' AND p.id=r.data->>'parentId')
        THEN jsonb_build_object('parentId',r.data->'parentId') ELSE '{}'::jsonb END)::text
    WHEN r.kind='tasks' THEN jsonb_set(r.data,'{dependencies}',(
      SELECT COALESCE(jsonb_agg(d.id ORDER BY d.position),'[]'::jsonb)
      FROM jsonb_array_elements_text(r.data->'dependencies') WITH ORDINALITY AS d(id,position)
      WHERE EXISTS (SELECT 1 FROM visible t WHERE t.kind='tasks' AND t.id=d.id)
    ))::text
    WHEN r.kind='charges' AND NOT EXISTS (
      SELECT 1 FROM visible resource WHERE resource.kind='resources' AND resource.id=r.data->>'linkedResourceId'
    ) THEN (r.data - 'linkedResourceId')::text
    WHEN r.kind='payments' AND NOT EXISTS (
      SELECT 1 FROM visible invoice WHERE invoice.kind='invoices' AND invoice.id=r.data->>'invoiceId'
    ) THEN (r.data - 'invoiceId')::text
    ELSE r.payload
  END AS payload,r.updated_at,r.record_version
FROM visible r
LEFT JOIN LATERAL (
  SELECT jsonb_agg(p.id ORDER BY p.position) AS ids
  FROM jsonb_array_elements_text(jsonb_build_array(r.project_id) ||
    CASE WHEN jsonb_typeof(r.data->'linkedProjectIds')='array'
      THEN r.data->'linkedProjectIds' ELSE '[]'::jsonb END) WITH ORDINALITY AS p(id,position)
  WHERE r.kind='resources' AND r.projects ? p.id
) links ON r.kind='resources' AND r.projects<>'null'::jsonb;

CREATE FUNCTION public.projectos_preserve_task_dependencies() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE scope jsonb := public.projectos_document_scope();
DECLARE hidden jsonb;
BEGIN
  IF scope->>'role' IS DISTINCT FROM 'editor' OR scope->'projects'='null'::jsonb THEN RETURN NEW; END IF;
  SELECT jsonb_agg(d.id ORDER BY d.position) INTO hidden
  FROM jsonb_array_elements_text(OLD.payload::jsonb->'dependencies') WITH ORDINALITY AS d(id,position)
  JOIN public.records t ON t.workspace_id=OLD.workspace_id AND t.kind='tasks' AND t.id=d.id
  WHERE NOT (scope->'projects' ? t.project_id);
  IF hidden IS NOT NULL THEN
    NEW.payload := jsonb_set(NEW.payload::jsonb,'{dependencies}',
      COALESCE(NEW.payload::jsonb->'dependencies','[]'::jsonb) || hidden)::text;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER preserve_task_dependencies BEFORE UPDATE ON records FOR EACH ROW
  WHEN (OLD.kind='tasks') EXECUTE FUNCTION public.projectos_preserve_task_dependencies();

-- Deferred validation also covers references to tasks created later in a batch.
CREATE FUNCTION public.projectos_validate_task_dependency_changes() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE scope jsonb := public.projectos_document_scope();
DECLARE previous jsonb := '[]'::jsonb;
BEGIN
  IF scope->>'role' IS DISTINCT FROM 'editor' OR scope->'projects'='null'::jsonb THEN RETURN NULL; END IF;
  IF TG_OP='UPDATE' THEN previous := OLD.payload::jsonb->'dependencies'; END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(NEW.payload::jsonb->'dependencies') AS d(id)
    LEFT JOIN public.records t ON t.workspace_id=NEW.workspace_id AND t.kind='tasks' AND t.id=d.id
    WHERE NOT previous ? d.id AND NOT COALESCE(scope->'projects' ? t.project_id,false)
  ) THEN RAISE EXCEPTION 'Invalid task dependency' USING ERRCODE='42501'; END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER validate_task_dependency_changes AFTER INSERT OR UPDATE ON records
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.kind='tasks')
  EXECUTE FUNCTION public.projectos_validate_task_dependency_changes();

CREATE FUNCTION projectos_private.grant_record_projection(target name) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  EXECUTE format('REVOKE SELECT ON public.records FROM %I',target);
  EXECUTE format('GRANT SELECT(workspace_id,kind,id,updated_at,record_version) ON public.records TO %I',target);
  EXECUTE format('GRANT SELECT ON public.projectos_records TO %I',target);
END
$$;
DO $$
DECLARE target name;
BEGIN
  FOR target IN SELECT DISTINCT r.rolname FROM pg_class c
    CROSS JOIN LATERAL aclexplode(c.relacl) a JOIN pg_roles r ON r.oid=a.grantee
    WHERE c.oid='public.sessions'::regclass AND a.privilege_type='INSERT' AND a.grantee<>c.relowner
  LOOP
    PERFORM projectos_private.grant_record_projection(target);
  END LOOP;
END
$$;
