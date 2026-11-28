-- Verify migration 014. Run after the main SQL script.
select
  to_regclass('public.tm_club_directory') as club_directory_view,
  to_regclass('public.tm_live_appearance_contributions') as live_appearance_ledger,
  (select count(*) from pg_trigger
   where tgrelid='public.tm_appearances'::regclass
     and tgname='tm_appearances_live_season_rollup'
     and not tgisinternal) as live_rollup_trigger_count,
  (select count(*) from pg_proc
   where pronamespace='public'::regnamespace
     and proname='tm_player_profile_bundle') as profile_bundle_function_count;

select club_id,name,short_name,logo_url
from public.tm_club_directory
where name<>''
order by name
limit 20;

select tm_id,season_id,competition_name,club_name,appearances,goals,assists,updated_at
from public.tm_player_season_stats
where source='live_appearance_rollup'
order by updated_at desc
limit 20;
