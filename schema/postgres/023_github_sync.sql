CREATE TABLE projectos_private.github_sync_bindings (
  login oid NOT NULL,
  database_oid oid NOT NULL,
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  repo text NOT NULL,
  PRIMARY KEY (login,database_oid,workspace_id,project_id,repo)
);
CREATE TABLE projectos_private.github_sync_jobs (
  workspace_id text NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  project_id text NOT NULL,
  repo text NOT NULL,
  requested bigint NOT NULL DEFAULT 1,
  started bigint,
  anchor timestamptz,
  stage text NOT NULL DEFAULT 'overview' CHECK (stage IN ('overview','commits','issues')),
  page integer NOT NULL DEFAULT 1 CHECK (page BETWEEN 1 AND 100),
  payload jsonb NOT NULL DEFAULT '{}',
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','running','backoff','completed','failed')),
  failures integer NOT NULL DEFAULT 0,
  ready_at timestamptz NOT NULL DEFAULT now(),
  lease uuid,
  leased_until timestamptz,
  error text,
  PRIMARY KEY(workspace_id,project_id,repo)
);

CREATE FUNCTION projectos_private.queue_github_sync() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  INSERT INTO projectos_private.github_sync_jobs(workspace_id,project_id,repo)
    VALUES(NEW.workspace_id,NEW.project_id,NEW.repo)
    ON CONFLICT (workspace_id,project_id,repo) DO UPDATE SET
      requested=projectos_private.github_sync_jobs.requested+1,
      state=CASE WHEN projectos_private.github_sync_jobs.state IN ('completed','failed') THEN 'pending' ELSE projectos_private.github_sync_jobs.state END,
      failures=CASE WHEN projectos_private.github_sync_jobs.state IN ('completed','failed') THEN 0 ELSE projectos_private.github_sync_jobs.failures END,
      ready_at=CASE WHEN projectos_private.github_sync_jobs.state IN ('completed','failed') THEN now() ELSE projectos_private.github_sync_jobs.ready_at END;
  RETURN NEW;
END
$$;
CREATE TRIGGER github_sync_on_delivery AFTER INSERT ON public.github_deliveries
FOR EACH ROW EXECUTE FUNCTION projectos_private.queue_github_sync();

INSERT INTO projectos_private.github_sync_jobs(workspace_id,project_id,repo)
SELECT workspace_id,project_id,repo FROM public.github_snapshots WHERE status='pending_refresh' ON CONFLICT DO NOTHING;

CREATE FUNCTION public.projectos_github_claim(workspace text, project text, repository text, token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE result jsonb;
BEGIN
  IF token IS NULL OR NOT EXISTS (SELECT 1 FROM projectos_private.github_sync_bindings b
    WHERE b.login=session_user::regrole::oid AND b.database_oid=(SELECT oid FROM pg_database WHERE datname=current_database()) AND (b.workspace_id,b.project_id,b.repo)=(workspace,project,repository))
    OR NOT EXISTS (SELECT 1 FROM public.records r WHERE r.workspace_id=workspace AND r.kind='projects' AND r.id=project)
  THEN RETURN NULL; END IF;

  UPDATE projectos_private.github_sync_jobs j SET state='failed',lease=NULL,leased_until=NULL,error='attempt_limit'
    WHERE (j.workspace_id,j.project_id,j.repo)=(workspace,project,repository)
      AND j.state='running' AND j.leased_until<=now() AND j.failures>=8;

  UPDATE projectos_private.github_sync_jobs j SET state='running',lease=token,leased_until=now()+interval '2 minutes',
    started=COALESCE(j.started,j.requested),anchor=COALESCE(j.anchor,now()),failures=j.failures+1
  WHERE (j.workspace_id,j.project_id,j.repo)=(workspace,project,repository)
    AND ((j.state IN ('pending','backoff') AND j.ready_at<=now()) OR (j.state='running' AND j.leased_until<=now()))
  RETURNING jsonb_build_object('stage',j.stage,'page',j.page,'anchor',j.anchor,'payload',j.payload,'failures',j.failures)
    INTO result;
  RETURN result;
END
$$;

CREATE FUNCTION public.projectos_github_settle(workspace text, project text, repository text, token uuid,
  next_stage text, next_page integer, checkpoint jsonb, failure text, retry_seconds integer)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE job projectos_private.github_sync_jobs%ROWTYPE;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM projectos_private.github_sync_bindings b
    WHERE b.login=session_user::regrole::oid AND b.database_oid=(SELECT oid FROM pg_database WHERE datname=current_database()) AND (b.workspace_id,b.project_id,b.repo)=(workspace,project,repository))
  THEN RETURN false; END IF;
  SELECT * INTO job FROM projectos_private.github_sync_jobs j
    WHERE (j.workspace_id,j.project_id,j.repo)=(workspace,project,repository)
      AND j.state='running' AND j.lease=token AND j.leased_until>now() FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF failure IS NOT NULL THEN
    IF failure NOT IN ('provider','rate_limited','page_limit') THEN RETURN false; END IF;
    UPDATE projectos_private.github_sync_jobs j SET
      state=CASE WHEN job.failures>=8 OR failure='page_limit' THEN 'failed' ELSE 'backoff' END,
      error=failure,lease=NULL,leased_until=NULL,
      ready_at=now()+make_interval(secs=>greatest(15,least(86400,coalesce(retry_seconds,30))))
    WHERE (j.workspace_id,j.project_id,j.repo)=(workspace,project,repository);
    RETURN true;
  END IF;

  IF checkpoint IS NULL OR jsonb_typeof(checkpoint)<>'object' OR octet_length(checkpoint::text)>1048576
    OR next_stage IS NULL OR next_page IS NULL OR NOT (
      (job.stage='overview' AND next_stage='commits' AND next_page=1)
      OR (job.stage='commits' AND next_stage='issues' AND next_page=1)
      OR (job.stage='issues' AND next_stage='done' AND next_page=1)
      OR (job.stage IN ('commits','issues') AND next_stage=job.stage AND next_page=job.page+1 AND next_page<=100))
  THEN RETURN false; END IF;

  IF next_stage='done' THEN
    IF NOT EXISTS (SELECT 1 FROM public.records r WHERE r.workspace_id=workspace AND r.kind='projects' AND r.id=project)
    THEN RETURN false; END IF;
    INSERT INTO public.github_snapshots(workspace_id,project_id,repo,checked_at,status,payload)
    VALUES(workspace,project,repository,now(),'connected',(checkpoint || jsonb_build_object(
      'repository',repository,'checkedAt',now(),'lastSuccessfulAt',now(),'state','connected'))::text)
    ON CONFLICT(workspace_id,project_id,repo) DO UPDATE SET
      checked_at=excluded.checked_at,status=excluded.status,payload=excluded.payload;
  END IF;
  UPDATE projectos_private.github_sync_jobs j SET
    state=CASE WHEN next_stage='done' AND job.requested=job.started THEN 'completed' ELSE 'pending' END,
    stage=CASE WHEN next_stage='done' THEN 'overview' ELSE next_stage END,page=next_page,failures=0,
    started=CASE WHEN next_stage='done' THEN NULL ELSE job.started END,
    anchor=CASE WHEN next_stage='done' THEN NULL ELSE job.anchor END,
    payload=CASE WHEN next_stage='done' THEN '{}'::jsonb ELSE checkpoint END,
    lease=NULL,leased_until=NULL,error=NULL,ready_at=now()
  WHERE (j.workspace_id,j.project_id,j.repo)=(workspace,project,repository);
  RETURN true;
END
$$;

CREATE FUNCTION public.projectos_github_job_status(project text, repository text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT jsonb_build_object('state',CASE WHEN j.state='running' AND j.leased_until<=now() THEN 'pending' ELSE j.state END,
    'stage',j.stage,'page',j.page,'error',j.error)
  FROM projectos_private.github_sync_jobs j
  WHERE (j.workspace_id,j.project_id,j.repo)=(public.projectos_verified_workspace(),project,repository)
    AND public.projectos_integration_project(project,repository,false)
    AND EXISTS (SELECT 1 FROM public.projectos_records r WHERE r.workspace_id=j.workspace_id AND r.kind='projects' AND r.id=project)
$$;
REVOKE ALL ON FUNCTION public.projectos_github_claim(text,text,text,uuid),
  public.projectos_github_settle(text,text,text,uuid,text,integer,jsonb,text,integer),
  public.projectos_github_job_status(text,text) FROM PUBLIC;

DO $$
DECLARE target name;
BEGIN
  FOR target IN SELECT DISTINCT r.rolname FROM pg_class c
    CROSS JOIN LATERAL aclexplode(c.relacl) a JOIN pg_roles r ON r.oid=a.grantee
    WHERE c.oid='public.sessions'::regclass AND a.privilege_type='INSERT' AND a.grantee<>c.relowner
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.projectos_github_job_status(text,text) TO %I',target);
  END LOOP;
END
$$;
