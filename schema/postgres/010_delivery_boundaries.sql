ALTER TABLE notification_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE delivery_retries ENABLE ROW LEVEL SECURITY;
CREATE POLICY outbox_existing_access ON notification_outbox USING (true) WITH CHECK (true);
CREATE POLICY retry_existing_access ON delivery_retries USING (true) WITH CHECK (true);
ALTER TABLE worker_heartbeats ENABLE ROW LEVEL SECURITY;
CREATE POLICY heartbeat_existing_access ON worker_heartbeats USING (true) WITH CHECK (true);
ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
CREATE POLICY workspace_existing_access ON workspaces USING (true) WITH CHECK (true);
