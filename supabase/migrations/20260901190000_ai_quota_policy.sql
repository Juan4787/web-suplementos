begin;

create or replace function public.claim_ai_request(p_input_chars integer)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_minute_bucket timestamptz;
  v_day_bucket timestamptz;
  v_minute_count integer;
  v_day_count integer;
  v_audit_id uuid;
  v_minute_limit constant integer := 8;
  v_day_limit constant integer := 100;
begin
  perform private.require_owner();

  if p_input_chars is null or p_input_chars < 1 or p_input_chars > 10000 then
    raise exception using errcode = 'P0001', message = 'INVALID_AI_REQUEST';
  end if;

  perform pg_advisory_xact_lock(73481, hashtext(auth.uid()::text));

  v_minute_bucket := date_trunc('minute', v_now);
  v_day_bucket := date_trunc('day', v_now);

  select coalesce(max(request_count), 0)
  into v_minute_count
  from public.ai_usage_counters
  where user_id = auth.uid()
    and bucket_kind = 'minute'
    and bucket_start = v_minute_bucket;

  select coalesce(max(request_count), 0)
  into v_day_count
  from public.ai_usage_counters
  where user_id = auth.uid()
    and bucket_kind = 'day'
    and bucket_start = v_day_bucket;

  if v_minute_count >= v_minute_limit or v_day_count >= v_day_limit then
    insert into public.ai_request_audit(user_id, status, input_chars, completed_at)
    values (auth.uid(), 'quota', p_input_chars, v_now)
    returning id into v_audit_id;

    return jsonb_build_object(
      'allowed', false,
      'requestId', v_audit_id,
      'retryAfter', case
        when v_day_count >= v_day_limit then 'next_utc_day'
        else 'next_minute'
      end
    );
  end if;

  insert into public.ai_usage_counters(user_id, bucket_kind, bucket_start, request_count)
  values (auth.uid(), 'minute', v_minute_bucket, 1)
  on conflict (user_id, bucket_kind, bucket_start)
  do update set request_count = public.ai_usage_counters.request_count + 1;

  insert into public.ai_usage_counters(user_id, bucket_kind, bucket_start, request_count)
  values (auth.uid(), 'day', v_day_bucket, 1)
  on conflict (user_id, bucket_kind, bucket_start)
  do update set request_count = public.ai_usage_counters.request_count + 1;

  insert into public.ai_request_audit(user_id, status, input_chars)
  values (auth.uid(), 'started', p_input_chars)
  returning id into v_audit_id;

  delete from public.ai_usage_counters
  where bucket_start < v_day_bucket - interval '2 days';

  return jsonb_build_object(
    'allowed', true,
    'requestId', v_audit_id,
    'context', jsonb_build_object(
      'currentDate', to_char(v_now at time zone 'America/Argentina/Buenos_Aires', 'YYYY-MM-DD'),
      'timezone', 'America/Argentina/Buenos_Aires',
      'currency', 'ARS'
    )
  );
end;
$$;

revoke all on function public.claim_ai_request(integer) from public, anon;
grant execute on function public.claim_ai_request(integer) to authenticated;

commit;
