-- SkorHane player history preseed verification.
-- Change only the target Transfermarkt ID below (Victor Osimhen example: 401923).
with target as (
  select '401923'::text as tm_id
),
counts as (
  select
    'tm_players'::text as table_name,
    count(*)::bigint as total_rows,
    count(*) filter (where p.tm_id = t.tm_id)::bigint as player_rows,
    count(*) filter (
      where p.tm_id = t.tm_id and p.updated_at >= now() - interval '24 hours'
    )::bigint as player_rows_updated_last_24h
  from public.tm_players p cross join target t

  union all
  select 'tm_player_season_stats', count(*)::bigint,
    count(*) filter (where s.tm_id = t.tm_id)::bigint,
    count(*) filter (where s.tm_id = t.tm_id and s.updated_at >= now() - interval '24 hours')::bigint
  from public.tm_player_season_stats s cross join target t

  union all
  select 'tm_appearances', count(*)::bigint,
    count(*) filter (where a.tm_id = t.tm_id)::bigint,
    count(*) filter (where a.tm_id = t.tm_id and a.updated_at >= now() - interval '24 hours')::bigint
  from public.tm_appearances a cross join target t

  union all
  select 'tm_transfers', count(*)::bigint,
    count(*) filter (where x.tm_id = t.tm_id)::bigint,
    count(*) filter (where x.tm_id = t.tm_id and x.updated_at >= now() - interval '24 hours')::bigint
  from public.tm_transfers x cross join target t

  union all
  select 'tm_market_values', count(*)::bigint,
    count(*) filter (where v.tm_id = t.tm_id)::bigint,
    count(*) filter (where v.tm_id = t.tm_id and v.updated_at >= now() - interval '24 hours')::bigint
  from public.tm_market_values v cross join target t

  union all
  select 'tm_injuries', count(*)::bigint,
    count(*) filter (where i.tm_id = t.tm_id)::bigint,
    count(*) filter (where i.tm_id = t.tm_id and i.updated_at >= now() - interval '24 hours')::bigint
  from public.tm_injuries i cross join target t

  union all
  select 'tm_source_records:detail_snapshots', count(*)::bigint,
    count(*) filter (where r.external_id = t.tm_id)::bigint,
    count(*) filter (
      where r.external_id = t.tm_id and r.fetched_at >= now() - interval '24 hours'
    )::bigint
  from public.tm_source_records r cross join target t
  where r.source = 'felipeall'
    and r.record_type in (
      'player_profile', 'player_stats', 'player_transfers',
      'player_market_values', 'player_injuries', 'player_absences',
      'current_season_matches'
    )

  union all
  select 'tm_source_records:history_checkpoints', count(*)::bigint,
    count(*) filter (where r.external_id = t.tm_id)::bigint,
    count(*) filter (
      where r.external_id = t.tm_id and r.fetched_at >= now() - interval '24 hours'
    )::bigint
  from public.tm_source_records r cross join target t
  where r.source = 'felipeall'
    and r.record_type = 'history_appearance_checkpoint'
)
select table_name, total_rows, player_rows, player_rows_updated_last_24h
from counts
order by table_name;
