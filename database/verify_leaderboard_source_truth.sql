-- Krallık doğrulaması. Lig/sezonu kendi seçimine göre değiştir.
with params as (
  select 'TR1'::text as competition_id, '2026'::text as season_id
),
goals as (
  select l.* from public.tm_league_goal_leaders l
  cross join params p
  where l.competition_id = p.competition_id and l.season_id = p.season_id
),
assists as (
  select l.* from public.tm_league_assist_leaders l
  cross join params p
  where l.competition_id = p.competition_id and l.season_id = p.season_id
)
select
  (select count(*) from goals) as gol_listesi_satiri,
  (select count(distinct tm_id) from goals) as benzersiz_golcu,
  (select count(*) from (
     select tm_id from goals group by tm_id having count(*) > 1
   ) d) as mukerrer_golcu_grubu,
  (select jsonb_agg(jsonb_build_object(
     'sira', x.leader_rank, 'oyuncu', x.player_name, 'tm_id', x.tm_id, 'gol', x.goals
   ) order by x.leader_rank, x.goals desc, x.player_name)
   from (select * from goals order by leader_rank, goals desc, player_name limit 10) x
  ) as ilk_10_gol,
  (select count(*) from assists) as asist_listesi_satiri,
  (select count(distinct tm_id) from assists) as benzersiz_asistci,
  (select count(*) from (
     select tm_id from assists group by tm_id having count(*) > 1
   ) d) as mukerrer_asistci_grubu,
  (select jsonb_agg(jsonb_build_object(
     'sira', x.leader_rank, 'oyuncu', x.player_name, 'tm_id', x.tm_id, 'asist', x.assists
   ) order by x.leader_rank, x.assists desc, x.player_name)
   from (select * from assists order by leader_rank, assists desc, player_name limit 10) x
  ) as ilk_10_asist;
