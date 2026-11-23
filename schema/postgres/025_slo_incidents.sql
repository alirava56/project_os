CREATE TABLE projectos_private.slo_lifecycle (
  workspace_id text REFERENCES public.workspaces(id) ON DELETE CASCADE,
  resource_id text,
  state text NOT NULL,
  incident_id text,
  opened_at timestamptz,
  last_recovered timestamptz,
  last_checked timestamptz NOT NULL,
  PRIMARY KEY(workspace_id,resource_id)
);

CREATE FUNCTION public.projectos_reconcile_slo(resource text, minimum integer, consecutive integer,
  recover integer, target_percent numeric, channels text[]) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE workspace text := public.projectos_monitor_workspace();
DECLARE project text;
DECLARE state_row projectos_private.slo_lifecycle%ROWTYPE;
DECLARE revision bigint;
DECLARE checked timestamptz;
DECLARE last_state text;
DECLARE known integer;
DECLARE unhealthy integer;
DECLARE tail_states text[];
DECLARE stage text;
DECLARE alert text;
DECLARE opened timestamptz;
DECLARE recovered timestamptz;
DECLARE timestamp_text text;
BEGIN
  IF workspace IS NULL OR minimum IS NULL OR minimum NOT BETWEEN 2 AND 30
    OR consecutive IS NULL OR consecutive NOT BETWEEN 2 AND 15 OR recover IS NULL OR recover NOT BETWEEN 2 AND 15
    OR target_percent IS NULL OR target_percent NOT BETWEEN 90 AND 100
    OR channels IS NULL OR NOT channels <@ ARRAY['telegram','email']::text[]
  THEN RETURN NULL; END IF;
  SELECT r.project_id INTO project FROM public.records r WHERE r.workspace_id=workspace AND r.kind='resources' AND r.id=resource;
  IF NOT FOUND OR project IS NULL THEN RETURN NULL; END IF;
  SELECT version+1 INTO revision FROM public.workspaces WHERE id=workspace FOR UPDATE;
  SELECT * INTO state_row FROM projectos_private.slo_lifecycle l WHERE l.workspace_id=workspace AND l.resource_id=resource FOR UPDATE;
  alert=state_row.incident_id; opened=state_row.opened_at; recovered=state_row.last_recovered;
  SELECT m.checked_at,m.state INTO checked,last_state FROM public.monitor_observations m
    WHERE m.workspace_id=workspace AND m.resource_id=resource AND m.source='https' AND m.checked_at<=now()
    ORDER BY m.checked_at DESC,m.id DESC LIMIT 1;
  IF NOT FOUND OR (state_row.last_checked IS NOT NULL AND checked<=state_row.last_checked) THEN RETURN state_row.state; END IF;
  SELECT count(*) FILTER (WHERE v.state IN ('healthy','unhealthy')),
    count(*) FILTER (WHERE v.state='unhealthy'),array_agg(v.state ORDER BY v.checked_at DESC,v.id DESC)
  INTO known,unhealthy,tail_states FROM (
    SELECT m.state,m.checked_at,m.id FROM public.monitor_observations m
    WHERE m.workspace_id=workspace AND m.resource_id=resource AND m.source='https' AND m.checked_at<=checked
      AND m.checked_at>checked-interval '30 minutes' AND (recovered IS NULL OR m.checked_at>recovered)
    ORDER BY m.checked_at DESC,m.id DESC LIMIT 60
  ) v;
  timestamp_text=to_char(checked AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');

  IF alert IS NOT NULL THEN
    stage=CASE WHEN last_state='healthy' THEN 'recovering' ELSE 'open' END;
    IF cardinality(tail_states)>=recover AND tail_states[1:recover] <@ ARRAY['healthy']::text[] THEN
      UPDATE public.records r SET payload=(payload::jsonb || jsonb_build_object('state','resolved',
        'endedAt',timestamp_text,'durationSeconds',greatest(0,floor(extract(epoch FROM checked-opened))::bigint)) - 'snoozedUntil')::text,
        record_version=revision,updated_at=now()
      WHERE r.workspace_id=workspace AND r.kind='incidents' AND r.id=alert;
      IF FOUND THEN UPDATE public.workspaces SET version=revision WHERE id=workspace; END IF;
      UPDATE public.notification_outbox o SET state='cancelled' WHERE o.workspace_id=workspace
        AND o.id IN ('tg-'||alert,'email-'||alert) AND (
          o.state IN ('pending','retrying') OR (o.state='sending' AND NOT EXISTS (
            SELECT 1 FROM public.delivery_retries d WHERE d.notification_id=o.id AND d.dispatch_at IS NOT NULL)));
      stage='resolved'; recovered=checked; alert=NULL; opened=NULL;
    END IF;
  ELSE
    stage=CASE WHEN known<minimum OR last_state='unknown' THEN 'insufficient_data'
      WHEN last_state='unhealthy' THEN 'degraded' ELSE 'healthy' END;
    IF stage='degraded' AND (
      (cardinality(tail_states)>=consecutive AND tail_states[1:consecutive] <@ ARRAY['unhealthy']::text[])
      OR (100.0*(known-unhealthy)/NULLIF(known,0))<target_percent
    ) THEN
      stage='open'; opened=checked;
      alert='monitor-'||left(encode(public.digest(convert_to(json_build_array(workspace,resource,timestamp_text)::text,'UTF8'),'sha256'),'hex'),28);
      INSERT INTO public.records(workspace_id,kind,id,project_id,payload,updated_at,record_version)
      VALUES(workspace,'incidents',alert,project,jsonb_build_object('id',alert,'projectId',project,
        'title','اختلال سرویس پایش‌شده','priority','high','source','پایش SLO · ثبت خودکار','date',timestamp_text,'state','open')::text,now(),revision)
      ON CONFLICT DO NOTHING;
      IF FOUND THEN UPDATE public.workspaces SET version=revision WHERE id=workspace; END IF;
      INSERT INTO public.notification_outbox(id,workspace_id,reminder_id,scheduled_for,channel,state,created_at,expires_at)
      SELECT CASE channel WHEN 'telegram' THEN 'tg-'||alert WHEN 'email' THEN 'email-'||alert ELSE alert END,
        workspace,'slo:'||alert,timestamp_text,channel,CASE WHEN channel='in_app' THEN 'available' ELSE 'pending' END,
        now(),(extract(epoch FROM now()+interval '6 hours')*1000)::bigint
      FROM (SELECT DISTINCT unnest(ARRAY['in_app']::text[] || channels) AS channel) configured
      ON CONFLICT DO NOTHING;
    END IF;
  END IF;
  INSERT INTO projectos_private.slo_lifecycle(workspace_id,resource_id,state,incident_id,opened_at,last_recovered,last_checked)
  VALUES(workspace,resource,stage,alert,opened,recovered,checked)
  ON CONFLICT(workspace_id,resource_id) DO UPDATE SET state=excluded.state,incident_id=excluded.incident_id,
    opened_at=excluded.opened_at,last_recovered=excluded.last_recovered,last_checked=excluded.last_checked;
  RETURN stage;
END
$$;

CREATE FUNCTION public.projectos_slo_status() RETURNS TABLE ("resourceId" text,state text,"lastChecked" timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT l.resource_id,l.state,l.last_checked FROM projectos_private.slo_lifecycle l
  JOIN public.projectos_records r ON r.workspace_id=l.workspace_id AND r.kind='resources' AND r.id=l.resource_id
  WHERE l.workspace_id=public.projectos_verified_workspace()
  ORDER BY l.last_checked DESC LIMIT 200
$$;
REVOKE ALL ON FUNCTION public.projectos_reconcile_slo(text,integer,integer,integer,numeric,text[]),
  public.projectos_slo_status() FROM PUBLIC;
DO $$
DECLARE target name;
BEGIN
  FOR target IN SELECT r.rolname FROM projectos_private.monitor_logins m JOIN pg_roles r ON r.oid=m.login
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.projectos_reconcile_slo(text,integer,integer,integer,numeric,text[]) TO %I',target);
  END LOOP;
  FOR target IN SELECT DISTINCT r.rolname FROM pg_class c
    CROSS JOIN LATERAL aclexplode(c.relacl) a JOIN pg_roles r ON r.oid=a.grantee
    WHERE c.oid='public.sessions'::regclass AND a.privilege_type='INSERT' AND a.grantee<>c.relowner
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.projectos_slo_status() TO %I',target);
  END LOOP;
END
$$;
