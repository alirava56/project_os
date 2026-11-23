CREATE TABLE public.vpn_observations (
  workspace_id text NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  resource_id text NOT NULL,
  checked_at timestamptz NOT NULL,
  handshake_at timestamptz,
  wireguard_state text NOT NULL CHECK (wireguard_state IN ('observed','unavailable')),
  service_state text NOT NULL CHECK (service_state IN ('ok','unconfigured','timeout','tls','connection','unexpected')),
  latency_ms integer CHECK (latency_ms BETWEEN 0 AND 5000),
  PRIMARY KEY(workspace_id,resource_id,checked_at),
  CHECK (handshake_at IS NULL OR (handshake_at<=checked_at AND wireguard_state='observed')),
  CHECK ((service_state='ok')=(latency_ms IS NOT NULL))
);
CREATE INDEX vpn_recent_idx ON public.vpn_observations(workspace_id,checked_at DESC);
ALTER TABLE public.vpn_observations ENABLE ROW LEVEL SECURITY;
CREATE POLICY vpn_read_scope ON public.vpn_observations FOR SELECT USING (
  workspace_id=(SELECT public.projectos_verified_workspace())
  AND EXISTS (SELECT 1 FROM public.projectos_records r WHERE r.workspace_id=vpn_observations.workspace_id
    AND r.kind='resources' AND r.id=vpn_observations.resource_id)
);
CREATE POLICY vpn_agent_insert ON public.vpn_observations FOR INSERT WITH CHECK (
  workspace_id=(SELECT public.projectos_verified_workspace())
  AND (SELECT public.projectos_document_scope()->>'role')='agent'
  AND (SELECT public.projectos_document_scope()->'resources') ? resource_id
  AND EXISTS (SELECT 1 FROM public.projectos_records r WHERE r.workspace_id=vpn_observations.workspace_id
    AND r.kind='resources' AND r.id=vpn_observations.resource_id)
);
DO $$
DECLARE target name;
BEGIN
  FOR target IN SELECT DISTINCT r.rolname FROM pg_class c
    CROSS JOIN LATERAL aclexplode(c.relacl) a JOIN pg_roles r ON r.oid=a.grantee
    WHERE c.oid='public.sessions'::regclass AND a.privilege_type='INSERT' AND a.grantee<>c.relowner
  LOOP
    EXECUTE format('GRANT SELECT,INSERT ON public.vpn_observations TO %I',target);
  END LOOP;
END
$$;
