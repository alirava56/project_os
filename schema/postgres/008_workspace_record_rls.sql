ALTER TABLE records ENABLE ROW LEVEL SECURITY;
CREATE POLICY records_workspace_scope ON records
  USING (workspace_id = NULLIF(current_setting('projectos.workspace', true), ''))
  WITH CHECK (workspace_id = NULLIF(current_setting('projectos.workspace', true), ''));

ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_workspace_scope ON audit_events
  USING (workspace_id = NULLIF(current_setting('projectos.workspace', true), ''))
  WITH CHECK (workspace_id = NULLIF(current_setting('projectos.workspace', true), ''));

ALTER TABLE document_versions ENABLE ROW LEVEL SECURITY;
CREATE POLICY document_versions_workspace_scope ON document_versions
  USING (workspace_id = NULLIF(current_setting('projectos.workspace', true), ''))
  WITH CHECK (workspace_id = NULLIF(current_setting('projectos.workspace', true), ''));
