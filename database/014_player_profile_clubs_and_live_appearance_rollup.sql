-- SkorHane 014: player club dictionary and idempotent live appearance rollup.
-- Apply after migrations 001-013. Safe to re-run.
begin;

create or replace view public.tm_club_directory
with (security_invoker = true)
as
select distinct on (r.external_id)
  r.external_id as club_id,
  coalesce(nullif(r.payload->>'club_name',''), nullif(r.payload->>'name',''), '') as name,
  coalesce(nullif(r.payload->>'short_name',''), nullif(r.payload->>'official_name','')) as short_name,
  nullif(r.payload->>'logo_url','') as logo_url,
  nullif(r.payload->>'club_code','') as club_code,
  r.record_key,
  r.fetched_at
from public.tm_source_records r
where r.source = 'felipeall'
  and r.record_type = 'club_metadata'
  and nullif(r.external_id,'') is not null
order by r.external_id, r.fetched_at desc, r.id desc;

revoke all on public.tm_club_directory from public, anon, authenticated;
grant select on public.tm_club_directory to service_role;

-- Extend the existing one-RPC player bundle with only the club IDs linked to this player.
do $migration$
declare
  v_definition text;
  v_needle text := '    ''season_stats'', coalesce((';
  v_insert text := $fragment$
    'club_directory', coalesce((
      select jsonb_agg(jsonb_build_object(
        'club_id', d.club_id,
        'name', d.name,
        'short_name', d.short_name,
        'logo_url', d.logo_url,
        'club_code', d.club_code
      ) order by d.name)
      from public.tm_club_directory d
      where d.club_id in (
        select distinct nullif(s.club_id, '')
        from public.tm_player_season_stats s
        where s.tm_id = (select tm_id from target_id)
      )
      or d.club_id in (
        select distinct q.club_id
        from public.tm_team_season_squads q
        where q.tm_id = (select tm_id from target_id)
      )
    ), '[]'::jsonb),
$fragment$;
begin
  v_definition := pg_get_functiondef('public.tm_player_profile_bundle(text)'::regprocedure);
  if position(v_needle in v_definition) = 0 then
    raise exception 'tm_player_profile_bundle içindeki season_stats bölümü bulunamadı; migration güvenle durduruldu.';
  end if;
  if position('club_directory' in v_definition) = 0 then
    v_definition := replace(v_definition, v_needle, v_insert || v_needle);
    execute v_definition;
  end if;
end;
$migration$;

-- Ledger rows make each source/match contribution idempotent. Historical Felipe
-- match snapshots already feed full season stats and are excluded from this delta.
create table if not exists public.tm_live_appearance_contributions (
  source text not null,
  source_record_key text not null,
  tm_id text not null references public.tm_players(tm_id) on delete cascade,
  season_id text not null,
  competition_id text,
  club_id text,
  competition_name text not null,
  club_name text not null,
  appearances integer not null default 0,
  starts integer not null default 0,
  goals integer not null default 0,
  assists integer not null default 0,
  minutes integer not null default 0,
  yellow_cards integer not null default 0,
  red_cards integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (source, source_record_key)
);

alter table public.tm_live_appearance_contributions enable row level security;
revoke all on public.tm_live_appearance_contributions from public, anon, authenticated;
grant all on public.tm_live_appearance_contributions to service_role;

create index if not exists tm_live_appearance_contributions_player_season_idx
  on public.tm_live_appearance_contributions (tm_id, season_id, competition_name, club_name);

create or replace function public.tm_apply_live_appearance_stat_delta(
  p_tm_id text,
  p_season_id text,
  p_competition_id text,
  p_club_id text,
  p_competition_name text,
  p_club_name text,
  p_appearances integer,
  p_starts integer,
  p_goals integer,
  p_assists integer,
  p_minutes integer,
  p_yellow_cards integer,
  p_red_cards integer
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_target_season text;
begin
  if coalesce(trim(p_tm_id),'') = ''
     or coalesce(trim(p_season_id),'') = ''
     or coalesce(trim(p_competition_name),'') = ''
     or coalesce(trim(p_club_name),'') = '' then
    return;
  end if;

  -- Reuse the already stored season spelling where possible (e.g. 2026/27).
  select s.season_id
    into v_target_season
  from public.tm_player_season_stats s
  where s.tm_id = p_tm_id
    and public.tm_leader_season_start_year(s.season_id) =
        public.tm_leader_season_start_year(p_season_id)
    and lower(trim(s.competition_name)) = lower(trim(p_competition_name))
    and lower(trim(s.club_name)) = lower(trim(p_club_name))
  order by
    case when s.season_id ~ '^[0-9]{4}/[0-9]{2,4}$' then 0 else 1 end,
    s.updated_at desc,
    s.id desc
  limit 1;

  v_target_season := coalesce(v_target_season, p_season_id);

  insert into public.tm_player_season_stats (
    tm_id, season_id, competition_id, club_id, competition_name, club_name,
    appearances, starts, goals, assists, minutes, yellow_cards, red_cards,
    payload, source
  ) values (
    p_tm_id, v_target_season, nullif(p_competition_id,''), nullif(p_club_id,''),
    p_competition_name, p_club_name,
    coalesce(p_appearances,0), coalesce(p_starts,0), coalesce(p_goals,0),
    coalesce(p_assists,0), coalesce(p_minutes,0), coalesce(p_yellow_cards,0),
    coalesce(p_red_cards,0),
    jsonb_build_object('live_appearance_rollup', true, 'last_live_match_at', now()),
    'live_appearance_rollup'
  )
  on conflict (tm_id, season_id, competition_name, club_name) do update set
    competition_id = coalesce(excluded.competition_id, tm_player_season_stats.competition_id),
    club_id = coalesce(excluded.club_id, tm_player_season_stats.club_id),
    appearances = greatest(0, coalesce(tm_player_season_stats.appearances,0) + coalesce(excluded.appearances,0)),
    starts = greatest(0, coalesce(tm_player_season_stats.starts,0) + coalesce(excluded.starts,0)),
    goals = greatest(0, coalesce(tm_player_season_stats.goals,0) + coalesce(excluded.goals,0)),
    assists = greatest(0, coalesce(tm_player_season_stats.assists,0) + coalesce(excluded.assists,0)),
    minutes = greatest(0, coalesce(tm_player_season_stats.minutes,0) + coalesce(excluded.minutes,0)),
    yellow_cards = greatest(0, coalesce(tm_player_season_stats.yellow_cards,0) + coalesce(excluded.yellow_cards,0)),
    red_cards = greatest(0, coalesce(tm_player_season_stats.red_cards,0) + coalesce(excluded.red_cards,0)),
    payload = public.tm_merge_jsonb(tm_player_season_stats.payload, excluded.payload),
    updated_at = now();
end;
$$;

create or replace function public.tm_rollup_live_appearance_to_player_season()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_previous public.tm_live_appearance_contributions%rowtype;
  v_found boolean := false;
  v_start_year integer;
  v_new_tm_id text;
  v_new_season_id text;
  v_new_competition_id text;
  v_new_club_id text;
  v_new_competition_name text;
  v_new_club_name text;
  v_new_appearances integer;
  v_new_starts integer;
  v_new_goals integer;
  v_new_assists integer;
  v_new_minutes integer;
  v_new_yellow integer;
  v_new_red integer;
  v_roster_competition_id text;
  v_roster_club_id text;
begin
  if tg_op <> 'INSERT' then
    select * into v_previous
    from public.tm_live_appearance_contributions
    where source = old.source and source_record_key = old.source_record_key
    for update;
    v_found := found;
  end if;

  if tg_op = 'DELETE' then
    if v_found then
      perform public.tm_apply_live_appearance_stat_delta(
        v_previous.tm_id, v_previous.season_id, v_previous.competition_id, v_previous.club_id,
        v_previous.competition_name, v_previous.club_name,
        -v_previous.appearances, -v_previous.starts, -v_previous.goals,
        -v_previous.assists, -v_previous.minutes, -v_previous.yellow_cards, -v_previous.red_cards
      );
      delete from public.tm_live_appearance_contributions
      where source = old.source and source_record_key = old.source_record_key;
      perform public.tm_refresh_player_league_season_totals_cache(v_previous.tm_id);
    end if;
    return old;
  end if;

  -- A row previously counted as live but later corrected into a historical
  -- snapshot must first be removed from the incremental ledger.
  if nullif(new.payload->>'history_source','') is not null then
    if v_found then
      perform public.tm_apply_live_appearance_stat_delta(
        v_previous.tm_id, v_previous.season_id, v_previous.competition_id, v_previous.club_id,
        v_previous.competition_name, v_previous.club_name,
        -v_previous.appearances, -v_previous.starts, -v_previous.goals,
        -v_previous.assists, -v_previous.minutes, -v_previous.yellow_cards, -v_previous.red_cards
      );
      delete from public.tm_live_appearance_contributions
      where source = old.source and source_record_key = old.source_record_key;
      perform public.tm_refresh_player_league_season_totals_cache(v_previous.tm_id);
    end if;
    return new;
  end if;

  if new.tm_id is null or new.played_at is null
     or coalesce(trim(new.competition_name),'') = ''
     or coalesce(trim(new.club_name),'') = ''
     or coalesce(trim(new.source_record_key),'') = '' then
    if v_found then
      perform public.tm_apply_live_appearance_stat_delta(
        v_previous.tm_id, v_previous.season_id, v_previous.competition_id, v_previous.club_id,
        v_previous.competition_name, v_previous.club_name,
        -v_previous.appearances, -v_previous.starts, -v_previous.goals,
        -v_previous.assists, -v_previous.minutes, -v_previous.yellow_cards, -v_previous.red_cards
      );
      delete from public.tm_live_appearance_contributions
      where source = old.source and source_record_key = old.source_record_key;
      perform public.tm_refresh_player_league_season_totals_cache(v_previous.tm_id);
    end if;
    return new;
  end if;

  v_start_year := case
    when extract(month from new.played_at) >= 7 then extract(year from new.played_at)::integer
    else extract(year from new.played_at)::integer - 1
  end;
  v_new_tm_id := new.tm_id;
  v_new_season_id := v_start_year::text;
  v_new_competition_name := new.competition_name;
  v_new_club_name := new.club_name;

  select q.competition_id, q.club_id
    into v_roster_competition_id, v_roster_club_id
  from public.tm_team_season_squads q
  where q.tm_id = new.tm_id
    and public.tm_leader_season_start_year(q.season_id) = v_start_year
    and lower(trim(q.club_name)) = lower(trim(new.club_name))
    and lower(trim(q.competition_name)) = lower(trim(new.competition_name))
  order by q.updated_at desc, q.id desc
  limit 1;

  v_new_competition_id := coalesce(
    nullif(new.payload->>'competition_id',''),
    nullif(new.payload->>'competitionId',''),
    v_roster_competition_id
  );
  v_new_club_id := coalesce(
    nullif(new.payload->>'club_id',''),
    nullif(new.payload->>'clubId',''),
    nullif(new.payload->>'team_id',''),
    v_roster_club_id
  );
  v_new_appearances := coalesce(round(new.appearances)::integer,1);
  v_new_starts := coalesce(round(new.starts)::integer,0);
  v_new_goals := coalesce(round(new.goals)::integer,0);
  v_new_assists := coalesce(round(new.assists)::integer,0);
  v_new_minutes := coalesce(round(new.minutes)::integer,0);
  v_new_yellow := coalesce(round(new.yellow_cards)::integer,0);
  v_new_red := coalesce(round(new.red_cards)::integer,0);

  if v_found then
    perform public.tm_apply_live_appearance_stat_delta(
      v_previous.tm_id, v_previous.season_id, v_previous.competition_id, v_previous.club_id,
      v_previous.competition_name, v_previous.club_name,
      -v_previous.appearances, -v_previous.starts, -v_previous.goals,
      -v_previous.assists, -v_previous.minutes, -v_previous.yellow_cards, -v_previous.red_cards
    );
  end if;

  perform public.tm_apply_live_appearance_stat_delta(
    v_new_tm_id, v_new_season_id, v_new_competition_id, v_new_club_id,
    v_new_competition_name, v_new_club_name,
    v_new_appearances, v_new_starts, v_new_goals, v_new_assists, v_new_minutes,
    v_new_yellow, v_new_red
  );

  if tg_op = 'UPDATE' and v_found and (old.source <> new.source or old.source_record_key <> new.source_record_key) then
    delete from public.tm_live_appearance_contributions
    where source = old.source and source_record_key = old.source_record_key;
  end if;

  insert into public.tm_live_appearance_contributions (
    source, source_record_key, tm_id, season_id, competition_id, club_id,
    competition_name, club_name, appearances, starts, goals, assists, minutes,
    yellow_cards, red_cards, updated_at
  ) values (
    new.source, new.source_record_key, v_new_tm_id, v_new_season_id,
    v_new_competition_id, v_new_club_id, v_new_competition_name, v_new_club_name,
    v_new_appearances, v_new_starts, v_new_goals, v_new_assists, v_new_minutes,
    v_new_yellow, v_new_red, now()
  )
  on conflict (source, source_record_key) do update set
    tm_id = excluded.tm_id, season_id = excluded.season_id,
    competition_id = excluded.competition_id, club_id = excluded.club_id,
    competition_name = excluded.competition_name, club_name = excluded.club_name,
    appearances = excluded.appearances, starts = excluded.starts, goals = excluded.goals,
    assists = excluded.assists, minutes = excluded.minutes,
    yellow_cards = excluded.yellow_cards, red_cards = excluded.red_cards,
    updated_at = now();

  if v_found and v_previous.tm_id <> v_new_tm_id then
    perform public.tm_refresh_player_league_season_totals_cache(v_previous.tm_id);
  end if;
  perform public.tm_refresh_player_league_season_totals_cache(v_new_tm_id);
  return new;
end;
$$;

drop trigger if exists tm_appearances_live_season_rollup on public.tm_appearances;
create trigger tm_appearances_live_season_rollup
after insert or update or delete on public.tm_appearances
for each row execute function public.tm_rollup_live_appearance_to_player_season();

revoke all on function public.tm_apply_live_appearance_stat_delta(text,text,text,text,text,text,integer,integer,integer,integer,integer,integer,integer) from public, anon, authenticated;
grant execute on function public.tm_apply_live_appearance_stat_delta(text,text,text,text,text,text,integer,integer,integer,integer,integer,integer,integer) to service_role;
revoke all on function public.tm_rollup_live_appearance_to_player_season() from public, anon, authenticated;
grant execute on function public.tm_rollup_live_appearance_to_player_season() to service_role;

comment on view public.tm_club_directory is
  'Latest known Transfermarkt club name, logo and short name keyed by provider club ID.';
comment on table public.tm_live_appearance_contributions is
  'Idempotency ledger for live tm_appearances changes; historical Felipe snapshots are excluded.';
comment on function public.tm_rollup_live_appearance_to_player_season() is
  'Automatically applies an idempotent match appearance delta to the correct player, season, competition and club totals.';

commit;

notify pgrst, 'reload schema';
