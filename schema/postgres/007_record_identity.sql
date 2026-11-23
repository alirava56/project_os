-- Validation is transactional. An inconsistent legacy row aborts the migration without rewriting it.
ALTER TABLE records ADD CONSTRAINT records_payload_identity CHECK (
  CASE kind
    WHEN 'preferences' THEN id = 'singleton' AND project_id IS NULL
    WHEN 'projects' THEN project_id IS NOT DISTINCT FROM id
      AND (payload::jsonb -> 'id') IS NOT DISTINCT FROM to_jsonb(id)
    ELSE project_id IS NOT NULL
      AND (payload::jsonb -> 'id') IS NOT DISTINCT FROM to_jsonb(id)
      AND (payload::jsonb -> 'projectId') IS NOT DISTINCT FROM to_jsonb(project_id)
  END
);
