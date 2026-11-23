CREATE POLICY reminder_record_read ON records AS RESTRICTIVE FOR SELECT USING (
  (SELECT public.projectos_reminder_workspace()) IS NULL
  OR kind IN ('reminders','tasks','charges','resources','contracts','preferences','incidents')
);
CREATE POLICY reminder_record_insert ON records AS RESTRICTIVE FOR INSERT WITH CHECK (
  (SELECT public.projectos_reminder_workspace()) IS NULL
  OR (kind='incidents' AND id LIKE 'auto-%' AND payload::jsonb->>'state'='open'
    AND payload::jsonb->>'source' IN ('زمان‌بند داخلی · ثبت خودکار','زمان‌بند داخلی · چرخش اعتبارنامه'))
);

CREATE FUNCTION public.projectos_guard_reminder_update() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF public.projectos_reminder_workspace() IS NOT NULL AND NOT COALESCE(
    OLD.payload::jsonb->>'state'='snoozed' AND NEW.payload::jsonb->>'state'='open'
    AND NOT (NEW.payload::jsonb ? 'snoozedUntil')
    AND OLD.payload::jsonb - ARRAY['state','snoozedUntil'] = NEW.payload::jsonb - 'state',false
  ) THEN RAISE EXCEPTION 'Invalid reminder incident transition' USING ERRCODE='42501'; END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER reminder_transition BEFORE UPDATE ON records FOR EACH ROW
  WHEN (OLD.kind='incidents') EXECUTE FUNCTION public.projectos_guard_reminder_update();

CREATE FUNCTION public.projectos_rotation_deadlines()
RETURNS TABLE (id text, payload text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT r.id,jsonb_build_object('projectId',r.project_id,'rotationDue',r.payload::jsonb->>'rotationDue')::text
  FROM public.records r
  WHERE r.kind='secrets' AND r.workspace_id=(SELECT public.projectos_reminder_workspace())
    AND r.payload::jsonb->>'rotationDue' IS NOT NULL
$$;
REVOKE EXECUTE ON FUNCTION public.projectos_rotation_deadlines() FROM PUBLIC;
