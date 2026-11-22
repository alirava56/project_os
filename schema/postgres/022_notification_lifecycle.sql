ALTER TABLE public.vault_checks DROP CONSTRAINT vault_checks_status_check;
ALTER TABLE public.vault_checks ADD CONSTRAINT vault_checks_status_check
  CHECK (status IN ('verified','unknown','not_found','unavailable','permission_denied','stale'));
UPDATE public.vault_checks SET status='stale' WHERE status='verified';

ALTER TABLE public.notification_outbox
  ADD COLUMN expires_at bigint, ADD COLUMN telegram_title text, ADD COLUMN telegram_project text;
ALTER TABLE public.delivery_retries
  ADD COLUMN dispatch_at bigint, ADD COLUMN provider_id text, ADD COLUMN last_error text;

-- An old in-flight row cannot distinguish claim from a request already sent.
UPDATE public.delivery_retries r SET dispatch_at=r.claimed_at
FROM public.notification_outbox o WHERE o.id=r.notification_id AND o.state='sending';

CREATE FUNCTION public.projectos_guard_notification_cancellation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.delivery_retries r WHERE r.notification_id=OLD.id AND r.dispatch_at IS NOT NULL) THEN
    NEW.state := 'unknown';
  END IF;
  RETURN NEW;
END
$$;
REVOKE EXECUTE ON FUNCTION public.projectos_guard_notification_cancellation() FROM PUBLIC;
CREATE TRIGGER projectos_notification_cancellation BEFORE UPDATE OF state ON public.notification_outbox
FOR EACH ROW WHEN (OLD.state='sending' AND NEW.state='cancelled') EXECUTE FUNCTION public.projectos_guard_notification_cancellation();

CREATE FUNCTION public.projectos_reminder_project_names() RETURNS TABLE (id text, name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT r.id,left(r.payload::jsonb->>'name',300) FROM public.records r
  WHERE r.kind='projects' AND r.workspace_id=(SELECT public.projectos_reminder_workspace())
$$;
REVOKE EXECUTE ON FUNCTION public.projectos_reminder_project_names() FROM PUBLIC;

CREATE FUNCTION public.projectos_retire_explicit_reminder(record_id text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE workspace text := public.projectos_verified_workspace();
DECLARE target text;
BEGIN
  FOR target IN SELECT i.id FROM public.records r
    JOIN public.records i ON i.workspace_id=r.workspace_id AND i.project_id=r.project_id AND i.kind='incidents'
    JOIN public.notification_outbox n ON n.workspace_id=i.workspace_id AND n.id=i.id AND n.channel='in_app'
    WHERE r.kind='reminders' AND r.workspace_id=workspace AND r.id=record_id
      AND public.projectos_can_write_record(r.kind,r.project_id,r.payload)
      AND i.id ~ '^auto-[a-f0-9]{28}$' AND i.payload::jsonb->>'source'='زمان‌بند داخلی · ثبت خودکار'
      AND n.reminder_id='reminders:'||record_id
  LOOP
    PERFORM public.projectos_cancel_incident_outbox(target);
    UPDATE public.notification_outbox SET state='cancelled' WHERE id=target AND workspace_id=workspace AND state='available';
  END LOOP;
END
$$;
REVOKE EXECUTE ON FUNCTION public.projectos_retire_explicit_reminder(text) FROM PUBLIC;

CREATE FUNCTION public.projectos_notification_status(alert text)
RETURNS TABLE (channel text, state text, scheduled_for text, delivered_at timestamptz, retry_after bigint, last_error text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT o.channel,o.state,o.scheduled_for,o.delivered_at,
    CASE WHEN o.state='retrying' THEN r.retry_after ELSE NULL END,r.last_error
  FROM public.notification_outbox o
  LEFT JOIN public.delivery_retries r ON r.notification_id=o.id
  WHERE alert ~ '^(auto|monitor)-[a-f0-9]{28}$'
    AND o.workspace_id=(SELECT public.projectos_verified_workspace())
    AND EXISTS (SELECT 1 FROM public.projectos_records a WHERE a.workspace_id=o.workspace_id AND a.kind='incidents' AND a.id=alert)
    AND ((o.channel='in_app' AND o.id=alert)
      OR (o.channel='telegram' AND (o.id='tg-'||alert OR o.id LIKE 'tg-'||alert||'-%'))
      OR (o.channel='email' AND (o.id='email-'||alert OR o.id LIKE 'email-'||alert||'-%')))
  ORDER BY o.created_at DESC,o.id LIMIT 50
$$;
REVOKE EXECUTE ON FUNCTION public.projectos_notification_status(text) FROM PUBLIC;

CREATE FUNCTION public.projectos_notification_health() RETURNS TABLE (name text, checked_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT split_part(h.name,'/',1),h.checked_at FROM public.worker_heartbeats h
  WHERE h.name IN ('reminders/'||public.projectos_verified_workspace(),'delivery/'||public.projectos_verified_workspace())
    AND public.projectos_document_scope()->>'role'='owner'
$$;
REVOKE EXECUTE ON FUNCTION public.projectos_notification_health() FROM PUBLIC;

-- Upgrade dedicated logins that were provisioned before this migration.
DO $$
DECLARE target name;
BEGIN
  FOR target IN SELECT DISTINCT r.rolname FROM pg_class c
    CROSS JOIN LATERAL aclexplode(c.relacl) a JOIN pg_roles r ON r.oid=a.grantee
    WHERE c.oid='public.sessions'::regclass AND a.privilege_type='INSERT' AND a.grantee<>c.relowner
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.projectos_notification_status(text),
      public.projectos_notification_health(),public.projectos_retire_explicit_reminder(text) TO %I',target);
  END LOOP;
  FOR target IN SELECT r.rolname FROM projectos_private.reminder_logins b JOIN pg_roles r ON r.oid=b.login
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.projectos_reminder_project_names() TO %I',target);
    EXECUTE format('GRANT SELECT (dispatch_at) ON public.delivery_retries TO %I',target);
    EXECUTE format('GRANT UPDATE (expires_at,telegram_title,telegram_project) ON public.notification_outbox TO %I',target);
    EXECUTE format('ALTER POLICY %I ON public.worker_heartbeats USING
      (public.projectos_reminder_workspace() IS NOT NULL AND name IN (%L,%L||public.projectos_reminder_workspace()))',
      target,'reminders','reminders/');
  END LOOP;
  FOR target IN SELECT p.polname FROM pg_policy p JOIN pg_roles r ON r.rolname=p.polname
    WHERE p.polrelid='public.worker_heartbeats'::regclass AND NOT p.polpermissive
      AND pg_get_expr(p.polqual,p.polrelid) ILIKE '%''delivery''%'
  LOOP
    EXECUTE format('ALTER POLICY %I ON public.worker_heartbeats USING (name=%L OR
      EXISTS (SELECT 1 FROM public.workspaces w WHERE worker_heartbeats.name=%L||w.id))',target,'delivery','delivery/');
  END LOOP;
END
$$;
