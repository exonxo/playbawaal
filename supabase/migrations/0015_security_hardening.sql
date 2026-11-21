-- Security hardening (round 14 review). Run in the Supabase SQL editor AFTER 0014. Safe to run more
-- than once. The app keeps working before this is applied (it falls back to its old behaviour).
--
-- 1. A shared rate limiter, so limits hold across all server instances (not per instance).
-- 2. Room lookups only through the app's server: browsers can no longer call the room functions
--    directly with the public key, so room codes can't be guessed at full speed.
-- 3. Player signals count once per host account per item per day, only for items that account was
--    actually served (or the built-in deck), and automatic switch-off needs several different hosts.
-- Nothing here is reachable by browsers: RLS on, no grants to anon/authenticated.

-- 1. Rate limiter -------------------------------------------------------------------------------
create table if not exists public.rate_buckets (
  key text not null check (length(key) between 1 and 200),
  window_start timestamptz not null,
  hits integer not null default 0,
  primary key (key, window_start)
);
alter table public.rate_buckets enable row level security;
revoke all on table public.rate_buckets from public, anon, authenticated;
grant select, insert, update, delete on table public.rate_buckets to service_role;

-- Counts one hit for p_key in the current window and says whether it is still within p_max.
-- Old windows are cleared now and then, so the table stays small.
create or replace function public.rate_hit(p_key text, p_window_seconds integer, p_max integer)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  w timestamptz;
  n integer;
begin
  if p_key is null or length(p_key) = 0 or length(p_key) > 200 or p_window_seconds < 1 or p_window_seconds > 86400 or p_max < 1 then
    raise exception 'rate_hit: bad arguments';
  end if;
  w := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  insert into public.rate_buckets as b (key, window_start, hits) values (p_key, w, 1)
  on conflict (key, window_start) do update set hits = b.hits + 1
  returning hits into n;
  if random() < 0.01 then
    delete from public.rate_buckets where window_start < now() - interval '1 day';
  end if;
  return n <= p_max;
end;
$$;
revoke all on function public.rate_hit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.rate_hit(text, integer, integer) to service_role;

-- 2. Room functions: no direct calls from browsers ------------------------------------------------
-- Supabase's default privileges give anon and authenticated EXECUTE on new functions directly
-- (not through PUBLIC), so revoking from PUBLIC in 0002/0003 wasn't enough.
do $$
begin
  if to_regprocedure('public.room_lookup(text)') is not null then
    revoke execute on function public.room_lookup(text) from public, anon, authenticated;
    grant execute on function public.room_lookup(text) to service_role;
  end if;
  if to_regprocedure('public.room_is_ended(text)') is not null then
    revoke execute on function public.room_is_ended(text) from public, anon, authenticated;
    grant execute on function public.room_is_ended(text) to service_role;
  end if;
  -- These check the signed-in user themselves; signed-out callers have no business calling them.
  if to_regprocedure('public.create_room()') is not null then
    revoke execute on function public.create_room() from public, anon;
  end if;
  if to_regprocedure('public.set_room_key(text, text)') is not null then
    revoke execute on function public.set_room_key(text, text) from public, anon;
  end if;
  if to_regprocedure('public.close_room(text)') is not null then
    revoke execute on function public.close_room(text) from public, anon;
  end if;
end;
$$;

-- 3. Signals: one vote per account per item per event per day -------------------------------------
create table if not exists public.content_votes (
  kind text not null check (kind ~ '^[a-z0-9-]{1,40}$'),
  category text not null check (category ~ '^[a-z0-9_-]{1,32}$'),
  text_norm text not null check (length(text_norm) between 1 and 200),
  voter text not null check (voter ~ '^[0-9a-f]{16,64}$'),
  event text not null check (event in ('shown', 'done', 'passed', 'flipped', 'skipped', 'loved', 'reported')),
  day date not null default current_date,
  primary key (kind, category, text_norm, voter, event, day)
);
create index if not exists content_votes_item_idx on public.content_votes (kind, category, text_norm);
alter table public.content_votes enable row level security;
revoke all on table public.content_votes from public, anon, authenticated;
grant select, insert, update, delete on table public.content_votes to service_role;

-- Records a batch of signals from one host account.
-- p_voter: a one-way hash of the host's account (no account id is stored).
-- p_user: the host's account id, used only to check which library items they were served.
-- p_builtin: normalised texts of the built-in deck for this kind/mood (accepted without a library row).
-- An event is counted only once per account, item and day, and only for items the account was served
-- (in the last 30 days) or that are in the built-in deck. Returns totals and distinct-host counts.
create or replace function public.signal_add_v2(
  p_kind text, p_category text, p_voter text, p_user uuid, p_items jsonb, p_builtin text[] default '{}'
)
returns table (text_norm text, shown bigint, done bigint, passed bigint, flipped bigint, reported_voters bigint, voters bigint)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  e jsonb;
  k text;
  n text;
  ev text;
  cat text := coalesce(nullif(p_category, ''), 'any');
  touched text[] := '{}';
begin
  if p_kind !~ '^[a-z0-9-]{1,40}$' or cat !~ '^[a-z0-9_-]{1,32}$' then
    raise exception 'signal_add_v2: bad kind or category';
  end if;
  if p_voter is null or p_voter !~ '^[0-9a-f]{16,64}$' or p_user is null then
    raise exception 'signal_add_v2: a host is required';
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 100 then
    raise exception 'signal_add_v2: items must be an array of at most 100';
  end if;
  for e in select * from jsonb_array_elements(p_items) loop
    k := left(btrim(coalesce(e ->> 'key', '')), 300);
    ev := e ->> 'event';
    n := public.library_norm(k);
    continue when n = '' or ev is null
      or ev not in ('shown', 'done', 'passed', 'flipped', 'skipped', 'loved', 'reported');
    -- Only real cards: in the built-in deck, or a library item this host was served.
    continue when not (n = any (coalesce(p_builtin, '{}')) or exists (
      select 1 from public.content_library l
      join public.content_seen s on s.item_id = l.id
      where l.kind = p_kind and l.text_norm = n and s.viewer = 'u:' || p_user::text
    ));
    insert into public.content_votes (kind, category, text_norm, voter, event)
    values (p_kind, cat, n, p_voter, ev)
    on conflict do nothing;
    continue when not found; -- this host already counted this event for this item today
    insert into public.content_signals as s (kind, category, text_norm, text_key,
      shown, done, passed, flipped, skipped, loved, reported)
    values (p_kind, cat, n, k,
      (ev = 'shown')::int, (ev = 'done')::int, (ev = 'passed')::int, (ev = 'flipped')::int,
      (ev = 'skipped')::int, (ev = 'loved')::int, (ev = 'reported')::int)
    on conflict on constraint content_signals_pkey do update set
      shown = s.shown + excluded.shown,
      done = s.done + excluded.done,
      passed = s.passed + excluded.passed,
      flipped = s.flipped + excluded.flipped,
      skipped = s.skipped + excluded.skipped,
      loved = s.loved + excluded.loved,
      reported = s.reported + excluded.reported,
      updated_at = now();
    touched := array_append(touched, n);
  end loop;
  return query
    select s.text_norm, s.shown, s.done, s.passed, s.flipped,
      (select count(distinct v.voter) from public.content_votes v
        where v.kind = s.kind and v.category = s.category and v.text_norm = s.text_norm and v.event = 'reported')::bigint,
      (select count(distinct v.voter) from public.content_votes v
        where v.kind = s.kind and v.category = s.category and v.text_norm = s.text_norm)::bigint
    from public.content_signals s
    where s.kind = p_kind and s.category = cat and s.text_norm = any (touched);
end;
$$;
revoke all on function public.signal_add_v2(text, text, text, uuid, jsonb, text[]) from public, anon, authenticated;
grant execute on function public.signal_add_v2(text, text, text, uuid, jsonb, text[]) to service_role;

-- The old function counted per room and accepted any text. Keep it callable only by the service
-- role (as before) but the app no longer uses it.
