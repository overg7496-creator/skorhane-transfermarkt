-- SkorHane profile fallback + normalized injury records.
-- Apply after 001, 002, 003 and 004. Safe to re-run.

begin;

create or replace function public.tm_extract_json_array(p_payload jsonb, p_keys text[])
returns jsonb
language plpgsql
immutable
as $$
declare
  k text;
  nested_key text;
  candidate jsonb;
begin
  if jsonb_typeof(p_payload) = 'array' then
    return p_payload;
  end if;
  if jsonb_typeof(p_payload) <> 'object' then
    return '[]'::jsonb;
  end if;

  foreach k in array coalesce(p_keys, array[]::text[]) loop
    candidate := p_payload -> k;
    if jsonb_typeof(candidate) = 'array' then
      return candidate;
    end if;
    if jsonb_typeof(candidate) = 'object' then
      foreach nested_key in array array[
        'items','data','stats','statistics','playerStats','transfers','history',
        'marketValues','market_value_history','marketValueHistory','valuations',
        'matches','matchHistory','appearances','injuries','injuryHistory','results'
      ] loop
        if jsonb_typeof(candidate -> nested_key) = 'array' then
          return candidate -> nested_key;
        end if;
      end loop;
    end if;
  end loop;
  return '[]'::jsonb;
end;
$$;

create table if not exists public.tm_injuries (
  id bigserial primary key,
  tm_id text not null references public.tm_players(tm_id) on delete cascade,
  source text not null default 'felipeall',
  injury_key text not null,
  injury text,
  from_date text,
  until_date text,
  season text,
  days integer,
  games_missed integer,
  payload jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  unique (tm_id, source, injury_key)
);

create index if not exists tm_injuries_player_date_idx
  on public.tm_injuries (tm_id, from_date desc, id desc);

create or replace function public.tm_replace_player_injuries(
  p_tm_id text,
  p_source text,
  p_rows jsonb
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  item jsonb;
  stable_key text;
  inserted_count integer := 0;
  raw_days text;
  raw_games text;
begin
  if nullif(trim(coalesce(p_tm_id, '')), '') is null then
    raise exception 'tm_replace_player_injuries: p_tm_id boş olamaz';
  end if;
  if jsonb_typeof(coalesce(p_rows, '[]'::jsonb)) <> 'array' then
    raise exception 'tm_replace_player_injuries: p_rows JSON array olmalı';
  end if;

  delete from public.tm_injuries
  where tm_id = p_tm_id and source = coalesce(nullif(p_source, ''), 'felipeall');

  for item in select value from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) as rows(value)
  loop
    stable_key := coalesce(
      nullif(item->>'id', ''),
      nullif(item->>'injuryId', ''),
      nullif(item->>'injury_id', ''),
      encode(digest(item::text, 'sha256'), 'hex')
    );
    raw_days := coalesce(item->>'days', item->>'daysMissed', item->>'durationDays');
    raw_games := coalesce(item->>'games_missed', item->>'gamesMissed', item->>'missedMatches');

    insert into public.tm_injuries(
      tm_id, source, injury_key, injury, from_date, until_date, season,
      days, games_missed, payload
    ) values (
      p_tm_id,
      coalesce(nullif(p_source, ''), 'felipeall'),
      stable_key,
      coalesce(item->>'injury', item->>'reason', item->>'type', item->>'description', item->>'injuryType'),
      coalesce(item->>'from_date', item->>'fromDate', item->>'from', item->>'startDate', item->>'start'),
      coalesce(item->>'until_date', item->>'untilDate', item->>'until', item->>'endDate', item->>'end'),
      coalesce(item->>'season', item->>'seasonName', item->>'season_id'),
      case when raw_days ~ '^[0-9]+$' then raw_days::integer else null end,
      case when raw_games ~ '^[0-9]+$' then raw_games::integer else null end,
      item
    )
    on conflict (tm_id, source, injury_key) do update set
      injury = coalesce(excluded.injury, tm_injuries.injury),
      from_date = coalesce(excluded.from_date, tm_injuries.from_date),
      until_date = coalesce(excluded.until_date, tm_injuries.until_date),
      season = coalesce(excluded.season, tm_injuries.season),
      days = coalesce(excluded.days, tm_injuries.days),
      games_missed = coalesce(excluded.games_missed, tm_injuries.games_missed),
      payload = public.tm_merge_jsonb(tm_injuries.payload, excluded.payload),
      updated_at = now();

    inserted_count := inserted_count + 1;
  end loop;

  return inserted_count;
end;
$$;

-- Backfill normalized rows from snapshots already stored before this migration.
with payloads as (
  select p.tm_id, 'felipeall'::text as source, p.injuries_payload as payload
  from public.tm_players p
  union all
  select r.external_id as tm_id, r.source, r.payload
  from public.tm_source_records r
  where r.record_type = 'player_injuries'
    and nullif(r.external_id, '') is not null
),
rows_to_insert as (
  select
    p.tm_id,
    p.source,
    x.value as item,
    coalesce(
      nullif(x.value->>'id', ''),
      nullif(x.value->>'injuryId', ''),
      nullif(x.value->>'injury_id', ''),
      encode(digest(x.value::text, 'sha256'), 'hex')
    ) as injury_key
  from payloads p
  cross join lateral jsonb_array_elements(
    public.tm_extract_json_array(p.payload, array['injuries','data','items','injuryHistory'])
  ) as x(value)
  where jsonb_typeof(x.value) = 'object'
)
insert into public.tm_injuries(
  tm_id, source, injury_key, injury, from_date, until_date, season, days, games_missed, payload
)
select
  tm_id,
  source,
  injury_key,
  coalesce(item->>'injury', item->>'reason', item->>'type', item->>'description', item->>'injuryType'),
  coalesce(item->>'from_date', item->>'fromDate', item->>'from', item->>'startDate', item->>'start'),
  coalesce(item->>'until_date', item->>'untilDate', item->>'until', item->>'endDate', item->>'end'),
  coalesce(item->>'season', item->>'seasonName', item->>'season_id'),
  case when coalesce(item->>'days', item->>'daysMissed', item->>'durationDays') ~ '^[0-9]+$'
       then coalesce(item->>'days', item->>'daysMissed', item->>'durationDays')::integer else null end,
  case when coalesce(item->>'games_missed', item->>'gamesMissed', item->>'missedMatches') ~ '^[0-9]+$'
       then coalesce(item->>'games_missed', item->>'gamesMissed', item->>'missedMatches')::integer else null end,
  item
from rows_to_insert
on conflict (tm_id, source, injury_key) do update set
  injury = coalesce(excluded.injury, tm_injuries.injury),
  from_date = coalesce(excluded.from_date, tm_injuries.from_date),
  until_date = coalesce(excluded.until_date, tm_injuries.until_date),
  season = coalesce(excluded.season, tm_injuries.season),
  days = coalesce(excluded.days, tm_injuries.days),
  games_missed = coalesce(excluded.games_missed, tm_injuries.games_missed),
  payload = public.tm_merge_jsonb(tm_injuries.payload, excluded.payload),
  updated_at = now();

alter table public.tm_injuries enable row level security;
revoke all on public.tm_injuries from anon, authenticated;
grant all on public.tm_injuries to service_role;

create or replace function public.tm_player_profile_bundle(p_tm_id text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with target_player as (
    select p.*
    from public.tm_players p
    where p.tm_id = p_tm_id
       or (
         regexp_replace(p.tm_id, '[^0-9]', '', 'g') <> ''
         and regexp_replace(p.tm_id, '[^0-9]', '', 'g') =
             regexp_replace(coalesce(p_tm_id, ''), '[^0-9]', '', 'g')
         and (
           select count(*)
           from public.tm_players candidate
           where regexp_replace(candidate.tm_id, '[^0-9]', '', 'g') =
                 regexp_replace(coalesce(p_tm_id, ''), '[^0-9]', '', 'g')
         ) = 1
       )
    order by (p.tm_id = p_tm_id) desc
    limit 1
  ),
  target_id as (
    select tm_id from target_player
  ),
  season_rows as (
    select s.tm_id, s.season_id, s.competition_name, s.club_name,
      s.appearances, s.starts, s.goals, s.assists, s.minutes,
      s.yellow_cards, s.second_yellow_cards, s.red_cards, s.goals_conceded, s.clean_sheets
    from public.tm_player_season_stats s
    where s.tm_id = (select tm_id from target_id)
    union all
    select h.tm_id, h.season_id, h.competition_name, h.club_name,
      h.appearances, h.starts, h.goals, h.assists, h.minutes,
      h.yellow_cards, null::integer, h.red_cards, null::integer, null::integer
    from public.tm_appearance_season_totals h
    where h.tm_id = (select tm_id from target_id)
      and not exists (
        select 1 from public.tm_player_season_stats s
        where s.tm_id = h.tm_id and s.season_id = h.season_id
          and coalesce(s.competition_name, '') = coalesce(h.competition_name, '')
          and coalesce(s.club_name, '') = coalesce(h.club_name, '')
      )
  ),
  distinct_appearances as (
    select distinct on (coalesce(nullif(a.game_id, ''), a.source_record_key))
      a.id, a.game_id, a.played_at, a.competition_name, a.club_name,
      a.opponent_name, a.goals, a.assists, a.minutes, a.payload, a.updated_at,
      coalesce(nullif(a.game_id, ''), a.source_record_key) as match_key
    from public.tm_appearances a
    where a.tm_id = (select tm_id from target_id) and a.played_at is not null
    order by coalesce(nullif(a.game_id, ''), a.source_record_key), a.updated_at desc, a.id desc
  )
  select jsonb_build_object(
    'player', (select to_jsonb(p) from target_player p),
    'source_records', coalesce((
      select jsonb_agg(jsonb_build_object('record_type', r.record_type, 'payload', r.payload, 'fetched_at', r.fetched_at) order by r.fetched_at desc)
      from public.tm_source_records r
      where r.source = 'felipeall' and r.external_id = (select tm_id from target_id)
        and (
          (r.record_key = '' and r.record_type in (
            'player_profile','player_stats','player_transfers','player_market_values',
            'player_injuries','player_absences'
          ))
          or r.record_type = 'current_season_matches'
        )
    ), '[]'::jsonb),
    'season_stats', coalesce((
      select jsonb_agg(to_jsonb(s) order by s.season_id desc, s.competition_name, s.club_name)
      from season_rows s
    ), '[]'::jsonb),
    'transfers', coalesce((
      select jsonb_agg(to_jsonb(t) order by t.transfer_date desc, t.id desc)
      from public.tm_transfers t where t.tm_id = (select tm_id from target_id)
    ), '[]'::jsonb),
    'market_values', coalesce((
      select jsonb_agg(to_jsonb(v) order by v.valuation_date desc, v.id desc)
      from public.tm_market_values v where v.tm_id = (select tm_id from target_id)
    ), '[]'::jsonb),
    'injuries', coalesce((
      select jsonb_agg(jsonb_build_object(
        'injury', i.injury, 'from_date', i.from_date, 'until_date', i.until_date,
        'season', i.season, 'days', i.days, 'games_missed', i.games_missed,
        'payload', i.payload
      ) order by i.from_date desc nulls last, i.id desc)
      from public.tm_injuries i where i.tm_id = (select tm_id from target_id)
    ), '[]'::jsonb),
    'recent_appearances', coalesce((
      select jsonb_agg(to_jsonb(a) - 'updated_at' - 'match_key' order by a.played_at desc, a.id desc)
      from (select * from distinct_appearances order by played_at desc, id desc limit 13) a
    ), '[]'::jsonb)
  );
$$;

create or replace function public.tm_player_data_diagnostic(p_tm_id text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with target_player as (
    select p.*
    from public.tm_players p
    where p.tm_id = p_tm_id
       or (
         regexp_replace(p.tm_id, '[^0-9]', '', 'g') <> ''
         and regexp_replace(p.tm_id, '[^0-9]', '', 'g') =
             regexp_replace(coalesce(p_tm_id, ''), '[^0-9]', '', 'g')
         and (
           select count(*)
           from public.tm_players candidate
           where regexp_replace(candidate.tm_id, '[^0-9]', '', 'g') =
                 regexp_replace(coalesce(p_tm_id, ''), '[^0-9]', '', 'g')
         ) = 1
       )
    order by (p.tm_id = p_tm_id) desc
    limit 1
  ),
  target_id as (
    select tm_id from target_player
  )
  select jsonb_build_object(
    'requested_tm_id', p_tm_id,
    'resolved_tm_id', (select tm_id from target_id),
    'exact_player_rows', (
      select count(*) from public.tm_players p where p.tm_id = p_tm_id
    ),
    'normalized_candidate_match_count', (
      select count(*) from public.tm_players p
      where regexp_replace(p.tm_id, '[^0-9]', '', 'g') <> ''
        and regexp_replace(p.tm_id, '[^0-9]', '', 'g') =
            regexp_replace(coalesce(p_tm_id, ''), '[^0-9]', '', 'g')
    ),
    'numeric_id_format_matches', coalesce((
      select jsonb_agg(p.tm_id order by p.tm_id)
      from public.tm_players p
      where regexp_replace(p.tm_id, '[^0-9]', '', 'g') =
            regexp_replace(coalesce(p_tm_id, ''), '[^0-9]', '', 'g')
        and p.tm_id <> p_tm_id
    ), '[]'::jsonb),
    'appearances_rows', (
      select count(*) from public.tm_appearances a where a.tm_id = (select tm_id from target_id)
    ),
    'appearances_with_date_rows', (
      select count(*) from public.tm_appearances a
      where a.tm_id = (select tm_id from target_id) and a.played_at is not null
    ),
    'season_stats_rows', (
      select count(*) from public.tm_player_season_stats s where s.tm_id = (select tm_id from target_id)
    ),
    'market_value_rows', (
      select count(*) from public.tm_market_values v where v.tm_id = (select tm_id from target_id)
    ),
    'transfer_rows', (
      select count(*) from public.tm_transfers t where t.tm_id = (select tm_id from target_id)
    ),
    'injury_rows', (
      select count(*) from public.tm_injuries i where i.tm_id = (select tm_id from target_id)
    ),
    'raw_payload_counts', coalesce((
      select jsonb_build_object(
        'stats_payload', jsonb_array_length(public.tm_extract_json_array(p.stats_payload, array['stats','statistics','playerStats','data','items'])),
        'current_season_matches', jsonb_array_length(public.tm_extract_json_array(p.current_season_payload, array['matches','matchHistory','data','items'])),
        'market_value_payload', jsonb_array_length(public.tm_extract_json_array(p.market_value_payload, array[
          'marketValueHistory','market_value_history','history','marketValues','valuations','items','data'
        ])),
        'transfers_payload', jsonb_array_length(public.tm_extract_json_array(p.transfers_payload, array['transfers','history','items','data'])),
        'injuries_payload', jsonb_array_length(public.tm_extract_json_array(p.injuries_payload, array['injuries','data','items','injuryHistory']))
      )
      from target_player p
    ), '{}'::jsonb),
    'source_records', coalesce((
      select jsonb_object_agg(x.record_type, x.rows)
      from (
        select r.record_type, count(*)::integer as rows
        from public.tm_source_records r
        where r.external_id = (select tm_id from target_id)
          and r.record_type in (
            'player_stats','player_transfers','player_market_values','player_injuries',
            'player_profile','current_season_matches'
          )
        group by r.record_type
      ) x
    ), '{}'::jsonb),
    'last_felipe_synced_at', (
      select p.last_felipe_synced_at from target_player p
    )
  );
$$;

revoke all on function public.tm_extract_json_array(jsonb,text[]) from public, anon, authenticated;
revoke all on function public.tm_replace_player_injuries(text,text,jsonb) from public, anon, authenticated;
revoke all on function public.tm_player_profile_bundle(text) from public, anon, authenticated;
revoke all on function public.tm_player_data_diagnostic(text) from public, anon, authenticated;

grant execute on function public.tm_extract_json_array(jsonb,text[]) to service_role;
grant execute on function public.tm_replace_player_injuries(text,text,jsonb) to service_role;
grant execute on function public.tm_player_profile_bundle(text) to service_role;
grant execute on function public.tm_player_data_diagnostic(text) to service_role;

commit;
