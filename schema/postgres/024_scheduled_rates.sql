CREATE TABLE projectos_private.currency_schedules (
  workspace_id text PRIMARY KEY REFERENCES public.workspaces(id) ON DELETE CASCADE,
  login oid NOT NULL,
  database_oid oid NOT NULL,
  projects text[] NOT NULL CHECK (cardinality(projects) BETWEEN 1 AND 100),
  interval_seconds integer NOT NULL CHECK (interval_seconds BETWEEN 3600 AND 604800),
  enabled boolean NOT NULL DEFAULT true,
  ready_at timestamptz NOT NULL DEFAULT now(),
  lease uuid,
  lease_until timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  last_success timestamptz,
  last_status text,
  observed_at timestamptz
);

CREATE FUNCTION public.projectos_currency_claim(workspace text, token uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE result jsonb;
BEGIN
  UPDATE projectos_private.currency_schedules s SET lease=NULL,lease_until=NULL,
    attempts=0,last_status='unavailable',ready_at=now()+make_interval(secs=>s.interval_seconds)
  WHERE s.workspace_id=workspace AND s.login=session_user::regrole::oid AND s.enabled
    AND token IS NOT NULL AND s.database_oid=(SELECT oid FROM pg_database WHERE datname=current_database())
    AND s.lease_until<=now() AND s.attempts>=4;
  UPDATE projectos_private.currency_schedules s SET lease=token,lease_until=now()+interval '30 seconds',attempts=s.attempts+1
  WHERE s.workspace_id=workspace AND s.login=session_user::regrole::oid
    AND s.database_oid=(SELECT oid FROM pg_database WHERE datname=current_database())
    AND token IS NOT NULL AND s.enabled AND s.ready_at<=now() AND (s.lease_until IS NULL OR s.lease_until<=now())
    AND EXISTS (SELECT 1 FROM public.records p WHERE p.workspace_id=workspace AND p.kind='projects' AND p.id=ANY(s.projects)
      AND p.payload::jsonb->>'status'<>'archived')
  RETURNING jsonb_build_object('attempts',s.attempts) INTO result;
  RETURN result;
END
$$;

CREATE FUNCTION public.projectos_currency_settle(workspace text, token uuid, outcome text,
  rate text, observed timestamptz, retry_seconds integer) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s projectos_private.currency_schedules%ROWTYPE;
DECLARE revision bigint;
DECLARE inserted integer := 0;
DECLARE stamp text;
BEGIN
  SELECT * INTO s FROM projectos_private.currency_schedules c
  WHERE c.workspace_id=workspace AND c.login=session_user::regrole::oid
    AND c.database_oid=(SELECT oid FROM pg_database WHERE datname=current_database())
    AND c.enabled AND c.lease=token AND c.lease_until>now() FOR UPDATE;
  IF NOT FOUND OR outcome IS NULL OR outcome NOT IN ('ok','unavailable','rate_limited') THEN RETURN false; END IF;

  IF outcome<>'ok' THEN
    UPDATE projectos_private.currency_schedules c SET lease=NULL,lease_until=NULL,last_status=outcome,
      attempts=CASE WHEN s.attempts<4 THEN s.attempts ELSE 0 END,
      ready_at=now()+make_interval(secs=>greatest(
        CASE WHEN s.attempts<4 THEN 60*(1<<(s.attempts-1)) ELSE s.interval_seconds END,
        least(604800,coalesce(retry_seconds,0))))
    WHERE c.workspace_id=workspace;
    RETURN true;
  END IF;

  IF rate IS NULL OR rate !~ '^[0-9]{1,12}(\.[0-9]{1,10})?$' OR rate::numeric<=0
    OR observed IS NULL OR observed>now() OR observed<now()-interval '48 hours'
  THEN RETURN false; END IF;
  -- A provider replay cannot replace a newer observation.
  IF s.observed_at IS NOT NULL AND observed<s.observed_at THEN
    UPDATE projectos_private.currency_schedules c SET lease=NULL,lease_until=NULL,last_status='unavailable',
      ready_at=now()+make_interval(secs=>s.interval_seconds),attempts=0 WHERE c.workspace_id=workspace;
    RETURN true;
  END IF;
  SELECT version+1 INTO revision FROM public.workspaces WHERE id=workspace FOR UPDATE;
  stamp=to_char(observed AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  WITH targets AS (
    SELECT p.id,'rate-'||left(encode(public.digest(convert_to(
      json_build_array(p.id,stamp,rate)::text,'UTF8'),'sha256'),'hex'),32) AS rate_id
    FROM public.records p WHERE p.workspace_id=workspace AND p.kind='projects' AND p.id=ANY(s.projects)
      AND p.payload::jsonb->>'status'<>'archived'
  )
  INSERT INTO public.records(workspace_id,kind,id,project_id,payload,updated_at,record_version)
  SELECT workspace,'exchangeRates',t.rate_id,t.id,jsonb_build_object('id',t.rate_id,'projectId',t.id,
    'from','USD','to','IRR','rate',rate,'source','currencyapi','observedAt',stamp,
    'receivedAt',to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))::text,now(),revision
  FROM targets t
  WHERE NOT EXISTS (SELECT 1 FROM public.records r WHERE r.workspace_id=workspace AND r.kind='exchangeRates' AND r.project_id=t.id
    AND r.payload::jsonb->>'source'='currencyapi' AND r.payload::jsonb->>'observedAt'=stamp
    AND r.payload::jsonb->>'rate'=rate AND r.payload::jsonb->>'from'='USD' AND r.payload::jsonb->>'to'='IRR')
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS inserted=ROW_COUNT;
  IF inserted>0 THEN UPDATE public.workspaces SET version=revision WHERE id=workspace; END IF;
  UPDATE projectos_private.currency_schedules c SET lease=NULL,lease_until=NULL,last_status='ok',
    last_success=now(),observed_at=observed,ready_at=now()+make_interval(secs=>s.interval_seconds),attempts=0
    WHERE c.workspace_id=workspace;
  RETURN true;
END
$$;

CREATE FUNCTION public.projectos_currency_status(project text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT jsonb_build_object('status',CASE WHEN NOT s.enabled THEN 'disabled' ELSE coalesce(s.last_status,'pending') END,
    'lastSuccessfulAt',s.last_success)
  FROM projectos_private.currency_schedules s
  WHERE s.workspace_id=public.projectos_verified_workspace() AND project=ANY(s.projects)
    AND EXISTS (SELECT 1 FROM public.projectos_records r WHERE r.workspace_id=s.workspace_id AND r.kind='projects' AND r.id=project)
$$;
REVOKE ALL ON FUNCTION public.projectos_currency_claim(text,uuid),
  public.projectos_currency_settle(text,uuid,text,text,timestamptz,integer),public.projectos_currency_status(text) FROM PUBLIC;
DO $$
DECLARE target name;
BEGIN
  FOR target IN SELECT DISTINCT r.rolname FROM pg_class c
    CROSS JOIN LATERAL aclexplode(c.relacl) a JOIN pg_roles r ON r.oid=a.grantee
    WHERE c.oid='public.sessions'::regclass AND a.privilege_type='INSERT' AND a.grantee<>c.relowner
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.projectos_currency_status(text) TO %I',target);
  END LOOP;
END
$$;
