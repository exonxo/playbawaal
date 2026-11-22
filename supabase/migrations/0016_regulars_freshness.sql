-- Fresh for the host AND their regulars. Run in the Supabase SQL editor AFTER 0015. Safe to run more
-- than once. The app works before this is applied (it uses library_pick, host only).
--
-- library_pick_group serves items that neither the host nor any of the given players' devices has
-- been shown in the last 30 days, and records them as shown to all of them. Players have no account:
-- each phone is identified by a one-way hash of its anonymous device id ('a:<hex>'), never a name.
-- Like library_pick: service-role only, one pick at a time per host.

create or replace function public.library_pick_group(
  p_user uuid,
  p_players text[],
  p_kind text,
  p_categories text[],
  p_lang text default 'en',
  p_count int default 1,
  p_min int default 1,
  p_exclude_norms text[] default '{}',
  p_exclude_ids text[] default '{}'
)
returns table (id bigint, category text, data jsonb)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_host text := public.library_viewer(p_user, null);
  v_players text[];
  v_viewers text[];
  v_count int := least(greatest(coalesce(p_count, 1), 1), 30);
  v_min int := least(greatest(coalesce(p_min, 1), 1), least(greatest(coalesce(p_count, 1), 1), 30));
  v_ids bigint[];
begin
  -- Player keys: at most 50, each a valid anonymous viewer id (the app sends hashes).
  select coalesce(array_agg(distinct 'a:' || p), '{}') into v_players
  from unnest(coalesce(p_players, '{}')) p
  where p ~ '^[A-Za-z0-9_-]{16,64}$';
  v_players := v_players[1:50];
  v_viewers := array_prepend(v_host, v_players);

  perform pg_advisory_xact_lock(hashtextextended('library:' || v_host, 0));
  delete from public.content_seen s where s.viewer = any(v_viewers) and s.seen_at < now() - interval '30 days';

  select array_agg(x.id) into v_ids from (
    select l.id
    from public.content_library l
    where l.active
      and l.kind = p_kind
      and l.lang = coalesce(p_lang, 'en')
      and l.category = any(coalesce(p_categories, array['any']))
      and not (l.text_norm = any(coalesce(p_exclude_norms, '{}')))
      and not (coalesce(l.data ->> 'id', '') = any(coalesce(p_exclude_ids, '{}')))
      and not exists (select 1 from public.content_seen s where s.viewer = any(v_viewers) and s.item_id = l.id)
      and (l.expires_at is null or l.expires_at > now())
    order by random()
    limit v_count
  ) x;

  if coalesce(array_length(v_ids, 1), 0) < v_min then
    return;
  end if;

  insert into public.content_seen (viewer, user_id, item_id, seen_at)
  select v, case when v = v_host then p_user else null end, i, now()
  from unnest(v_viewers) v cross join unnest(v_ids) i
  on conflict (viewer, item_id) do update set seen_at = excluded.seen_at;

  update public.content_library l set served_count = l.served_count + 1, last_served_at = now()
  where l.id = any(v_ids);

  return query select l.id, l.category, l.data from public.content_library l where l.id = any(v_ids);
end;
$$;

revoke all on function public.library_pick_group(uuid, text[], text, text[], text, int, int, text[], text[]) from public, anon, authenticated;
grant execute on function public.library_pick_group(uuid, text[], text, text[], text, int, int, text[], text[]) to service_role;
