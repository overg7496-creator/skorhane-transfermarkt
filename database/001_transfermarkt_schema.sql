-- SkorHane / PostgreSQL schema for Transfermarkt ingestion
-- Run once in Supabase SQL Editor. Keep all tables private; Worker and GitHub Actions use service-role credentials only.

create extension if not exists pgcrypto;
create extension if not exists pg_trgm;

create or replace function public.tm_clean_jsonb(p jsonb)
returns jsonb
language plpgsql immutable
as $$
declare
  cleaned jsonb;
begin
  if p is null or p = 'null'::jsonb or p = '""'::jsonb or p = '[]'::jsonb or p = '{}'::jsonb then
    return '{}'::jsonb;
  end if;

  if jsonb_typeof(p) = 'object' then
    select coalesce(jsonb_object_agg(key, value), '{}'::jsonb)
      into cleaned
      from (
        select key, public.tm_clean_jsonb(value) as value
        from jsonb_each(p)
      ) as entries
      where value not in ('null'::jsonb, '""'::jsonb, '[]'::jsonb, '{}'::jsonb);
    return coalesce(cleaned, '{}'::jsonb);
  elsif jsonb_typeof(p) = 'array' then
    select coalesce(jsonb_agg(value), '[]'::jsonb)
      into cleaned
      from (
        select public.tm_clean_jsonb(value) as value
        from jsonb_array_elements(p)
      ) as entries
      where value not in ('null'::jsonb, '""'::jsonb, '[]'::jsonb, '{}'::jsonb);
    return coalesce(cleaned, '[]'::jsonb);
  end if;

  -- Keep 0 and false: both are meaningful football data values.
  return p;
end;
$$;

create or replace function public.tm_merge_jsonb(old_value jsonb, new_value jsonb)
returns jsonb
language plpgsql immutable
as $$
declare
  cleaned_new jsonb;
  merged jsonb;
  entry record;
begin
  if new_value is null or new_value = 'null'::jsonb or new_value = '""'::jsonb or new_value = '[]'::jsonb or new_value = '{}'::jsonb then
    return coalesce(old_value, '{}'::jsonb);
  end if;

  cleaned_new := public.tm_clean_jsonb(new_value);
  if jsonb_typeof(old_value) = 'object' and jsonb_typeof(cleaned_new) = 'object' then
    merged := coalesce(old_value, '{}'::jsonb);
    for entry in select key, value from jsonb_each(cleaned_new) loop
      if merged ? entry.key then
        merged := jsonb_set(merged, array[entry.key],
          public.tm_merge_jsonb(merged->entry.key, entry.value), true);
      else
        merged := jsonb_set(merged, array[entry.key], entry.value, true);
      end if;
    end loop;
    return merged;
  end if;

  return cleaned_new;
end;
$$;

create table if not exists public.tm_players (
  tm_id text primary key,
  name text not null,
  team_name text,
  position text,
  photo_url text,
  current_market_value_eur numeric,
  current_market_value_text text,
  current_market_value_date date,
  current_market_value_observed_at timestamptz,
  profile_payload jsonb not null default '{}'::jsonb,
  stats_payload jsonb not null default '{}'::jsonb,
  current_season_payload jsonb not null default '{}'::jsonb,
  transfers_payload jsonb not null default '{}'::jsonb,
  market_value_payload jsonb not null default '{}'::jsonb,
  injuries_payload jsonb not null default '{}'::jsonb,
  absences_payload jsonb not null default '{}'::jsonb,
  national_career_payload jsonb not null default '{}'::jsonb,
  source_presence jsonb not null default '{}'::jsonb,
  is_active boolean not null default false,
  last_squad_seen_at timestamptz,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  last_synced_at timestamptz not null default now(),
  last_felipe_synced_at timestamptz,
  last_source text,
  updated_at timestamptz not null default now()
);

alter table public.tm_players add column if not exists current_market_value_eur numeric;
alter table public.tm_players add column if not exists current_market_value_text text;
alter table public.tm_players add column if not exists current_market_value_date date;
alter table public.tm_players add column if not exists current_market_value_observed_at timestamptz;
alter table public.tm_players add column if not exists last_squad_seen_at timestamptz;
alter table public.tm_players add column if not exists last_felipe_synced_at timestamptz;

create index if not exists tm_players_name_trgm_idx on public.tm_players using gin (name gin_trgm_ops);
create index if not exists tm_players_team_idx on public.tm_players (team_name);
create index if not exists tm_players_active_squad_idx on public.tm_players (last_squad_seen_at desc) where is_active = true;

create table if not exists public.tm_player_season_stats (
  id bigserial primary key,
  tm_id text not null references public.tm_players(tm_id) on delete cascade,
  season_id text not null,
  competition_name text not null default '',
  club_name text not null default '',
  appearances integer,
  starts integer,
  goals integer,
  assists integer,
  minutes integer,
  yellow_cards integer,
  second_yellow_cards integer,
  red_cards integer,
  payload jsonb not null default '{}'::jsonb,
  source text not null,
  updated_at timestamptz not null default now(),
  unique (tm_id, season_id, competition_name, club_name)
);

create index if not exists tm_player_season_stats_lookup_idx
  on public.tm_player_season_stats (tm_id, season_id desc);

create table if not exists public.tm_transfers (
  id bigserial primary key,
  tm_id text not null references public.tm_players(tm_id) on delete cascade,
  transfer_date text not null default '',
  from_club text not null default '',
  to_club text not null default '',
  transfer_type text,
  fee_text text,
  fee_eur numeric,
  payload jsonb not null default '{}'::jsonb,
  source text not null,
  updated_at timestamptz not null default now(),
  unique (tm_id, transfer_date, from_club, to_club)
);

create table if not exists public.tm_market_values (
  id bigserial primary key,
  tm_id text not null references public.tm_players(tm_id) on delete cascade,
  valuation_date text not null,
  value_eur numeric,
  display_value text,
  club_name text,
  payload jsonb not null default '{}'::jsonb,
  source text not null,
  updated_at timestamptz not null default now(),
  unique (tm_id, valuation_date)
);

create table if not exists public.tm_appearances (
  id bigserial primary key,
  source text not null,
  source_record_key text not null,
  tm_id text,
  game_id text,
  played_at date,
  competition_name text,
  club_name text,
  opponent_name text,
  appearances numeric,
  starts numeric,
  minutes numeric,
  goals numeric,
  assists numeric,
  yellow_cards numeric,
  red_cards numeric,
  payload jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  unique (source, source_record_key)
);

create index if not exists tm_appearances_player_date_idx
  on public.tm_appearances (tm_id, played_at desc);

create table if not exists public.tm_source_records (
  id bigserial primary key,
  source text not null,
  record_type text not null,
  external_id text not null default '',
  record_key text not null default '',
  payload jsonb not null default '{}'::jsonb,
  fetched_at timestamptz not null default now(),
  unique (source, record_type, external_id, record_key)
);

create table if not exists public.tm_sync_runs (
  id bigserial primary key,
  source text not null,
  mode text not null,
  status text not null default 'running',
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  inserted_count integer not null default 0,
  updated_count integer not null default 0,
  skipped_count integer not null default 0,
  error_count integer not null default 0,
  message text,
  details jsonb not null default '{}'::jsonb
);

-- Partial updates merge only useful fields. NULL, blank string, empty object and empty array
-- never erase an existing populated field. Numeric zero and boolean false remain valid values.
create or replace function public.tm_upsert_player(
  p_tm_id text,
  p_source text,
  p_player jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(trim(p_tm_id), '') = '' then
    raise exception 'tm_id is required';
  end if;

  insert into public.tm_players (
    tm_id, name, team_name, position, photo_url,
    current_market_value_eur, current_market_value_text, current_market_value_date, current_market_value_observed_at,
    profile_payload, stats_payload, current_season_payload, transfers_payload,
    market_value_payload, injuries_payload, absences_payload,
    national_career_payload, source_presence, last_source, is_active, last_squad_seen_at
  ) values (
    p_tm_id,
    coalesce(nullif(p_player->>'name',''), p_tm_id),
    nullif(p_player->>'team_name',''),
    nullif(p_player->>'position',''),
    nullif(p_player->>'photo_url',''),
    nullif(p_player->>'current_market_value_eur','')::numeric,
    nullif(p_player->>'current_market_value_text',''),
    nullif(p_player->>'current_market_value_date','')::date,
    nullif(p_player->>'current_market_value_observed_at','')::timestamptz,
    public.tm_clean_jsonb(p_player->'profile_payload'),
    public.tm_clean_jsonb(p_player->'stats_payload'),
    public.tm_clean_jsonb(p_player->'current_season_payload'),
    public.tm_clean_jsonb(p_player->'transfers_payload'),
    public.tm_clean_jsonb(p_player->'market_value_payload'),
    public.tm_clean_jsonb(p_player->'injuries_payload'),
    public.tm_clean_jsonb(p_player->'absences_payload'),
    public.tm_clean_jsonb(p_player->'national_career_payload'),
    jsonb_build_object(p_source, now()),
    p_source,
    coalesce((p_player->>'is_active')::boolean, false),
    case when coalesce((p_player->>'is_active')::boolean, false) then now() else null end
  )
  on conflict (tm_id) do update set
    name = case
      when p_source = 'dcaribou' and tm_players.is_active then tm_players.name
      when excluded.name = excluded.tm_id then tm_players.name
      else coalesce(nullif(excluded.name, ''), tm_players.name)
    end,
    team_name = case when p_source = 'dcaribou' and tm_players.is_active then tm_players.team_name
                     else coalesce(nullif(excluded.team_name, ''), tm_players.team_name) end,
    position = case when p_source = 'dcaribou' and tm_players.is_active then tm_players.position
                    else coalesce(nullif(excluded.position, ''), tm_players.position) end,
    photo_url = case when p_source = 'dcaribou' and tm_players.is_active then tm_players.photo_url
                     else coalesce(nullif(excluded.photo_url, ''), tm_players.photo_url) end,
    current_market_value_eur = case when p_source = 'dcaribou' then tm_players.current_market_value_eur else coalesce(excluded.current_market_value_eur, tm_players.current_market_value_eur) end,
    current_market_value_text = case when p_source = 'dcaribou' then tm_players.current_market_value_text else coalesce(excluded.current_market_value_text, tm_players.current_market_value_text) end,
    current_market_value_date = case when p_source = 'dcaribou' then tm_players.current_market_value_date else coalesce(excluded.current_market_value_date, tm_players.current_market_value_date) end,
    current_market_value_observed_at = case when p_source = 'dcaribou' then tm_players.current_market_value_observed_at else coalesce(excluded.current_market_value_observed_at, tm_players.current_market_value_observed_at) end,
    profile_payload = case when p_source = 'dcaribou' and tm_players.is_active then tm_players.profile_payload
                            else public.tm_merge_jsonb(tm_players.profile_payload, excluded.profile_payload) end,
    stats_payload = public.tm_merge_jsonb(tm_players.stats_payload, excluded.stats_payload),
    current_season_payload = public.tm_merge_jsonb(tm_players.current_season_payload, excluded.current_season_payload),
    transfers_payload = public.tm_merge_jsonb(tm_players.transfers_payload, excluded.transfers_payload),
    market_value_payload = public.tm_merge_jsonb(tm_players.market_value_payload, excluded.market_value_payload),
    injuries_payload = public.tm_merge_jsonb(tm_players.injuries_payload, excluded.injuries_payload),
    absences_payload = public.tm_merge_jsonb(tm_players.absences_payload, excluded.absences_payload),
    national_career_payload = public.tm_merge_jsonb(tm_players.national_career_payload, excluded.national_career_payload),
    source_presence = public.tm_merge_jsonb(tm_players.source_presence, excluded.source_presence),
    last_seen_at = case when p_source = 'dcaribou' and tm_players.is_active then tm_players.last_seen_at else now() end,
    last_synced_at = case when p_source = 'dcaribou' and tm_players.is_active then tm_players.last_synced_at else now() end,
    last_source = case when p_source = 'dcaribou' and tm_players.is_active then tm_players.last_source else excluded.last_source end,
    is_active = case when p_player ? 'is_active' then coalesce((p_player->>'is_active')::boolean, tm_players.is_active) else tm_players.is_active end,
    last_squad_seen_at = case when p_player ? 'is_active' and coalesce((p_player->>'is_active')::boolean, false) then now() else tm_players.last_squad_seen_at end,
    updated_at = now();
end;
$$;

create or replace function public.tm_upsert_source_record(
  p_source text, p_record_type text, p_external_id text, p_record_key text, p_payload jsonb
)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.tm_source_records(source, record_type, external_id, record_key, payload)
  values (p_source, p_record_type, coalesce(p_external_id,''), coalesce(p_record_key,''), public.tm_clean_jsonb(p_payload))
  on conflict (source, record_type, external_id, record_key) do update
  set payload = public.tm_merge_jsonb(tm_source_records.payload, excluded.payload), fetched_at = now();
$$;

create or replace function public.tm_upsert_season_stat(p_row jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.tm_player_season_stats(
    tm_id, season_id, competition_name, club_name, appearances, starts, goals, assists,
    minutes, yellow_cards, second_yellow_cards, red_cards, payload, source
  ) values (
    p_row->>'tm_id', p_row->>'season_id', coalesce(p_row->>'competition_name',''), coalesce(p_row->>'club_name',''),
    nullif(p_row->>'appearances','')::integer, nullif(p_row->>'starts','')::integer,
    nullif(p_row->>'goals','')::integer, nullif(p_row->>'assists','')::integer,
    nullif(p_row->>'minutes','')::integer, nullif(p_row->>'yellow_cards','')::integer,
    nullif(p_row->>'second_yellow_cards','')::integer, nullif(p_row->>'red_cards','')::integer,
    public.tm_clean_jsonb(p_row->'payload'), coalesce(p_row->>'source','unknown')
  )
  on conflict (tm_id, season_id, competition_name, club_name) do update set
    appearances = coalesce(excluded.appearances, tm_player_season_stats.appearances),
    starts = coalesce(excluded.starts, tm_player_season_stats.starts),
    goals = coalesce(excluded.goals, tm_player_season_stats.goals),
    assists = coalesce(excluded.assists, tm_player_season_stats.assists),
    minutes = coalesce(excluded.minutes, tm_player_season_stats.minutes),
    yellow_cards = coalesce(excluded.yellow_cards, tm_player_season_stats.yellow_cards),
    second_yellow_cards = coalesce(excluded.second_yellow_cards, tm_player_season_stats.second_yellow_cards),
    red_cards = coalesce(excluded.red_cards, tm_player_season_stats.red_cards),
    payload = public.tm_merge_jsonb(tm_player_season_stats.payload, excluded.payload),
    source = excluded.source, updated_at = now();
end;
$$;

create or replace function public.tm_upsert_transfer(p_row jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.tm_transfers(tm_id, transfer_date, from_club, to_club, transfer_type, fee_text, fee_eur, payload, source)
  values (
    p_row->>'tm_id', coalesce(p_row->>'transfer_date',''), coalesce(p_row->>'from_club',''), coalesce(p_row->>'to_club',''),
    nullif(p_row->>'transfer_type',''), nullif(p_row->>'fee_text',''), nullif(p_row->>'fee_eur','')::numeric,
    public.tm_clean_jsonb(p_row->'payload'), coalesce(p_row->>'source','unknown')
  )
  on conflict (tm_id, transfer_date, from_club, to_club) do update set
    transfer_type = coalesce(excluded.transfer_type, tm_transfers.transfer_type),
    fee_text = coalesce(excluded.fee_text, tm_transfers.fee_text),
    fee_eur = coalesce(excluded.fee_eur, tm_transfers.fee_eur),
    payload = public.tm_merge_jsonb(tm_transfers.payload, excluded.payload), source = excluded.source, updated_at = now();
end;
$$;

create or replace function public.tm_upsert_market_value(p_row jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.tm_market_values(tm_id, valuation_date, value_eur, display_value, club_name, payload, source)
  values (
    p_row->>'tm_id', p_row->>'valuation_date', nullif(p_row->>'value_eur','')::numeric,
    nullif(p_row->>'display_value',''), nullif(p_row->>'club_name',''), public.tm_clean_jsonb(p_row->'payload'),
    coalesce(p_row->>'source','unknown')
  )
  on conflict (tm_id, valuation_date) do update set
    value_eur = case when tm_market_values.source = 'kamerozkan' and excluded.source = 'dcaribou' then tm_market_values.value_eur else coalesce(excluded.value_eur, tm_market_values.value_eur) end,
    display_value = case when tm_market_values.source = 'kamerozkan' and excluded.source = 'dcaribou' then tm_market_values.display_value else coalesce(excluded.display_value, tm_market_values.display_value) end,
    club_name = case when tm_market_values.source = 'kamerozkan' and excluded.source = 'dcaribou' then tm_market_values.club_name else coalesce(excluded.club_name, tm_market_values.club_name) end,
    payload = case when tm_market_values.source = 'kamerozkan' and excluded.source = 'dcaribou' then tm_market_values.payload else public.tm_merge_jsonb(tm_market_values.payload, excluded.payload) end,
    source = case when tm_market_values.source = 'kamerozkan' and excluded.source = 'dcaribou' then tm_market_values.source else excluded.source end,
    updated_at = now();
end;
$$;

create or replace function public.tm_upsert_appearance(p_row jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.tm_appearances(
    source, source_record_key, tm_id, game_id, played_at, competition_name, club_name, opponent_name,
    appearances, starts, minutes, goals, assists, yellow_cards, red_cards, payload
  ) values (
    p_row->>'source', p_row->>'source_record_key', nullif(p_row->>'tm_id',''), nullif(p_row->>'game_id',''),
    nullif(p_row->>'played_at','')::date, nullif(p_row->>'competition_name',''), nullif(p_row->>'club_name',''),
    nullif(p_row->>'opponent_name',''), nullif(p_row->>'appearances','')::numeric, nullif(p_row->>'starts','')::numeric,
    nullif(p_row->>'minutes','')::numeric, nullif(p_row->>'goals','')::numeric, nullif(p_row->>'assists','')::numeric,
    nullif(p_row->>'yellow_cards','')::numeric, nullif(p_row->>'red_cards','')::numeric,
    public.tm_clean_jsonb(p_row->'payload')
  )
  on conflict (source, source_record_key) do update set
    tm_id = coalesce(excluded.tm_id, tm_appearances.tm_id), game_id = coalesce(excluded.game_id, tm_appearances.game_id),
    played_at = coalesce(excluded.played_at, tm_appearances.played_at),
    competition_name = coalesce(excluded.competition_name, tm_appearances.competition_name),
    club_name = coalesce(excluded.club_name, tm_appearances.club_name),
    opponent_name = coalesce(excluded.opponent_name, tm_appearances.opponent_name),
    appearances = coalesce(excluded.appearances, tm_appearances.appearances), starts = coalesce(excluded.starts, tm_appearances.starts),
    minutes = coalesce(excluded.minutes, tm_appearances.minutes), goals = coalesce(excluded.goals, tm_appearances.goals),
    assists = coalesce(excluded.assists, tm_appearances.assists), yellow_cards = coalesce(excluded.yellow_cards, tm_appearances.yellow_cards),
    red_cards = coalesce(excluded.red_cards, tm_appearances.red_cards),
    payload = public.tm_merge_jsonb(tm_appearances.payload, excluded.payload), updated_at = now();
end;
$$;

-- Private tables: do not create policies for anon/authenticated. Service role bypasses RLS.
do $$
declare t text;
begin
  foreach t in array array['tm_players','tm_player_season_stats','tm_transfers','tm_market_values','tm_appearances','tm_source_records','tm_sync_runs'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;

revoke all on all sequences in schema public from anon, authenticated;
grant usage, select on all sequences in schema public to service_role;

revoke all on function public.tm_clean_jsonb(jsonb) from public, anon, authenticated;
revoke all on function public.tm_merge_jsonb(jsonb,jsonb) from public, anon, authenticated;
revoke all on function public.tm_upsert_player(text,text,jsonb) from public, anon, authenticated;
revoke all on function public.tm_upsert_source_record(text,text,text,text,jsonb) from public, anon, authenticated;
revoke all on function public.tm_upsert_season_stat(jsonb) from public, anon, authenticated;
revoke all on function public.tm_upsert_transfer(jsonb) from public, anon, authenticated;
revoke all on function public.tm_upsert_market_value(jsonb) from public, anon, authenticated;
revoke all on function public.tm_upsert_appearance(jsonb) from public, anon, authenticated;

grant execute on function public.tm_upsert_player(text,text,jsonb) to service_role;
grant execute on function public.tm_upsert_source_record(text,text,text,text,jsonb) to service_role;
grant execute on function public.tm_upsert_season_stat(jsonb) to service_role;
grant execute on function public.tm_upsert_transfer(jsonb) to service_role;
grant execute on function public.tm_upsert_market_value(jsonb) to service_role;
grant execute on function public.tm_upsert_appearance(jsonb) to service_role;


-- Historical player match records grouped into season/competition/club totals.
-- This view is a fallback when the Felipe API does not have season totals for a player.
create or replace view public.tm_appearance_season_totals as
select
  tm_id,
  case when extract(month from played_at) >= 7 then extract(year from played_at)::integer
       else (extract(year from played_at)::integer - 1) end::text || '/' ||
       right((case when extract(month from played_at) >= 7 then extract(year from played_at)::integer + 1
                   else extract(year from played_at)::integer end)::text, 2) as season_id,
  coalesce(competition_name, '') as competition_name,
  coalesce(club_name, '') as club_name,
  count(*)::integer as appearances,
  sum(coalesce(starts, 0))::integer as starts,
  sum(coalesce(goals, 0))::integer as goals,
  sum(coalesce(assists, 0))::integer as assists,
  sum(coalesce(minutes, 0))::integer as minutes,
  sum(coalesce(yellow_cards, 0))::integer as yellow_cards,
  sum(coalesce(red_cards, 0))::integer as red_cards
from public.tm_appearances
where tm_id is not null and played_at is not null
group by tm_id, season_id, competition_name, club_name;

revoke all on public.tm_appearance_season_totals from anon, authenticated;
grant select on public.tm_appearance_season_totals to service_role;
