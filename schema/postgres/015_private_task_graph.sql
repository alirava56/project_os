-- The editor checks integrity across hidden dependencies without reading their task rows.
CREATE FUNCTION public.projectos_check_task_graph(changed jsonb) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  WITH RECURSIVE allowed AS MATERIALIZED (
    SELECT public.projectos_verified_workspace() AS workspace,
      public.projectos_document_scope() AS claims
  ), tasks AS MATERIALIZED (
    SELECT r.id,r.payload::jsonb->'dependencies' AS dependencies
    FROM public.records r CROSS JOIN allowed a
    WHERE r.kind='tasks' AND r.workspace_id=a.workspace AND a.claims->>'role'='editor'
  ), edges AS MATERIALIZED (
    SELECT t.id, next.id AS target FROM tasks t
    CROSS JOIN LATERAL jsonb_array_elements_text(t.dependencies) AS next(id)
  ), walk(origin,node) AS (
    SELECT id,target FROM edges WHERE changed ? id
    UNION
    SELECT w.origin,e.target FROM walk w JOIN edges e ON e.id=w.node
  )
  SELECT CASE
    WHEN a.workspace IS NULL OR a.claims->>'role' IS DISTINCT FROM 'editor' THEN 'denied'
    WHEN jsonb_typeof(changed) IS DISTINCT FROM 'array' THEN 'denied'
    WHEN EXISTS (SELECT 1 FROM edges e LEFT JOIN tasks t ON t.id=e.target WHERE t.id IS NULL) THEN 'missing'
    WHEN EXISTS (SELECT 1 FROM walk WHERE origin=node) THEN 'cycle'
    ELSE 'valid'
  END FROM allowed a
$$;
