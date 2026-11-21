-- Content engine core: admin rules, strictness settings, player signals and player reports.
-- Run in the Supabase SQL editor AFTER 0013. Safe to run more than once. Nothing existing is changed
-- except that library items can now be switched off with a reason (quarantine).
-- The app works before this is applied: rules and strictness fall back to the built-in defaults,
-- and signals and reports are simply not recorded.
--
-- Like 0004 to 0013, nothing here is reachable by browsers: RLS is on with no policies, the public
-- roles have no privileges, and the functions can only be run with the service role key.
-- No email, account id or room code is stored with signals or reports. A report stores a one-way
-- hash of the room it came from, only so one room can't count as several reports.

-- 1. Rules the admin adds: blocked words or patterns, allowed exceptions, topic bans.
create table if not exists public.content_rules (
  id bigint generated always as identity primary key,
  -- 'block' = drop anything containing it; 'allow' = an exception to block rules;
  -- 'topic' = a topic the AI must avoid (also blocked like a word).
  rule_type text not null check (rule_type in ('block', 'allow', 'topic')),
  -- 'word' = whole word or phrase, case-insensitive; 'pattern' = a regular expression.
  match_type text not null default 'word' check (match_type in ('word', 'pattern')),
  pattern text not null check (length(pattern) between 1 and 200),
  -- Which content it applies to: 'all' or one library kind.
  scope text not null default 'all' check (scope ~ '^(all|[a-z0-9-]{1,40})$'),
  note text check (note is null or length(note) <= 200),
  active boolean not null default true,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists content_rules_active_idx on public.content_rules (active, scope);
alter table public.content_rules enable row level security;

-- 2. Strictness settings, e.g. key 'spin-bottle' = {"college": {"phone": true, "social": false, ...}}.
create table if not exists public.content_policy (
  key text primary key check (key ~ '^[a-z0-9:_-]{1,64}$'),
  value jsonb not null check (jsonb_typeof(value) = 'object'),
  updated_by text,
  updated_at timestamptz not null default now()
);
alter table public.content_policy enable row level security;

-- 3. Player signals per item (built-in or library), keyed by kind + mood/level + normalised text.
create table if not exists public.content_signals (
  kind text not null check (kind ~ '^[a-z0-9-]{1,40}$'),
  category text not null default 'any' check (category ~ '^[a-z0-9_-]{1,32}$'),
  text_norm text not null check (length(text_norm) between 1 and 200),
  text_key text not null check (length(text_key) between 1 and 300),
  shown bigint not null default 0,
  done bigint not null default 0,
  passed bigint not null default 0,
  flipped bigint not null default 0,
  skipped bigint not null default 0,
  loved bigint not null default 0,
  reported bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key (kind, category, text_norm)
);
create index if not exists content_signals_reported_idx on public.content_signals (reported desc) where reported > 0;
alter table public.content_signals enable row level security;

-- 4. Player reports: one row per item per room, so a single room can't report an item many times.
create table if not exists public.content_reports (
  kind text not null check (kind ~ '^[a-z0-9-]{1,40}$'),
  category text not null default 'any' check (category ~ '^[a-z0-9_-]{1,32}$'),
  text_norm text not null check (length(text_norm) between 1 and 200),
  room_hash text not null check (room_hash ~ '^[0-9a-f]{16,64}$'),
  created_at timestamptz not null default now(),
  primary key (kind, category, text_norm, room_hash)
);
alter table public.content_reports enable row level security;

-- 5. Library items switched off automatically say why, so the admin can see and undo it.
alter table public.content_library add column if not exists off_reason text
  check (off_reason is null or off_reason ~ '^[a-z0-9:_-]{1,40}$');
alter table public.content_library add column if not exists off_at timestamptz;

revoke all on table public.content_rules, public.content_policy, public.content_signals, public.content_reports from public, anon, authenticated;
revoke all on sequence public.content_rules_id_seq from public, anon, authenticated;
grant select, insert, update, delete on table public.content_rules, public.content_policy, public.content_signals, public.content_reports to service_role;
grant usage, select on sequence public.content_rules_id_seq to service_role;

-- 6. Records a batch of signals from one game. p_items: [{"key": text, "event": shown|done|passed|
--    flipped|skipped|loved|reported}, ...] (at most 100). Reports count once per room.
--    Returns, for each item touched, its totals and how many rooms have reported it.
create or replace function public.signal_add(p_kind text, p_category text, p_room_hash text, p_items jsonb)
returns table (text_norm text, shown bigint, done bigint, passed bigint, flipped bigint, reported_rooms bigint)
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
    raise exception 'signal_add: bad kind or category';
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 100 then
    raise exception 'signal_add: items must be an array of at most 100';
  end if;
  for e in select * from jsonb_array_elements(p_items) loop
    k := left(btrim(coalesce(e ->> 'key', '')), 300);
    ev := e ->> 'event';
    n := public.library_norm(k);
    continue when n = '' or ev is null
      or ev not in ('shown', 'done', 'passed', 'flipped', 'skipped', 'loved', 'reported');
    if ev = 'reported' then
      continue when p_room_hash is null or p_room_hash !~ '^[0-9a-f]{16,64}$';
      insert into public.content_reports (kind, category, text_norm, room_hash)
      values (p_kind, cat, n, p_room_hash)
      on conflict do nothing;
      -- A room that already reported this item adds nothing.
      continue when not found;
    end if;
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
      (select count(*) from public.content_reports r
        where r.kind = s.kind and r.category = s.category and r.text_norm = s.text_norm)::bigint
    from public.content_signals s
    where s.kind = p_kind and s.category = cat and s.text_norm = any (touched);
end;
$$;

-- 7. Switches library items off (or back on) by normalised text, with a reason. Returns how many changed.
create or replace function public.library_set_off(p_kind text, p_norms text[], p_reason text, p_off boolean)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  changed integer;
begin
  if p_reason is not null and p_reason !~ '^[a-z0-9:_-]{1,40}$' then
    raise exception 'library_set_off: bad reason';
  end if;
  update public.content_library
  set active = not p_off,
      off_reason = case when p_off then p_reason else null end,
      off_at = case when p_off then now() else null end
  where kind = p_kind and text_norm = any (coalesce(p_norms, '{}'))
    -- Turning on only undoes automatic switch-offs, never an admin's manual one, unless asked.
    and (p_off and active or (not p_off and not active and (p_reason is null or off_reason = p_reason)));
  get diagnostics changed = row_count;
  return changed;
end;
$$;

revoke all on function public.signal_add(text, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.library_set_off(text, text[], text, boolean) from public, anon, authenticated;
grant execute on function public.signal_add(text, text, text, jsonb) to service_role;
grant execute on function public.library_set_off(text, text[], text, boolean) to service_role;
