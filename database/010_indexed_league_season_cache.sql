-- SkorHane: indexed, per-player league-season read model and batched ingestion.
-- Apply after migrations 007-009. Safe to re-run.
begin;

create index if not exists tm_player_season_stats_player_league_cache_idx
  on public.tm_player_season_stats (tm_id, competition_id, season_id, club_id);

create index if not exists tm_team_season_squads_competition_season_cache_idx
  on public.tm_team_season_squads (competition_id, season_id, tm_id, club_id);

create index if not exists tm_team_season_squads_player_season_cache_idx
  on public.tm_team_season_squads (tm_id, season_id, competition_id, club_id);

create table if not exists public.tm_league_player_season_totals_cache (
  competition_id text not null,
  competition_name text not null default '',
  season_id text not null,
  tm_id text not null references public.tm_players(tm_id) on delete cascade,
  player_name text not null default '',
  photo_url text,
  club_name text not null default '',
  appearances bigint not null default 0,
  starts bigint not null default 0,
  goals bigint not null default 0,
  assists bigint not null default 0,
  minutes bigint not null default 0,
  yellow_cards bigint not null default 0,
  second_yellow_cards bigint not null default 0,
  red_cards bigint not null default 0,
  goals_conceded bigint not null default 0,
  clean_sheets bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key (competition_id, season_id, tm_id)
);

create index if not exists tm_league_player_season_totals_cache_lookup_idx
  on public.tm_league_player_season_totals_cache (competition_id, season_id, tm_id);

alter table public.tm_league_player_season_totals_cache enable row level security;
revoke all on public.tm_league_player_season_totals_cache from public, anon, authenticated;
grant select on public.tm_league_player_season_totals_cache to service_role;

-- Bulk upsert all league/season/club rows returned by one player stats response.
-- Synthetic zero rows may fill absent roster stints, but never overwrite an
-- existing non-null statistic with zero.
create or replace function public.tm_upsert_season_stats_batch(p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_saved integer := 0;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'p_rows must be a JSON array';
  end if;

  insert into public.tm_player_season_stats (
    tm_id, season_id, competition_name, club_name, competition_id, club_id,
    appearances, starts, goals, assists, minutes, yellow_cards, second_yellow_cards,
    red_cards, goals_conceded, clean_sheets, payload, source
  )
  select
    x.row->>'tm_id',
    x.row->>'season_id',
    coalesce(x.row->>'competition_name', ''),
    coalesce(x.row->>'club_name', ''),
    nullif(x.row->>'competition_id', ''),
    nullif(x.row->>'club_id', ''),
    nullif(x.row->>'appearances', '')::integer,
    nullif(x.row->>'starts', '')::integer,
    nullif(x.row->>'goals', '')::integer,
    nullif(x.row->>'assists', '')::integer,
    nullif(x.row->>'minutes', '')::integer,
    nullif(x.row->>'yellow_cards', '')::integer,
    nullif(x.row->>'second_yellow_cards', '')::integer,
    nullif(x.row->>'red_cards', '')::integer,
    nullif(x.row->>'goals_conceded', '')::integer,
    nullif(x.row->>'clean_sheets', '')::integer,
    public.tm_clean_jsonb(x.row->'payload'),
    coalesce(x.row->>'source', 'felipeall')
  from jsonb_array_elements(p_rows) as x(row)
  where coalesce(x.row->>'tm_id', '') <> ''
    and coalesce(x.row->>'season_id', '') <> ''
    and coalesce(x.row->>'competition_name', '') <> ''
    and coalesce(x.row->>'club_name', '') <> ''
  on conflict (tm_id, season_id, competition_name, club_name) do update set
    competition_id = coalesce(excluded.competition_id, tm_player_season_stats.competition_id),
    club_id = coalesce(excluded.club_id, tm_player_season_stats.club_id),
    appearances = case
      when excluded.payload#>>'{league_stats_sync,zero_fill}' = 'true'
        then coalesce(tm_player_season_stats.appearances, excluded.appearances)
      else coalesce(excluded.appearances, tm_player_season_stats.appearances)
    end,
    starts = case
      when excluded.payload#>>'{league_stats_sync,zero_fill}' = 'true'
        then coalesce(tm_player_season_stats.starts, excluded.starts)
      else coalesce(excluded.starts, tm_player_season_stats.starts)
    end,
    goals = case
      when excluded.payload#>>'{league_stats_sync,zero_fill}' = 'true'
        then coalesce(tm_player_season_stats.goals, excluded.goals)
      else coalesce(excluded.goals, tm_player_season_stats.goals)
    end,
    assists = case
      when excluded.payload#>>'{league_stats_sync,zero_fill}' = 'true'
        then coalesce(tm_player_season_stats.assists, excluded.assists)
      else coalesce(excluded.assists, tm_player_season_stats.assists)
    end,
    minutes = case
      when excluded.payload#>>'{league_stats_sync,zero_fill}' = 'true'
        then coalesce(tm_player_season_stats.minutes, excluded.minutes)
      else coalesce(excluded.minutes, tm_player_season_stats.minutes)
    end,
    yellow_cards = case
      when excluded.payload#>>'{league_stats_sync,zero_fill}' = 'true'
        then coalesce(tm_player_season_stats.yellow_cards, excluded.yellow_cards)
      else coalesce(excluded.yellow_cards, tm_player_season_stats.yellow_cards)
    end,
    second_yellow_cards = case
      when excluded.payload#>>'{league_stats_sync,zero_fill}' = 'true'
        then coalesce(tm_player_season_stats.second_yellow_cards, excluded.second_yellow_cards)
      else coalesce(excluded.second_yellow_cards, tm_player_season_stats.second_yellow_cards)
    end,
    red_cards = case
      when excluded.payload#>>'{league_stats_sync,zero_fill}' = 'true'
        then coalesce(tm_player_season_stats.red_cards, excluded.red_cards)
      else coalesce(excluded.red_cards, tm_player_season_stats.red_cards)
    end,
    goals_conceded = case
      when excluded.payload#>>'{league_stats_sync,zero_fill}' = 'true'
        then coalesce(tm_player_season_stats.goals_conceded, excluded.goals_conceded)
      else coalesce(excluded.goals_conceded, tm_player_season_stats.goals_conceded)
    end,
    clean_sheets = case
      when excluded.payload#>>'{league_stats_sync,zero_fill}' = 'true'
        then coalesce(tm_player_season_stats.clean_sheets, excluded.clean_sheets)
      else coalesce(excluded.clean_sheets, tm_player_season_stats.clean_sheets)
    end,
    payload = public.tm_merge_jsonb(tm_player_season_stats.payload, excluded.payload),
    source = excluded.source,
    updated_at = now();

  get diagnostics v_saved = row_count;
  return v_saved;
end;
$$;

-- Rebuild one player's cache row set only after that player's full response was
-- written. The legacy view performs the identity-safe deduplication once here;
-- subsequent page requests are plain indexed table reads.
create or replace function public.tm_refresh_player_league_season_totals_cache(p_tm_id text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows integer := 0;
begin
  if coalesce(trim(p_tm_id), '') = '' then
    raise exception 'p_tm_id is required';
  end if;

  delete from public.tm_league_player_season_totals_cache
  where tm_id = p_tm_id;

  insert into public.tm_league_player_season_totals_cache (
    competition_id, competition_name, season_id, tm_id, player_name, photo_url,
    club_name, appearances, starts, goals, assists, minutes, yellow_cards,
    second_yellow_cards, red_cards, goals_conceded, clean_sheets, updated_at
  )
  select
    v.competition_id, coalesce(v.competition_name, ''), v.season_id, v.tm_id,
    coalesce(v.player_name, v.tm_id), v.photo_url, coalesce(v.club_name, ''),
    coalesce(v.appearances, 0), coalesce(v.starts, 0), coalesce(v.goals, 0),
    coalesce(v.assists, 0), coalesce(v.minutes, 0), coalesce(v.yellow_cards, 0),
    coalesce(v.second_yellow_cards, 0), coalesce(v.red_cards, 0),
    coalesce(v.goals_conceded, 0), coalesce(v.clean_sheets, 0), now()
  from public.tm_league_player_season_totals v
  where v.tm_id = p_tm_id;

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

revoke all on function public.tm_upsert_season_stats_batch(jsonb) from public, anon, authenticated;
grant execute on function public.tm_upsert_season_stats_batch(jsonb) to service_role;
revoke all on function public.tm_refresh_player_league_season_totals_cache(text) from public, anon, authenticated;
grant execute on function public.tm_refresh_player_league_season_totals_cache(text) to service_role;

comment on table public.tm_league_player_season_totals_cache is
  'Indexed player totals by competition and season; refreshed once per player stats import, read directly by the Worker.';
comment on function public.tm_upsert_season_stats_batch(jsonb) is
  'Bulk upsert all season/competition/club rows from one complete player stats response.';
comment on function public.tm_refresh_player_league_season_totals_cache(text) is
  'Rebuild one player cache after all league season stats have been written.';

commit;
