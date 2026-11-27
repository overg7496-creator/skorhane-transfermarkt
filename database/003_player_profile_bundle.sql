-- SkorHane player profile: one Supabase round-trip for all history tabs.
-- Apply after 001_transfermarkt_schema.sql and 002_team_seasons_and_leaderboards.sql.
create index if not exists tm_transfers_player_date_idx on public.tm_transfers (tm_id, transfer_date desc);
create index if not exists tm_market_values_player_date_idx on public.tm_market_values (tm_id, valuation_date desc);
create index if not exists tm_appearances_player_date_cover_idx on public.tm_appearances (tm_id, played_at desc, updated_at desc);

create or replace function public.tm_player_profile_bundle(p_tm_id text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with season_rows as (
    select s.tm_id, s.season_id, s.competition_name, s.club_name,
      s.appearances, s.starts, s.goals, s.assists, s.minutes,
      s.yellow_cards, s.second_yellow_cards, s.red_cards, s.goals_conceded, s.clean_sheets
    from public.tm_player_season_stats s
    where s.tm_id = p_tm_id
    union all
    select h.tm_id, h.season_id, h.competition_name, h.club_name,
      h.appearances, h.starts, h.goals, h.assists, h.minutes,
      h.yellow_cards, null::integer, h.red_cards, null::integer, null::integer
    from public.tm_appearance_season_totals h
    where h.tm_id = p_tm_id
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
    where a.tm_id = p_tm_id and a.played_at is not null
    order by coalesce(nullif(a.game_id, ''), a.source_record_key), a.updated_at desc, a.id desc
  )
  select jsonb_build_object(
    'player', (select to_jsonb(p) from public.tm_players p where p.tm_id = p_tm_id limit 1),
    'source_records', coalesce((
      select jsonb_agg(jsonb_build_object('record_type', r.record_type, 'payload', r.payload, 'fetched_at', r.fetched_at) order by r.fetched_at desc)
      from public.tm_source_records r
      where r.source = 'felipeall' and r.external_id = p_tm_id and r.record_key = ''
        and r.record_type in ('player_profile','player_stats','player_transfers','player_market_values','player_injuries')
    ), '[]'::jsonb),
    'season_stats', coalesce((
      select jsonb_agg(to_jsonb(s) order by s.season_id desc, s.competition_name, s.club_name) from season_rows s
    ), '[]'::jsonb),
    'transfers', coalesce((
      select jsonb_agg(to_jsonb(t) order by t.transfer_date desc, t.id desc)
      from public.tm_transfers t where t.tm_id = p_tm_id
    ), '[]'::jsonb),
    'market_values', coalesce((
      select jsonb_agg(to_jsonb(v) order by v.valuation_date desc, v.id desc)
      from public.tm_market_values v where v.tm_id = p_tm_id
    ), '[]'::jsonb),
    'recent_appearances', coalesce((
      select jsonb_agg(to_jsonb(a) - 'updated_at' - 'match_key' order by a.played_at desc, a.id desc)
      from (select * from distinct_appearances order by played_at desc, id desc limit 13) a
    ), '[]'::jsonb)
  );
$$;

revoke all on function public.tm_player_profile_bundle(text) from public, anon, authenticated;
grant execute on function public.tm_player_profile_bundle(text) to service_role;
