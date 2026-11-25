// Cloudflare Worker: ESPN ve SportScore'dan maç verisi çeker, kısa süre önbellekler.
// İsteğe bağlı gizli değişkenler: PITCH_API_KEY (gol/asist sezon toplaması), ODDSPAPI_API_KEY (İddaa maç önü oranları ve maç önü tarihsel arşivi; alternatif ad: ODDSPAPI_KEY), SPORTSCORE_KEY, API_FOOTBALL_KEY (alias: APISPORTS_KEY veya API_KEY), SOCCER_DATA_KEY, THESPORTSDB_API_KEY, FOOTBALL_DATA_TOKEN.
//
// Adresler:
//   /fixtures?date=YYYY-MM-DD&part=N -> o günün maç listesi (N: lig grubu, 0..PARTS-1; cevapta `parts` toplam sayıyı verir)
//   /fixtures?date=YYYY-MM-DD&part=s -> SportScore'un o günkü maçları
//   /match?id=e:LIGKODU:MACNO  (ESPN)  veya  s:SLUG:MACNO (SportScore) -> maç detayı
//   /standings?league=eng.1        -> puan durumu (API-Football league id fallback: af-<id>)
//   /search?q=messi                -> oyuncu/takım arama (SportScore)
//   /player?slug=lionel-messi      -> oyuncu bilgisi ve sezon istatistikleri (SportScore)
//   /pitch-leaders?code=eng.1&season=2026&offset=0 -> PitchAPI lig gol/asist sıralaması
//   /pitch-player-resolve?name=...&team=...&code=tur.1&season=2025/2026&offset=0 -> PitchAPI oyuncu ID eşleştirme
//   /pitch-player-career?player=p_x&code=eng.1&season=2025/2026&offset=0 -> PitchAPI oyuncu sezon kariyeri

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};
const json = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8", ...extra },
  });

const SITE = "https://site.api.espn.com/apis/site/v2/sports/soccer/";
const SITE_V2 = "https://site.api.espn.com/apis/v2/sports/soccer/";

// [ESPN kodu, sıralama için lig no (önemli ligler) veya null, Türkçe ad, ülke]
// Cloudflare ücretsiz plan: istek başına en fazla 50 alt istek. Bu yüzden liste PART_SIZE'lık parçalara bölünür
// ve sayfa parçaları ayrı ayrı (paralel) ister. Olmayan bir ESPN kodu sadece boş döner, zararı yoktur.
const PART_SIZE = 45;
const LEAGUES = [
  // --- Türkiye ---
  ["tur.1",203,"Süper Lig","Türkiye"],["tur.2",204,"TFF 1. Lig","Türkiye"],["tur.cup",206,"Türkiye Kupası","Türkiye"],["tur.3",null,"TFF 2. Lig","Türkiye"],
  // --- Büyük 5 lig ve kupaları ---
  ["eng.1",39,"Premier Lig","İngiltere"],["esp.1",140,"La Liga","İspanya"],["ger.1",78,"Bundesliga","Almanya"],["ita.1",135,"Serie A","İtalya"],["fra.1",61,"Ligue 1","Fransa"],
  ["uefa.champions",2,"UEFA Şampiyonlar Ligi","Avrupa"],["uefa.europa",3,"UEFA Avrupa Ligi","Avrupa"],["uefa.europa.conf",848,"UEFA Konferans Ligi","Avrupa"],
  ["eng.2",40,"Championship","İngiltere"],["eng.fa",45,"FA Cup","İngiltere"],["eng.league_cup",48,"Lig Kupası","İngiltere"],
  ["esp.copa_del_rey",143,"Kral Kupası","İspanya"],["ita.coppa_italia",137,"İtalya Kupası","İtalya"],["ger.dfb_pokal",81,"DFB Pokal","Almanya"],
  ["ned.1",88,"Eredivisie","Hollanda"],["por.1",94,"Liga Portugal","Portekiz"],["usa.1",253,"MLS","ABD"],["ksa.1",307,"Suudi Pro Lig","S. Arabistan"],
  ["bra.1",71,"Brezilya Serie A","Brezilya"],["arg.1",128,"Arjantin Ligi","Arjantin"],
  ["uefa.nations",5,"UEFA Uluslar Ligi","Avrupa"],["uefa.euro",4,"Avrupa Şampiyonası","Avrupa"],["fifa.world",1,"Dünya Kupası","Dünya"],
  ["fifa.worldq.uefa",null,"Dünya Kupası Elemeleri (UEFA)","Avrupa"],["fifa.friendly",null,"Hazırlık Maçları (Milli)","Dünya"],
  ["uefa.euroq",null,"Avrupa Şampiyonası Elemeleri","Avrupa"],["uefa.super_cup",null,"UEFA Süper Kupa","Avrupa"],["fifa.cwc",null,"Kulüpler Dünya Kupası","Dünya"],
  ["fifa.worldq.conmebol",null,"Dünya Kupası Elemeleri (G. Amerika)","G. Amerika"],["fifa.worldq.concacaf",null,"Dünya Kupası Elemeleri (K. Amerika)","K. Amerika"],
  ["fifa.worldq.afc",null,"Dünya Kupası Elemeleri (Asya)","Asya"],["fifa.worldq.caf",null,"Dünya Kupası Elemeleri (Afrika)","Afrika"],
  ["fifa.worldq.ofc",null,"Dünya Kupası Elemeleri (Okyanusya)","Okyanusya"],
  // --- İngiltere / İskoçya / İrlanda / Galler ---
  ["eng.3",null,"League One","İngiltere"],["eng.4",null,"League Two","İngiltere"],["eng.5",null,"National League","İngiltere"],["eng.trophy",null,"EFL Trophy","İngiltere"],
  ["sco.1",null,"Premiership","İskoçya"],["sco.2",null,"Championship","İskoçya"],["sco.tennents",null,"İskoçya Kupası","İskoçya"],["sco.cis",null,"İskoçya Lig Kupası","İskoçya"],
  ["irl.1",null,"Premier Division","İrlanda"],["nir.1",null,"Premiership","K. İrlanda"],["wal.1",null,"Cymru Premier","Galler"],
  // --- İspanya / İtalya / Almanya / Fransa alt ligler ---
  ["esp.2",null,"La Liga 2","İspanya"],["esp.super_cup",null,"İspanya Süper Kupa","İspanya"],
  ["ita.2",null,"Serie B","İtalya"],["ita.super_cup",null,"İtalya Süper Kupa","İtalya"],
  ["ger.2",null,"2. Bundesliga","Almanya"],["ger.3",null,"3. Lig","Almanya"],["ger.super_cup",null,"Almanya Süper Kupa","Almanya"],
  ["fra.2",null,"Ligue 2","Fransa"],["fra.coupe_de_france",null,"Fransa Kupası","Fransa"],["fra.super_cup",null,"Fransa Süper Kupa","Fransa"],
  // --- Diğer Avrupa ---
  ["ned.2",null,"Eerste Divisie","Hollanda"],["ned.cup",null,"Hollanda Kupası","Hollanda"],
  ["por.2",null,"Liga Portugal 2","Portekiz"],["por.taca.portugal",null,"Portekiz Kupası","Portekiz"],
  ["bel.1",null,"Pro Lig","Belçika"],["bel.2",null,"Challenger Pro","Belçika"],
  ["gre.1",null,"Süper Lig","Yunanistan"],["gre.2",null,"Yunanistan 2. Lig","Yunanistan"],
  ["rus.1",null,"Premier Lig","Rusya"],["rus.2",null,"Rusya 1. Lig","Rusya"],["ukr.1",null,"Premier Lig","Ukrayna"],
  ["aut.1",null,"Bundesliga","Avusturya"],["sui.1",null,"Süper Lig","İsviçre"],
  ["den.1",null,"Superliga","Danimarka"],["swe.1",null,"Allsvenskan","İsveç"],["swe.2",null,"Superettan","İsveç"],["nor.1",null,"Eliteserien","Norveç"],["nor.2",null,"OBOS-ligaen","Norveç"],
  ["fin.1",null,"Veikkausliiga","Finlandiya"],["isl.1",null,"Besta deild","İzlanda"],
  ["pol.1",null,"Ekstraklasa","Polonya"],["cze.1",null,"Birinci Lig","Çekya"],["cro.1",null,"HNL","Hırvatistan"],["srb.1",null,"Süper Lig","Sırbistan"],
  ["rou.1",null,"Liga 1","Romanya"],["hun.1",null,"NB I","Macaristan"],["bul.1",null,"Birinci Lig","Bulgaristan"],["svk.1",null,"Süper Lig","Slovakya"],
  ["svn.1",null,"Prva Liga","Slovenya"],["bih.1",null,"Premijer Liga","Bosna Hersek"],["alb.1",null,"Süper Lig","Arnavutluk"],["mkd.1",null,"Birinci Lig","K. Makedonya"],
  ["cyp.1",null,"Birinci Lig","Kıbrıs"],["isr.1",null,"Ligat ha'Al","İsrail"],["geo.1",null,"Erovnuli Liga","Gürcistan"],["aze.1",null,"Premier Lig","Azerbaycan"],
  ["arm.1",null,"Premier Lig","Ermenistan"],["kaz.1",null,"Premier Lig","Kazakistan"],["lva.1",null,"Virsliga","Letonya"],["ltu.1",null,"A Lyga","Litvanya"],["est.1",null,"Meistriliiga","Estonya"],
  ["mlt.1",null,"Premier Lig","Malta"],["lux.1",null,"Ulusal Lig","Lüksemburg"],
  // --- Amerika ---
  ["usa.nwsl",null,"NWSL (Kadınlar)","ABD"],["usa.open",null,"ABD Open Cup","ABD"],["usa.usl.1",null,"USL Championship","ABD"],["usa.mls_next_pro",null,"MLS Next Pro","ABD"],["can.1",null,"Kanada Premier Lig","Kanada"],
  ["mex.1",null,"Liga MX","Meksika"],["mex.2",null,"Liga de Expansión MX","Meksika"],
  ["bra.2",null,"Brezilya Serie B","Brezilya"],["bra.copa_do_brazil",null,"Brezilya Kupası","Brezilya"],
  ["arg.2",null,"Arjantin 2. Lig","Arjantin"],["arg.copa",null,"Arjantin Kupası","Arjantin"],
  ["col.1",null,"Primera A","Kolombiya"],["chi.1",null,"Primera División","Şili"],["uru.1",null,"Primera División","Uruguay"],["par.1",null,"Primera División","Paraguay"],
  ["per.1",null,"Liga 1","Peru"],["ecu.1",null,"Serie A","Ekvador"],["ven.1",null,"Primera División","Venezuela"],["bol.1",null,"Primera División","Bolivya"],
  ["crc.1",null,"Primera División","Kosta Rika"],["hon.1",null,"Liga Nacional","Honduras"],["gua.1",null,"Liga Nacional","Guatemala"],["slv.1",null,"Primera División","El Salvador"],
  ["conmebol.libertadores",null,"Libertadores Kupası","G. Amerika"],["conmebol.sudamericana",null,"Sudamericana Kupası","G. Amerika"],
  ["conmebol.america",null,"Copa América","G. Amerika"],["concacaf.champions",null,"CONCACAF Şampiyonlar Kupası","K. Amerika"],
  ["concacaf.nations.league",null,"CONCACAF Uluslar Ligi","K. Amerika"],["concacaf.gold",null,"Altın Kupa","K. Amerika"],
  // --- Asya / Okyanusya ---
  ["jpn.1",null,"J1 League","Japonya"],["jpn.2",null,"J2 League","Japonya"],["kor.1",null,"K League 1","G. Kore"],["chn.1",null,"Süper Lig","Çin"],
  ["aus.1",null,"A-League","Avustralya"],["ind.1",null,"Hindistan Süper Lig","Hindistan"],["tha.1",null,"Tayland Ligi","Tayland"],["idn.1",null,"Liga 1","Endonezya"],
  ["mys.1",null,"Süper Lig","Malezya"],["sgp.1",null,"Premier Lig","Singapur"],["vie.1",null,"V.League 1","Vietnam"],
  ["uae.1",null,"Pro Lig","BAE"],["qat.1",null,"Yıldızlar Ligi","Katar"],["irn.1",null,"Pro Lig","İran"],["irq.1",null,"Irak Ligi","Irak"],
  ["afc.champions",null,"AFC Şampiyonlar Ligi","Asya"],["afc.asian.cup",null,"Asya Kupası","Asya"],
  // --- Afrika ---
  ["rsa.1",null,"Premier Soccer League","G. Afrika"],["egy.1",null,"Mısır Premier Lig","Mısır"],["mar.1",null,"Botola Pro","Fas"],["tun.1",null,"Ligue 1","Tunus"],
  ["alg.1",null,"Ligue 1","Cezayir"],["nga.1",null,"Premier Lig","Nijerya"],["caf.nations",null,"Afrika Uluslar Kupası","Afrika"],["caf.champions",null,"CAF Şampiyonlar Ligi","Afrika"],
];
const PARTS = Math.ceil(LEAGUES.length / PART_SIZE);
const META = Object.fromEntries(LEAGUES.map((m) => [m[0], m]));
const AF_LEAGUE_TO_ESPN = Object.fromEntries(LEAGUES.filter(m => m[1] != null).map(m => [String(m[1]), m[0]]));
function espnCodeFromAfLeague(id) { return AF_LEAGUE_TO_ESPN[String(id || "")] || ""; }
function recentSeasonYears(count = 20) {
  const start = seasonStartYear();
  return Array.from({ length: count }, (_, i) => start - i);
}

const addDays = (d, n) => new Date(Date.parse(d + "T12:00:00Z") + n * 86400e3).toISOString().slice(0, 10);
const istDay = (iso) => new Date(Date.parse(iso) + 3 * 3600e3).toISOString().slice(0, 10);
const digits = (s) => String(s == null ? "" : s).replace(/[^0-9+]/g, "");

// ---------- Bellek önbelleği ----------
const MEM = new Map();
const INFLIGHT = new Map();
async function cached(key, producer) {
  const hit = MEM.get(key);
  if (hit && Date.now() - hit.at < hit.ttl) return { body: hit.body, state: "HIT" };
  if (!INFLIGHT.has(key)) {
    INFLIGHT.set(
      key,
      (async () => {
        const out = await producer(); // { body, ttl (saniye) }
        MEM.set(key, { body: out.body, at: Date.now(), ttl: out.ttl * 1000 });
        if (MEM.size > 300) MEM.delete(MEM.keys().next().value);
        return out.body;
      })().finally(() => INFLIGHT.delete(key))
    );
  }
  try {
    return { body: await INFLIGHT.get(key), state: "MISS" };
  } catch (e) {
    if (hit) return { body: hit.body, state: "STALE" };
    throw e;
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getJSON(url, tries = 2) {
  // Geçici hatalarda (429 / 5xx) kısa beklemeyle tekrar dener.
  for (let i = 0; ; i++) {
    try { return await getJSON1(url); }
    catch (e) { if (i >= tries - 1 || !(/fly\.dev|onrender|transfermarkt|thesportsdb/.test(url) ? /HTTP (429|5\d\d)/ : /HTTP 5\d\d/).test(String(e.message))) throw e; await sleep(/fly\.dev|onrender|transfermarkt|thesportsdb/.test(url) ? 1500 : 400); }
  }
}
const BROWSER_H = { Accept: "application/json, text/plain, */*", "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36", Referer: "https://www.espn.com/", Origin: "https://www.espn.com" };
async function getJSON1(url) {
  // ESPN 403 verirse: diğer ESPN sunucusu, sonra tarayıcı başlıklarıyla denenir (günlük skor listesinde yapılmaz: istek sınırı).
  const attempts = [[url, { Accept: "application/json" }]];
  if (url.includes("//site.api.espn.com/") || url.includes("//site.web.api.espn.com/")) {
    const alt = url.includes("//site.api.espn.com/") ? url.replace("//site.api.espn.com/", "//site.web.api.espn.com/") : url.replace("//site.web.api.espn.com/", "//site.api.espn.com/");
    attempts.push([alt, { Accept: "application/json" }]);
    if (!url.includes("/scoreboard")) attempts.push([url, BROWSER_H]);
  }
  let last;
  for (const [u, hd] of attempts) {
    try {
      const h = /(?:wikipedia|wikimedia)\.org/i.test(u) ? { Accept: "application/json", "User-Agent": "CanliSkor/1.0 (football scores app; contact via workers.dev)", "Api-User-Agent": "CanliSkor/1.0" } : hd;
      const r = await fetch(u, { signal: AbortSignal.timeout(/fly\.dev|onrender|transfermarkt|understat/.test(u) ? 15000 : 6000), headers: h });
      if (r.ok) return r.json();
      last = new Error((u.includes("espn") ? "ESPN" : "Sunucu") + " HTTP " + r.status);
    } catch (e) { last = e && e.name === "TimeoutError" ? new Error("Sunucu HTTP 504 (zaman aşımı)") : e; }
  }
  throw last;
}

// ---------- Durum çözümleme ----------
function statusOf(st) {
  const t = (st && st.type) || {}, n = t.name || "";
  let short = "NS";
  if (t.state === "in") short = /HALFTIME/.test(n) ? "HT" : /SECOND[_ ]?HALF|2ND[_ ]?HALF/.test(n) ? "2H" : /EXTRA[_ ]?TIME|OVERTIME/.test(n) ? "ET" : /PENALT|SHOOTOUT/.test(n) ? "P" : "1H";
  else if (t.state === "post") short = /POSTPONED/.test(n) ? "PST" : /CANCEL/.test(n) ? "CANC" : /ABANDON/.test(n) ? "ABD" : /PEN/.test(n) ? "PEN" : /AET|EXTRA/.test(n) ? "AET" : "FT";
  else if (/POSTPONED/.test(n)) short = "PST";
  else if (/CANCEL/.test(n)) short = "CANC";
  return { short, elapsed: t.state === "in" ? elapsedMinutes(st && (st.displayClock || st.clock)) : null, state: t.state };
}
function elapsedMinutes(value) {
  const s = String(value == null ? "" : value).trim();
  const m = s.match(/(\d+)(?::\d{1,2})?\s*'?\s*(?:\+\s*(\d+))?/);
  return m ? String(Number(m[1]) + (m[2] ? Number(m[2]) : 0)) : null;
}
const scoreOf = (c, state) => (state === "pre" || c.score === undefined || c.score === "" || c.score === null ? null : Number(c.score && c.score.displayValue !== undefined ? c.score.displayValue : c.score));

// ---------- Maç listesi ----------
function listMatch(code, ev) {
  const meta = META[code];
  const c = ev.competitions && ev.competitions[0];
  if (!c) return null;
  const h = c.competitors.find((x) => x.homeAway === "home"), a = c.competitors.find((x) => x.homeAway === "away");
  if (!h || !a) return null;
  const s = statusOf(ev.status);
  const weekValues = [ev.week, c.week, ev.round, c.round, ...(Array.isArray(c.notes) ? c.notes : []), ...(Array.isArray(ev.notes) ? ev.notes : [])]
    .map(x => x && typeof x === "object" ? (x.displayName || x.name || x.headline || x.text || x.number || "") : x)
    .filter(x => x !== undefined && x !== null && String(x).trim());
  const weekValue = weekValues.find(x => /^\d+$/.test(String(x).trim()) || /(?:week|matchday|round|hafta|regular season|league stage).*\d+|\d+.*(?:week|matchday|round|hafta)/i.test(String(x)))
    || weekValues.find(x => /week|matchday|round|hafta/i.test(String(x))) || weekValues[0];
  const round = weekValue == null ? "" : (/^\d+$/.test(String(weekValue).trim()) ? "Hafta " + String(weekValue).trim() : String(weekValue).trim());
  const matchdayRaw = weekValues.find(x => /^\d+$/.test(String(x).trim())) || "";
  return {
    matchday: matchdayRaw ? Number(matchdayRaw) : null,
    fixture: { id: "e:" + code + ":" + ev.id, date: ev.date, status: { short: s.short, elapsed: s.elapsed } },
    league: { id: meta[1] || "e:" + code, code, name: meta[2], country: meta[3], round, logo: "" },
    teams: {
      home: { id: h.team.id, name: h.team.displayName || h.team.name, logo: h.team.logo || "" },
      away: { id: a.team.id, name: a.team.displayName || a.team.name, logo: a.team.logo || "" },
    },
    goals: { home: scoreOf(h, s.state), away: scoreOf(a, s.state) },
  };
}
async function dayList(date, part) {
  // ESPN günleri ABD saatine göre keser: önceki ve sonraki günü de alıp İstanbul gününe göre süzüyoruz.
  // Aralık reddedilirse (HTTP 400) yalnızca o günü isteriz.
  const slice = LEAGUES.slice(part * PART_SIZE, (part + 1) * PART_SIZE);
  if (!slice.length) return [];
  const modes = [addDays(date, -1).replace(/-/g, "") + "-" + addDays(date, 1).replace(/-/g, ""), date.replace(/-/g, "")];
  const one = async (code, dates) => {
    const j = await getJSON(SITE + code + "/scoreboard?dates=" + dates);
    return (j.events || []).map((e) => { try { return listMatch(code, e); } catch (_) { return null; } })
      .filter((m) => m && istDay(m.fixture.date) === date);
  };
  // Hangi sorgu biçiminin çalıştığını bu parçanın ilk ligi ile yokla (404 = o lig yok, sorun değil)
  let dates = null, first = [], firstErr = "";
  for (const m of modes) {
    try { first = await one(slice[0][0], m); dates = m; break; }
    catch (e) {
      if (/HTTP 404/.test(e.message)) { dates = m; break; }
      if (!firstErr) firstErr = e.message;
    }
  }
  if (!dates) throw new Error("ESPN'e ulaşılamadı (" + firstErr + ")");
  const per = await Promise.all(
    slice.map(async (m, i) => { if (i === 0) return first; try { return await one(m[0], dates); } catch (_) { return []; } })
  );
  return per.flat();
}

// ---------- Maç detayı ----------
const STAT_TR = {
  possessionPct: "Topa Sahip Olma", totalShots: "Toplam Şut", shotsOnTarget: "İsabetli Şut", blockedShots: "Engellenen Şut",
  wonCorners: "Korner", foulsCommitted: "Faul", yellowCards: "Sarı Kart", redCards: "Kırmızı Kart", offsides: "Ofsayt",
  saves: "Kurtarış", totalPasses: "Toplam Pas", accuratePasses: "İsabetli Pas", passPct: "Pas Başarısı",
  totalCrosses: "Orta", accurateCrosses: "İsabetli Orta", totalTackles: "Top Kapma", interceptions: "Top Çalma",
  totalClearance: "Uzaklaştırma", penaltyKickGoals: "Penaltı Golü", shotPct: "Şut İsabeti",
  "Ball Possession": "Topa Sahip Olma", possession: "Topa Sahip Olma", "Total Shots": "Toplam Şut", shots: "Toplam Şut",
  "Shots on Goal": "İsabetli Şut", "Shots on Target": "İsabetli Şut", "Shots off Goal": "İsabetsiz Şut", "Shots off Target": "İsabetsiz Şut",
  "Blocked Shots": "Engellenen Şut", "Shots insidebox": "Ceza Sahası İçi Şut", "Shots inside Box": "Ceza Sahası İçi Şut", "Shots outsidebox": "Ceza Sahası Dışı Şut", "Shots outside Box": "Ceza Sahası Dışı Şut",
  "Corner Kicks": "Korner", corners: "Korner", fouls: "Faul", Offsides: "Ofsayt", "Yellow Cards": "Sarı Kart", "Red Cards": "Kırmızı Kart",
  "Goalkeeper Saves": "Kaleci Kurtarışı", "Total passes": "Toplam Pas", "Passes accurate": "İsabetli Pas", "Passes %": "Pas Başarısı",
  "Total Crosses": "Orta", "Accurate Crosses": "İsabetli Orta", Tackles: "Top Kapma", "Total Tackles": "Top Kapma", Interceptions: "Top Çalma",
  "Total Clearances": "Uzaklaştırma", Clearances: "Uzaklaştırma", "Penalty Goals": "Penaltı Golü", "Expected Goals": "Beklenen Gol (xG)",
  "Big Chances": "Net Gol Fırsatı", "Big Chances Created": "Yaratılan Net Gol Fırsatı", "Total Duels Won": "Kazanılan İkili Mücadele",
  "Duels Won": "Kazanılan İkili Mücadele", "Long Balls": "Uzun Pas", "Accurate Long Balls": "İsabetli Uzun Pas", "Saves": "Kaleci Kurtarışı",
  "goals_prevented": "Önlenen Gol", "expected_goals": "Beklenen Gol (xG)", "Shots on target": "İsabetli Şut", "Shots off target": "İsabetsiz Şut",
};
function statNameTR(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const exact = STAT_TR[raw] || Object.entries(STAT_TR).find(([k]) => k.toLowerCase() === raw.toLowerCase());
  return exact ? (Array.isArray(exact) ? exact[1] : exact) : raw;
}
function clockParts(v) {
  const m = String(v || "").match(/(\d+)(?:'?\s*\+\s*(\d+))?/);
  return { elapsed: m ? Number(m[1]) : null, extra: m && m[2] ? Number(m[2]) : null };
}
function normEvent(k) {
  const tp = ((k.type && (k.type.type || k.type.text)) || "").toLowerCase(), text = k.text || k.shortText || "";
  const who = (k.participants || k.athletesInvolved || []).map((p) => (p.athlete ? p.athlete.displayName : p.displayName) || "");
  const base = { time: clockParts(k.clock && k.clock.displayValue), team: { id: k.team && k.team.id } };
  if (k.scoringPlay || (/goal|penalty---scored/.test(tp) && !/disallowed|saved|missed/.test(tp))) {
    const own = k.ownGoal || /own/.test(tp), pen = k.penaltyKick || /penalty/.test(tp);
    return { ...base, type: "Goal", detail: own ? "Own Goal" : pen ? "Penalty" : "Normal Goal", player: { name: who[0] || "" }, assist: { name: own ? "" : who[1] || "" } };
  }
  if (/yellow|red-card/.test(tp) || k.yellowCard || k.redCard) {
    const red = k.redCard || /red/.test(tp);
    return { ...base, type: "Card", detail: red ? "Red Card" : "Yellow Card", player: { name: who[0] || "" } };
  }
  if (/substitution/.test(tp)) {
    const m = text.match(/\.\s*(.+?) replaces (.+?)(?: because|\.|$)/);
    return { ...base, type: "subst", detail: "Substitution", player: { name: m ? m[2] : who[1] || "" }, assist: { name: m ? m[1] : who[0] || "" } };
  }
  return null;
}
function matchText(value) {
  if (typeof value === "string") return value.trim();
  if (!value || typeof value !== "object") return "";
  return String(value.displayName || value.name || value.fullName || value.full_name || value.text || "").trim();
}
function matchBroadcasts(...sources) {
  const out = [], seen = new Set();
  const add = value => {
    if (!value) return;
    const list = Array.isArray(value) ? value : [value];
    for (const item of list) {
      if (typeof item === "string") { const name = item.trim(); if (name && !seen.has(name)) { seen.add(name); out.push({ name, country: "" }); } continue; }
      if (!item || typeof item !== "object") continue;
      const names = Array.isArray(item.names) ? item.names.map(matchText).filter(Boolean) : [];
      const name = names.join(" / ") || matchText(item.channel) || matchText(item.name) || matchText(item.displayName) || matchText(item.network);
      if (!name) continue;
      const market = item.market || item.area || item.geo || {};
      const country = matchText(item.country) || matchText(item.countryName) || matchText(item.marketCountry) || matchText(market.country) || matchText(market.name) || "";
      const key = name.toLowerCase() + "|" + country.toLowerCase();
      if (!seen.has(key)) { seen.add(key); out.push({ name, country }); }
    }
  };
  sources.forEach(add);
  return out;
}
function matchReferee(gameInfo, competition) {
  const candidates = [gameInfo && gameInfo.referee, gameInfo && gameInfo.officials, competition && competition.officials].filter(Boolean);
  for (const candidate of candidates) {
    const list = Array.isArray(candidate) ? candidate : [candidate];
    const found = list.find(x => /referee|hakem|main official/i.test([x && x.type && (x.type.text || x.type.name), x && x.role, x && x.position, x && x.displayName].filter(Boolean).join(" ")));
    const selected = found || (list.length === 1 ? list[0] : null);
    const name = matchText(selected);
    if (name) return name;
  }
  return "";
}
function parseSummary(j, code, rawId) {
  const meta = META[code] || [code, null, code, ""];
  const comp = (j.header && j.header.competitions && j.header.competitions[0]) || {};
  const h = (comp.competitors || []).find((x) => x.homeAway === "home"), a = (comp.competitors || []).find((x) => x.homeAway === "away");
  if (!h || !a) throw new Error("Maç bilgisi okunamadı");
  const s = statusOf(comp.status);
  const tm = (c) => ({ id: c.team.id, name: c.team.displayName || c.team.name, logo: c.team.logo || (c.team.logos && c.team.logos[0] && c.team.logos[0].href) || "" });
  let items = j.keyEvents && j.keyEvents.length ? j.keyEvents : comp.details || [];
  const events = items.map((k) => { try { return normEvent(k); } catch (_) { return null; } }).filter(Boolean);

  const lineups = (j.rosters || []).map((r) => {
    const mk = (x) => ({ player: { name: (x.athlete && x.athlete.displayName) || "", number: x.jersey == null ? null : x.jersey, pos: optaPosition(r.formation, x.formationPlace) || (x.position && (x.position.abbreviation || x.position.name)) || "", place: x.formationPlace == null || x.formationPlace === "" ? null : Number(x.formationPlace) } });
    const roster = r.roster || [];
    return {
      team: { id: r.team.id, name: r.team.displayName || r.team.name, logo: r.team.logo || "" },
      formation: r.formation || "",
      startXI: roster.filter((x) => x.starter).map(mk),
      substitutes: roster.filter((x) => !x.starter).map(mk),
    };
  });
  const statistics = ((j.boxscore && j.boxscore.teams) || []).map((t) => ({
    team: { id: t.team.id },
    statistics: (t.statistics || []).map((x) => ({
      type: statNameTR(STAT_TR[x.name] || x.label || x.displayName || x.shortDisplayName || x.name),
      value: /Pct$/.test(x.name || "") && x.displayValue != null ? String(x.displayValue).replace(/%?$/, "%") : x.displayValue,
    })),
  }));
  const gameInfo = j.gameInfo || {};
  const venueRaw = gameInfo.venue || comp.venue || null;
  const venue = venueRaw ? { name: matchText(venueRaw.fullName) || matchText(venueRaw.name) || "", city: matchText(venueRaw.address && venueRaw.address.city) || matchText(venueRaw.city) || "", country: matchText(venueRaw.address && venueRaw.address.country) || matchText(venueRaw.country) || "" } : null;
  const referee = matchReferee(gameInfo, comp);
  const broadcasts = matchBroadcasts(gameInfo.broadcasts, comp.broadcasts, j.broadcasts);
  return {
    match: {
      fixture: { id: "e:" + code + ":" + rawId, date: comp.date, status: { short: s.short, elapsed: s.elapsed }, venue },
      league: { id: meta[1] || "e:" + code, code, name: meta[2], country: meta[3], round: comp.notes && comp.notes[0] && comp.notes[0].headline || comp.type && comp.type.text || "" },
      teams: { home: tm(h), away: tm(a) },
      goals: { home: scoreOf(h, s.state), away: scoreOf(a, s.state) },
      referee, broadcasts, events, lineups, statistics,
    },
    live: s.state === "in", done: s.state === "post",
  };
}

// ---------- Puan durumu ----------
function parseStandings(j) {
  const groups = j.children && j.children.length ? j.children : [j];
  return groups.map((g) => {
    const entries = (g.standings && g.standings.entries) || [];
    const rows = entries.map((e, i) => {
      const st = {};
      (e.stats || []).forEach((x) => { st[x.name] = x.value; });
      return {
        rank: st.rank != null ? st.rank : i + 1,
        team: { id: e.team.id, name: e.team.displayName || e.team.name, logo: (e.team.logos && e.team.logos[0] && e.team.logos[0].href) || e.team.logo || "" },
        points: st.points, diff: st.pointDifferential != null ? st.pointDifferential : (st.pointsFor || 0) - (st.pointsAgainst || 0),
        played: st.gamesPlayed, win: st.wins, draw: st.ties, lose: st.losses,
        desc: (e.note && e.note.description) || "",
      };
    }).sort((x, y) => x.rank - y.rank);
    return { name: j.children && j.children.length ? g.name || "" : "", rows };
  }).filter((t) => t.rows.length);
}

const SOCCER_CORE = "https://sports.core.api.espn.com/v2/sports/soccer/leagues/";
function seasonStartYear() {
  const now = new Date(Date.now() + 3 * 3600e3);
  return now.getUTCMonth() >= 6 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
}
function seasonMonths(year) {
  return Array.from({ length: 12 }, (_, i) => {
    const from = new Date(Date.UTC(year, 6 + i, 1)), to = new Date(Date.UTC(year, 7 + i, 0));
    return [from.toISOString().slice(0, 10).replace(/-/g, ""), to.toISOString().slice(0, 10).replace(/-/g, "")];
  });
}
const TSDB_LEAGUE_IDS = {
  "eng.1": "4328", "esp.1": "4335", "ger.1": "4331", "ita.1": "4332", "fra.1": "4334",
  "tur.1": "4339", "uefa.champions": "4480", "uefa.europa": "4481", "uefa.europa.conf": "5071",
};
const tsdbPremiumKey = env => env && env.THESPORTSDB_API_KEY || "";
async function tsdbPremiumJSON(env, path) {
  const key = tsdbPremiumKey(env);
  if (!key) throw new Error("THESPORTSDB_API_KEY tanımlı değil");
  const r = await fetch("https://www.thesportsdb.com/api/v2/json/" + path, {
    headers: { "X-API-KEY": key, Accept: "application/json" },
    signal: AbortSignal.timeout(12000),
  });
  if (!r.ok) throw new Error(r.status === 429 ? "TheSportsDB istek sınırı doldu; daha sonra yeniden deneyin" : "TheSportsDB v2 HTTP " + r.status);
  return r.json();
}
const API_FOOTBALL_BASE = "https://v3.football.api-sports.io";
const apiFootballKey = env => env && (env.API_FOOTBALL_KEY || env.APISPORTS_KEY || env.API_KEY || "");
async function apiFootballJSON(env, path, params = {}) {
  const key = apiFootballKey(env);
  if (!key) throw new Error("API_FOOTBALL_KEY tanımlı değil");
  const url = API_FOOTBALL_BASE + path + "?" + new URLSearchParams(params);
  const r = await fetch(url, { headers: { "x-apisports-key": key, Accept: "application/json" }, signal: AbortSignal.timeout(12000) });
  if (!r.ok) {
    if (r.status === 429) throw new Error("API-Football dakikalık istek sınırı doldu; biraz bekleyip yeniden deneyin");
    throw new Error("API-Football HTTP " + r.status);
  }
  const data = await r.json();
  if (data.errors && Object.keys(data.errors).length) {
    const detail = JSON.stringify(data.errors);
    if (/free plans? .*do not have access to this season/i.test(detail)) {
      const range = detail.match(/try from\s+(\d{4})\s+to\s+(\d{4})/i);
      const requested = params.season ? " " + params.season + " sezonuna" : " istenen sezona";
      throw new Error("API-Football ücretsiz planı" + requested + " erişemiyor" + (range ? " (ücretsiz kapsam: " + range[1] + "–" + range[2] + ")" : "") + ". Güncel sezon verisi için sezon erişimi olan bir plan gerekiyor.");
    }
    if (/too many requests|exceeded the limit of requests per minute|rateLimit/i.test(detail)) {
      throw new Error("API-Football dakikalık istek sınırı doldu; en az 60 saniye bekleyip yeniden deneyin");
    }
    throw new Error("API-Football: " + detail);
  }
  return data;
}
async function apiFootballPaged(env, path, params = {}, maxPages = 8) {
  const first = await apiFootballJSON(env, path, { ...params, page: "1" });
  const response = [...(first.response || [])];
  const total = Number(first.paging && first.paging.total || first.pagination && first.pagination.total || 1);
  const last = Math.max(1, Math.min(Number.isFinite(total) ? total : 1, maxPages));
  for (let page = 2; page <= last; page++) {
    const next = await apiFootballJSON(env, path, { ...params, page: String(page) });
    response.push(...(next.response || []));
  }
  return { ...first, response, paging: { ...(first.paging || {}), current: last, total }, limited: total > maxPages };
}
function apiFootballLeaders(data, kind) {
  return (Array.isArray(data && data.response) ? data.response : []).map((x, i) => {
    const s = Array.isArray(x.statistics) ? (x.statistics[0] || {}) : (x.statistics || {});
    const goals = s.goals || x.goals || {}, player = x.player || {};
    const value = kind === "goals" ? (goals.total ?? goals.goals ?? x.goalsTotal) : (goals.assists ?? x.assists);
    return { rank: i + 1, player: player.name || x.player_name || x.name || "", team: s.team && s.team.name || x.team && x.team.name || "", value, logo: player.photo || x.photo || "", source: "API-Football" };
  }).filter(x => x.player && x.value != null && x.value !== "" && Number.isFinite(Number(x.value))).slice(0, 50).map(x => ({ ...x, value: Number(x.value) }));
}
async function apiFootballLeagueLeaders(env, code, year, kind) {
  const id = (META[code] || [])[1];
  if (!id || !apiFootballKey(env)) return [];
  const path = kind === "goals" ? "/players/topscorers" : "/players/topassists";
  const key = "af-leaders:v2:" + code + ":" + year + ":" + kind;
  const result = await cached(key, async () => {
    const body = await apiFootballJSON(env, path, { league: String(id), season: String(year) });
    return { body, ttl: (body.response || []).length ? 86400 : 900 };
  });
  return apiFootballLeaders(result.body, kind);
}
async function apiFootballPlayerSearch(env, query) {
  if (!apiFootballKey(env) || !query) return [];
  const term = String(query).trim().slice(0, 80);
  const familyName = term.split(/\s+/).pop();
  const searchTerm = familyName.length >= 4 ? familyName : term;
  if (searchTerm.length < 4) return [];
  // API-Football araması Türkçe karakterlerde bazen sonuç döndürmüyor.
  // Görünen adı değiştirmeden sağlayıcı sorgusunu ASCII'ye normalize et.
  const providerTerm = nkp(searchTerm) || searchTerm;
  const cacheKey = "af-player-search:v6:" + nkp(providerTerm);
  const result = await cached(cacheKey, async () => ({
    body: await apiFootballJSON(env, "/players/profiles", { search: providerTerm }), ttl: 86400,
  }));
  const target = nkp(term);
  return (result.body.response || []).map(x => x.player || x).filter(x => x && x.id).map(x => {
    const name = x.name || [x.firstname, x.lastname].filter(Boolean).join(" ");
    const id = String(x.id);
    const photos = collectPhotoUrls(x.photo, x.image, x.headshot);
    return { name, af: id, team: "", country: x.nationality || x.country || "", nationality: x.nationality || "", pos: x.position || "", logo: photos[0] || "", photo: photos[0] || "", photos };
  }).filter(x => x.name && (nkp(x.name) === target || target.split(" ").every(t => nkp(x.name).split(" ").some(w => w.startsWith(t))))).slice(0, 10);
}
async function apiFootballPlayerCareer(env, name, knownPlayerId = "", teamHint = "", posHint = "") {
  if (!apiFootballKey(env) || !name) return { seasons: [], bio: {}, photo: "", player: "", transfers: [], injuries: [] };
  const term = String(name).trim().slice(0, 80), familyName = term.split(/\s+/).pop(), key = nkp(term);
  const searchTerms = [...new Set([familyName, nkp(familyName), term, key].filter(x => x && x.length >= 4))].slice(0, 3);
  let profiles = [];
  if (knownPlayerId) {
    try {
      const direct = await cached("af-player-profile:v9:id:" + knownPlayerId, async () => ({ body: await apiFootballJSON(env, "/players/profiles", { player: String(knownPlayerId) }), ttl: 86400 }));
      profiles.push(...(direct.body.response || []).map(x => x.player || x));
    } catch (_) {}
  }
  profiles = [...new Map(profiles.filter(x => x && x.id).map(x => [String(x.id), x])).values()];
  // A team/provider ID can accidentally be passed in the API-Football field.
  // Never accept an ID-only hit unless its profile also matches the requested name.
  let profile = knownPlayerId ? profiles.find(x => String(x.id) === String(knownPlayerId) && playerCandidateScore(x, term, "", posHint) >= 68) : null;
  if (!profile) {
    profiles = [];
    const lookups = await Promise.allSettled(searchTerms.map(search => cached("af-player-profile:v9:" + nkp(search), async () => ({
      body: await apiFootballJSON(env, "/players/profiles", { search }), ttl: 86400,
    }))));
    for (const result of lookups) if (result.status === "fulfilled") profiles.push(...(result.value.body.response || []).map(x => x.player || x));
    profiles = [...new Map(profiles.filter(x => x && x.id).map(x => [String(x.id), x])).values()];
  }
  if (!profile && profiles.length) profile = selectPlayerCandidate(profiles, term, teamHint, posHint);
  if (!profile && profiles.length && teamHint) {
    // Same-name players are common; compare their registered club histories before choosing.
    const likely = profiles.map(x => ({ x, score: playerCandidateScore(x, term, "", posHint) })).filter(x => x.score >= 68).sort((a,b) => b.score-a.score).slice(0, 6);
    const teamMatches = await Promise.all(likely.map(async item => {
      try {
        const id = String(item.x.id);
        const teams = await cached("af-player-teams:v2:" + id, async () => ({ body: await apiFootballJSON(env, "/players/teams", { player: id }), ttl: 86400 }));
        const found = (teams.body.response || []).some(row => {
          const team = row.team || row;
          return teamSearchKey(team.name || "") === teamSearchKey(teamHint) || nameLike(team.name || "", teamHint);
        });
        return found ? item.x : null;
      } catch (_) { return null; }
    }));
    const matched = teamMatches.filter(Boolean);
    if (matched.length === 1) profile = matched[0];
  }
  if (!profile) return { seasons: [], bio: {}, photo: "", player: "", transfers: [], injuries: [], ambiguous: profiles.length > 1, profileNotFound: true };
  const playerId = String(profile.id);
  // /transfers supplies dated from/to club pairs; it is the authoritative order for same-season team changes.
  const transferData = await cached("af-player-transfers:v3:" + playerId, async () => ({
    body: await apiFootballJSON(env, "/transfers", { player: playerId }), ttl: 86400,
  })).catch(() => ({ body: { response: [] } }));
  // API-Football statistics can contain two clubs in the same season. The transfer
  // record is the chronological source of truth: the receiving club ranks just
  // after the leaving club. Keep both the stable team ID and normalized name.
  const transferOrder = new Map(), transferOrderById = new Map();
  const transferOrderBySeason = new Map(), transferOrderBySeasonId = new Map();
  const lastClubBySeason = new Map();
  let latestTransferClub = { stamp: 0, name: "", id: "" };
  const transferSeason = stamp => {
    const d = new Date(stamp);
    return d.getUTCMonth() >= 5 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
  };
  const setTransferOrder = (team, stamp, seasonYear) => {
    if (!team || !Number.isFinite(stamp)) return;
    const name = typeof team === "string" ? team : (team.name || "");
    const id = typeof team === "object" && team.id != null ? String(team.id) : "";
    const key = nkw(name), seasonKey = Number(seasonYear) + "|";
    if (key) {
      const oldGlobal = transferOrder.get(key) || 0;
      const oldSeason = transferOrderBySeason.get(seasonKey + key) || 0;
      transferOrder.set(key, oldGlobal ? Math.max(oldGlobal, stamp) : stamp);
      transferOrderBySeason.set(seasonKey + key, oldSeason ? Math.max(oldSeason, stamp) : stamp);
    }
    if (id) {
      const oldGlobal = transferOrderById.get(id) || 0;
      const oldSeason = transferOrderBySeasonId.get(seasonKey + id) || 0;
      transferOrderById.set(id, oldGlobal ? Math.max(oldGlobal, stamp) : stamp);
      transferOrderBySeasonId.set(seasonKey + id, oldSeason ? Math.max(oldSeason, stamp) : stamp);
    }
  };
  const transfers = (transferData.body.response || []).flatMap(item => Array.isArray(item.transfers) ? item.transfers : item.transfer ? [item.transfer] : []);
  const transferRows = transfers.map(move => {
    const outgoing = move && move.teams && (move.teams.out || move.teams.from) || {};
    const incoming = move && move.teams && (move.teams.in || move.teams.to) || {};
    const rawType = String(move && (move.type || move.fee || move.transfer_type) || "").trim();
    const isLoan = /loan|kiral/i.test(rawType);
    const isFree = /free|bedelsiz/i.test(rawType);
    const fee = /€|£|\$|\b\d/.test(rawType) && !isLoan ? rawType : "";
    const kind = isLoan ? "Kiralık" : isFree ? "Bedelsiz" : fee ? "Bonservis" : "Detay belirtilmemiş";
    const rawDate = move && (move.date || move.date_transfer || move.timestamp) || "";
    const date = typeof rawDate === "number" ? new Date(rawDate < 1e12 ? rawDate * 1000 : rawDate).toISOString().slice(0,10) : String(rawDate).slice(0,10);
    const teamName = team => typeof team === "string" ? team : team && team.name || "";
    return { date, from: teamName(outgoing), to: teamName(incoming), kind, fee, rawType };
  }).filter(x => x.date || x.from || x.to).sort((a,b) => String(b.date).localeCompare(String(a.date)));
  const sidelinedData = await cached("af-player-sidelined:v1:" + playerId, async () => ({
    body: await apiFootballJSON(env, "/sidelined", { player: playerId }), ttl: 86400,
  })).catch(() => ({ body: { response: [] } }));
  const injuries = (sidelinedData.body.response || []).map(item => {
    const type = String(item.type || item.reason || "").trim();
    const reason = String(item.reason || item.type || "Sakatlık kaydı").trim();
    return { type, reason, start: String(item.start || item.date || ""), end: String(item.end || item.until || ""), season: item.season || null };
  }).filter(x => x.start || x.end || x.reason).sort((a,b) => String(b.start).localeCompare(String(a.start)));
  for (const move of transfers) {
    const rawDate = move.date || move.date_transfer || move.timestamp || "";
    const rawStamp = String(rawDate).trim();
    const stamp = typeof rawDate === "number" ? (rawDate < 1e12 ? rawDate * 1000 : rawDate)
      : /^\d{10,13}$/.test(rawStamp) ? (Number(rawStamp) < 1e12 ? Number(rawStamp) * 1000 : Number(rawStamp))
      : Date.parse(rawStamp);
    if (!Number.isFinite(stamp)) continue;
    const incoming = move.teams && (move.teams.in || move.teams.to);
    const outgoing = move.teams && (move.teams.out || move.teams.from);
    const seasonYear = transferSeason(stamp);
    // The previous club ranks just below the incoming club in the season of the move.
    if (outgoing) setTransferOrder(outgoing, stamp - 1, seasonYear);
    if (incoming) {
      setTransferOrder(incoming, stamp, seasonYear);
      const incomingName = typeof incoming === "string" ? incoming : (incoming.name || "");
      const incomingId = typeof incoming === "object" && incoming.id != null ? String(incoming.id) : "";
      const previous = lastClubBySeason.get(seasonYear);
      if (!previous || stamp > previous.stamp) lastClubBySeason.set(seasonYear, { stamp, name: incomingName, id: incomingId });
      if (stamp > latestTransferClub.stamp) latestTransferClub = { stamp, name: incomingName, id: incomingId };
    }
  }
  const transferOrderFor = (teamName, teamId, seasonYear) => {
    const seasonKey = Number(seasonYear) + "|";
    const bySeasonId = teamId == null ? 0 : (transferOrderBySeasonId.get(seasonKey + String(teamId)) || 0);
    const bySeasonName = transferOrderBySeason.get(seasonKey + nkw(teamName)) || 0;
    // Never use a transfer from a different season to order this season's rows.
    const values = [bySeasonId, bySeasonName].filter(value => value > 0);
    return values.length ? Math.max(...values) : 0;
  };
  const data = [], failedYears = [];
  let yearValues = [], seasonListError = "";
  try {
    const seasonData = await cached("af-player-seasons:v2:" + playerId, async () => ({
      body: await apiFootballJSON(env, "/players/seasons", { player: playerId }), ttl: 86400,
    }));
    yearValues = Array.isArray(seasonData.body.response) ? seasonData.body.response : [];
  } catch (e) { seasonListError = e && e.message || String(e); }
  if (!yearValues.length) {
    // This second endpoint also lists club-season history and is a documented fallback.
    try {
      const history = await cached("af-player-teams:v3:" + playerId, async () => ({ body: await apiFootballJSON(env, "/players/teams", { player: playerId }), ttl: 86400 }));
      yearValues = (history.body.response || []).flatMap(x => Array.isArray(x.seasons) ? x.seasons : Array.isArray(x.team && x.team.seasons) ? x.team.seasons : []);
    } catch (e) { if (!seasonListError) seasonListError = e && e.message || String(e); }
  }
  // If both season indexes are empty, still query a limited recent window. This
  // recovers players when the season index endpoint is temporarily unavailable.
  let years = [...new Set(yearValues.map(x => Number(typeof x === "object" ? (x.season || x.year || x.id) : x)).filter(y => Number.isInteger(y) && y >= 1900 && y <= 2200))]
    .sort((a, b) => b - a);
  const authOrQuotaFailure = /HTTP (?:401|403|429)|rate limit|limit of requests|unauthorized|invalid api key/i.test(seasonListError);
  if (!years.length && !authOrQuotaFailure) years = recentSeasonYears(12);
  if (seasonListError && !years.length) failedYears.push({ year: 0, message: seasonListError });
  for (let i = 0; i < years.length; i += 4) {
    const batch = await Promise.all(years.slice(i, i + 4).map(async year => {
      const combined = { response: [], paging: { current: 1, total: 1 } };
      const firstKey = "af-player-season:v5:" + playerId + ":" + year + ":1";
      const first = await cached(firstKey, async () => {
        try { return { body: await apiFootballJSON(env, "/players", { id: playerId, season: String(year), page: "1" }), ttl: 86400 }; }
        catch (e) { return { body: { response: [], _error: e && e.message || String(e) }, ttl: 1800 }; }
      });
      if (first.body && first.body._error) { failedYears.push({ year, message: first.body._error }); return first.body; }
      combined.response.push(...(first.body.response || []));
      const totalPages = Math.min(12, Math.max(1, Number(first.body.paging && first.body.paging.total) || 1));
      combined.paging.total = totalPages;
      // API-Football paginates the /players response. Do not silently drop later pages.
      for (let page = 2; page <= totalPages; page++) {
        const pageKey = "af-player-season:v5:" + playerId + ":" + year + ":" + page;
        const result = await cached(pageKey, async () => {
          try { return { body: await apiFootballJSON(env, "/players", { id: playerId, season: String(year), page: String(page) }), ttl: 86400 }; }
          catch (e) { return { body: { response: [], _error: e && e.message || String(e) }, ttl: 1800 }; }
        });
        if (result.body && result.body._error) failedYears.push({ year, page, message: result.body._error });
        else combined.response.push(...(result.body.response || []));
      }
      return combined;
    }));
    data.push(...batch);
  }
  const rows = new Map();
  for (const doc of data) for (const entry of doc && doc.response || []) {
    for (const stats of entry.statistics || []) {
      const league = stats.league || {}, team = stats.team || {};
      const seasonYear = Number(league.season) || Number(years.find(y => y === Number(league.season))) || 0;
      const teamName = String(team.name || "").trim();
      const games = stats.games || stats.game || {}, goalsBox = stats.goals || stats.goal || {}, cards = stats.cards || stats.card || {};
      const firstNumeric = (...values) => {
        for (const value of values) if (value !== undefined && value !== null && value !== "" && Number.isFinite(Number(value))) return Number(value);
        return null;
      };
      const appsRaw = firstNumeric(games.appearances, games.appearences, stats.appearances, stats.apps),
        // API-Football v3's documented starting-XI count is games.lineups.
        startsRaw = firstNumeric(games.lineups, games.starts, games.started, games.starting_appearances, stats.lineups, stats.starts);
      const goalsRaw = firstNumeric(goalsBox.total, goalsBox.goals, stats.goals_total), assistsRaw = firstNumeric(goalsBox.assists, stats.assists, stats.assist);
      const yellowRaw = firstNumeric(cards.yellow, cards.yellow_cards, stats.yellow_cards), redRaw = firstNumeric(cards.red, cards.red_cards, stats.red_cards);
      if (!seasonYear || !teamName || [appsRaw, startsRaw, goalsRaw, assistsRaw, yellowRaw, redRaw].every(v => v == null)) continue;
      const season = seasonYear + "/" + String(seasonYear + 1).slice(-2), keyRow = season + "|" + nkw(teamName);
      const teamAfId = team.id == null ? "" : String(team.id), teamCode = espnCodeFromAfLeague(league.id);
      const transferRank = transferOrderFor(teamName, teamAfId, seasonYear);
      const row = rows.get(keyRow) || { "Sezon": season, "Takım": teamName, logo: team.logo || "", teamAfId, teamCode, careerOrder: transferRank, careerTimestamp: transferRank, "Maç": 0, "Gol": 0, "Asist": null, "İlk 11": null, "Sarı Kart": null, "Kırmızı Kart": null, cats: emptyCats() };
      if (transferRank > 0 && (!(Number(row.careerTimestamp) > 0) || transferRank > Number(row.careerTimestamp))) { row.careerTimestamp = transferRank; row.careerOrder = transferRank; }
      if (!row.teamAfId && teamAfId) row.teamAfId = teamAfId;
      if (!row.teamCode && teamCode) row.teamCode = teamCode;
      if (!row.logo && team.logo) row.logo = team.logo;
      const apps = Number(appsRaw) || 0, goals = Number(goalsRaw) || 0, assists = assistsRaw == null ? null : Number(assistsRaw) || 0;
      const starts = startsRaw == null ? null : Number(startsRaw) || 0, yellow = yellowRaw == null ? null : Number(yellowRaw) || 0, red = redRaw == null ? null : Number(redRaw) || 0;
      row["Maç"] += apps; row["Gol"] += goals;
      if (assists != null) row["Asist"] = (row["Asist"] || 0) + assists;
      if (starts != null) row["İlk 11"] = (row["İlk 11"] || 0) + starts;
      if (yellow != null) row["Sarı Kart"] = (row["Sarı Kart"] || 0) + yellow;
      if (red != null) row["Kırmızı Kart"] = (row["Kırmızı Kart"] || 0) + red;
      const category = catOf(league.name || "") || catOf(league.type || "") || (String(league.country || "").trim() ? "lig" : "intl");
      addCat(row.cats, category, apps, goals, assists, starts, yellow, red);
      rows.set(keyRow, row);
    }
  }
  for (const row of rows.values()) {
    const seasonYear = Number(String(row["Sezon"] || "").slice(0, 4));
    const lastClub = lastClubBySeason.get(seasonYear);
    if (lastClub) {
      const sameId = lastClub.id && String(row.teamAfId || "") === lastClub.id;
      const sameName = nkw(row["Takım"]) === nkw(lastClub.name);
      if (sameId || sameName) { row.seasonLastTeam = true; row.transferLastTeam = true; }
    }
  }
  const birth = profile.birth && profile.birth.date || "";
  return {
    seasons: [...rows.values()], player: profile.name || term, failedYears,
    transfers: transferRows, injuries,
    photo: profile.photo || "https://media.api-sports.io/football/players/" + playerId + ".png",
    bio: { ...dateBio(birth), "Yaş": profile.age || "", "Boy": profile.height || "", "Kilo": profile.weight || "", "Uyruk": profile.nationality || "", "Mevki": profile.position || "", "Forma No": profile.number || "", "Şu Anki Takım": latestTransferClub.name || "" },
  };
}
const SOCCER_DATA_BASE = "https://api.soccer-data.co/v1";
const soccerDataKey = env => env && (env.SOCCER_DATA_KEY || "");
async function soccerDataJSON(env, path) {
  const key = soccerDataKey(env);
  if (!key) throw new Error("SOCCER_DATA_KEY tanımlı değil");
  const r = await fetch(SOCCER_DATA_BASE + path, { headers: { "X-Api-Key": key, Accept: "application/json" }, signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error("Soccer Data HTTP " + r.status);
  const data = await r.json();
  if (data && data.error) throw new Error("Soccer Data: " + (data.error.message || data.error));
  return data;
}
function soccerDataSeason(value) {
  const raw = String(value || "");
  const m = raw.match(/((?:19|20)\d{2}|\d{2})\s*[\/–-]\s*((?:19|20)?\d{2})/);
  if (m) {
    const year = x => { const n = Number(x); return String(x).length === 2 ? (n >= 70 ? 1900 + n : 2000 + n) : n; };
    const start = year(m[1]), end = year(m[2]);
    if (start >= 1900 && start <= 2200 && end >= start && end <= start + 2) return start + "/" + String(end).slice(-2);
  }
  const one = raw.match(/(?:19|20)\d{2}/);
  if (!one) return "";
  const start = Number(one[0]);
  return start + "/" + String(start + 1).slice(-2);
}
async function soccerDataPlayerCareer(env, name, teamHint = "", posHint = "") {
  if (!soccerDataKey(env) || !name) return { seasons: [], player: "", failures: [] };
  const term = String(name).trim().slice(0, 80), exact = nkp(term);
  if (exact.length < 3) return { seasons: [], player: "", failures: [] };
  // Search both the original spelling and its accent-free form. The provider
  // documents accent-insensitive search, but keep both queries for punctuation
  // and transliteration variants returned by external feeds.
  const searchTerms = [...new Set([term, exact].filter(x => x.length >= 3))];
  const searches = await Promise.allSettled(searchTerms.map(searchTerm => cached("sd-player-search:v2:" + nkp(searchTerm), async () => ({
    body: await soccerDataJSON(env, "/players?" + new URLSearchParams({ search: searchTerm, sort: "relevance", per_page: "20" })), ttl: 2592000,
  }))));
  const candidates = [...new Map(searches.flatMap(result => result.status === "fulfilled" ? (result.value.body.data || []) : []).filter(x => x && x.id).map(x => [String(x.id), x])).values()];
  const mapped = candidates.map(x => ({ ...x, team: x.current_team || x.team || null, position: x.position || x.pos || "" }));
  const selected = selectPlayerCandidate(mapped, term, teamHint, posHint);
  const player = selected && candidates.find(x => String(x.id) === String(selected.id));
  if (!player || !player.current_team || !player.current_team.id) return { seasons: [], player: player && player.name || "", ambiguous: candidates.length > 1 && !player, failures: searches.filter(x => x.status === "rejected").map(x => String(x.reason && x.reason.message || x.reason)) };
  const team = player.current_team;
  const table = await cached("sd-team-seasons:" + team.id, async () => ({
    body: await soccerDataJSON(env, "/teams/" + encodeURIComponent(team.id) + "/standings"), ttl: 86400,
  }));
  const currentYear = new Date().getUTCFullYear();
  const seasonOptions = [];
  for (const comp of table.body.data || []) for (const season of comp.seasons || []) {
    const label = soccerDataSeason(season.name);
    const year = Number((label.match(/^\d{4}/) || [])[0]);
    // Do not silently discard older seasons: the old implementation only searched
    // the last two years, which hid a large part of long-serving players' careers.
    if (!season.id || !label || !year || year < currentYear - 14 || year > currentYear + 1) continue;
    seasonOptions.push({ id: String(season.id), label, year, competition: String(comp.competition && comp.competition.name || "") });
  }
  const unique = [...new Map(seasonOptions.map(x => [x.id, x])).values()]
    .sort((a, b) => b.year - a.year || (catOf(a.competition) === "lig" ? -1 : 0) - (catOf(b.competition) === "lig" ? -1 : 0))
    .slice(0, 12);
  const docs = await Promise.allSettled(unique.map(async season => {
    const hit = await cached("sd-player-stat:" + player.id + ":" + season.id, async () => ({
      body: await soccerDataJSON(env, "/players/" + encodeURIComponent(player.id) + "/stats?" + new URLSearchParams({ season_id: season.id })), ttl: 21600,
    }));
    return { season, data: hit.body.data || {} };
  }));
  const failures = [
    ...searches.filter(x => x.status === "rejected").map(x => String(x.reason && x.reason.message || x.reason)),
    ...docs.filter(x => x.status === "rejected").map(x => String(x.reason && x.reason.message || x.reason)),
  ];
  const rows = new Map();
  for (const result of docs) {
    if (result.status !== "fulfilled") continue;
    const { season, data } = result.value;
    const scoring = data.scoring || {}, discipline = data.discipline || {};
    const apps = data.appearances == null ? null : Number(data.appearances), starts = data.starts == null ? null : Number(data.starts);
    const goals = scoring.goals == null ? null : Number(scoring.goals), assists = scoring.assists == null ? null : Number(scoring.assists);
    const yellow = discipline.yellow_cards == null ? null : Number(discipline.yellow_cards), red = discipline.red_cards == null ? null : Number(discipline.red_cards);
    if ([apps, starts, goals, assists, yellow, red].every(v => v == null || !Number.isFinite(v))) continue;
    const rowKey = season.label + "|" + nkw(team.name);
    const row = rows.get(rowKey) || { "Sezon": season.label, "Takım": team.name, "Maç": 0, "Gol": 0, "Asist": null, "İlk 11": null, "Sarı Kart": null, "Kırmızı Kart": null, cats: emptyCats() };
    row["Maç"] += Number.isFinite(apps) ? apps : 0;
    row["Gol"] += Number.isFinite(goals) ? goals : 0;
    if (Number.isFinite(assists)) row["Asist"] = (row["Asist"] || 0) + assists;
    if (Number.isFinite(starts)) row["İlk 11"] = (row["İlk 11"] || 0) + starts;
    if (Number.isFinite(yellow)) row["Sarı Kart"] = (row["Sarı Kart"] || 0) + yellow;
    if (Number.isFinite(red)) row["Kırmızı Kart"] = (row["Kırmızı Kart"] || 0) + red;
    addCat(row.cats, catOf(season.competition), apps, goals, assists, starts, yellow, red);
    rows.set(rowKey, row);
  }
  return { seasons: [...rows.values()], player: player.name || term, failures, searchedSeasons: unique.length };
}
// İsteğe bağlı geniş kapsamlı ek kaynak. Cloudflare Worker > Settings > Variables
// bölümüne SPORTMONKS_API_TOKEN adıyla Secret olarak eklenince etkinleşir.
const SPORTMONKS_BASE = "https://api.sportmonks.com/v3/football";
const sportmonksToken = env => env && (env.SPORTMONKS_API_TOKEN || env.SPORTMONKS_TOKEN || "");
async function sportmonksJSON(env, path, params = {}) {
  const token = sportmonksToken(env);
  if (!token) throw new Error("SPORTMONKS_API_TOKEN tanımlı değil");
  const query = new URLSearchParams({ ...params, api_token: token });
  const response = await fetch(SPORTMONKS_BASE + path + (path.includes("?") ? "&" : "?") + query.toString(), {
    headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error("Sportmonks HTTP " + response.status);
  const data = await response.json();
  if (data && (data.errors || data.message && !data.data)) throw new Error("Sportmonks: " + JSON.stringify(data.errors || data.message).slice(0, 220));
  return data;
}
function sportmonksSeasonLabel(value) {
  const raw = String(value || "").trim();
  const full = raw.match(/((?:19|20)\d{2})(?:\s*[\/–-]\s*((?:(?:19|20)?\d{2})))?/);
  if (full) {
    const start = Number(full[1]);
    const end = full[2] ? String(full[2]).slice(-2) : String(start + 1).slice(-2);
    return start + "/" + end;
  }
  // Some provider records use short labels such as 24/25 or 25-26.
  const short = raw.match(/(?:^|\D)(\d{2})\s*[\/–-]\s*(\d{2})(?:\D|$)/);
  if (!short) return "";
  const yy = Number(short[1]), start = yy >= 70 ? 1900 + yy : 2000 + yy;
  return start + "/" + short[2];
}
function sportmonksValue(detail) {
  const value = detail && detail.value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  if (value && typeof value === "object") {
    for (const key of ["total", "value", "count"]) {
      const candidate = value[key];
      if (candidate != null && Number.isFinite(Number(candidate))) return Number(candidate);
    }
  }
  return null;
}
function sportmonksDetailKind(detail) {
  const type = detail && (detail.type || detail.statistic_type || {});
  const label = nkp([type.name, type.developer_name, type.code, detail && detail.name, detail && detail.code].filter(Boolean).join(" "));
  const id = Number(detail && (detail.type_id || type.id));
  if (/appearances?|matches played|games played/.test(label) || id === 321) return "m";
  if (/^goals?$|goals scored/.test(label)) return "g";
  if (/^assists?$|goal assists/.test(label)) return "a";
  if (/lineups|starting xi|starts|games started|starting appearances/.test(label)) return "s";
  if (/yellow ?cards?|yellowcards|bookings yellow/.test(label)) return "y";
  if (/red ?cards?|redcards|bookings red/.test(label)) return "r";
  return "";
}
async function sportmonksPlayerCareer(env, name, teamHint = "", posHint = "") {
  if (!sportmonksToken(env) || !name) return { seasons: [], player: "", photo: "" };
  const terms = [...new Set([String(name).trim(), nkp(name)].filter(x => x.length >= 3))];
  const lookups = await Promise.allSettled(terms.map(term => cached("sm-player-search:v1:" + nkp(term), async () => ({
    body: await sportmonksJSON(env, "/players/search/" + encodeURIComponent(term), {
      per_page: "50", include: "statistics.details.type;statistics.team;statistics.season;teams.team",
    }), ttl: 86400,
  }))));
  const candidates = [];
  for (const result of lookups) if (result.status === "fulfilled") candidates.push(...((result.value.body && result.value.body.data) || []));
  const unique = [...new Map(candidates.filter(x => x && x.id).map(x => [String(x.id), x])).values()];
  let player = selectPlayerCandidate(unique, name, teamHint, posHint);
  if (!player) return { seasons: [], player: "", ambiguous: unique.length > 1 };
  let detail = player;
  if (!Array.isArray(detail.statistics) || !detail.statistics.some(x => Array.isArray(x.details) && x.details.length)) {
    try {
      const full = await cached("sm-player-full:v1:" + player.id, async () => ({
        body: await sportmonksJSON(env, "/players/" + encodeURIComponent(player.id), {
          include: "statistics.details.type;statistics.team;statistics.season;teams.team",
        }), ttl: 86400,
      }));
      detail = full.body && full.body.data || player;
    } catch (_) {}
  }
  const teamRows = Array.isArray(detail.teams) ? detail.teams : [];
  const teamById = new Map(teamRows.map(item => {
    const team = item.team || item;
    return [String(team.id || item.team_id || ""), team];
  }).filter(x => x[0]));
  const rows = new Map();
  for (const stat of Array.isArray(detail.statistics) ? detail.statistics : []) {
    const seasonObject = stat.season || {};
    const season = sportmonksSeasonLabel(seasonObject.name || seasonObject.display_name || seasonObject.year || stat.season_name || stat.season);
    const seasonYear = Number((season.match(/^(?:19|20)\d{2}/) || [])[0]);
    const teamObject = stat.team || teamById.get(String(stat.team_id || "")) || {};
    const team = String(teamObject.name || teamObject.display_name || stat.team_name || "").trim();
    if (!season || !seasonYear || !team) continue;
    const leagueObject = stat.league || stat.competition || seasonObject.league || {};
    const competition = String(leagueObject.name || stat.league_name || stat.competition_name || "");
    const key = season + "|" + nkw(team);
    const row = rows.get(key) || { "Sezon": season, "Takım": team, "Maç": null, "Gol": null, "Asist": null, "İlk 11": null, "Sarı Kart": null, "Kırmızı Kart": null, cats: emptyCats(), source: "Sportmonks" };
    for (const item of Array.isArray(stat.details) ? stat.details : []) {
      const kind = sportmonksDetailKind(item), value = sportmonksValue(item);
      if (!kind || value == null) continue;
      const field = ({ m: "Maç", g: "Gol", a: "Asist", s: "İlk 11", y: "Sarı Kart", r: "Kırmızı Kart" })[kind];
      row[field] = (row[field] == null ? 0 : row[field]) + value;
    }
    const category = catOf(competition);
    if (category) {
      const get = kind => {
        const detail = (stat.details || []).find(x => sportmonksDetailKind(x) === kind);
        return detail ? sportmonksValue(detail) : null;
      };
      addCat(row.cats, category, get("m") || 0, get("g") || 0, get("a"), get("s"), get("y"), get("r"));
    }
    rows.set(key, row);
  }
  return {
    seasons: [...rows.values()], player: detail.display_name || detail.name || player.name || name,
    photo: detail.image_path || player.image_path || "",
    bio: { "Doğum Tarihi": detail.date_of_birth || "", "Boy": detail.height ? detail.height + " cm" : "", "Kilo": detail.weight ? detail.weight + " kg" : "", "Uyruk": detail.nationality && detail.nationality.name || "", "Mevki": detail.position && detail.position.name || "" },
  };
}

function tsdbEventTime(e) {
  if (e.strTimestamp) return /Z$|[+-]\d\d:\d\d$/.test(e.strTimestamp) ? e.strTimestamp : e.strTimestamp + "Z";
  return String(e.dateEvent || "") + "T" + String(e.strTime || "00:00:00").replace(/Z$/, "") + "Z";
}
function tsdbStatus(e) {
  const raw = String(e.strStatus || e.strProgress || "").toLowerCase();
  if (/postpon/.test(raw)) return "PST";
  if (/cancel/.test(raw)) return "CANC";
  if (/abandon/.test(raw)) return "ABD";
  if (/half.?time|halftime/.test(raw)) return "HT";
  if (/second half|2nd half/.test(raw)) return "2H";
  if (/first half|1st half|in progress|live/.test(raw)) return "1H";
  if (/extra.?time/.test(raw)) return "ET";
  if (/penalty|shootout/.test(raw)) return "P";
  if (/finished|full.?time|after extra/.test(raw) || (e.intHomeScore != null && e.intAwayScore != null && e.strStatus)) return "FT";
  return "NS";
}
function tsdbLeagueEvent(e, code) {
  const meta = META[code] || [code, null, e.strLeague || code, e.strCountry || ""];
  const short = tsdbStatus(e), done = ["FT", "AET", "PEN"].includes(short), live = ["1H", "HT", "2H", "ET", "P"].includes(short);
  return {
    fixture: { id: "t:" + String(e.idEvent || ""), date: tsdbEventTime(e), status: { short, elapsed: live ? elapsedMinutes(e.strProgress || e.intProgress) : null }, venue: e.strVenue ? { name: e.strVenue } : null },
    league: { id: meta[1] || "t:" + String(e.idLeague || ""), code, name: meta[2], country: meta[3], round: e.strRound || "", logo: "" },
    teams: { home: { id: e.idHomeTeam || "h", name: e.strHomeTeam || "", logo: e.strHomeTeamBadge || "" }, away: { id: e.idAwayTeam || "a", name: e.strAwayTeam || "", logo: e.strAwayTeamBadge || "" } },
    goals: { home: e.intHomeScore == null || e.intHomeScore === "" ? null : Number(e.intHomeScore), away: e.intAwayScore == null || e.intAwayScore === "" ? null : Number(e.intAwayScore) },
  };
}
async function tsdbLeagueFixtures(env, code, year) {
  const id = TSDB_LEAGUE_IDS[code];
  if (!id) return [];
  const season = year + "-" + (year + 1);
  if (tsdbPremiumKey(env)) {
    const data = await cached("tsdb-v2-season-fixtures:" + id + ":" + season, async () => ({
      body: await tsdbPremiumJSON(env, "schedule/league/" + id + "/" + season), ttl: 1800,
    }));
    return (data.body.schedule || data.body.events || data.body.response || []).map(e => tsdbLeagueEvent(e, code))
      .filter(m => /^t:\d+$/.test(m.fixture.id) && m.teams.home.name && m.teams.away.name)
      .sort((a, b) => Date.parse(a.fixture.date) - Date.parse(b.fixture.date));
  }
  const data = await cached("tsdb-season-fixtures:" + id + ":" + year, async () => {
    const response = await fetch(TSDB + "eventsseason.php?" + new URLSearchParams({ id, s: season }), { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(response.status === 429 ? "TheSportsDB istek sınırı doldu; daha sonra yeniden deneyin" : "TheSportsDB HTTP " + response.status);
    return { body: await response.json(), ttl: 1800 };
  });
  const rows = (data.body.events || []).map(e => tsdbLeagueEvent(e, code)).filter(m => /^t:\d+$/.test(m.fixture.id) && m.teams.home.name && m.teams.away.name).sort((a, b) => Date.parse(a.fixture.date) - Date.parse(b.fixture.date));
  // The free v1 season endpoint is capped; disclose that instead of presenting a short list as complete.
  rows.forEach(m => { m.league.fixturesLimited = true; });
  return rows;
}
function apiFootballStatus(value) {
  return ({ TBD:"NS", NS:"NS", "1H":"1H", HT:"HT", "2H":"2H", ET:"ET", BT:"HT", P:"P", LIVE:"1H", SUSP:"SUSP", INT:"INT", FT:"FT", AET:"AET", PEN:"PEN", PST:"PST", CANC:"CANC", ABD:"ABD", AWD:"FT", WO:"FT" })[String(value || "").toUpperCase()] || "NS";
}
function apiFootballFixtureMatch(x, code) {
  const f=x.fixture||{}, teams=x.teams||{}, status=apiFootballStatus(f.status&&f.status.short), live=["1H","HT","2H","ET","P","INT"].includes(status);
  const leagueId=String(x.league&&x.league.id||""), matchCode=code||(/^\d+$/.test(leagueId)?"af-"+leagueId:""), meta=META[code]||[matchCode,null,x.league&&x.league.name||code,x.league&&x.league.country||""];
  const roundText=String(x.league&&x.league.round||"");
  const roundNumber=(roundText.match(/(?:regular season|league stage)\s*[-–:]\s*(\d+)|(?:matchday|week|round|hafta)\D*(\d+)/i)||[]);
  return { matchday: Number(x.matchday||x.league&&x.league.matchday||roundNumber[1]||roundNumber[2])||null, fixture:{id:"a:"+String(f.id||""),date:f.date,status:{short:status,elapsed:live?f.status&&f.status.elapsed:null},venue:f.venue&&f.venue.name?{name:f.venue.name,city:f.venue.city||"",country:x.league&&x.league.country||""}:null},
    league:{id:meta[1]||"a:"+leagueId,code:matchCode,name:meta[2],country:meta[3],afId:leagueId,season:Number(x.league&&x.league.season)||null,round:x.league&&x.league.round||"",logo:x.league&&x.league.logo||""},
    referee:f.referee||"", broadcasts:matchBroadcasts(x.broadcasts, f.broadcasts),
    teams:{home:{id:teams.home&&teams.home.id||"h",name:teams.home&&teams.home.name||"",logo:teams.home&&teams.home.logo||""},away:{id:teams.away&&teams.away.id||"a",name:teams.away&&teams.away.name||"",logo:teams.away&&teams.away.logo||""}},
    goals:{home:!x.goals||x.goals.home==null?null:Number(x.goals.home),away:!x.goals||x.goals.away==null?null:Number(x.goals.away)} };
}
async function apiFootballLeagueFixtures(env, code, year) {
  const id=(META[code]||[])[1]; if(!id||!apiFootballKey(env))return [];
  const data=await cached("af-league-fixtures:v2:"+code+":"+year,async()=>({body:await apiFootballPaged(env,"/fixtures",{league:String(id),season:String(year)},20),ttl:21600}));
  const rows=(data.body.response||[]).map(x=>apiFootballFixtureMatch(x,code)).filter(m=>/^a:\d+$/.test(m.fixture.id)&&m.teams.home.name&&m.teams.away.name).sort((a,b)=>Date.parse(a.fixture.date)-Date.parse(b.fixture.date));
  if (data.body.limited) rows.forEach(m=>{m.league.fixturesLimited=true;});
  return rows;
}
const FOOTBALL_DATA_CODES = {
  "eng.1":"PL", "eng.2":"ELC", "esp.1":"PD", "ger.1":"BL1", "ita.1":"SA", "fra.1":"FL1",
  "tur.1":"TSL", "uefa.champions":"CL", "uefa.europa":"EL", "uefa.europa.conf":"UCL",
};
const FOOTBALL_DATA_TO_ESPN = Object.fromEntries(Object.entries(FOOTBALL_DATA_CODES).map(([code, value]) => [value, code]));
const footballDataToken = env => env && env.FOOTBALL_DATA_TOKEN || "";
async function footballDataJSON(env, path, extraHeaders = {}) {
  const token = footballDataToken(env);
  if (!token) throw new Error("FOOTBALL_DATA_TOKEN tanımlı değil");
  const r = await fetch("https://api.football-data.org/v4" + path, {
    headers: { "X-Auth-Token": token, Accept: "application/json", ...extraHeaders }, signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error("football-data.org HTTP " + r.status);
  return r.json();
}
function footballDataStatus(value) {
  return ({ SCHEDULED:"NS", TIMED:"NS", IN_PLAY:"1H", PAUSED:"HT", EXTRA_TIME:"ET", PENALTY_SHOOTOUT:"PEN", FINISHED:"FT", SUSPENDED:"SUSP", POSTPONED:"PST", CANCELLED:"CANC", AWARDED:"FT" })[String(value || "").toUpperCase()] || "NS";
}
function footballDataFixtureMatch(x, code) {
  const meta = META[code] || [code, null, x.competition && x.competition.name || code, x.area && x.area.name || ""];
  const round = x.matchday ? "Hafta " + x.matchday : x.stage || x.group || "";
  const status = footballDataStatus(x.status), score = x.score || {}, full = score.fullTime || {};
  return {
    source: "football-data.org",
    matchday: Number(x.matchday)||null,
    fixture: { id: "fd:" + String(x.id || ""), date: x.utcDate || x.date, status: { short: status, elapsed: null }, venue: x.venue ? { name: x.venue, city: x.venueCity || "" } : null },
    league: { id: x.competition && x.competition.id || meta[1] || "fd:" + (FOOTBALL_DATA_CODES[code] || code), code, name: meta[2], country: meta[3], round, logo: x.competition && x.competition.emblem || "" },
    teams: {
      home: { id: x.homeTeam && x.homeTeam.id || "h", name: x.homeTeam && x.homeTeam.name || "", logo: x.homeTeam && x.homeTeam.crest || "" },
      away: { id: x.awayTeam && x.awayTeam.id || "a", name: x.awayTeam && x.awayTeam.name || "", logo: x.awayTeam && x.awayTeam.crest || "" },
    },
    goals: { home: ["NS"].includes(status) || full.home == null ? null : Number(full.home), away: ["NS"].includes(status) || full.away == null ? null : Number(full.away) },
    referee: ((x.referees || []).find(r => !r.type || /MAIN|REFEREE/i.test(String(r.type))) || {}).name || "",
    broadcasts: matchBroadcasts(x.broadcasts),
  };
}
async function apiFootballLeagueSeasons(env, code) {
  const id = (META[code] || [])[1];
  if (!id || !apiFootballKey(env)) return recentSeasonYears(20);
  try {
    const data = await cached("af-league-seasons:v1:" + id, async () => ({
      body: await apiFootballJSON(env, "/leagues", { id: String(id) }), ttl: 86400,
    }));
    const years = (data.body.response || []).flatMap(x => x.seasons || []).map(x => Number(x.year))
      .filter(y => Number.isInteger(y) && y >= 1900 && y <= seasonStartYear() + 1);
    return years.length ? [...new Set(years)].sort((a,b)=>b-a).slice(0,30) : recentSeasonYears(20);
  } catch (_) { return recentSeasonYears(20); }
}
async function apiFootballTeamSeasons(env, teamId) {
  if (!apiFootballKey(env) || !/^\d+$/.test(String(teamId || ""))) return [];
  const data = await cached("af-team-seasons:v2:" + teamId, async () => ({
    body: await apiFootballJSON(env, "/teams/seasons", { team: String(teamId) }), ttl: 86400,
  }));
  return [...new Set((data.body.response || []).map(Number).filter(y => Number.isInteger(y) && y >= 1900 && y <= seasonStartYear() + 1))].sort((a,b)=>b-a).slice(0,30);
}
function apiFootballStandingsRows(data) {
  const out = [];
  for (const item of data && data.response || []) {
    const blocks = item.league && Array.isArray(item.league.standings) ? item.league.standings : [];
    for (const block of blocks) {
      const rows = (block || []).map((x, i) => {
        const all = x.all || {}, goals = all.goals || {};
        return {
          rank: x.rank == null ? i + 1 : x.rank,
          team: { id: x.team && x.team.id != null ? String(x.team.id) : "", name: x.team && x.team.name || "", logo: x.team && x.team.logo || "", afId: x.team && x.team.id != null ? String(x.team.id) : "" },
          points: x.points == null ? null : Number(x.points),
          diff: x.goalsDiff == null ? (Number(goals.for)||0) - (Number(goals.against)||0) : Number(x.goalsDiff),
          played: all.played == null ? null : Number(all.played),
          win: all.win == null ? null : Number(all.win), draw: all.draw == null ? null : Number(all.draw), lose: all.lose == null ? null : Number(all.lose),
          desc: x.description || "",
        };
      }).filter(x => x.team.name);
      if (rows.length) out.push({ name: "", rows });
    }
  }
  return out;
}
async function apiFootballStandings(env, code, year, teamId = "") {
  if (!apiFootballKey(env)) return [];
  const dynamic = String(code || "").match(/^af-(\d+)$/i);
  const leagueId = dynamic ? dynamic[1] : (META[code] || [])[1];
  if (!leagueId && !/^\d+$/.test(String(teamId || ""))) return [];
  const useTeam = /^\d+$/.test(String(teamId || ""));
  const params = useTeam ? { team: String(teamId), season: String(year) } : { league: String(leagueId), season: String(year) };
  const key = useTeam ? "af-team-standings:v4:" + teamId + ":" + year : "af-standings:v5:" + leagueId + ":" + year;
  const data = await cached(key, async () => ({ body: await apiFootballJSON(env, "/standings", params), ttl: 1800 }));
  return apiFootballStandingsRows(data.body);
}
async function apiFootballStandingsForTeam(env, code, year, teamId) {
  if (!apiFootballKey(env) || !/^\d+$/.test(String(teamId || ""))) return [];
  try {
    const byTeam = await apiFootballStandings(env, code, year, teamId);
    if (byTeam.length) return byTeam;
  } catch (_) {}
  if (code && META[code]) {
    try {
      const byLeague = await apiFootballStandings(env, code, year);
      if (byLeague.length) return byLeague;
    } catch (_) {}
  }
  // A team may participate in a league whose ESPN code is not in our static map.
  // Discover its league IDs from that season's fixtures, then request each table.
  try {
    const fixtures = await apiFootballTeamFixtures(env, teamId, year);
    const ids = [...new Set((fixtures.rows || []).map(m => {
      const id = String(m.league && m.league.id || "");
      return /^\d+$/.test(id) ? id : (id.match(/^a:(\d+)$/) || [])[1] || "";
    }).filter(Boolean))].slice(0, 12);
    const tables = [];
    for (let i = 0; i < ids.length; i += 4) {
      const batch = await Promise.all(ids.slice(i, i + 4).map(async id => {
        try {
          const result = await cached("af-discovered-standings:v1:" + id + ":" + year, async () => ({ body: await apiFootballJSON(env, "/standings", { league: id, season: String(year) }), ttl: 1800 }));
          return apiFootballStandingsRows(result.body);
        } catch (_) { return []; }
      }));
      for (const groups of batch) for (const group of groups) {
        if ((group.rows || []).some(row => String(row.team && row.team.afId || "") === String(teamId))) tables.push(group);
      }
    }
    if (tables.length) return tables;
  } catch (_) {}
  return [];
}
function apiFootballTeamMatch(x) {
  const league = x.league || {}, code = espnCodeFromAfLeague(league.id);
  return apiFootballFixtureMatch(x, code);
}
async function apiFootballTeamFixtures(env, teamId, year) {
  if (!apiFootballKey(env) || !/^\d+$/.test(String(teamId || ""))) return { rows: [], limited: false };
  const data = await cached("af-team-fixtures:v3:" + teamId + ":" + year, async () => ({
    // Team fixtures span league, domestic cups and continental cups. Fetch all
    // available pages (20 max) instead of silently stopping after page 8.
    body: await apiFootballPaged(env, "/fixtures", { team: String(teamId), season: String(year) }, 20), ttl: 21600,
  }));
  const rows = (data.body.response || []).map(apiFootballTeamMatch)
    .filter(m => /^a:\d+$/.test(m.fixture.id) && m.teams.home.name && m.teams.away.name)
    .sort((a,b)=>Date.parse(a.fixture.date)-Date.parse(b.fixture.date));
  return { rows, limited: !!data.body.limited };
}
function groupTeamFixtures(rows) {
  const valid = (rows || []).filter(match => match && match.fixture && match.teams && match.teams.home && match.teams.away);
  const groups = new Map();
  for (const match of valid) {
    const name = match.league && match.league.name || "Diğer";
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(match);
  }
  const sortMatches = matches => matches.sort((a,b)=>Date.parse(a.fixture.date)-Date.parse(b.fixture.date));
  const all = new Map();
  for (const match of valid) all.set(String(match.fixture.id), match);
  const combined = sortMatches([...all.values()]);
  const competitions = [...groups.entries()].map(([name, matches]) => ({ name, matches: sortMatches(matches) }));
  return combined.length ? [{ name: "Tüm Maçlar", matches: combined }, ...competitions] : competitions;
}
function apiFootballRosterRows(data) {
  return (data && data.response || []).map(entry => {
    const p = entry.player || {}, stats = (entry.statistics || [])[0] || {}, games = stats.games || {};
    const id = p.id == null ? "" : String(p.id), photo = p.photo || "", fallbackPhoto = id ? "https://media.api-sports.io/football/players/" + id + ".png" : "";
    return { name: p.name || [p.firstname,p.lastname].filter(Boolean).join(" "), number: games.number || "", pos: games.position || p.position || "", age: p.age || "", nat: p.nationality || "", photo: photo || fallbackPhoto, photos: [photo, fallbackPhoto].filter((x,i,a)=>x&&a.indexOf(x)===i), afPlayerId: id };
  }).filter(p => p.name);
}
async function enrichRosterPhotos(players, teamName = "") {
  const names = (players || []).map(p => p.name).filter(Boolean);
  const wiki = names.length ? await wikiPhotos(names).catch(() => ({})) : {};
  const needsExtra = (players || []).filter(player => {
    const existing = [...(player.photos || []), player.photo].filter(Boolean);
    return !existing.some(url => !/media\.api-sports\.io/.test(url));
  });
  const tsdb = {};
  // TheSportsDB only queries players without an independent portrait; cap concurrency.
  for (let i = 0; i < needsExtra.length; i += 5) {
    await Promise.all(needsExtra.slice(i, i + 5).map(async player => {
      const photo = await tsdbRosterPhoto(player.name, teamName);
      if (photo) tsdb[player.name] = photo;
    }));
  }
  for (const player of players || []) {
    const apiPhoto = player.afPlayerId ? "https://media.api-sports.io/football/players/" + player.afPlayerId + ".png" : "";
    const afPhoto = (player.photos || []).find(url => /media\.api-sports\.io/.test(url)) || apiPhoto;
    const providerPhoto = player.photo && player.photo !== afPhoto ? player.photo : "";
    const knownPhoto = ROSTER_KNOWN_PHOTOS[nkw(player.name)] || "";
    const candidates = [knownPhoto, providerPhoto, tsdb[player.name], wiki[player.name], ...(player.photos || []), player.photo, afPhoto]
      .filter((x,i,a) => typeof x === "string" && /^https?:\/\//i.test(x) && a.indexOf(x) === i);
    player.photos = candidates;
    player.photo = candidates[0] || "";
  }
  return players || [];
}
function rosterNameParts(name) {
  return nkw(name).replace(/\b(jr|sr|ii|iii|iv)\b/g, " ").split(/\s+/).filter(Boolean);
}
function findRosterPhotoFallback(player, fallbacks) {
  const key = nkw(player && player.name);
  if (!key) return null;
  const exact = (fallbacks || []).filter(x => nkw(x.name) === key);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;
  // Kaynaklardan biri ilk adını baş harfe kısaltmışsa yalnızca soyadı + baş harf
  // tek bir oyuncuya karşılık gelirse görseli eşleştir.
  const parts = rosterNameParts(player.name);
  if (parts.length < 2) return null;
  const last = parts[parts.length - 1], initial = parts[0][0];
  const possible = (fallbacks || []).filter(x => {
    const p = rosterNameParts(x.name);
    return p.length >= 2 && p[p.length - 1] === last && p[0][0] === initial;
  });
  return possible.length === 1 ? possible[0] : null;
}
function mergeRosterPhotoSources(primary, photoSource) {
  const fallback = photoSource || [];
  const rows = (primary || []).map(player => {
    const match = findRosterPhotoFallback(player, fallback);
    const exact = fallback.filter(x => nkw(x.name) === nkw(player.name));
    const same = exact.length === 1 ? exact[0] : match;
    const knownPhoto = ROSTER_KNOWN_PHOTOS[nkw(player.name)] || "";
    const photos = [
      knownPhoto,
      ...(same && Array.isArray(same.photos) ? same.photos : []),
      same && same.photo,
      ...(Array.isArray(player.photos) ? player.photos : []),
      player.photo,
    ].filter((x,i,a) => typeof x === "string" && /^https?:\/\//i.test(x) && a.indexOf(x) === i);
    return { ...(same || {}), ...player,
      number: player.number || (same && same.number) || "", pos: player.pos || (same && same.pos) || "",
      age: player.age || (same && same.age) || "", nat: player.nat || (same && same.nat) || "",
      espnPlayerId: player.espnPlayerId || (same && same.espnPlayerId) || "",
      tsdb: player.tsdb || (same && same.tsdb) || "", photo: photos[0] || "", photos };
  });
  // The second provider is not merely a photo source: append players absent from the primary roster.
  const known = new Set(rows.map(x => nkw(x.name)));
  for (const item of fallback) {
    const key = nkw(item && item.name);
    if (!key || known.has(key)) continue;
    rows.push({ ...item, photos: [...new Set([...(item.photos || []), item.photo].filter(x => typeof x === "string" && /^https?:\/\//i.test(x)))], photo: item.photo || (item.photos || [])[0] || "" });
    known.add(key);
  }
  return rows;
}

async function apiFootballCurrentSquad(env, teamId, teamName = "") {
  const data = await cached("af-current-squad:v3:" + teamId, async () => ({
    body: await apiFootballJSON(env, "/players/squads", { team: String(teamId) }), ttl: 21600,
  }));
  const entries = (data.body.response || []).flatMap(x => x.players || []);
  const players = entries.map(p => {
    const id = p.id == null ? "" : String(p.id);
    const direct = p.photo || (id ? "https://media.api-sports.io/football/players/" + id + ".png" : "");
    return { name: p.name || "", number: p.number || "", pos: p.position || "", age: p.age || "", nat: p.nationality || "",
      photo: direct, photos: direct ? [direct] : [], afPlayerId: id };
  }).filter(p => p.name);
  return { players: await enrichRosterPhotos(players, teamName), limited: false, note: "Güncel kadro sağlayıcının resmî takım kadrosudur." };
}
async function apiFootballRoster(env, teamId, year, teamName = "") {
  const data = await apiFootballPaged(env, "/players", { team: String(teamId), season: String(year) }, 5);
  const players = await enrichRosterPhotos(apiFootballRosterRows(data), teamName);
  return { players, limited: !!data.limited, note: "Geçmiş sezon listesi, o sezon için istatistik kaydı bulunan oyunculardan oluşur; hiç süre almamış veya kaydı bulunmayan sözleşmeli oyuncular eksik olabilir." };
}
async function footballDataLeagueFixtures(env, code, year) {
  const competition = FOOTBALL_DATA_CODES[code];
  if (!competition || !footballDataToken(env)) return [];
  const data = await cached("fd-fixtures:" + competition + ":" + year, async () => ({
    body: await footballDataJSON(env, "/competitions/" + competition + "/matches?season=" + year), ttl: 1800,
  }));
  return (data.body.matches || []).map(x => footballDataFixtureMatch(x, code))
    .filter(m => /^fd:\d+$/.test(m.fixture.id) && m.teams.home.name && m.teams.away.name)
    .sort((a, b) => Date.parse(a.fixture.date) - Date.parse(b.fixture.date));
}
async function footballDataLeagueLeaders(env, code, year, kind) {
  const competition = FOOTBALL_DATA_CODES[code];
  if (!competition || !footballDataToken(env)) return [];
  const data = await cached("fd-leaders:" + competition + ":" + year, async () => ({
    body: await footballDataJSON(env, "/competitions/" + competition + "/scorers?season=" + year + "&limit=50"), ttl: 900,
  }));
  const rows = (data.body.scorers || []).map(x => ({ player: x.player && x.player.name || "", team: x.team && x.team.name || "", logo: x.player && x.player.id ? "" : "", value: kind === "goals" ? x.goals : x.assists, source: "football-data.org" }))
    .filter(x => x.player && x.value != null && Number.isFinite(Number(x.value)) && (kind === "goals" || Number(x.value) > 0))
    .sort((a, b) => Number(b.value) - Number(a.value) || a.player.localeCompare(b.player));
  return rows.slice(0, 50).map((x, i) => ({ ...x, value: Number(x.value), rank: i + 1 }));
}
async function leagueFixtures(env, code, year) {
  const espnFixtures = async () => {
    const per = await Promise.allSettled(seasonMonths(year).map(([from, to]) => getJSON(SITE + code + "/scoreboard?dates=" + from + "-" + to + "&limit=1000")));
    const events = new Map(); let ok = 0;
    for (const result of per) if (result.status === "fulfilled") {
      ok++;
      for (const event of result.value.events || []) events.set(String(event.id), event);
    }
    if (!ok) throw new Error("ESPN sezon fikstürünü vermedi");
    return [...events.values()].map(event => { try { return listMatch(code, event); } catch (_) { return null; } }).filter(Boolean);
  };
  const results = await Promise.allSettled([
    apiFootballLeagueFixtures(env, code, year),
    espnFixtures(),
    tsdbLeagueFixtures(env, code, year),
    footballDataLeagueFixtures(env, code, year),
  ]);
  const groups = results.filter(x => x.status === "fulfilled").map(x => x.value);
  const merged = mergeFixtureRows(groups);
  if (merged.length) return merged.sort((a, b) => Date.parse(a.fixture.date) - Date.parse(b.fixture.date));
  const errors = results.filter(x => x.status === "rejected").map(x => x.reason && x.reason.message).filter(Boolean);
  if (errors.length) throw new Error("Fikstür kaynakları yanıt vermedi: " + errors.join(" · "));
  return [];
}
function fixturePairKey(m) {
  return [m && m.teams && m.teams.home && nkp(m.teams.home.name), m && m.teams && m.teams.away && nkp(m.teams.away.name)].join("|");
}
function mergeFixtureRows(groups) {
  const rows = [], byPair = new Map();
  for (const group of groups) for (const incoming of group || []) {
    if (!incoming || !incoming.fixture || !incoming.teams || !incoming.teams.home || !incoming.teams.away) continue;
    const pair = fixturePairKey(incoming), time = Date.parse(incoming.fixture.date);
    const candidates = byPair.get(pair) || [];
    const existing = candidates.find(x => {
      const other = Date.parse(x.fixture.date);
      return Number.isFinite(time) && Number.isFinite(other) && Math.abs(time - other) <= 36 * 3600e3;
    });
    if (!existing) {
      if (incoming.source && !(incoming.sources || []).includes(incoming.source)) incoming.sources = [...(incoming.sources || []), incoming.source];
      rows.push(incoming);
      if (!byPair.has(pair)) byPair.set(pair, []);
      byPair.get(pair).push(incoming);
      continue;
    }
    if (incoming.source) {
      existing.sources = existing.sources || [];
      if (!existing.sources.includes(incoming.source)) existing.sources.push(incoming.source);
    }
    if (existing.matchday == null && incoming.matchday != null) existing.matchday = incoming.matchday;
    if (!existing.league.round && incoming.league && incoming.league.round) existing.league.round = incoming.league.round;
    for (const side of ["home", "away"]) {
      if (!existing.teams[side].logo && incoming.teams[side] && incoming.teams[side].logo) existing.teams[side].logo = incoming.teams[side].logo;
      if (!existing.teams[side].id && incoming.teams[side] && incoming.teams[side].id) existing.teams[side].id = incoming.teams[side].id;
    }
    const oldStatus = existing.fixture.status && existing.fixture.status.short;
    const newStatus = incoming.fixture.status && incoming.fixture.status.short;
    if ((!oldStatus || oldStatus === "NS") && newStatus && newStatus !== "NS") existing.fixture.status = incoming.fixture.status;
    if (!existing.fixture.venue && incoming.fixture.venue) existing.fixture.venue = incoming.fixture.venue;
    if (existing.goals && incoming.goals) {
      if (existing.goals.home == null && incoming.goals.home != null) existing.goals.home = incoming.goals.home;
      if (existing.goals.away == null && incoming.goals.away != null) existing.goals.away = incoming.goals.away;
    }
  }
  return rows.sort((a, b) => Date.parse(a.fixture.date) - Date.parse(b.fixture.date));
}
function leaderNumber(v) {
  if (v && typeof v === "object") v = v.value ?? v.displayValue ?? v.total;
  if (v == null || String(v).trim() === "") return null;
  const n = Number(String(v == null ? "" : v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}
function leaderRows(doc, kind, assumed = false) {
  const out = [], isKind = s => kind === "goals" ? /goal|scor|\bgls\b|^g$/i.test(String(s || "").trim()) : /assist|^ast$|^a$/i.test(String(s || "").trim());
  const seen = new Set();
  const walk = (value, inherited, depth, inheritedLabels = []) => {
    if (!value || depth > 8) return;
    if (Array.isArray(value)) { value.forEach(x => walk(x, inherited, depth + 1, inheritedLabels)); return; }
    if (typeof value !== "object") return;
    const labels = [value.abbreviation, value.statName, value.category, value.displayName, value.name, value.title].filter(x => typeof x === "string");
    const localKind = labels.find(isKind) || inherited;
    const statLabels = Array.isArray(value.labels) ? value.labels : inheritedLabels;
    const athlete = value.athlete || value.player || value.person || value.competitor;
    if (athlete && typeof athlete === "object" && (assumed || isKind(localKind))) {
      const name = athlete.displayName || athlete.fullName || athlete.name || athlete.shortName || "";
      let val = leaderNumber(value.value ?? value.displayValue ?? value.stat ?? value.total ?? value.statistics?.[kind]);
      if (val == null && Array.isArray(value.stats)) {
        const i = statLabels.findIndex(isKind);
        if (i >= 0) val = leaderNumber(value.stats[i]);
      }
      if (val == null && value.statistics && typeof value.statistics === "object") {
        const entry = Object.entries(value.statistics).find(([key, stat]) => isKind(key) || isKind(stat && (stat.name || stat.displayName || stat.category)));
        if (entry) val = leaderNumber(entry[1]);
      }
      if (name && val != null) {
        const key = nkp(name);
        if (!seen.has(key)) {
          seen.add(key);
          const team = value.team || athlete.team || {};
          out.push({ rank: Number(value.rank || value.rankDisplayValue) || out.length + 1, player: name, team: typeof team === "string" ? team : (team.displayName || team.name || ""), value: val, logo: athlete.headshot?.href || athlete.headshot || athlete.image?.href || "" });
        }
      }
    }
    for (const [key, child] of Object.entries(value)) walk(child, isKind(key) ? key : localKind, depth + 1, statLabels);
  };
  walk(doc, "", 0);
  return out.sort((a, b) => b.value - a.value || a.player.localeCompare(b.player));
}
const WORLD_FOOTBALL_COMPETITIONS = {
  "eng.1": ["co91", "england-premier-league"], "esp.1": ["co97", "spain-primera-division"],
  "ger.1": ["co12", "germany-bundesliga"], "ita.1": ["co111", "italy-serie-a"],
  "fra.1": ["co71", "france-ligue-1"], "tur.1": ["co116", "turkey-sueperlig"],
  "uefa.champions": ["co19", "uefa-champions-league"], "uefa.europa": ["co132", "uefa-europa-league"],
  "uefa.europa.conf": ["co6395", "uefa-conference-league"],
};
async function worldFootballHTML(url) {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(url, { headers: {
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36",
        Referer: "https://www.worldfootball.net/",
      }, signal: AbortSignal.timeout(10000) });
      if (r.ok) return r.text();
      if (attempt >= 1 || !(r.status === 429 || r.status >= 500)) throw new Error("worldfootball.net HTTP " + r.status);
    } catch (e) {
      if (attempt >= 1 || !/worldfootball\.net HTTP (429|5\d\d)/.test(String(e.message))) throw e;
    }
    await sleep(500);
  }
}
function worldFootballText(value) {
  return String(value || "").replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, " ")
    .replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&nbsp;|&#160;/gi, " ").replace(/&amp;/gi, "&").replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&auml;/gi, "ä").replace(/&ouml;/gi, "ö").replace(/&uuml;/gi, "ü").replace(/&szlig;/gi, "ß")
    .replace(/&Auml;/g, "Ä").replace(/&Ouml;/g, "Ö").replace(/&Uuml;/g, "Ü").replace(/&eacute;/gi, "é")
    .replace(/&egrave;/gi, "è").replace(/&ecirc;/gi, "ê").replace(/&aacute;/gi, "á").replace(/&agrave;/gi, "à")
    .replace(/&iacute;/gi, "í").replace(/&oacute;/gi, "ó").replace(/&uacute;/gi, "ú").replace(/&ccedil;/gi, "ç")
    .replace(/&ntilde;/gi, "ñ").replace(/&atilde;/gi, "ã").replace(/&otilde;/gi, "õ").replace(/&aring;/gi, "å")
    .replace(/\s+/g, " ").trim();
}
function worldFootballLeaderRows(html, kind) {
  const metric = kind === "goals" ? /^(?:scores?|goals?)$/i : /^assists?$/i;
  for (const table of html.matchAll(/<table\b[\s\S]*?<\/table>/gi)) {
    const trs = [...table[0].matchAll(/<tr\b[\s\S]*?<\/tr>/gi)].map(x => x[0]);
    const cells = tr => [...tr.matchAll(/<(?:td|th)\b[^>]*>([\s\S]*?)<\/(?:td|th)>/gi)].map(x => worldFootballText(x[1]));
    const hi = trs.findIndex(tr => { const h = cells(tr); return h.some(x => /^player$/i.test(x)) && h.some(x => metric.test(x)); });
    if (hi < 0) continue;
    const headers = cells(trs[hi]), metricIndex = headers.findIndex(x => metric.test(x));
    const teamIndex = headers.findIndex(x => /^team$/i.test(x));
    const playerIndices = headers.map((x, i) => /^player$/i.test(x) ? i : -1).filter(i => i >= 0);
    const rows = [], seen = new Set();
    for (const tr of trs.slice(hi + 1)) {
      const row = cells(tr); if (row.length <= metricIndex) continue;
      const links = [...tr.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)].map(x => ({ href: x[1], text: worldFootballText(x[2]) }));
      const playerLink = links.find(x => /\/player\//i.test(x.href));
      const teamLink = links.find(x => /\/team\//i.test(x.href));
      const player = playerLink && playerLink.text || row[playerIndices[playerIndices.length - 1] >= 0 ? playerIndices[playerIndices.length - 1] : 0] || "";
      const team = teamLink && teamLink.text || (teamIndex >= 0 ? row[teamIndex] : "") || "";
      const value = Number((String(row[metricIndex] || "").match(/\d+/) || [])[0]);
      if (!player || !Number.isFinite(value)) continue;
      const key = nkp(player) + "|" + nkp(team);
      if (seen.has(key)) continue;
      seen.add(key);
      const rank = Number((row[0] || "").match(/\d+/)?.[0]) || rows.length + 1;
      rows.push({ rank, player, team, value, logo: "" });
    }
    if (rows.length) return rows.sort((a, b) => b.value - a.value || a.rank - b.rank).slice(0, 50).map((x, i) => ({ ...x, rank: x.rank || i + 1 }));
  }
  return [];
}
async function worldFootballLeagueLeaders(code, year, kind) {
  const comp = WORLD_FOOTBALL_COMPETITIONS[code];
  if (!comp) return [];
  const [id, slug] = comp, stats = kind === "goals" ? ["scorers", "goals"] : ["assists"];
  const key = "worldfootball-leaders:v1:" + code + ":" + year + ":" + kind;
  const data = await cached(key, async () => {
    const yearEnd = year + 1;
    let lastError = "";
    for (const stat of stats) {
      try {
        const base = "https://www.worldfootball.net/competition/" + id + "/" + slug + "/statistics-" + stat + "/";
        let html = await worldFootballHTML(base);
        const route = new RegExp("href=[\\\"']([^\\\"']*\\/competition\\/" + id + "\\/" + slug + "\\/se\\d+\\/" + year + "[-/]" + yearEnd + "\\/statistics-" + stat + "\\/?)", "i");
        const seasonLink = html.match(route);
        if (seasonLink) {
          const target = /^https?:/i.test(seasonLink[1]) ? seasonLink[1] : "https://www.worldfootball.net" + seasonLink[1];
          html = await worldFootballHTML(target);
        } else {
          const title = worldFootballText((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "");
          const season = title.match(/(20\d{2})\s*[\/-]\s*(?:20)?(\d{2,4})/);
          if (season && Number(season[1]) !== year) throw new Error("worldfootball.net " + season[1] + "/" + season[2] + " sezonunu gösteriyor; istenen " + year + "/" + yearEnd + " bulunamadı");
        }
        const rows = worldFootballLeaderRows(html, kind);
        if (rows.length) return { body: rows, ttl: 3600 };
        lastError = "worldfootball.net sayfasında " + (kind === "goals" ? "gol" : "asist") + " tablosu bulunamadı";
      } catch (e) { lastError = e && e.message || String(e); }
    }
    throw new Error(lastError || "worldfootball.net lider tablosu alınamadı");
  });
  return data.body;
}
async function leagueLeaders(env, code, year, kind) {
  let apiFootballError = "";
  try {
    const alternate = await apiFootballLeagueLeaders(env, code, year, kind);
    if (alternate.length) return alternate;
    if (apiFootballKey(env)) {
      const id = (META[code] || [])[1];
      apiFootballError = id ? "API-Football bu lig/sezon için " + kind + " listesi döndürmedi (lig " + id + ", sezon " + year + ")" : "API-Football için bu lige ait ID eşlemesi yok";
    }
  } catch (e) {
    const message = e && e.message || String(e);
    apiFootballError = /HTTP 429|Too many requests|rateLimit|per minute/i.test(message)
      ? "API-Football dakikalık istek sınırı doldu; en az 60 saniye bekleyip yeniden deneyin"
      : "API-Football: " + message;
  }
  let footballDataError = "";
  try {
    const alternate = await footballDataLeagueLeaders(env, code, year, kind);
    if (alternate.length) return alternate;
  } catch (e) { footballDataError = e && e.message || String(e); }
  let worldFootballError = "";
  try {
    const alternate = await worldFootballLeagueLeaders(code, year, kind);
    if (alternate.length) return alternate;
  } catch (e) { worldFootballError = e && e.message || String(e); }
  const paths = [
    "https://site.web.api.espn.com/apis/common/v3/sports/soccer/" + code + "/statistics/byathlete?" + new URLSearchParams({ category: kind, sort: kind + ":desc", limit: "50", season: String(year), seasontype: "2" }),
    SOCCER_CORE + code + "/seasons/" + year + "/leaders?limit=50",
    SITE + code + "/leaders?season=" + year,
  ];
  let last = "lider verisi yok";
  for (const url of paths) {
    try {
      const data = await getJSON(url);
      const rows = leaderRows(data, kind, /statistics\/byathlete/.test(url));
      if (rows.length) return rows.slice(0, 50);
      last = "yanıtta " + kind + " alanı yok";
    } catch (e) { last = e.message || String(e); }
  }
  const setup = !apiFootballKey(env) && !footballDataToken(env) ? ". Worker'a API_FOOTBALL_KEY (veya APISPORTS_KEY/API_KEY) ya da FOOTBALL_DATA_TOKEN gizli değişkeni eklenmeli." : "";
  const sourceErrors = [footballDataError && "football-data.org: " + footballDataError, worldFootballError && "worldfootball.net: " + worldFootballError, apiFootballError].filter(Boolean);
  if (/HTTP 404/i.test(last) && !apiFootballKey(env)) throw new Error("ESPN bu lig için lider verisi sunmuyor" + (sourceErrors.length ? "; " + sourceErrors.join("; ") : "") + setup);
  throw new Error([last, ...sourceErrors].filter(Boolean).join("; ") + setup);
}
async function apiFootballLeagueDataById(env, id, year) {
  if (!apiFootballKey(env)) throw new Error("Bu lig için API_FOOTBALL_KEY gerekli.");
  const code = "af-" + String(id);
  const [metaR, tablesR, fixturesR, goalsR, assistsR] = await Promise.allSettled([
    apiFootballJSON(env, "/leagues", { id: String(id) }),
    apiFootballJSON(env, "/standings", { league: String(id), season: String(year) }),
    apiFootballPaged(env, "/fixtures", { league: String(id), season: String(year) }, 20),
    apiFootballJSON(env, "/players/topscorers", { league: String(id), season: String(year) }),
    apiFootballJSON(env, "/players/topassists", { league: String(id), season: String(year) }),
  ]);
  const metaItem = metaR.status === "fulfilled" ? (metaR.value.response || [])[0] || {} : {};
  const league = metaItem.league || {}, country = metaItem.country || {};
  const name = league.name || code, countryName = typeof country === "string" ? country : (country.name || "");
  const logo = league.logo || "";
  const rawFixtures = fixturesR.status === "fulfilled" ? (fixturesR.value.response || []) : [];
  const fixtures = rawFixtures.map(x => {
    const match = apiFootballFixtureMatch(x, code);
    match.league = { id: String(id), code, name, country: countryName, round: x.league && x.league.round || "", logo };
    return match;
  }).filter(x => x.teams.home.name && x.teams.away.name).sort((a,b) => Date.parse(a.fixture.date)-Date.parse(b.fixture.date));
  if (fixturesR.status === "fulfilled" && fixturesR.value.limited) fixtures.forEach(x => { x.league.fixturesLimited = true; });
  const years = metaItem.seasons || [];
  const seasons = [...new Set(years.map(x => Number(x.year)).filter(y => Number.isInteger(y) && y >= 1900 && y <= seasonStartYear()+1))].sort((a,b)=>b-a);
  const tables = tablesR.status === "fulfilled" ? apiFootballStandingsRows(tablesR.value) : [];
  const goals = goalsR.status === "fulfilled" ? apiFootballLeaders(goalsR.value, "goals") : [];
  const assists = assistsR.status === "fulfilled" ? apiFootballLeaders(assistsR.value, "assists") : [];
  return {
    code, name, country: countryName, season: year + "/" + String(year+1).slice(-2), seasonYear: year,
    seasons: seasons.length ? seasons : recentSeasonYears(20), logo, tables, fixtures, goals, assists,
    errors: {
      tables: tablesR.status === "rejected" ? String(tablesR.reason && tablesR.reason.message || tablesR.reason) : "",
      fixtures: fixturesR.status === "rejected" ? String(fixturesR.reason && fixturesR.reason.message || fixturesR.reason) : "",
      goals: goalsR.status === "rejected" ? String(goalsR.reason && goalsR.reason.message || goalsR.reason) : "",
      assists: assistsR.status === "rejected" ? String(assistsR.reason && assistsR.reason.message || assistsR.reason) : "",
    },
  };
}

async function leagueData(env, code, year) {
  const meta = META[code] || [code, null, code, ""];
  const [tables, fixtures, goals, assists, seasons] = await Promise.allSettled([
    (async () => {
      try { const af = await apiFootballStandings(env, code, year); if (af.length) return af; } catch (_) {}
      return parseStandings(await getJSON(SITE_V2 + code + "/standings?season=" + encodeURIComponent(String(year))));
    })(),
    leagueFixtures(env, code, year),
    leagueLeaders(env, code, year, "goals"),
    leagueLeaders(env, code, year, "assists"),
    apiFootballLeagueSeasons(env, code),
  ]);
  const val = (x, fallback) => x.status === "fulfilled" ? x.value : fallback;
  const fixtureRows = val(fixtures, []), goalRows = val(goals, []), assistRows = val(assists, []);
  const footballDataUsed = fixtureRows.some(x => (x.sources || []).includes("football-data.org") || x.source === "football-data.org") || goalRows.some(x => x.source === "football-data.org") || assistRows.some(x => x.source === "football-data.org");
  const noAnonymousKey = !apiFootballKey(env) && !footballDataToken(env);
  const fixtureError = fixtures.status === "rejected" ? fixtures.reason.message : fixtureRows.length ? "" : noAnonymousKey ? "ESPN ve diğer açık kaynaklar bu sezonun fikstürünü döndürmedi. Worker secret olarak FOOTBALL_DATA_TOKEN ekleyin." : "Bu kaynakta bu sezon için fikstür bulunamadı; lig kapsamını kontrol edin.";
  const goalError = goals.status === "rejected" ? goals.reason.message : goalRows.length ? "" : noAnonymousKey ? "Lider verisi için API_FOOTBALL_KEY veya FOOTBALL_DATA_TOKEN gerekli; football-data.org lider uç noktası bazı planlarda ücretlidir." : "Bu lig ve sezon için erişilebilir gol lideri listesi bulunamadı.";
  const assistError = assists.status === "rejected" ? assists.reason.message : assistRows.length ? "" : noAnonymousKey ? "Asist lideri için API_FOOTBALL_KEY veya FOOTBALL_DATA_TOKEN gerekli; football-data.org lider uç noktası bazı planlarda ücretlidir." : "Bu lig ve sezon için erişilebilir asist lideri listesi bulunamadı.";
  return {
    code, name: meta[2], country: meta[3], season: year + "/" + String(year + 1).slice(-2), seasonYear: year,
    seasons: seasons.status === "fulfilled" ? seasons.value : recentSeasonYears(20),
    logo: "https://a.espncdn.com/i/leaguelogos/soccer/500/" + code + ".png",
    tables: val(tables, []), fixtures: fixtureRows, goals: goalRows, assists: assistRows, footballDataUsed,
    errors: { tables: tables.status === "rejected" ? tables.reason.message : "", fixtures: fixtureError, goals: goalError, assists: assistError },
  };
}

// ---------- Ek istatistik kaynağı: PitchAPI (maç oyuncu verilerinden sezon liderlerini toplar) ----------
// Secret: PITCH_API_KEY. Anahtar yalnızca Worker tarafında kullanılır.
// PitchAPI lig bazında hazır lider endpoint'i sunmadığından, sezon maçlarının oyuncu istatistikleri
// 20 maçlık parçalarla toplanır. Bu, Worker başına alt istek sınırını aşmamayı sağlar.
const PITCH_API_BASE = "https://api.pitchapi.dev";
const PITCH_LEADER_PAGE_SIZE = 20;
const pitchApiKey = env => env && env.PITCH_API_KEY || "";
const pitchNorm = value => String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
async function pitchApiJSON(env, path) {
  const key = pitchApiKey(env);
  if (!key) throw new Error("PitchAPI için PITCH_API_KEY gizli değişkeni gerekli.");
  const r = await fetch(PITCH_API_BASE + path, {
    headers: { "X-API-KEY": key, Accept: "application/json" },
    signal: AbortSignal.timeout(18000),
  });
  let payload = {};
  try { payload = await r.json(); } catch (_) {}
  if (!r.ok) {
    const code = String(payload && payload.error && payload.error.code || "").toUpperCase();
    const message = payload && payload.error && (payload.error.message || payload.error.code) || "HTTP " + r.status;
    const error = new Error(code === "PLAN_UPGRADE_REQUIRED"
      ? "Bu lig mevcut PitchAPI anahtarının planında bulunmuyor."
      : code === "ANALYTICS_UNAVAILABLE"
        ? "Bu maç için gelişmiş analiz verisi yayımlanmamış."
        : r.status === 401
          ? "PitchAPI anahtarı geçersiz."
          : r.status === 429
            ? "Futbol verisi geçici olarak yoğun."
            : "Futbol verisi şu anda alınamadı.");
    error.code = code;
    error.status = r.status;
    error.retryAfter = r.headers && r.headers.get ? r.headers.get("Retry-After") : null;
    error.providerMessage = String(message || "").slice(0, 240);
    throw error;
  }
  if (payload && payload.error) {
    const code = String(payload.error.code || "").toUpperCase();
    const error = new Error(code === "ANALYTICS_UNAVAILABLE" ? "Bu maç için gelişmiş analiz verisi yayımlanmamış." : "Futbol verisi şu anda alınamadı.");
    error.code = code;
    throw error;
  }
  return payload && Object.prototype.hasOwnProperty.call(payload, "data") ? payload.data : payload;
}
const PITCH_COUNTRY_CODES = {
  "ingiltere":"ENG", "ispanya":"ESP", "almanya":"GER", "italya":"ITA", "fransa":"FRA", "turkiye":"TUR", "hollanda":"NED", "portekiz":"POR", "abd":"USA", "s arabistan":"KSA", "brezilya":"BRA", "arjantin":"ARG", "iskocya":"SCO", "irlanda":"IRL", "k irlanda":"NIR", "galler":"WAL", "belcika":"BEL", "yunanistan":"GRE", "rusya":"RUS", "ukrayna":"UKR", "avusturya":"AUT", "isvicre":"SUI", "danimarka":"DEN", "isvec":"SWE", "norvec":"NOR", "finlandiya":"FIN", "izlanda":"ISL", "polonya":"POL", "ceky a":"CZE", "cekya":"CZE", "hirvatistan":"CRO", "sirbistan":"SRB", "romanya":"ROU", "macaristan":"HUN", "bulgaristan":"BUL", "slovakya":"SVK", "slovenya":"SVN", "bosna hersek":"BIH", "arnavutluk":"ALB", "k makedonya":"MKD", "kibris":"CYP", "israil":"ISR", "gurcistan":"GEO", "azerbaycan":"AZE", "ermenistan":"ARM", "kazakistan":"KAZ", "letonya":"LVA", "litvanya":"LTU", "estonya":"EST", "malta":"MLT", "luksemburg":"LUX", "kanada":"CAN", "meksika":"MEX", "kolombiya":"COL", "sili":"CHI", "uruguay":"URU", "paraguay":"PAR", "peru":"PER", "ekvador":"ECU", "venezuela":"VEN", "bolivya":"BOL", "kostarika":"CRC", "honduras":"HON", "guatemala":"GUA", "el salvador":"SLV", "japonya":"JPN", "g kore":"KOR", "cin":"CHN", "avustralya":"AUS", "hindistan":"IND", "tayland":"THA", "vietnam":"VIE", "iran":"IRN", "katar":"QAT", "bae":"UAE", "endonezya":"IDN", "malezya":"MAS", "singapur":"SIN", "g afrika":"RSA", "misir":"EGY", "fas":"MAR", "tunus":"TUN", "cezayir":"ALG", "nijerya":"NGA"
};
const PITCH_LEAGUE_ALIASES = {
  "tur.1":["Super Lig","Süper Lig"], "tur.2":["1. Lig","First League","TFF 1. Lig"],
  "eng.1":["Premier League"], "eng.2":["Championship"], "eng.3":["League One"], "eng.4":["League Two"],
  "esp.1":["La Liga","Primera Division"], "esp.2":["La Liga 2","Segunda Division"],
  "ger.1":["Bundesliga","1. Bundesliga"], "ger.2":["2. Bundesliga"],
  "ita.1":["Serie A"], "ita.2":["Serie B"], "fra.1":["Ligue 1"], "fra.2":["Ligue 2"],
  "ned.1":["Eredivisie"], "por.1":["Primeira Liga","Liga Portugal"], "usa.1":["MLS","Major League Soccer"],
  "ksa.1":["Saudi Pro League"], "bra.1":["Brasileirao","Campeonato Brasileiro Serie A","Serie A"],
  "arg.1":["Liga Profesional","Primera Division"], "bel.1":["Belgian Pro League","Pro League","Jupiler Pro League"],
  "sco.1":["Premiership","Scottish Premiership"], "den.1":["Superliga","Danish Superliga"],
  "swe.1":["Allsvenskan"], "nor.1":["Eliteserien"], "pol.1":["Ekstraklasa"],
  "uefa.champions":["Champions League","UEFA Champions League"], "uefa.europa":["Europa League","UEFA Europa League"],
  "uefa.europa.conf":["Conference League","UEFA Conference League"], "uefa.nations":["Nations League","UEFA Nations League"],
  "fifa.world":["World Cup","FIFA World Cup"], "fifa.cwc":["Club World Cup","FIFA Club World Cup"],
  "eng.fa":["FA Cup"], "eng.league_cup":["EFL Cup","League Cup"], "esp.copa_del_rey":["Copa del Rey"],
  "ita.coppa_italia":["Coppa Italia"], "ger.dfb_pokal":["DFB Pokal","DFB-Pokal"],
  "conmebol.libertadores":["Copa Libertadores","Libertadores"], "conmebol.sudamericana":["Copa Sudamericana","Sudamericana"],
  "mex.1":["Liga MX"], "jpn.1":["J1 League","J.League"], "kor.1":["K League 1"],
  "aus.1":["A League","A-League"], "rsa.1":["Premier Soccer League","South African Premier Division"],
  "can.1":["Canadian Premier League","Canadian PL"], "col.1":["Primera A","Categoría Primera A","Colombian Primera A","Liga BetPlay"],
  "chi.1":["Primera Division","Primera División"],
  // PitchAPI'nin 19 Eylül 2026 tarihli katalog güncellemesinde geri açtığı liglerin adları.
  "ned.2":["Eerste Divisie","Keuken Kampioen Divisie"],
  "cro.1":["HNL","Prva HNL","Croatian First Football League"],
  "cze.1":["Czech First League","Czech 1. Liga","Chance Liga","1. Liga"],
  "usa.mls_next_pro":["MLS Next Pro","MLS Next Pro League"],
  "usa.usl.1":["USL Championship"],
  "eng.3":["League One","EFL League One"],
  "bra.2":["Brasileirao Serie B","Brasileirão Série B","Campeonato Brasileiro Serie B","Brazilian Serie B"],
  "qat.1":["Qatar Stars League","Stars League"],
  "uae.1":["UAE Pro League","UAE ADNOC Pro League"],
  "per.1":["Liga 1","Peruvian Primera Division","Peru Liga 1"]
};
function canonicalPitchLeagueCode(code) {
  const raw = String(code || "").trim();
  if (META[raw]) return raw;
  const af = raw.match(/^af-(\d+)$/i);
  return af ? (espnCodeFromAfLeague(af[1]) || "") : "";
}
async function pitchLeagueInfoForCode(env, code) {
  code = canonicalPitchLeagueCode(code);
  const meta = META[code];
  if (!meta) throw new Error("Bu lig için PitchAPI eşlemesi bulunamadı.");
  const listing = await cached("pitch:league-list:v2", async () => ({
    body: await pitchApiJSON(env, "/v1/leagues"), ttl: 43200,
  }));
  const all = Array.isArray(listing.body) ? listing.body : (listing.body && (listing.body.leagues || listing.body.data && listing.body.data.leagues)) || [];
  const names = new Set([meta[2], ...(PITCH_LEAGUE_ALIASES[code] || [])].map(pitchNorm));
  const matches = all.filter(item => item && item.id && names.has(pitchNorm(item.name)));
  const expectedCountry = PITCH_COUNTRY_CODES[pitchNorm(meta[3])] || "";
  const europeanCompetition=/^(uefa\.|fifa\.)/i.test(code)||pitchNorm(meta[3])==="avrupa";
  let candidates = expectedCountry ? matches.filter(item => String(item.country_code || "").toUpperCase() === expectedCountry) : matches;
  if(europeanCompetition){const europe=matches.filter(item=>["UEFA","EUR","EU","EUROPE","INT","INTERNATIONAL"].includes(String(item.country_code||"").toUpperCase()));if(europe.length)candidates=europe;}
  if (!candidates.length) candidates = matches;
  if (candidates.length > 1) {
    const exact = candidates.filter(item => pitchNorm(item.name) === pitchNorm(meta[2]));
    if (exact.length === 1) candidates = exact;
  }
  if (!candidates.length) throw new Error("PitchAPI bu ligi kapsamıyor: " + meta[2] + ". Mevcut kaynaklardan gelen veri varsa gösterilmeye devam eder.");
  if (candidates.length > 1) throw new Error("PitchAPI'de " + meta[2] + " için birden fazla lig eşleşti; güvenli eşleşme yapılamadı.");
  const league = candidates[0];
  const rawSeasons = Array.isArray(league.seasons) ? league.seasons : [];
  const seasonValue = item => {
    if (typeof item === "string" || typeof item === "number") return String(item).trim();
    if (!item || typeof item !== "object") return "";
    if (item.start_year && item.end_year) return String(item.start_year) + "/" + String(item.end_year);
    return String(item.name || item.label || item.season || item.year || "").trim();
  };
  const seasons = [...new Set(rawSeasons.map(seasonValue).map(value => {
    const short = value.match(/^((?:19|20)\d{2})\/(\d{2})$/);
    return short ? short[1] + "/" + String(Number(short[1].slice(0,2) + short[2])) : value;
  }).filter(s => /^(?:19|20)\d{2}(?:\/(?:19|20)\d{2})?$/.test(s)))];
  if (!seasons.length && league.season) seasons.push(String(league.season));
  seasons.sort((a,b) => (Number((b.match(/\d{4}/)||[])[0])||0) - (Number((a.match(/\d{4}/)||[])[0])||0));
  return {
    id: String(league.id), name: league.name || meta[2], seasons,
    isFree: league.is_free === true,
    countryCode: String(league.country_code || "").toUpperCase(),
    planCoverage: league.is_free === true ? "free" : "pro",
  };
}
async function pitchLeagueForCode(env, code, year) {
  const info = await pitchLeagueInfoForCode(env, code),wanted=String(year);
  // Bazı ligler sezonu başlangıç yılı (2025/2026), bazıları bitiş yılı (2026) ile etiketler.
  const season = info.seasons.find(s => s === wanted || s.startsWith(wanted + "/") || s.endsWith("/" + wanted) || String(s).slice(0,4)===wanted || String(s).slice(-4)===wanted);
  if (!season) throw new Error("PitchAPI " + info.name + " için " + year + " sezonunu sunmuyor.");
  return { id: info.id, name: info.name, season };
}
function pitchPlayerMetric(player, kind) {
  const groups = Array.isArray(player && player.stats) ? player.stats : [];
  for (const group of groups) {
    const groupKey = pitchNorm(group && (group.key || group.name || group.title || ""));
    if (groupKey && groupKey !== "top stats") continue;
    const fields = group && group.stats && typeof group.stats === "object" ? group.stats : {};
    for (const [label, item] of Object.entries(fields)) {
      const keys = [label, item && item.key, item && item.name, item && item.stat && item.stat.key].filter(Boolean).map(pitchNorm);
      const wanted = kind === "goals" ? keys.some(k => /(^| )(goals?|total goals)( |$)/.test(k) && !k.includes("expected")) : keys.some(k => /(^| )(assists?|total assists)( |$)/.test(k) && !k.includes("expected"));
      if (!wanted) continue;
      const raw = (item && item.stat ? (item.stat.value ?? item.stat.total) : undefined) ?? (item ? (item.value ?? item.total) : undefined);
      const n = Number(raw);
      if (Number.isFinite(n) && n >= 0) return n;
    }
  }
  return null;
}
function pitchIsGoalkeeper(entry) {
  const player = entry && entry.player || {};
  const position = player.position || player.position_name || player.positionName || entry && (entry.position || entry.position_name || entry.positionName) || "";
  const positionText = pitchNorm(position && typeof position === "object" ? (position.name || position.label || position.short_name || "") : position);
  if (/^(gk|keeper|goalkeeper|goalie|kaleci)$/.test(positionText)) return true;
  // Starter position_id is a formation-grid slot (1..11), not a player role.
  // Never classify a starter as goalkeeper from this numeric field.
  if (player.is_goalkeeper === true || player.is_goalkeeper === 1 || entry && (entry.is_goalkeeper === true || entry.is_goalkeeper === 1)) return true;
  // In the match stat line, keeper-only shot-stopping values live in top_stats.
  for (const group of Array.isArray(entry && entry.stats) ? entry.stats : []) {
    const groupKey = pitchNorm(group && (group.key || group.name || group.title || ""));
    if (/goalkeeping|keeper/.test(groupKey)) return true;
    const fields = group && group.stats && typeof group.stats === "object" ? group.stats : {};
    const keys = Object.entries(fields).flatMap(([label, item]) => [label, item && item.key, item && item.name, item && item.stat && item.stat.key]).filter(Boolean).map(pitchNorm);
    if (keys.some(key => /(^| )(saves?|goals conceded|goals prevented|claims|punches|keeper actions)( |$)/.test(key))) return true;
  }
  return false;
}
function pitchAggregateRows(map) {
  return [...map.values()].map(row => ({ ...row, team: [...row.teams].join(" / ") }))
    .sort((a, b) => b.value - a.value || a.player.localeCompare(b.player, "tr"))
    .slice(0, 50).map((row, index) => ({ rank: index + 1, player: row.player, playerId: row.playerId, team: row.team, value: row.value, logo: row.logo, source: "PitchAPI" }));
}
async function pitchLeaderBatch(env, code, year, offset) {
  if (!pitchApiKey(env)) throw new Error("PitchAPI entegrasyonu için Skor3 Worker ayarlarına PITCH_API_KEY gizli değişkeni eklenmeli.");
  const league = await pitchLeagueForCode(env, code, year);
  const matchResult = await cached("pitch:matches:v3:" + league.id + ":" + league.season, async () => ({
    body: await pitchApiJSON(env, "/v1/leagues/" + encodeURIComponent(league.id) + "/matches?" + new URLSearchParams({ season: league.season, status: "played" })), ttl: 900,
  }));
  const matches = pitchUnwrapList(matchResult.body, ["matches"]);
  const totalMatches = matches.length;
  const batch = matches.slice(offset, offset + PITCH_LEADER_PAGE_SIZE);
  const goalsMap = new Map(), assistsMap = new Map();
  let failedMatches = 0;
  const settled = await Promise.allSettled(batch.map(async match => {
    if (!match || !match.id) return [];
    const matchId=String(match.id),[playersResult,eventsResult]=await Promise.allSettled([
      pitchApiJSON(env, "/v1/matches/" + encodeURIComponent(matchId) + "/players"),
      cached("pitch:leader-events:v3:"+matchId,async()=>({body:await pitchApiJSON(env,"/v1/matches/"+encodeURIComponent(matchId)+"/events"),ttl:900})).then(x=>x.body),
    ]);
    if(playersResult.status!=="fulfilled"&&eventsResult.status!=="fulfilled")throw playersResult.reason||eventsResult.reason||new Error("Maç oyuncu ve olay verisi alınamadı.");
    const playerRows=playersResult.status==="fulfilled"?pitchUnwrapList(playersResult.value,["players"]):[],eventsRaw=eventsResult.status==="fulfilled"?eventsResult.value:{events:[]},teams=new Map();
    if(match.home_team&&match.home_team.id)teams.set(String(match.home_team.id),match.home_team.name||"");
    if(match.away_team&&match.away_team.id)teams.set(String(match.away_team.id),match.away_team.name||"");
    const eventCount=(metric)=>{
      const map=new Map();
      for(const row of pitchEventPlayerMetricRows(eventsRaw,metric)){
        const key=(pitchNorm(row.name)||String(row.id))+"|"+String(row.teamId||"");
        const old=map.get(key)||{id:row.id,name:row.name,teamId:String(row.teamId||""),value:0};old.value++;map.set(key,old);
      }
      return map;
    };
    const eventGoals=eventCount("goals"),eventAssists=eventCount("assists");
    const direct=new Map();
    for(const item of playerRows){
      const player=item&&(item.player||item.person)||{},id=String(player.id||player.player_id||item.player_id||item.playerId||player.name||""),name=player.name||player.full_name||player.short_name||item.player_name||"";
      if(!id||!name)continue;
      const teamId=String(item.team_id||item.team&&item.team.id||""),team=teams.get(teamId)||item.team&&item.team.name||"";
      const key=pitchNorm(name)+"|"+teamId,old=direct.get(key)||{id,name,teamId,logo:player.image_url||player.photo||item.image_url||"",team,goals:0,assists:0};
      old.goals=Math.max(old.goals,Number(pitchMetricValue(item,["goals","goal","goals_scored","scored"]))||0);
      old.assists=Math.max(old.assists,Number(pitchMetricValue(item,["assists","assist","goal_assists","assists_made"]))||0);
      if(!old.logo)old.logo=player.image_url||player.photo||item.image_url||"";
      if(!old.teamId&&teamId)old.teamId=teamId;
      direct.set(key,old);
    }
    const merged=new Map(direct);
    for(const [kind,eventMap] of [["goals",eventGoals],["assists",eventAssists]]){
      for(const [key,eventRow] of eventMap){
        let oldKey=key,old=merged.get(key);
        if(!old&&eventRow.name){const matches=[...merged.entries()].filter(([,row])=>pitchNorm(row.name)===pitchNorm(eventRow.name)&&(!eventRow.teamId||!row.teamId||String(row.teamId)===String(eventRow.teamId)));if(matches.length===1){oldKey=matches[0][0];old=matches[0][1];}}
        if(!old)old={id:eventRow.id,name:eventRow.name,logo:"",team:teams.get(String(eventRow.teamId||""))||"",teamId:String(eventRow.teamId||""),goals:0,assists:0};
        old[kind]=Math.max(Number(old[kind])||0,Number(eventRow.value)||0);
        if(!old.id&&eventRow.id)old.id=eventRow.id;
        if(!old.team&&eventRow.teamId)old.team=teams.get(String(eventRow.teamId))||"";
        if(!old.teamId&&eventRow.teamId)old.teamId=String(eventRow.teamId);
        const finalKey=(old.name?pitchNorm(old.name):String(old.id))+"|"+String(old.teamId||eventRow.teamId||"");
        if(oldKey!==finalKey)merged.delete(oldKey);
        merged.set(finalKey,old);
      }
    }
    return [...merged.values()].filter(row=>row.id&&row.name).map(row=>({id:row.id,name:row.name,logo:row.logo,team:row.team,goals:row.goals,assists:row.assists}));
  }));
  for (const result of settled) {
    if (result.status !== "fulfilled") { failedMatches++; continue; }
    for (const player of result.value) {
      for (const kind of ["goals", "assists"]) {
        const value = player[kind];
        if (!(value > 0)) continue;
        const map = kind === "goals" ? goalsMap : assistsMap;
        let row = map.get(player.id);
        if (!row) { row = { playerId: player.id, player: player.name, logo: player.logo, value: 0, teams: new Set() }; map.set(player.id, row); }
        row.value += value;
        if (!row.logo && player.logo) row.logo = player.logo;
        if (player.team) row.teams.add(player.team);
      }
    }
  }
  const nextOffset = offset + batch.length;
  return {
    code, league: league.name, season: league.season, offset, nextOffset, totalMatches,
    done: nextOffset >= totalMatches, failedMatches,
    goals: pitchAggregateRows(goalsMap), assists: pitchAggregateRows(assistsMap),
  };
}

// ---------- İkinci kaynak: SportScore (anahtarsız; sayfada "Powered by SportScore" bağlantısı zorunlu) ----------
const SS = "https://sportscore.com/api/";
async function ssGet(env, path, params) {
  const r = await fetch(SS + path + "?" + new URLSearchParams(params), {
    headers: env.SPORTSCORE_KEY ? { "X-Api-Key": env.SPORTSCORE_KEY } : {},   // isteğe bağlı: dakikada 6000 istek
  });
  if (!r.ok) {
    if (r.status >= 500 || r.status === 429) { await sleep(700); const r2 = await fetch(SS + path + "?" + new URLSearchParams(params), { headers: env.SPORTSCORE_KEY ? { "X-Api-Key": env.SPORTSCORE_KEY } : {} }); if (r2.ok) return r2.json(); throw new Error("SportScore HTTP " + r2.status); }
    throw new Error("SportScore HTTP " + r.status);
  }
  return r.json();
}
// Listede dakika gelmediğinde başlama saatinden tahmin (yaklaşık: devre arası 15 dk, uzatmalar bilinmez). Maç detayında kesin dakika gelir.
function ssEstimate(time, tx) {
  const t = Date.parse(time);
  if (!isFinite(t)) return null;
  const mins = Math.floor((Date.now() - t) / 60000);
  if (mins < 0) return null;
  const second = /2nd|second|\b2h\b|\b2\b/i.test(tx), first = /1st|first|\b1h\b|\b1\b/i.test(tx);
  let e;
  if (second) e = Math.max(46, mins - 15);
  else if (first) e = Math.max(1, mins);
  else e = mins > 60 ? mins - 15 : Math.max(1, mins);
  if ((first && !second && e > 45) || (!first && !second && e > 45 && mins <= 60)) return "45+";
  return e > 90 ? "90+" : String(e);
}
function ssStatus(m) {
  const st = String(m.status || "").toLowerCase(), tx = String(m.status_text || "");
  if (st === "live" || st === "inplay" || st === "in_play") {
    if (/half.?time|^ht$/i.test(tx)) return { short: "HT", elapsed: null };
    // Dakikayı yalnızca açıkça dakika yazılmışsa ("52'" / "45+2'" / "52 min") metinden al: "2nd half" gibi metinlerdeki "2" dakika DEĞİLDİR
    const mm = String(tx).match(/(\d+)\s*(?:\+\s*(\d+))?\s*(?:'|′|’|min)/i);
    let el = m.live_minute != null ? String(m.live_minute) : mm ? mm[1] + (mm[2] ? "+" + mm[2] : "") : null;
    if (el == null && m.url) {
      const k = String(m.url).split("/").filter(Boolean)[3], z = LIVEMIN.get(k);
      if (z && Date.now() - z.at < 1200000) el = String(z.e + Math.floor((Date.now() - z.at) / 60000));
    }
    if (el == null) el = ssEstimate(m.time, tx);
    return { short: "1H", elapsed: el };
  }
  if (st === "finished" || st === "ended") return { short: /pen/i.test(tx) ? "PEN" : /extra|aet/i.test(tx) ? "AET" : "FT", elapsed: null };
  if (/postpon/.test(st)) return { short: "PST", elapsed: null };
  if (/cancel/.test(st)) return { short: "CANC", elapsed: null };
  if (/abandon|interrupt/.test(st)) return { short: "ABD", elapsed: null };
  return { short: "NS", elapsed: null };
}
const ssScore = (v, short) => (short === "NS" || v === null || v === undefined || v === "" ? null : Number(v));
function ssIdOf(url) {
  // "/football/match/<slug>/<id>/"
  const p = String(url || "").split("/").filter(Boolean);
  return p.length >= 4 ? { slug: p[2], id: p[3] } : null;
}
function ssMatch(m) {
  const k = ssIdOf(m.url);
  if (!k || !m.home || !m.away || !m.time) return null;
  const s = ssStatus(m);
  return {
    fixture: { id: "s:" + k.slug + ":" + k.id, date: m.time, status: { short: s.short, elapsed: s.elapsed } },
    league: { id: "s:" + (m.competition || "Diğer"), code: "", name: m.competition || "Diğer", country: "", logo: m.competition_logo || "" },
    teams: { home: { id: "h", name: m.home, logo: m.home_logo || "" }, away: { id: "a", name: m.away, logo: m.away_logo || "" } },
    goals: { home: ssScore(m.home_score, s.short), away: ssScore(m.away_score, s.short) },
  };
}
async function ssDay(env, date, todayTR) {
  // SportScore günleri UTC: İstanbul gününü kapsamak için iki UTC günü çekip süzüyoruz.
  // Her çağrı en fazla 200 maç verir, bu yüzden durum durum (biten / başlayacak / canlı) ayrı çağırıyoruz.
  const days = [addDays(date, -1), date];
  const sts = (date === todayTR ? ["live"] : []).concat(["finished", "upcoming"]);
  let ok = 0, capped = false, firstErr = "";
  const per = await Promise.all(
    days.flatMap((d) => sts.map(async (st) => {
      try {
        const live = st === "live";
        const j = (await cached("ssf:" + d + ":" + st, async () => ({ body: await ssGet(env, "v1/fixtures/", { sport: "football", date: d, status: st, limit: 200 }), ttl: live ? 8 : date === todayTR ? 90 : 600 }))).body;
        ok++;
        if ((j.matches || []).length >= 200) capped = true;
        return j.matches || [];
      } catch (e) { if (!firstErr) firstErr = e.message; return []; }
    }))
  );
  if (!ok) throw new Error("SportScore'a ulaşılamadı (" + firstErr + ")");
  const seen = new Set(), out = [];
  for (const raw of per.flat()) {
    const m = ssMatch(raw);
    if (!m || seen.has(m.fixture.id) || istDay(m.fixture.date) !== date) continue;
    seen.add(m.fixture.id); out.push(m);
  }
  if (date === todayTR) {
    // Canlı maçların dakikası/skoru, maç detayıyla AYNI kaynaktan (aynı önbellek) gelsin: liste ve detay hep eşit olur.
    const liveOnes = out.filter((m) => m.fixture.status.short === "1H" || m.fixture.status.short === "HT").slice(0, 20);
    await Promise.all(liveOnes.map(async (m) => {
      const [, slug, id] = m.fixture.id.split(":");
      try { const d = (await ssDetailC(env, slug, id)).body.match; m.fixture.status = { short: d.fixture.status.short, elapsed: d.fixture.status.elapsed }; m.goals = d.goals; } catch (_) {}
    }));
  }
  return { list: out, capped };
}
const LIVEMIN = new Map(); // maç -> detaydan gelen kesin dakika (listeyle aynı dakikayı göstermek için)
function ssIncident(x) {
  const t = String(x.type || "").toLowerCase();
  const el = Number(x.time);
  const base = { time: { elapsed: Number.isFinite(el) ? el : null, extra: null }, team: { id: x.side === "away" ? "a" : "h" } };
  if (x.is_sub || /substitution/.test(t)) return { ...base, type: "subst", detail: "Substitution", player: { name: x.player_out || "" }, assist: { name: x.player_in || "" } };
  if (/penalty missed|missed penalty/.test(t)) return { ...base, type: "Goal", detail: "Missed Penalty", player: { name: x.player || "" }, assist: { name: "" } };
  if (x.is_goal || /goal/.test(t)) {
    const own = /own/.test(t), pen = /penalty/.test(t);
    return { ...base, type: "Goal", detail: own ? "Own Goal" : pen ? "Penalty" : "Normal Goal", player: { name: x.player || "" }, assist: { name: own ? "" : x.assist || "" } };
  }
  if (x.is_card || /card/.test(t)) {
    const red = /red/.test(t), second = /yellow.*red|second/.test(t);
    return { ...base, type: "Card", detail: second ? "Second Yellow card" : red ? "Red Card" : "Yellow Card", player: { name: x.player || "" } };
  }
  if (/var/.test(t)) return { ...base, type: "Var", detail: x.type, player: { name: x.player || "" } };
  return null;
}
function ssSide(arr) {
  return (arr || []).map((p) => ({ player: { name: String(p.name || "").trim(), number: p.number == null ? null : p.number, pos: String(p.position || "").toUpperCase() } }));
}
const tsdbPos = (v) => {
  const p = String(v || "").toLowerCase().replace(/[._-]+/g," ").replace(/\s+/g," ").trim();
  if (!p) return "";
  if (/goalkeeper|goalie|keeper/.test(p)) return "GK";
  if (/left.*wing.?back|left wing back/.test(p)) return "LWB";
  if (/right.*wing.?back|right wing back/.test(p)) return "RWB";
  if (/wing.?back/.test(p)) return "WB";
  if (/left.*(centre|center).*back|left central defender/.test(p)) return "LCB";
  if (/right.*(centre|center).*back|right central defender/.test(p)) return "RCB";
  if (/left back/.test(p)) return "LB";
  if (/right back/.test(p)) return "RB";
  if (/(centre|center|central).*back|central defender/.test(p)) return "CB";
  if (/left.*defensive midfield/.test(p)) return "LDM";
  if (/right.*defensive midfield/.test(p)) return "RDM";
  if (/central defensive midfield|holding midfield/.test(p)) return "CDM";
  if (/defensive midfield/.test(p)) return "DM";
  if (/left.*attacking midfield/.test(p)) return "LAM";
  if (/right.*attacking midfield/.test(p)) return "RAM";
  if (/attacking midfield/.test(p)) return "CAM";
  if (/left.*central midfield/.test(p)) return "LCM";
  if (/right.*central midfield/.test(p)) return "RCM";
  if (/central midfield/.test(p)) return "CM";
  if (/left.*wing|left wide forward/.test(p)) return "LW";
  if (/right.*wing|right wide forward/.test(p)) return "RW";
  if (/wing|wide forward/.test(p)) return "F";
  if (/left midfield/.test(p)) return "LM";
  if (/right midfield/.test(p)) return "RM";
  if (/midfield|half/.test(p)) return "MF";
  if (/second striker|supporting striker/.test(p)) return "SS";
  if (/striker/.test(p)) return "ST";
  if (/centre forward|center forward/.test(p)) return "CF";
  if (/forward|attack/.test(p)) return "FW";
  if (/defend|back|sweeper/.test(p)) return "DF";
  return String(v || "").toUpperCase();
};
function lineupPositionSpecificity(value) {
  const p=String(value||"").trim().toUpperCase().replace(/[^A-Z]/g,"");
  if(!p)return 0;
  if(["GK","RB","LB","RWB","LWB","RCB","LCB","CB","SW","CDM","DM","RDM","LDM","CM","RCM","LCM","CAM","AM","RAM","LAM","RM","LM","RW","LW","RWF","LWF","ST","CF","RCF","LCF","SS"].includes(p))return 2;
  if(["G","D","DF","DEF","M","MF","MID","F","FW","FWD","GOALKEEPER","DEFENDER","MIDFIELDER","FORWARD","ATTACKER","STRIKER"].includes(p))return 1;
  return 0;
}
function lineupPositionSourcePriority(source) {
  const s=String(source||"");
  if(/API-Football maç kadrosu \(diziliş ızgarası\)/i.test(s))return 60;
  if(/PitchAPI maç kadrosu mevki/i.test(s))return 55;
  if(/ESPN maç kadrosu \(Opta\)/i.test(s))return 50;
  if(/TheSportsDB maç kadrosu/i.test(s))return 45;
  if(/API-Football maç kadrosu/i.test(s))return 35;
  if(/koordinat tahmini|formasyon şablonu|formasyon tahmini/i.test(s))return 10;
  return 20;
}
function applyExactRoleLayout(side, formationValue) {
  if(!side||!Array.isArray(side.startXI)||side.startXI.length!==11)return side;
  const formation=String(formationValue||side.formation||"").replace(/\s+/g,"").replace(/_/g,"-");
  const rows=API_FOOTBALL_FORMATION_ROLE_ROWS[formation];
  if(!rows)return side;
  const entries=side.startXI.map(entry=>entry.player||entry);
  const roleSlots=new Map([["GK",{row:1,column:1,rowSize:1}]]);
  rows.forEach((line,lineIndex)=>line.forEach((role,columnIndex)=>roleSlots.set(role,{row:lineIndex+2,column:columnIndex+1,rowSize:line.length})));
  const mapped=[];
  for(const player of entries){
    const role=String(player.pos||"").trim().toUpperCase().replace(/[^A-Z]/g,"");
    const slot=roleSlots.get(role);
    if(!slot)return side;
    mapped.push({player,role,...slot});
  }
  const unique=new Set(mapped.map(x=>x.row+":"+x.column));
  if(mapped.length!==11||unique.size!==11||mapped.filter(x=>x.role==="GK").length!==1)return side;
  for(const item of mapped){
    item.player.grid={row:item.row,column:item.column};
    item.player.formationLine=item.role==="GK"?-1:item.row-2;
    item.player.formationSlot=item.column-1;
    item.player.formationLineSize=item.rowSize;
    item.player.formationLayoutReliable=true;
  }
  side.formation=formation;
  side.formationLayoutReliable=true;
  side.formationSource=side.formationSource||"Maça özel mevki rollerinden oluşturulan diziliş";
  return side;
}
function mergeDetailedLineupPositions(primary, detailed, sourceLabel="TheSportsDB maç kadrosu", preferDetailed=false) {
  if(!Array.isArray(primary)||!Array.isArray(detailed)||!detailed.length)return primary;
  return primary.map(side=>{
    const other=detailed.find(x=>pitchTeamNameMatches(side.team&&side.team.name,x.team&&x.team.name));
    if(!other)return side;
    const candidates=[...(other.startXI||[]),...(other.substitutes||[])].map(x=>x.player||x);
    const enrich=entry=>{
      const player=entry.player||entry;
      const match=candidates.find(x=>pitchPlayerNameMatches(player.name,x.name));
      if(!match)return entry;
      const oldPos=player.pos||"",newPos=match.pos||"",oldSource=String(player.posSource||"");
      const oldRank=lineupPositionSpecificity(oldPos),newRank=lineupPositionSpecificity(newPos);
      const oldPriority=lineupPositionSourcePriority(oldSource),newPriority=lineupPositionSourcePriority(sourceLabel);
      // A detailed role (LB/CDM/CAM/ST...) outranks a generic category (D/M/F),
      // even when the detailed role was derived from this match's own x/y formation.
      // A higher-trust fixture-specific detailed source may replace an inference,
      // but a lower-trust generic roster feed may never demote it.
      const shouldReplace=newRank>0&&(
        oldRank===0 ||
        (newRank===2 && (oldRank<2 || newPriority>oldPriority || (newPriority===oldPriority&&preferDetailed))) ||
        (newRank===1 && oldRank===1 && (newPriority>oldPriority || (newPriority===oldPriority&&preferDetailed)))
      );
      if(!shouldReplace)return entry;
      return {...entry,player:{...player,pos:newPos,posSource:sourceLabel}};
    };
    const updated={...side,startXI:(side.startXI||[]).map(enrich),substitutes:(side.substitutes||[]).map(enrich)};
    return applyExactRoleLayout(updated,other.formation||side.formation);
  });
}
function lineupQuality(lineups) {
  if (!Array.isArray(lineups) || lineups.length < 2) return 0;
  let score = 0;
  for (const side of lineups.slice(0, 2)) {
    const xi = side.startXI || [], names = new Set(xi.map((x) => String(x.player && x.player.name || "").trim().toLowerCase()).filter(Boolean));
    if (xi.length !== 11 || names.size !== 11) return 0;
    const positions = xi.filter((x) => x.player && x.player.pos).length;
    const hasPitchCoordinates = xi.length === 11 && xi.every(x => {
      const p=x.player||{},px=Number(p.pitchX),py=Number(p.pitchY);
      return Number.isFinite(px)&&Number.isFinite(py)&&px>=0&&px<=1&&py>=0&&py<=1&&!(px===0&&py===0);
    });
    const gridRows = xi.map(x => Number(x.player && x.player.grid && x.player.grid.row) || 0);
    const gridCols = xi.map(x => Number(x.player && x.player.grid && x.player.grid.column) || 0);
    const grids = xi.filter((x) => x.player && x.player.grid && Number(x.player.grid.row) > 0 && Number(x.player.grid.column) > 0).length;
    const gridKeys = new Set(xi.filter(x => x.player && x.player.grid).map(x => Number(x.player.grid.row) + ":" + Number(x.player.grid.column)));
    const validGrid = grids === 11 && gridKeys.size === 11 && Math.max(...gridRows) <= 6 && Math.max(...gridCols) <= 6;
    if (positions < 7 && !validGrid && !hasPitchCoordinates) return 0;
    const specific = xi.filter((x) => /^(LB|RB|CB|LCB|RCB|LWB|RWB|LM|RM|CM|LCM|RCM|LW|RW|LWF|RWF|AM|CAM|DM|CDM|ST|CF|SS)$/i.test(String(x.player && x.player.pos || ""))).length;
    const shape = String(side.formation || "").split("-").filter(Boolean).map(Number);
    if (shape.length && (shape.some(n => !Number.isInteger(n) || n < 1 || n > 5) || shape.reduce((a, b) => a + b, 0) !== 10) && !validGrid) return 0;
    if (xi.some((x) => /^(G|GK|GOALKEEPER)$/i.test(String(x.player.pos || "")))) score++;
    score += positions + specific * 2;
    score += grids * 3;
    if (validGrid) score += 100;
    if (hasPitchCoordinates) score += 120;
    if (side.formation) score++;
  }
  return score;
}
// ESPN formationPlace, Opta'nın diziliş içindeki pozisyon kimliğidir; sıradan forma/roster sırası değildir.
// Eşlemeler mplsoccer'ın Opta formation tablolarındaki pozisyon kimliklerine dayanır.
const OPTA_FORMATION_ROLES = {
  "442": {1:"GK",2:"RB",3:"LB",4:"RCM",5:"RCB",6:"LCB",7:"RM",8:"LCM",9:"LCF",10:"RCF",11:"LM"},
  "41212": {1:"GK",2:"RB",3:"LB",4:"CDM",5:"RCB",6:"LCB",7:"RCM",8:"CAM",9:"LCF",10:"RCF",11:"LCM"},
  "433": {1:"GK",2:"RB",3:"LB",4:"CDM",5:"RCB",6:"LCB",7:"RCM",8:"LCM",9:"ST",10:"RW",11:"LW"},
  "451": {1:"GK",2:"RB",3:"LB",4:"RCM",5:"RCB",6:"LCB",7:"RM",8:"LCM",9:"ST",10:"CM",11:"LM"},
  "4411": {1:"GK",2:"RB",3:"LB",4:"RCM",5:"RCB",6:"LCB",7:"RM",8:"LCM",9:"ST",10:"CAM",11:"LM"},
  "4141": {1:"GK",2:"RB",3:"LB",4:"CDM",5:"RCB",6:"LCB",7:"RM",8:"RCM",9:"ST",10:"LCM",11:"LM"},
  "4231": {1:"GK",2:"RB",3:"LB",4:"LDM",5:"RCB",6:"LCB",7:"RW",8:"RDM",9:"ST",10:"CAM",11:"LW"},
  "4321": {1:"GK",2:"RB",3:"LB",4:"CM",5:"RCB",6:"LCB",7:"LCM",8:"RCM",9:"ST",10:"RW",11:"LW"},
  "4222": {1:"GK",2:"RB",3:"LB",4:"RCM",5:"RCB",6:"LCB",7:"RW",8:"LCM",9:"LCF",10:"RCF",11:"LW"},
  "4312": {1:"GK",2:"RB",3:"LB",4:"CM",5:"RCB",6:"LCB",7:"RCM",8:"CAM",9:"RCF",10:"LCF",11:"LCM"},
  "424": {1:"GK",2:"RB",3:"LB",4:"RDM",5:"RCB",6:"LCB",7:"RW",8:"LDM",9:"RCF",10:"LCF",11:"LW"},
  "532": {1:"GK",2:"RB",3:"LB",4:"LCB",5:"CB",6:"RCB",7:"RCM",8:"CDM",9:"LCF",10:"RCF",11:"LCM"},
  "541": {1:"GK",2:"RB",3:"LB",4:"LCB",5:"CB",6:"RCB",7:"RM",8:"RCM",9:"ST",10:"LCM",11:"LM"},
  "352": {1:"GK",2:"RWB",3:"LWB",4:"LCB",5:"CB",6:"RCB",7:"RCM",8:"LCM",9:"LCF",10:"RCF",11:"CM"},
  "343": {1:"GK",2:"RWB",3:"LWB",4:"LCB",5:"CB",6:"RCB",7:"RCM",8:"LCM",9:"ST",10:"RW",11:"LW"},
  "3421": {1:"GK",2:"RWB",3:"LWB",4:"LCB",5:"CB",6:"RCB",7:"RDM",8:"LDM",9:"ST",10:"RAM",11:"LAM"},
  "3412": {1:"GK",2:"RWB",3:"LWB",4:"LCB",5:"CB",6:"RCB",7:"RCM",8:"LCM",9:"CAM",10:"RCF",11:"LCF"},
  "3241": {1:"GK",2:"RDM",3:"LDM",4:"LCB",5:"CB",6:"RCB",7:"RAM",8:"LAM",9:"ST",10:"RW",11:"LW"},
};
function optaPosition(formation, place) {
  const key = String(formation || "").replace(/\D/g, "");
  const id = Number(place);
  return OPTA_FORMATION_ROLES[key] && OPTA_FORMATION_ROLES[key][id] || "";
}
function apiFootballGrid(value) {
  const m = String(value || "").match(/^(\d+)\s*:\s*(\d+)$/);
  return m ? { row: Number(m[1]), column: Number(m[2]) } : null;
}
const API_FOOTBALL_FORMATION_ROLE_ROWS = {
  "4-2-3-1": [["LB","LCB","RCB","RB"],["LDM","RDM"],["LW","CAM","RW"],["ST"]],
  "4-3-3": [["LB","LCB","RCB","RB"],["LCM","CM","RCM"],["LW","ST","RW"]],
  "4-4-2": [["LB","LCB","RCB","RB"],["LM","LCM","RCM","RM"],["LCF","RCF"]],
  "4-1-4-1": [["LB","LCB","RCB","RB"],["CDM"],["LM","LCM","RCM","RM"],["ST"]],
  "4-4-1-1": [["LB","LCB","RCB","RB"],["LM","LCM","RCM","RM"],["CAM"],["ST"]],
  "4-2-2-2": [["LB","LCB","RCB","RB"],["LDM","RDM"],["LAM","RAM"],["LCF","RCF"]],
  "4-3-1-2": [["LB","LCB","RCB","RB"],["LCM","CM","RCM"],["CAM"],["LCF","RCF"]],
  "4-3-2-1": [["LB","LCB","RCB","RB"],["LCM","CM","RCM"],["LAM","RAM"],["ST"]],
  "4-5-1": [["LB","LCB","RCB","RB"],["LM","LCM","CM","RCM","RM"],["ST"]],
  "4-1-2-1-2": [["LB","LCB","RCB","RB"],["CDM"],["LCM","RCM"],["CAM"],["LCF","RCF"]],
  "5-3-2": [["LWB","LCB","CB","RCB","RWB"],["LCM","CM","RCM"],["LCF","RCF"]],
  "5-4-1": [["LWB","LCB","CB","RCB","RWB"],["LM","LCM","RCM","RM"],["ST"]],
  "5-2-3": [["LWB","LCB","CB","RCB","RWB"],["LDM","RDM"],["LW","ST","RW"]],
  "3-5-2": [["LCB","CB","RCB"],["LM","LCM","CM","RCM","RM"],["LCF","RCF"]],
  "3-4-3": [["LCB","CB","RCB"],["LM","LCM","RCM","RM"],["LW","ST","RW"]],
  "3-4-2-1": [["LCB","CB","RCB"],["LWB","LCM","RCM","RWB"],["LAM","RAM"],["ST"]],
  "3-4-1-2": [["LCB","CB","RCB"],["LM","LCM","RCM","RM"],["CAM"],["LCF","RCF"]],
  "3-2-4-1": [["LCB","CB","RCB"],["LDM","RDM"],["LM","LAM","RAM","RM"],["ST"]],
  "3-1-4-2": [["LCB","CB","RCB"],["CDM"],["LM","LCM","RCM","RM"],["LCF","RCF"]],
  "4-2-1-3": [["LB","LCB","RCB","RB"],["LDM","RDM"],["CAM"],["LW","ST","RW"]]
};
function applyApiFootballGridRoles(primary, detailed) {
  if (!Array.isArray(primary) || !Array.isArray(detailed) || detailed.length !== 2) return primary;
  return primary.map(side => {
    const sourceSide = detailed.find(x => pitchTeamNameMatches(side.team && side.team.name, x.team && x.team.name));
    if (!sourceSide) return side;
    const formation = String(sourceSide.formation || side.formation || "").replace(/\s+/g, "").replace(/_/g, "-");
    const rows = API_FOOTBALL_FORMATION_ROLE_ROWS[formation];
    const raw = Array.isArray(sourceSide.startXI) ? sourceSide.startXI : [];
    if (!rows || raw.length !== 11) return side;
    const gridRows = raw.map(entry => {
      const player = entry.player || entry;
      const rawGrid = player.grid;
      const grid = rawGrid && typeof rawGrid === "object"
        ? { row: Number(rawGrid.row), column: Number(rawGrid.column) }
        : apiFootballGrid(rawGrid);
      return { entry, player, grid };
    });
    if (gridRows.some(x => !x.grid || !Number.isInteger(Number(x.grid.row)) || !Number.isInteger(Number(x.grid.column)) || Number(x.grid.row) < 1 || Number(x.grid.row) > rows.length + 1 || Number(x.grid.column) < 1)) return side;
    const keys = gridRows.map(x => Number(x.grid.row) + ":" + Number(x.grid.column));
    if (new Set(keys).size !== 11) return side;
    const rowCounts = new Map();
    for (const item of gridRows) rowCounts.set(Number(item.grid.row), (rowCounts.get(Number(item.grid.row)) || 0) + 1);
    if (rowCounts.get(1) !== 1) return side;
    for (let r = 0; r < rows.length; r++) if (rowCounts.get(r + 2) !== rows[r].length) return side;
    if ([...rowCounts.keys()].some(r => r < 1 || r > rows.length + 1)) return side;
    const primaryEntries = (side.startXI || []).map(entry => entry.player || entry);
    const usedTargets = new Set();
    const matches = gridRows.map(item => {
      const sourcePlayer = item.player;
      const target = primaryEntries.find(player => !usedTargets.has(player) && pitchPlayerNameMatches(sourcePlayer.name, player.name));
      if (!target) return null;
      usedTargets.add(target);
      const row = Number(item.grid.row), col = Number(item.grid.column);
      const role = row === 1 ? "GK" : rows[row - 2][col - 1];
      if (!role) return null;
      return { target, role, row, col, rowSize: row === 1 ? 1 : rows[row - 2].length };
    });
    const usable = matches.filter(Boolean);
    if (usable.length !== 11 || usable.filter(x => x.role === "GK").length !== 1) return side;
    for (const match of usable) {
      const source = String(match.target.posSource || "");
      const alreadyGridVerified = /API-Football maç kadrosu \(diziliş ızgarası\)/i.test(source);
      // A complete, fixture-matched grid (11 names + unique coordinates + matching formation)
      // is stronger than generic/estimated roles and may correct an earlier roster label.
      if (!alreadyGridVerified) {
        if (match.target.pos && !match.target.originalPosition) match.target.originalPosition = match.target.pos;
        match.target.pos = match.role;
        match.target.posSource = "API-Football maç kadrosu (diziliş ızgarası)";
      }
      match.target.grid = { row: match.row, column: match.col };
      match.target.formationLine = match.row === 1 ? -1 : match.row - 2;
      match.target.formationSlot = match.col - 1;
      match.target.formationLineSize = match.rowSize;
      match.target.formationLayoutReliable = true;
    }
    if (usable.length === 11) {
      side.formation = formation;
      side.formationLayoutReliable = true;
      side.formationSource = "API-Football resmî diziliş ızgarası";
    }
    return side;
  });
}
async function apiFootballMatchLineups(env, home, away, date) {
  if (!apiFootballKey(env)) return [];
  const day = String(date || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return [];
  const fixtures = await cached("af-fixtures-day:" + day, async () => ({ body: await apiFootballJSON(env, "/fixtures", { date: day }), ttl: 900 }));
  const matches = fixtures.body.response || [];
  const toKey = v => nkw(v).replace(/\b(fc|cf|sc|afc|club|the)\b/g, " ").replace(/\bman\b/g,"manchester").replace(/\butd\b/g,"united").replace(/\s+/g, " ").trim();
  const hk = toKey(home), ak = toKey(away);
  const exact = matches.filter(x => toKey(x.teams && x.teams.home && x.teams.home.name) === hk && toKey(x.teams && x.teams.away && x.teams.away.name) === ak);
  const candidates = exact.length ? exact : matches.filter(x => nameLike(x.teams && x.teams.home && x.teams.home.name, home) && nameLike(x.teams && x.teams.away && x.teams.away.name, away));
  if (!candidates.length) return [];
  candidates.sort((a, b) => Math.abs(Date.parse(a.fixture.date) - Date.parse(date)) - Math.abs(Date.parse(b.fixture.date) - Date.parse(date)));
  const fixtureId = String(candidates[0].fixture && candidates[0].fixture.id || "");
  if (!/^\d+$/.test(fixtureId)) return [];
  const data = await cached("af-lineups:" + fixtureId, async () => {
    const body = await apiFootballJSON(env, "/fixtures/lineups", { fixture: fixtureId });
    const complete = (body.response || []).length === 2 && (body.response || []).every(side => (side.startXI || []).length === 11);
    return { body, ttl: complete ? 1800 : 900 };
  });
  const raw = data.body.response || [];
  const out = [];
  for (const [isHome, name] of [[true, home], [false, away]]) {
    const expected = isHome ? hk : ak;
    const side = raw.find(x => toKey(x.team && x.team.name) === expected) || raw.find(x => nameLike(x.team && x.team.name, name));
    if (!side) continue;
    const convert = p => {
      const x = p.player || {}, grid = apiFootballGrid(x.grid);
      return { player: { name: x.name || "", number: x.number == null ? null : x.number, pos: String(x.pos || "").toUpperCase(), grid } };
    };
    out.push({ team: { id: isHome ? "h" : "a", name, logo: side.team && side.team.logo || "" }, formation: side.formation || "", coach: side.coach && side.coach.name ? { name: side.coach.name, id: side.coach.id || null, photo: side.coach.photo || side.coach.image || "" } : null,
      startXI: (side.startXI || []).map(convert), substitutes: (side.substitutes || []).map(convert) });
  }
  return out.length === 2 ? out : [];
}
async function espnMatchSpecificLineups(code, home, away, date) {
  if (!META[code] || !home || !away) return [];
  const day = String(date || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return [];
  const start = addDays(day, -1).replace(/-/g, ""), end = addDays(day, 1).replace(/-/g, "");
  let board;
  try {
    board = await cached("pitch:espn-lineup-board:" + code + ":" + day, async () => ({ body: await getJSON(SITE + code + "/scoreboard?dates=" + start + "-" + end + "&limit=100"), ttl: 900 }));
  } catch (_) { return []; }
  const targetTime = Date.parse(date);
  const candidates = (board.body && board.body.events || []).filter(event => {
    const comp = event.competitions && event.competitions[0];
    const competitors = comp && comp.competitors || [];
    const h = competitors.find(x => x.homeAway === "home"), a = competitors.find(x => x.homeAway === "away");
    if (!h || !a) return false;
    return nameLike(h.team && (h.team.displayName || h.team.name), home) && nameLike(a.team && (a.team.displayName || a.team.name), away);
  }).sort((a,b) => Math.abs(Date.parse(a.date) - targetTime) - Math.abs(Date.parse(b.date) - targetTime));
  for (const event of candidates.slice(0, 3)) {
    if (!event || !event.id) continue;
    try {
      const summary = await cached("pitch:espn-lineup-summary:" + code + ":" + event.id, async () => ({ body: await getJSON(SITE + code + "/summary?event=" + encodeURIComponent(event.id)), ttl: 3600 }));
      const parsed = parseSummary(summary.body, code, event.id);
      const lineups = parsed && parsed.match && parsed.match.lineups || [];
      if (lineups.length === 2 && lineups.every(side => (side.startXI || []).length === 11)) {
        for (const side of lineups) side.lineupSource = "ESPN maç kadrosu (Opta)";
        return lineups;
      }
    } catch (_) { /* ESPN does not publish a roster for every fixture. */ }
  }
  return [];
}

async function tsdbFindEvent(home, away, date, exhaustive = true) {
  const fmt = s => String(s || "").replace(/\b(football club|fc|cf|sc|afc)\b/gi, " ").replace(/[^\p{L}\p{N}]+/gu, "_").replace(/^_|_$/g, "");
  const homeKey = nkw(home), awayKey = nkw(away);
  const day = String(date || "").slice(0, 10);
  const days = /^\d{4}-\d{2}-\d{2}$/.test(day) ? (exhaustive ? [day, addDays(day, -1), addDays(day, 1)] : [day]) : [];
  const pairs = [[home, away], [away, home]];
  for (const [first, second] of pairs) for (const d of days) {
    try {
      const eventData = await cached("tsdb-event:" + d + ":" + nkw(first) + ":" + nkw(second), async () => ({ body: await getJSON(TSDB + "searchevents.php?" + new URLSearchParams({ e: fmt(first) + "_vs_" + fmt(second), d, s: "Soccer" })), ttl: 21600 }));
      const event = (eventData.body.events || []).find(x => {
        const h = nkw(x.strHomeTeam), a = nkw(x.strAwayTeam);
        return (h === homeKey && a === awayKey || h === awayKey && a === homeKey) && (!x.dateEvent || x.dateEvent === d);
      });
      if (event && event.idEvent) return event;
    } catch (_) { /* try the next date and reversed event title */ }
  }
  return null;
}
async function tsdbMatchLineups(home, away, date, exhaustive = true) {
  const event = await tsdbFindEvent(home, away, date, exhaustive);
  if (event) {
      const data = await cached("tsdb-lineup:" + event.idEvent, async () => ({ body: await getJSON(TSDB + "lookuplineup.php?id=" + encodeURIComponent(event.idEvent)), ttl: 21600 }));
      const raw = data.body.lineup || [];
      const tsdbHomeIsRequestedHome = nkw(event.strHomeTeam) === nkw(home);
      const sides = [true, false].map(isHome => {
        const isTsdbHome = isHome === tsdbHomeIsRequestedHome;
        const players = raw.filter(x => String(x.strHome).toLowerCase() === (isTsdbHome ? "yes" : "no"));
        const xi = players.filter(x => String(x.strSubstitute).toLowerCase() !== "yes");
        const subs = players.filter(x => String(x.strSubstitute).toLowerCase() === "yes");
        const roleCount = role => xi.filter(x => {
          const p = tsdbPos(x.strPosition);
          // Use complete role codes. A prefix check for "D" incorrectly puts DM/CDM in defence.
          return role === "D"
            ? /^(D|DF|DEF|DEFENDER|CB|LCB|RCB|LB|RB|WB|LWB|RWB|SW)$/.test(p)
            : role === "M"
              ? /^(M|MF|MID|MIDFIELDER|OS|DM|CDM|RDM|LDM|CM|LCM|RCM|AM|CAM|RAM|LAM|LM|RM)$/.test(p)
              : /^(F|FW|FWD|LW|RW|LWF|RWF|ST|CF|RCF|LCF|SS|FORWARD|STRIKER|ATTACKER)$/.test(p);
        }).length;
        const shape = [roleCount("D"), roleCount("M"), roleCount("F")].filter(Boolean);
        const formation = shape.reduce((n, x) => n + x, 0) === 10 ? shape.join("-") : "";
        return { team: { id: isHome ? "h" : "a", name: isHome ? home : away }, formation,
          startXI: xi.map(x => ({ player: { name: x.strPlayer || "", number: x.intSquadNumber || null, pos: tsdbPos(x.strPosition) } })),
          substitutes: subs.map(x => ({ player: { name: x.strPlayer || "", number: x.intSquadNumber || null, pos: tsdbPos(x.strPosition) } })) };
      });
      if (lineupQuality(sides)) return sides;
  }
  return [];
}
async function improveMatchLineups(env, match) {
  if (!match) return match;
  const currentQuality = lineupQuality(match.lineups);
  const hasPitchApiStartingCoordinates = Array.isArray(match.lineups) && match.lineups.length >= 2 &&
    match.lineups.slice(0,2).every(side => {
      const xi=side.startXI||[];
      return xi.length===11&&xi.every(entry=>{
        const p=entry.player||entry,px=Number(p.pitchX),py=Number(p.pitchY);
        return Number.isFinite(px)&&Number.isFinite(py)&&px>=0&&px<=1&&py>=0&&py<=1&&!(px===0&&py===0);
      });
    });
  // PitchAPI's XI coordinates are the match-specific positions. Do not replace them
  // with API-Football/TheSportsDB roster grids merely because PitchAPI position_id is a slot.
  if (hasPitchApiStartingCoordinates && /PitchAPI/i.test(String(match.lineupsSource||match.pitchSource||""))) return match;
  const h = match.teams && match.teams.home, a = match.teams && match.teams.away;
  if (!h || !a) return match;
  const apiLineups = await apiFootballMatchLineups(env, h.name, a.name, match.fixture && match.fixture.date).catch(() => []);
  const apiHasCompleteGrid = Array.isArray(apiLineups) && apiLineups.length === 2 && apiLineups.every(side => {
    const xi = side.startXI || [];
    const keys = new Set(xi.map(x => x.player && x.player.grid ? Number(x.player.grid.row) + ":" + Number(x.player.grid.column) : ""));
    return xi.length === 11 && keys.size === 11 && xi.every(x => x.player && x.player.grid && Number(x.player.grid.row) > 0 && Number(x.player.grid.row) <= 6 && Number(x.player.grid.column) > 0 && Number(x.player.grid.column) <= 6);
  });
  if (apiHasCompleteGrid || lineupQuality(apiLineups) > lineupQuality(match.lineups)) {
    // API-Football often labels every outfielder only as D/M/F. Preserve more
    // precise roles already known, then fill missing detail from TheSportsDB.
    let selected=mergeDetailedLineupPositions(apiLineups,match.lineups||[]);
    const detailedCount=(selected||[]).reduce((n,side)=>n+(side.startXI||[]).filter(x=>lineupPositionSpecificity(x.player&&x.player.pos)===2).length,0);
    if(detailedCount<8){
      const alt=await tsdbMatchLineups(h.name,a.name,match.fixture&&match.fixture.date,currentQuality<16).catch(()=>[]);
      if(alt.length)selected=mergeDetailedLineupPositions(selected,alt);
    }
    match.lineups = selected;
    match.lineupsSource = "API-Football + mevki zenginleştirme";
    return match;
  }
  const alt = await tsdbMatchLineups(h.name, a.name, match.fixture && match.fixture.date, currentQuality < 16).catch(() => []);
  if (lineupQuality(alt) > currentQuality) {
    match.lineups = alt;
    match.lineupsSource = "TheSportsDB";
  }
  return match;
}
function statRowsQuality(rows) {
  return Array.isArray(rows) ? rows.reduce((n, t) => n + ((t.statistics || []).filter(x => x.value != null && x.value !== "").length), 0) : 0;
}
async function tsdbMatchStats(home, away, date, exhaustive = true, ttl = 21600) {
  const event = await tsdbFindEvent(home, away, date, exhaustive);
  if (!event) return [];
  const data = await cached("tsdb-event-stats:" + event.idEvent, async () => ({ body: await getJSON(TSDB + "lookupeventstats.php?id=" + encodeURIComponent(event.idEvent)), ttl }));
  const raw = data.body.eventstats || data.body.stats || [];
  const tsdbHomeIsRequestedHome = nkw(event.strHomeTeam) === nkw(home);
  const stats = raw.map(x => ({
    type: x.strStat || x.type || x.name || "",
    h: tsdbHomeIsRequestedHome ? (x.intHome ?? x.home ?? x.strHome) : (x.intAway ?? x.away ?? x.strAway),
    a: tsdbHomeIsRequestedHome ? (x.intAway ?? x.away ?? x.strAway) : (x.intHome ?? x.home ?? x.strHome),
  })).filter(x => x.type && x.h != null && x.a != null && x.h !== "" && x.a !== "");
  if (!stats.length) return [];
  return [
    { team: { id: "h", name: home }, statistics: stats.map(x => ({ type: x.type, value: x.h })) },
    { team: { id: "a", name: away }, statistics: stats.map(x => ({ type: x.type, value: x.a })) },
  ];
}
async function improveMatchStats(match) {
  if (!match || statRowsQuality(match.statistics) >= 12) return match;
  const h = match.teams && match.teams.home, a = match.teams && match.teams.away;
  if (!h || !a) return match;
  const short = match.fixture && match.fixture.status && match.fixture.status.short;
  const ttl = ["1H", "2H", "HT", "ET", "P", "LIVE", "INT"].includes(short) ? 15 : ["FT", "AET", "PEN"].includes(short) ? 21600 : 900;
  const alt = await tsdbMatchStats(h.name, a.name, match.fixture && match.fixture.date, true, ttl).catch(() => []);
  if (statRowsQuality(alt) > statRowsQuality(match.statistics)) {
    match.statistics = alt;
    match.statisticsSource = "TheSportsDB";
  }
  return match;
}
function apiFootballEvent(x) {
  const kind=String(x.type||"").toLowerCase(),detail=String(x.detail||"");
  const time={elapsed:x.time&&x.time.elapsed!=null?Number(x.time.elapsed):null,extra:x.time&&x.time.extra!=null?Number(x.time.extra):null};
  const base={time,team:{id:x.team&&x.team.id}};
  if(kind==="goal")return{...base,type:"Goal",detail:/penalty/i.test(detail)?"Penalty":/own/i.test(detail)?"Own Goal":"Normal Goal",player:{name:x.player&&x.player.name||""},assist:{name:x.assist&&x.assist.name||""}};
  if(kind==="card")return{...base,type:"Card",detail:/red/i.test(detail)?"Red Card":"Yellow Card",player:{name:x.player&&x.player.name||""}};
  if(kind==="subst"||kind==="substitution")return{...base,type:"subst",detail:"Substitution",player:{name:x.assist&&x.assist.name||""},assist:{name:x.player&&x.player.name||""}};
  if(kind==="var")return{...base,type:"Var",detail:detail||"VAR",player:{name:x.player&&x.player.name||""}};
  return null;
}
async function apiFootballMatchDetail(env, id) {
  if(!apiFootballKey(env))throw new Error("Bu maçın detayları için Worker ortamında API_FOOTBALL_KEY tanımlanmalı");
  const [fxR,evR,luR,stR]=await Promise.allSettled([
    apiFootballJSON(env,"/fixtures",{ids:id}),apiFootballJSON(env,"/fixtures/events",{fixture:id}),
    apiFootballJSON(env,"/fixtures/lineups",{fixture:id}),apiFootballJSON(env,"/fixtures/statistics",{fixture:id}),
  ]);
  if(fxR.status!=="fulfilled"||!(fxR.value.response||[]).length)throw new Error("API-Football maç bilgisi bulunamadı");
  const base=apiFootballFixtureMatch(fxR.value.response[0],""),m={...base,events:[],lineups:[],statistics:[]};
  if(evR.status==="fulfilled")m.events=(evR.value.response||[]).map(apiFootballEvent).filter(Boolean);
  if(luR.status==="fulfilled"){
    for(const side of luR.value.response||[]){const isHome=String(side.team&&side.team.id)===String(base.teams.home.id),team=isHome?base.teams.home:base.teams.away;
      const convert=p=>{const x=p.player||{};return{player:{name:x.name||"",number:x.number==null?null:x.number,pos:String(x.pos||"").toUpperCase(),grid:apiFootballGrid(x.grid)}}};
      m.lineups.push({team,formation:side.formation||"",coach:side.coach&&side.coach.name?{name:side.coach.name}:null,startXI:(side.startXI||[]).map(convert),substitutes:(side.substitutes||[]).map(convert)});
    }
  }
  if(stR.status==="fulfilled")m.statistics=(stR.value.response||[]).map(x=>({team:{id:x.team&&x.team.id,name:x.team&&x.team.name},statistics:(x.statistics||[]).map(s=>({type:statNameTR(s.type),value:s.value}))}));
  m.lineupsSource="API-Football";
  return {match:m};
}
function footballDataMatchEvents(x) {
  const events = [], teamId = name => {
    const home = x.homeTeam || {}, away = x.awayTeam || {};
    return nameLike(name, home.name) ? home.id || "h" : away.id || "a";
  };
  for (const g of x.goals || []) if (g.scorer && g.scorer.name) events.push({ time: { elapsed: g.minute == null ? null : Number(g.minute), extra: g.injuryTime == null ? null : Number(g.injuryTime) }, team: { id: g.team && g.team.id || teamId(g.team && g.team.name) }, type: "Goal", detail: ({ OWN:"Own Goal", PENALTY:"Penalty", REGULAR:"Normal Goal" })[String(g.type || "").toUpperCase()] || "Normal Goal", player: { name: g.scorer.name }, assist: { name: g.assist && g.assist.name || "" } });
  for (const b of x.bookings || []) if (b.player && b.player.name) events.push({ time: { elapsed: b.minute == null ? null : Number(b.minute), extra: b.injuryTime == null ? null : Number(b.injuryTime) }, team: { id: b.team && b.team.id || teamId(b.team && b.team.name) }, type: "Card", detail: /RED/.test(String(b.card || "").toUpperCase()) ? "Red Card" : "Yellow Card", player: { name: b.player.name } });
  for (const s of x.substitutions || []) if (s.playerIn || s.playerOut) events.push({ time: { elapsed: s.minute == null ? null : Number(s.minute), extra: s.injuryTime == null ? null : Number(s.injuryTime) }, team: { id: s.team && s.team.id || teamId(s.team && s.team.name) }, type: "subst", detail: "Substitution", player: { name: s.playerOut && s.playerOut.name || "" }, assist: { name: s.playerIn && s.playerIn.name || "" } });
  return events.sort((a, b) => Number(a.time.elapsed || 0) - Number(b.time.elapsed || 0));
}
async function footballDataMatchDetail(env, id) {
  const doc = await footballDataJSON(env, "/matches/" + id, { "X-Unfold-Lineups": "true", "X-Unfold-Bookings": "true", "X-Unfold-Subs": "true", "X-Unfold-Goals": "true" });
  const x = doc.match || doc, code = FOOTBALL_DATA_TO_ESPN[String(x.competition && x.competition.code || "")] || "";
  const match = footballDataFixtureMatch(x, code);
  match.events = footballDataMatchEvents(x);
  match.statistics = [];
  match.lineups = [];
  for (const [side, key] of [["home", "homeTeam"], ["away", "awayTeam"]]) {
    const raw = x[key] || {}, lineup = raw.lineup || raw.lineUp || [], bench = raw.bench || raw.substitutes || [];
    if (!Array.isArray(lineup) || !lineup.length) continue;
    const convert = p => ({ player: { name: p && p.name || "", number: p ? (p.shirtNumber ?? p.number ?? null) : null, pos: p && (p.position && (p.position.name || p.position) || "") } });
    match.lineups.push({ team: match.teams[side], formation: raw.formation || "", startXI: lineup.map(convert).filter(p => p.player.name), substitutes: (Array.isArray(bench) ? bench : []).map(convert).filter(p => p.player.name) });
  }
  if (match.lineups.length) match.lineupsSource = "football-data.org";
  // If the schedule provider omits lineups, use ESPN's event details when the same fixture is available.
  if (!match.lineups.length && code && match.fixture.date) {
    try {
      const day = String(match.fixture.date).slice(0, 10), range = addDays(day, -1).replace(/-/g, "") + "-" + addDays(day, 1).replace(/-/g, "");
      const board = await getJSON(SITE + code + "/scoreboard?dates=" + range + "&limit=100");
      const targetTime = Date.parse(match.fixture.date), events = (board.events || []).filter(e => {
        const c = e.competitions && e.competitions[0], home = c && c.competitors && c.competitors.find(t => t.homeAway === "home"), away = c && c.competitors && c.competitors.find(t => t.homeAway === "away");
        return home && away && nameLike(home.team.displayName || home.team.name, match.teams.home.name) && nameLike(away.team.displayName || away.team.name, match.teams.away.name);
      }).sort((a, b) => Math.abs(Date.parse(a.date) - targetTime) - Math.abs(Date.parse(b.date) - targetTime));
      if (events.length) {
        const summary = await getJSON(SITE + code + "/summary?event=" + events[0].id), fromEspn = parseSummary(summary, code, events[0].id).match;
        await Promise.all([improveMatchLineups(env, fromEspn), improveMatchStats(fromEspn)]);
        if ((fromEspn.lineups || []).length) {
          fromEspn.fixture.id = match.fixture.id;
          fromEspn.fixture.date = match.fixture.date;
          if (!(fromEspn.events || []).length) fromEspn.events = match.events;
          return { match: fromEspn };
        }
      }
    } catch (_) {}
  }
  return { match };
}
function tsdbTimelineEvent(x) {
  const raw=String(x.strTimeline||x.strEvent||x.strTimelineDetail||"").toLowerCase(),name=x.strPlayer||"",assist=x.strAssist||"";
  const time={elapsed:x.intTime==null?null:Number(x.intTime),extra:x.intExtra==null?null:Number(x.intExtra)},base={time,team:{id:x.idTeam||null}};
  if(/goal|penalty/.test(raw))return{...base,type:"Goal",detail:/own/.test(raw)?"Own Goal":/penalty/.test(raw)?"Penalty":"Normal Goal",player:{name},assist:{name:assist}};
  if(/card/.test(raw))return{...base,type:"Card",detail:/red/.test(raw)?"Red Card":"Yellow Card",player:{name}};
  if(/subst/.test(raw))return{...base,type:"subst",detail:"Substitution",player:{name},assist:{name:assist}};
  return null;
}
async function tsdbMatchDetail(id) {
  const data=await cached("tsdb-match-event:"+id,async()=>({body:await getJSON(TSDB+"lookupevent.php?id="+encodeURIComponent(id)),ttl:21600}));
  const e=(data.body.events||[])[0];if(!e)throw new Error("TheSportsDB maç kaydı bulunamadı");
  const code=Object.entries(TSDB_LEAGUE_IDS).find(([,leagueId])=>String(leagueId)===String(e.idLeague))?.[0]||"";
  const match=tsdbLeagueEvent(e,code);match.lineups=await tsdbMatchLineups(e.strHomeTeam,e.strAwayTeam,tsdbEventTime(e),false).catch(()=>[]);
  match.statistics=await tsdbMatchStats(e.strHomeTeam,e.strAwayTeam,tsdbEventTime(e),false,21600).catch(()=>[]);
  try{const tl=await getJSON(TSDB+"lookuptimeline.php?id="+encodeURIComponent(id));match.events=(tl.timeline||[]).map(tsdbTimelineEvent).filter(Boolean)}catch(_){match.events=[]}
  return {match};
}
function ssStats(stats) {
  // Bu maçta boş geldi; dolu geldiğinde biçimi bilinmediği için olası alan adlarını deniyoruz.
  if (!Array.isArray(stats) || !stats.length) return [];
  const rows = stats.map((x) => ({
    type: x.name || x.type || x.label || x.title || "",
    h: x.home !== undefined ? x.home : x.home_value, a: x.away !== undefined ? x.away : x.away_value,
  })).filter((x) => x.type && x.h !== undefined && x.a !== undefined);
  if (!rows.length) return [];
  return [
    { team: { id: "h" }, statistics: rows.map((r) => ({ type: r.type, value: r.h })) },
    { team: { id: "a" }, statistics: rows.map((r) => ({ type: r.type, value: r.a })) },
  ];
}
async function ssDetail(env, slug, id) {
  let j = await ssGet(env, "widget/match/", { sport: "football", slug });
  if (!j.match || (j.match.url && !String(j.match.url).includes(id))) {
    try { const j2 = await ssGet(env, "widget/match/", { sport: "football", slug: slug + "/" + id }); if (j2.match) j = j2; } catch (_) {}
  }
  const m = j.match;
  if (!m) throw new Error("Maç bulunamadı");
  const s = ssStatus({ ...m, live_minute: m.live_minute });
  if (s.short === "1H" && /^\d+$/.test(String(s.elapsed))) { LIVEMIN.set(id, { e: Number(s.elapsed), at: Date.now() }); if (LIVEMIN.size > 300) LIVEMIN.delete(LIVEMIN.keys().next().value); }
  const lu = m.lineups || {};
  const lineups = [];
  if ((lu.home_xi || []).length || (lu.away_xi || []).length) {
    lineups.push({ team: { id: "h", name: m.home, logo: m.home_logo || "" }, formation: lu.home_formation || "", startXI: ssSide(lu.home_xi), substitutes: ssSide(lu.home_subs), coach: lu.home_coach ? { name: lu.home_coach } : null });
    lineups.push({ team: { id: "a", name: m.away, logo: m.away_logo || "" }, formation: lu.away_formation || "", startXI: ssSide(lu.away_xi), substitutes: ssSide(lu.away_subs), coach: lu.away_coach ? { name: lu.away_coach } : null });
  }
  return {
    match: {
      fixture: { id: "s:" + slug + ":" + id, date: m.time, status: { short: s.short, elapsed: s.elapsed }, venue: (m.venue || m.stadium || m.strVenue) ? { name: m.venue || m.stadium || m.strVenue, city: m.city || m.strCity || "", country: m.country || m.strCountry || "" } : null },
      league: { id: "s:" + (m.competition || "Diğer"), code: "", name: m.competition || "Diğer", country: m.country || "" },
      referee: m.referee || m.strReferee || m.official || "", broadcasts: matchBroadcasts(m.broadcasts, m.tv, m.channel),
      teams: { home: { id: "h", name: m.home, logo: m.home_logo || "" }, away: { id: "a", name: m.away, logo: m.away_logo || "" } },
      goals: { home: ssScore(m.home_score, s.short), away: ssScore(m.away_score, s.short) },
      events: (m.incidents || []).map((x) => { try { return ssIncident(x); } catch (_) { return null; } }).filter(Boolean),
      lineups,
      statistics: ssStats(m.stats),
    },
    live: s.short === "1H" || s.short === "HT", done: ["FT", "AET", "PEN"].includes(s.short),
  };
}

// ---------- Oyuncu arama / oyuncu bilgisi ----------
const slugOf = (u) => { const p = String(u || "").split("/").filter(Boolean), i = p.indexOf("player"); return i >= 0 && p[i + 1] ? p[i + 1] : ""; };
function ssPlayers(j) {
  const out = [];
  (function walk(o, d, key) {
    if (!o || typeof o !== "object" || d > 3) return;
    if (Array.isArray(o)) {
      o.forEach((it) => {
        if (it && typeof it === "object" && !Array.isArray(it)) {
          const u = String(it.url || it.link || "");
          if (/player/i.test(key || "") || u.includes("/player/") || String(it.type || "").toLowerCase() === "player") out.push(it);
          else if (d < 3) walk(it, d + 1, key);
        }
      });
      return;
    }
    Object.keys(o).forEach((k) => walk(o[k], d + 1, k));
  })(j, 0, "");
  const seen = new Set(), res = [];
  for (const it of out) {
    const t = it.team, team = t && typeof t === "object" ? t.name : t || it.team_name || it.club || it.subtitle || "";
    const name = String(it.name || it.title || it.full_name || it.short_name || "").trim();
    const slug = it.slug || slugOf(it.url || it.link);
    if (!name || !slug) continue;
    const key = String(slug).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const photos = collectPhotoUrls(it.photos, it.photo, it.headshot, it.profileImage, it.avatar, it.image, it.logo);
    res.push({ name, slug, team: String(team || ""), pos: it.position || "", logo: photos[0] || "", photos });
  }
  return res;
}
const ssPlayerInfo = async (env, slug) => (await cached("p:" + slug, async () => ({ body: await ssGet(env, "widget/player/", { sport: "football", slug, src: "canliskor" }), ttl: 3600 }))).body;
const STAT_PL = { GP: "Maç", APP: "Maç", APPS: "Maç", APPEARANCES: "Maç", MATCHES: "Maç", GAMES: "Maç", GS: "İlk 11", STARTS: "İlk 11", STARTED: "İlk 11", GAMESSTARTED: "İlk 11", SUBIN: "Yedek Girdi", SUBOUT: "Çıktı", G: "Gol", GOALS: "Gol", A: "Asist", ASSISTS: "Asist", ST: "İsabetli Şut", SH: "Şut", FC: "Faul", FA: "Yenen Faul", YC: "Sarı Kart", YELLOW: "Sarı Kart", YELLOWCARD: "Sarı Kart", YELLOWCARDS: "Sarı Kart", RC: "Kırmızı Kart", RED: "Kırmızı Kart", REDCARD: "Kırmızı Kart", REDCARDS: "Kırmızı Kart", SV: "Kurtarış", GA: "Yenen Gol", OFF: "Ofsayt", MIN: "Dakika", SHOTS: "Şut", SOG: "İsabetli Şut", FOULS: "Faul" };
function espnSeasons(j, leagueCode = "") {
  const rows = new Map();
  for (const c of (j && j.categories) || []) {
    const labels = c.labels || [], names = c.names || [];
    const category = catOf(c.displayName || c.name || c.abbreviation || c.type || "");
    for (const s of c.statistics || []) {
      const season = String((s.season && (s.season.displayName || s.season.year)) || s.season || "");
      const rawTeam = (s.team && (s.team.displayName || s.team.name || s.team.shortDisplayName || s.team.abbreviation)) || String(s.teamName || s.clubName || s.teamSlug || "");
      const teamLogo = s.team && ((s.team.logos && s.team.logos[0] && s.team.logos[0].href) || s.team.logo) || "";
      const teamId = s.team && (s.team.id || ((String(s.team.$ref || "").match(/\/teams\/(\d+)/) || [])[1])) || "";
      const teamCode = leagueCode || (s.league && (s.league.slug || s.league.abbreviation || s.league.code)) || "";
      // Some ESPN athlete tables contain only a league-prefixed team slug (for example tur.fenerbahce).
      // Keep the actual club in the career table instead of dropping every such row in the UI.
      const team = String(rawTeam).replace(/^[a-z]{2,5}\./i, "").replace(/[._-]+/g, " ").trim().replace(/\b\p{L}/gu, x => x.toLocaleUpperCase("tr-TR"));
      const key = season + "|" + nkw(team);
      if (!season || !team) continue;
      const values = Array.isArray(s.stats) ? s.stats : Array.isArray(s.statistics) ? s.statistics : [];
      const row = rows.get(key) || { "Sezon": season, "Takım": team, logo: teamLogo, teamId: String(teamId || ""), teamCode, "Maç": null, "Gol": null, "Asist": null, "İlk 11": null, "Sarı Kart": null, "Kırmızı Kart": null, cats: emptyCats() };
      if (!row.logo && teamLogo) row.logo = teamLogo;
      if (!row.teamId && teamId) row.teamId = String(teamId);
      if (!row.teamCode && teamCode) row.teamCode = teamCode;
      values.forEach((v, i) => {
        const l = labels[i] || names[i] || ("c" + i), k = STAT_PL[String(l).toUpperCase().replace(/[^A-Z]/g, "")] || l;
        // ESPN may repeat the same season under separate stat categories. Merge fields; never add duplicate GP/goals.
        if (row[k] == null || row[k] === "") row[k] = v;
      });
      if (category) {
        const get = re => { const i = labels.findIndex((x, n) => re.test(String(x || names[n] || ""))); return i < 0 ? null : num(values[i]); };
        const apps = get(/^(?:gp|app|apps|appearances?|matches played|games played)$/i), goals = get(/^(?:g|goals?)$/i), assists = get(/^(?:a|assists?)$/i);
        const starts = get(/^(?:gs|starts?|started|games started|starting appearances)$/i), yellow = get(/^(?:yc|yellow(?: cards?)?)$/i), red = get(/^(?:rc|red(?: cards?)?)$/i);
        if (apps != null || goals != null || assists != null || starts != null || yellow != null || red != null) addCat(row.cats, category, apps || 0, goals || 0, assists, starts, yellow, red);
      }
      rows.set(key, row);
    }
  }
  return [...rows.values()];
}
const ESPN_PLAYER_LEAGUES = ["ksa.1", "por.1", "tur.1", "eng.1", "esp.1", "ger.1", "ita.1", "fra.1", "ned.1", "bel.1", "sco.1", "aut.1", "usa.1", "bra.1", "arg.1"];
function espnPlayerLeagueCodes(item) {
  const values = [item && item.uid, item && item.leagueSlug, item && item.defaultLeagueSlug,
    item && item.league && (item.league.slug || item.league.abbreviation || item.league.code),
    item && item.team && (item.team.leagueSlug || item.team.defaultLeagueSlug)];
  const found = [];
  for (const value of values) {
    if (!value) continue;
    const s = typeof value === "object" ? JSON.stringify(value) : String(value);
    const matches = s.match(/(?:^|[~/:])l:([a-z0-9._-]+)/ig) || [];
    for (const m of matches) found.push(m.replace(/^.*l:/i, ""));
    if (/^[a-z]{2,5}\.[a-z0-9._-]+$/i.test(s)) found.push(s);
  }
  return [...new Set([...found, ...ESPN_PLAYER_LEAGUES])];
}
async function espnPlayerSearch(query) {
  const term = String(query || "").trim().slice(0, 40);
  if (!term) return [];
  const queries = [...new Set([term, nkp(term)].filter(Boolean))];
  const data = await cached("espn-player-search:v7:" + nkp(term), async () => {
    const results = await Promise.allSettled(queries.map(query => getJSON("https://site.web.api.espn.com/apis/common/v3/search?" + new URLSearchParams({ query, limit: "20", type: "player" }))));
    const items = results.flatMap(result => result.status === "fulfilled" ? (result.value.items || result.value.results || []) : []);
    return { body: { items }, ttl: 1800 };
  });
  const raw = data.body.items || data.body.results || [];
  return raw.map(x => {
    const name = x.displayName || x.name || x.fullName || "";
    const team = x.team && (x.team.displayName || x.team.name) || x.teamName || x.teamDisplayName || "";
    const pos = x.position && (x.position.abbreviation || x.position.displayName || x.position.name) || "";
    const id = String(x.id || (x.athlete && x.athlete.id) || "");
    const soccer = /soccer|football/i.test(String(x.sport || x.league || x.sportName || "")) || /soccer/i.test(JSON.stringify(x.uid || x.links || ""));
    const allText = JSON.stringify(x).toLowerCase();
    const clearlyOtherSport = /basketball|baseball|american football|ice hockey|tennis|volleyball|cricket|rugby|golf|mma|boxing/.test(allText);
    const hasSoccerProfileShape = !!(team || pos || (x.headshot && x.headshot.href));
    // Do not promote an unverified guessed CDN path to an actual search photo.
    // The resolver adds it as a final fallback after provider-returned portraits.
    const photos = collectPhotoUrls(x.headshot, x.image, x.images, x.athlete && x.athlete.headshot);
    const leagueCandidates=[x.uid,x.leagueSlug,x.defaultLeagueSlug,x.league&& (x.league.slug||x.league.abbreviation||x.league.code),x.team&&(x.team.leagueSlug||x.team.defaultLeagueSlug)].filter(Boolean).map(v=>String(v));
    let pitchCode='';for(const value of leagueCandidates){const match=value.match(/(?:^|[~/:])l:([a-z0-9._-]+)/i);const direct=/^[a-z]{2,5}\.[a-z0-9._-]+$/i.test(value)?value:(match&&match[1]);if(direct&&META[direct]){pitchCode=direct;break;}}
    return { name, team, country: x.nationality || x.country || x.citizenship || "", nationality: x.nationality || x.country || "", pos, espn: id, pitchCode, logo: photos[0] || "", photos, _soccer: soccer || (!clearlyOtherSport && hasSoccerProfileShape) };
  }).filter(x => x.name && x.espn && x._soccer).map(({_soccer,...x}) => x).slice(0, 20);
}
async function espnPlayer(name, leagueLimit = 15, knownEspnId = "", teamHint = "", posHint = "") {
  const out = { id: null, bio: {}, seasons: [], note: "" };
  try {
    let pick = null;
    if (knownEspnId) pick = { id: String(knownEspnId), displayName: name };
    else {
      const queries = [...new Set([String(name || "").trim(), nkp(name)].filter(x => x && x.length >= 3))];
      const results = await Promise.allSettled(queries.map(query => getJSON("https://site.web.api.espn.com/apis/common/v3/search?" + new URLSearchParams({ query, limit: "20", type: "player" }))));
      const allItems = results.flatMap(result => result.status === "fulfilled" ? (result.value.items || result.value.results || []) : []);
      const unique = [...new Map(allItems.map(x => [String(x.id || (x.athlete && x.athlete.id) || "") , x]).filter(x => x[0])).values()];
      const soccerCandidates = unique.filter(x => {
        const text = JSON.stringify([x.sport, x.league, x.uid, x.links, x.position, x.team]).toLowerCase();
        const other = /basketball|baseball|american football|ice hockey|tennis|volleyball|cricket|rugby|golf|mma|boxing/.test(text);
        return !other && (/soccer|football/.test(text) || (x.team && x.position));
      });
      pick = selectPlayerCandidate(soccerCandidates.map(x => ({ ...x, name: x.displayName || x.name || x.fullName, team: x.team && (x.team.displayName || x.team.name) || x.teamName, position: x.position && (x.position.displayName || x.position.name || x.position.abbreviation) })), name, teamHint, posHint);
      if (pick) {
        const actual = soccerCandidates.find(x => String(x.id || (x.athlete && x.athlete.id) || "") === String(pick.id || ""));
        pick = actual || pick;
      }
    }
    if (!pick) { out.note = "ESPN'de takım/mevkiyle doğrulanmış tekil oyuncu kaydı bulunamadı"; return out; }
    out.id = pick.id || (pick.athlete && pick.athlete.id) || null;
    out.headshot = (pick.headshot && (pick.headshot.href || pick.headshot.default)) || "https://a.espncdn.com/i/headshots/soccer/players/full/" + out.id + ".png";
  } catch (e) { out.note = "ESPN araması başarısız: " + e.message; return out; }
  const id = out.id;
  try {
    const b = await getJSON("https://sports.core.api.espn.com/v2/sports/soccer/athletes/" + id);
    out.bio = { "Doğum Tarihi": b.dateOfBirth ? String(b.dateOfBirth).slice(0, 10) : "", "Yaş": b.age || "", "Boy": b.displayHeight || "", "Kilo": b.displayWeight || "", "Uyruk": b.citizenship || "", "Mevki": (b.position && (b.position.displayName || b.position.name)) || "", "Forma No": b.jersey || "" };
    if (b.headshot && b.headshot.href) out.headshot = b.headshot.href;
  } catch (_) {}
  const playerLeagues = espnPlayerLeagueCodes(pick).slice(0, Math.max(1, leagueLimit));
  const statSets = await Promise.all(playerLeagues.map(async code => {
    try {
      const j = await getJSON("https://site.web.api.espn.com/apis/common/v3/sports/soccer/" + code + "/athletes/" + id + "/stats");
      return espnSeasons(j.categories ? j : j.statistics || {}, code);
    } catch (_) { return []; }
  }));
  out.seasons = mergeCareerRows(statSets);
  if (!out.seasons.length) {
    const overviewSets = await Promise.all(playerLeagues.slice(0, 5).map(async code => {
      try {
        const j = await getJSON("https://site.web.api.espn.com/apis/common/v3/sports/soccer/" + code + "/athletes/" + id + "/overview");
        return espnSeasons(j.categories ? j : j.statistics || {}, code);
      } catch (_) { return []; }
    }));
    out.seasons = mergeCareerRows(overviewSets);
  }
  if (!out.seasons.length && !out.note) out.note = "ESPN oyuncu kaydını buldu ancak sorgulanan liglerde sezon tablosu vermedi";
  return out;
}

const ssDetailC = (env, slug, id) => cached("m:s:" + slug + ":" + id, async () => {
  const r = await ssDetail(env, slug, id);
  await Promise.all([improveMatchLineups(env, r.match), improveMatchStats(r.match)]);
  return { body: { match: r.match }, ttl: r.live ? 8 : r.done ? 3600 : (r.match.lineups || []).length ? 300 : 60 };
});
const nkw = (n) => String(n || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\b(fc|cf|sc|afc|ac|club|the|u\d+|women|w)\b/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
const nameLike = (a, b) => { a = nkw(a); b = nkw(b); return !!a && !!b && (a === b || a.includes(b) || b.includes(a)); };
// Takım adını kaynaklar arasında eşleştirirken önce tam eşleşmeyi seç.
function pickCareerTeamCandidate(found, name, requireLogo = true) {
  const list = (found || []).filter(x => x && x.name && (!requireLogo || x.logo));
  const key = teamSearchKey(name);
  // Exact normalized club names only. Prefix/fuzzy matches can confuse FK Partizan (Serbia)
  // with FK Partizani (Albania), or similarly named clubs in different countries.
  const exact = list.filter(x => teamSearchKey(x.name) === key);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) {
    const withCountry = exact.filter(x => /serbia|srb|belgrade|sırbistan/i.test(String(x.team || x.country || "")));
    return withCountry.length === 1 ? withCountry[0] : null;
  }
  return null;
}
// Oyuncunun sezon kariyerindeki armaları birden fazla kaynaktan bul.
// Boş sonuçlar kısa süre önbelleğe alınır; geçici kaynak hatası bir gün boyunca kilitlemez.
async function lookupCareerTeamLogo(env, name) {
  let found = [];
  const cleanName = careerTeamLogoLookupName(name);
  // Exact API-Football team search covers many countries outside the small ESPN directory.
  try {
    if (apiFootballKey(env) && cleanName.length >= 3) {
      found = await apiFootballTeamSearch(env, cleanName);
      const candidate = pickCareerTeamCandidate(found.map(x => ({ ...x, logo: x.apiLogo || x.logo || "" })), cleanName);
      if (candidate && candidate.logo) return candidate.logo;
    }
  } catch (_) {}
  try {
    found = await espnTeamSearch(cleanName);
    let candidate = pickCareerTeamCandidate(found, cleanName, false);
    if (candidate && candidate.logo) return candidate.logo;
    // ESPN araması takım kimliğini bulup armayı vermediyse lig takım listesinden dene.
    if (candidate && candidate.code && candidate.id) {
      try {
        const j = await getJSON(SITE + candidate.code + "/teams");
        const teams = (j.sports && j.sports[0] && j.sports[0].leagues && j.sports[0].leagues[0] && j.sports[0].leagues[0].teams || []).map(x => x.team || x);
        const team = teams.find(t => String(t.id || "") === String(candidate.id))
          || teams.find(t => nameLike(t.displayName || t.name, cleanName));
        const logo = team && ((team.logos && team.logos[0] && team.logos[0].href) || team.logo);
        if (logo) return logo;
      } catch (_) {}
    }
  } catch (_) {}
  // ESPN'in kulübü bulamadığı/armayı vermediği durumlarda TheSportsDB'yi dene.
  try {
    found = await tsdbTeamSearch(name);
    const candidate = pickCareerTeamCandidate(found, cleanName);
    if (candidate && candidate.logo) return candidate.logo;
  } catch (_) {}
  // Kurulumda API-Football anahtarı tanımlıysa üçüncü kaynak olarak kullan.
  try {
    if (apiFootballKey(env)) {
      found = await apiFootballTeamSearch(env, name);
      const candidate = pickCareerTeamCandidate(found.map(x => ({ ...x, logo: x.apiLogo || "" })), name);
      if (candidate && candidate.logo) return candidate.logo;
    }
  } catch (_) {}
  return "";
}
// Kariyer tablosundaki takım armaları için ana liglerin toplu dizini.
// Bu bölüm yalnızca logo bulur; oyuncu istatistiklerinin kaynaklarına ve birleştirilmesine dokunmaz.
const CAREER_LOGO_LEAGUES = [
  "tur.1", "eng.1", "eng.2", "esp.1", "esp.2", "ger.1", "ger.2", "ita.1", "ita.2",
  "fra.1", "fra.2", "ned.1", "por.1", "bel.1", "bel.2", "sco.1", "aut.1", "aut.2",
  "gre.1", "den.1", "swe.1", "srb.1", "nor.1", "pol.1", "cz.1", "hrv.1", "rom.1",
  "usa.1", "ksa.1", "bra.1", "arg.1"
];
async function espnCareerTeamDirectory() {
  const groups = [];
  for (let i = 0; i < CAREER_LOGO_LEAGUES.length; i += 5) {
    const codes = CAREER_LOGO_LEAGUES.slice(i, i + 5);
    const found = await Promise.all(codes.map(async code => {
      try {
        const result = await cached("career-team-directory:v1:" + code, async () => ({
          body: await getJSON(SITE + code + "/teams"), ttl: 21600
        }));
        const league = (((result.body || {}).sports || [])[0] || {}).leagues || [];
        const teams = (league[0] && league[0].teams || []).map(x => x.team || x);
        return teams.map(t => {
          const logos = Array.isArray(t.logos) ? t.logos : [];
          const logoObj = logos.find(x => x && (x.href || x.url)) || null;
          const logo = (logoObj && (logoObj.href || logoObj.url))
            || (typeof t.logo === "string" ? t.logo : t.logo && (t.logo.href || t.logo.url)) || "";
          return { name: t.displayName || t.name || t.shortDisplayName || "", logo, id: String(t.id || ""), code };
        }).filter(x => x.name && x.logo);
      } catch (_) { return []; }
    }));
    groups.push(...found);
  }
  const unique = new Map();
  for (const team of groups.flat()) {
    const key = teamSearchKey(team.name);
    if (key && !unique.has(key)) unique.set(key, team);
  }
  return [...unique.values()];
}
function careerTeamLogoLookupName(value) {
  return String(value || "").trim()
    .replace(/\s*[\[(]\s*(?:k|kiralik|kiralık|w|women|women's|on loan|loan|loaned|load)\s*[\])]\s*$/i, "")
    .replace(/\s+(?:women|women's|ladies|femenino|feminino|on loan|loaned?|load)\s*$/i, "")
    .trim();
}
async function attachCareerTeamLogos(env, rows) {
  const allRows = rows || [];
  const names = [...new Set(allRows.map(r => String(r && r["Takım"] || "").trim()).filter(Boolean))];
  const foundLogos = new Map();
  const lookupKey = name => teamSearchKey(careerTeamLogoLookupName(name));

  // İlk gelen geçerli arma korunur; (K)/(W)/kiralık ibaresi takım aramasına katılmaz.
  for (const row of allRows) {
    const name = String(row && row["Takım"] || "").trim();
    const key = name ? lookupKey(name) : "";
    if (!key) continue;
    const existing = typeof row.logo === "string" ? row.logo.trim() : "";
    if (existing) foundLogos.set(key, [existing]);
  }

  let directory = [];
  try { directory = await espnCareerTeamDirectory(); } catch (_) {}
  const espnTeamMatches = new Map();
  for (const originalName of names) {
    const name = careerTeamLogoLookupName(originalName), key = lookupKey(originalName);
    const direct = foundLogos.get(key) || [];
    const candidate = pickCareerTeamCandidate(directory, name, false);
    if (candidate) {
      espnTeamMatches.set(key, candidate);
      for (const row of allRows) {
        if (lookupKey(row["Takım"]) !== key) continue;
        if (!row.teamId && candidate.id) row.teamId = String(candidate.id);
        if (!row.teamCode && candidate.code) row.teamCode = candidate.code;
      }
      if (candidate.logo && !direct.includes(candidate.logo)) direct.push(candidate.logo);
    }
    if (direct.length) foundLogos.set(key, direct);
  }

  // Resolve provider-native team IDs once per unique historical club. Those IDs are
  // carried into the click payload for fixtures and standings.
  if (apiFootballKey(env)) {
    const missingIds = names.filter(name => allRows.some(row => lookupKey(row["Takım"]) === lookupKey(name) && !/^\d+$/.test(String(row.teamAfId || ""))));
    for (let i = 0; i < missingIds.length; i += 4) {
      await Promise.all(missingIds.slice(i, i + 4).map(async originalName => {
        const key = lookupKey(originalName);
        try {
          const id = await cached("career-team-af-id:v1:" + key, async () => {
            const found = await resolveApiFootballTeam(env, originalName);
            return { body: found && found.id || "", ttl: found ? 604800 : 900 };
          });
          if (id.body) for (const row of allRows) if (lookupKey(row["Takım"]) === key && !row.teamAfId) row.teamAfId = String(id.body);
        } catch (_) {}
      }));
    }
  }

  const leftovers = names.filter(name => !(foundLogos.get(lookupKey(name)) || []).length);
  for (let i = 0; i < leftovers.length; i += 4) {
    await Promise.all(leftovers.slice(i, i + 4).map(async originalName => {
      try {
        const name = careerTeamLogoLookupName(originalName), key = lookupKey(originalName);
        const result = await cached("career-team-logo:v7:" + key, async () => {
          const logo = await lookupCareerTeamLogo(env, name);
          return { body: logo || "", ttl: logo ? 604800 : 900 };
        });
        if (result.body) foundLogos.set(key, [result.body]);
      } catch (_) {}
    }));
  }

  for (const row of allRows) {
    const name = String(row && row["Takım"] || "").trim();
    const key = name ? lookupKey(name) : "";
    if (!row || !key) continue;
    const candidates = [...(foundLogos.get(key) || [])];
    if (/^\d+$/.test(String(row.teamAfId || ""))) {
      const afLogo = "https://media.api-sports.io/football/teams/" + row.teamAfId + ".png";
      if (!candidates.includes(afLogo)) candidates.push(afLogo);
    }
    if (row.logo && typeof row.logo === "string") candidates.unshift(row.logo);
    row.logoCandidates = [...new Set(candidates.filter(x => typeof x === "string" && /^https?:\/\//i.test(x)))];
    if (!row.logo && row.logoCandidates.length) row.logo = row.logoCandidates[0];
  }
  return rows;
}
async function ssFindByTeams(env, date, home, away, todayTR) {
  const day = (await cached("ss:" + date, async () => {
    const r = await ssDay(env, date, todayTR);
    return { body: { source: "SportScore", parts: PARTS, capped: r.capped, response: r.list }, ttl: date === todayTR ? 5 : date < todayTR ? 21600 : 3600 };
  })).body;
  const m = (day.response || []).find((x) => nameLike(x.teams.home.name, home) && nameLike(x.teams.away.name, away));
  if (!m) return null;
  const [, slug, id] = m.fixture.id.split(":");
  return { slug, id };
}

// ---------- Oyuncu: Transfermarkt DB + TheSportsDB + SportScore + ESPN + API-Football + Sportmonks ----------
// Transfermarkt verisi yalnızca senkronizasyon cron'u tarafından PostgreSQL'e yazılır.
// Bu Worker'ın HTTP endpoint'leri Transfermarkt'a doğrudan istek atmaz.
async function tmDbRows(env, query) {
  const base = String(env && env.SUPABASE_URL || "").replace(/\/$/, "");
  const key = String(env && env.SUPABASE_SERVICE_ROLE_KEY || "");
  if (!base || !key) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY yapılandırılmadı");
  const url = base + "/rest/v1/" + query;
  const response = await fetch(url, {
    headers: { apikey: key, Authorization: "Bearer " + key, Accept: "application/json" },
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) throw new Error("PostgreSQL REST HTTP " + response.status);
  const rows = await response.json();
  return Array.isArray(rows) ? rows : [];
}
const TSDB = "https://www.thesportsdb.com/api/v1/json/123/";
const pick = (o, ...ks) => { for (const k of ks) if (o && o[k] != null && o[k] !== "") return o[k]; return ""; };
const nkp = (n) => String(n || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
function playerCandidateScore(candidate, wantedName, teamHint = "", posHint = "") {
  const candidateName = nkp(candidate && (candidate.name || candidate.display_name || candidate.displayName || [candidate.firstname, candidate.lastname].filter(Boolean).join(" ")));
  const wanted = nkp(wantedName);
  if (!candidateName || !wanted) return -1;
  const a = wanted.split(/\s+/).filter(Boolean), b = candidateName.split(/\s+/).filter(Boolean);
  let score = candidateName === wanted ? 100 : 0;
  if (!score && a.every(t => b.some(x => x === t || (t.length >= 4 && x.startsWith(t))))) score = 86;
  if (!score && a.length >= 2 && b.length >= 2 && a[a.length - 1] === b[b.length - 1] && (a[0][0] === b[0][0] || a[0] === b[0])) score = 72;
  if (!score && (candidateName.includes(wanted) || wanted.includes(candidateName)) && Math.min(candidateName.length, wanted.length) >= 6) score = 68;
  const teamList = candidate && Array.isArray(candidate.teams) ? candidate.teams.map(item => item && (item.team || item)).map(item => item && (item.name || item.display_name || item.displayName)).filter(Boolean).join(" | ") : "";
  const team = candidate && (candidate.team && (candidate.team.name || candidate.team.displayName) || candidate.teamName || candidate.club || candidate.clubName || candidate.current_team && candidate.current_team.name || teamList || "");
  if (teamHint && team) {
    if (teamSearchKey(team) === teamSearchKey(teamHint)) score += 28;
    else if (nameLike(team, teamHint)) score += 18;
  }
  const pos = candidate && (candidate.position && (candidate.position.name || candidate.position.displayName || candidate.position) || candidate.pos || "");
  if (posHint && pos && nkp(pos).includes(nkp(posHint))) score += 4;
  return score;
}
function selectPlayerCandidate(candidates, name, teamHint = "", posHint = "") {
  const ranked = (candidates || []).map(candidate => ({ candidate, score: playerCandidateScore(candidate, name, teamHint, posHint) }))
    .filter(x => x.score >= 68).sort((a, b) => b.score - a.score);
  if (!ranked.length) return null;
  if (ranked.length > 1 && ranked[0].score === ranked[1].score) return null;
  if (ranked.length > 1 && ranked[0].score - ranked[1].score < 7) return null;
  return ranked[0].candidate;
}

function transferDateStamp(value) {
  if (value == null || value === "") return 0;
  if (typeof value === "number") return value < 1e12 ? value * 1000 : value;
  const s = String(value).trim();
  if (/^\d{10,13}$/.test(s)) return Number(s) < 1e12 ? Number(s) * 1000 : Number(s);
  const dmy = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  if (dmy) return Date.UTC(Number(dmy[3]), Number(dmy[2]) - 1, Number(dmy[1]));
  const parsed = Date.parse(s);
  return Number.isFinite(parsed) ? parsed : 0;
}
function transferClubName(value) {
  if (typeof value === "string") return value.trim();
  if (!value || typeof value !== "object") return "";
  return String(value.name || value.clubName || value.displayName || value.shortName || value.teamName || "").trim();
}
function collectTransferOrderRows(payload) {
  const found = [], seen = new Set();
  const visit = (value, depth = 0) => {
    if (!value || depth > 5) return;
    if (Array.isArray(value)) { for (const item of value) visit(item, depth + 1); return; }
    if (typeof value !== "object") return;
    const date = pick(value, "date", "transferDate", "transfer_date", "dateOfTransfer", "dateFormatted", "transferDateFormatted", "timestamp", "joined", "startDate");
    const from = pick(value, "fromClub", "clubFrom", "from", "previousClub", "oldClub");
    const to = pick(value, "toClub", "clubTo", "to", "newClub", "nextClub");
    if (date && (from || to)) {
      const stamp = transferDateStamp(date);
      const fromName = transferClubName(from), toName = transferClubName(to);
      if (stamp && (fromName || toName)) {
        const key = [stamp, nkw(fromName), nkw(toName)].join("|");
        if (!seen.has(key)) { seen.add(key); found.push({ stamp, fromName, toName }); }
      }
    }
    for (const [key, child] of Object.entries(value)) {
      if (["player", "profile", "club", "league", "image", "logo"].includes(key.toLowerCase())) continue;
      if (child && typeof child === "object") visit(child, depth + 1);
    }
  };
  visit(payload);
  return found.sort((a, b) => a.stamp - b.stamp);
}
function applyTransferOrderToCareerRows(rows, transferPayload) {
  const order = new Map(), latestIncoming = new Map();
  for (const move of collectTransferOrderRows(transferPayload)) {
    const date = new Date(move.stamp), seasonStart = date.getUTCMonth() >= 5 ? date.getUTCFullYear() : date.getUTCFullYear() - 1;
    const prefix = seasonStart + "|";
    if (move.fromName) {
      const key = prefix + nkw(move.fromName), stamp = move.stamp - 1;
      order.set(key, order.has(key) ? Math.max(order.get(key), stamp) : stamp);
    }
    if (move.toName) {
      const key = prefix + nkw(move.toName), stamp = move.stamp;
      order.set(key, order.has(key) ? Math.max(order.get(key), stamp) : stamp);
      const previous = latestIncoming.get(seasonStart);
      if (!previous || move.stamp > previous.stamp) latestIncoming.set(seasonStart, { name: move.toName, stamp: move.stamp });
    }
  }
  for (const row of rows || []) {
    const year = Number(String(row["Sezon"] || "").match(/(?:19|20)\d{2}/)?.[0] || 0);
    const stamp = order.get(year + "|" + nkw(row["Takım"]));
    if (stamp) {
      const current = Number(row.careerTimestamp || row.careerOrder) || 0;
      if (!current || stamp > current) {
        row.careerTimestamp = stamp;
        row.careerOrder = stamp;
      }
    }
  }
  // Tarihli transfer geçmişi varsa o sezonun en son gidilen kulübünü açıkça işaretle.
  for (const [year, latest] of latestIncoming) {
    const seasonRows = (rows || []).filter(row => Number(String(row["Sezon"] || "").match(/(?:19|20)\d{2}/)?.[0] || 0) === Number(year));
    const matched = seasonRows.filter(row => teamSearchKey(careerTeamLogoLookupName(row["Takım"])) === teamSearchKey(careerTeamLogoLookupName(latest.name)));
    if (matched.length === 1) for (const row of seasonRows) row.transferLastTeam = row === matched[0];
  }
}

// Provider responses use several different image shapes (string, href, url, nested image).
// Normalize them once so search cards always receive usable HTTPS image candidates.
function normalizePhotoUrl(value) {
  if (typeof value !== "string") return "";
  let url = value.trim();
  if (url.startsWith("//")) url = "https:" + url;
  else if (/^http:\/\//i.test(url)) url = url.replace(/^http:\/\//i, "https://");
  return /^https:\/\//i.test(url) ? url : "";
}
function collectPhotoUrls(...values) {
  const out = [], seen = new Set();
  const visit = (value, depth = 0) => {
    if (value == null || depth > 3) return;
    if (Array.isArray(value)) { for (const child of value) visit(child, depth + 1); return; }
    const direct = normalizePhotoUrl(value);
    if (direct) { if (!seen.has(direct)) { seen.add(direct); out.push(direct); } return; }
    if (typeof value !== "object") return;
    for (const key of ["href", "url", "src", "default", "original", "imageUrl", "imageURL", "photo", "picture", "thumbnail", "thumb", "headshot", "profileImage", "image", "images", "logos", "strCutout", "strThumb", "strRender"]) {
      if (value[key] != null) visit(value[key], depth + 1);
    }
  };
  for (const value of values) visit(value);
  return out;
}
async function tmSearch(env, q) {
  const term = String(q || "").trim().replace(/[,*()]/g, " ").replace(/\s+/g, " ").slice(0, 60);
  if (!term) return [];
  const params = new URLSearchParams({
    select: "tm_id,name,team_name,position,photo_url",
    name: "ilike.*" + term + "*",
    order: "name.asc",
    limit: "15"
  });
  const rows = await tmDbRows(env, "tm_players?" + params.toString());
  return rows.map(x => ({
    name: x.name || "",
    tm: String(x.tm_id || ""),
    team: x.team_name || "",
    pos: x.position || "",
    logo: x.photo_url || "",
    photos: x.photo_url ? [x.photo_url] : []
  })).filter(x => x.name && x.tm);
}
async function espnPlayerPortrait(id) {
  const playerId = String(id || '').replace(/\D/g, '');
  if (!playerId) return [];
  try {
    const result = await cached('espn-player-portrait:v3:' + playerId, async () => ({
      body: await getJSON('https://sports.core.api.espn.com/v2/sports/soccer/athletes/' + playerId), ttl: 86400,
    }));
    const b = result.body || {};
    const href = b.headshot && (b.headshot.href || b.headshot.default) || '';
    const guessed = 'https://a.espncdn.com/i/headshots/soccer/players/full/' + playerId + '.png';
    return [href, guessed].filter((v,i,a)=>v&&a.indexOf(v)===i);
  } catch (_) { return []; }
}
async function tmTeamRoster(env, teamName) {
  const term = String(teamName || "").trim().replace(/[,*()]/g, " ").replace(/\s+/g, " ").slice(0, 80);
  if (!term) return [];
  const params = new URLSearchParams({
    select: "tm_id,name,team_name,position,photo_url,profile_payload",
    team_name: "ilike.*" + term + "*",
    is_active: "eq.true",
    last_squad_seen_at: "gte." + new Date(Date.now() - 14 * 86400000).toISOString(),
    order: "name.asc",
    limit: "120"
  });
  const rows = await tmDbRows(env, "tm_players?" + params.toString());
  return rows.map(x => ({
    name: x.name || "",
    tm: String(x.tm_id || ""),
    team: x.team_name || term,
    pos: x.position || "",
    photo: x.photo_url || "",
    photos: x.photo_url ? [x.photo_url] : [],
    number: (x.profile_payload && (x.profile_payload.shirtNumber || x.profile_payload.shirt_number)) || "",
    source: "Transfermarkt DB"
  })).filter(x => x.name && x.tm);
}

async function tmPlayerPortrait(env, id) {
  const playerId = String(id || "").replace(/\D/g, "");
  if (!playerId) return [];
  try {
    const rows = await tmDbRows(env, "tm_players?select=photo_url&tm_id=eq." + encodeURIComponent(playerId) + "&limit=1");
    return rows[0] && rows[0].photo_url ? [rows[0].photo_url] : [];
  } catch (_) { return []; }
}
async function tsdbPlayerPortrait(id) {
  const playerId = String(id || '').replace(/\D/g, '');
  if (!playerId) return [];
  try {
    const result = await cached('tsdb-player-portrait:v3:' + playerId, async () => ({
      body: await getJSON(TSDB + 'lookupplayer.php?id=' + encodeURIComponent(playerId)), ttl: 86400,
    }));
    const p = (result.body && result.body.players || [])[0] || {};
    return [p.strCutout, p.strThumb, p.strRender].filter((v,i,a)=>typeof v==='string'&&/^https?:\/\//i.test(v)&&a.indexOf(v)===i);
  } catch (_) { return []; }
}
async function wikiPlayerPortrait(name) {
  const title = String(name || "").trim().replace(/\s+/g, "_").slice(0, 100);
  if (!title) return [];
  try {
    const result = await cached("wiki-player-portrait:v3:" + nkp(title), async () => ({
      body: await getJSON("https://en.wikipedia.org/api/rest_v1/page/summary/" + encodeURIComponent(title), 2), ttl: 86400,
    }));
    const body = result.body || {};
    const image = body.thumbnail && body.thumbnail.source || body.originalimage && body.originalimage.source || "";
    const wanted = nkp(title).split(" ").filter(Boolean), resolved = nkp(body.title || "");
    const surname = wanted[wanted.length - 1] || "";
    const hits = wanted.filter(token => resolved.includes(token)).length;
    const samePersonTitle = !!surname && resolved.includes(surname) && hits >= (wanted.length > 1 ? 2 : 1);
    // Only accept a page image when its article title matches the requested player's name.
    return samePersonTitle && image && /^https?:\/\//i.test(image) ? [image] : [];
  } catch (_) { return []; }
}
async function commonsPlayerPortrait(name) {
  const fullName = String(name || "").trim().replace(/\s+/g, " ").slice(0, 90);
  const tokens = nkp(fullName).split(" ").filter(x => x.length > 1);
  if (!tokens.length) return [];
  try {
    // Dosya adlarında "footballer portrait" ifadesi bulunmayabildiğinden önce
    // oyuncu adını tek başına ara; Türkçe karakterli ve ASCII biçimlerini birleştir.
    const queries = [...new Set([fullName, nkp(fullName)].filter(Boolean))];
    const key = "commons-player-portrait:v5:" + nkp(fullName);
    const result = await cached(key, async () => {
      const searches = await Promise.allSettled(queries.map(query => getJSON("https://commons.wikimedia.org/w/api.php?" + new URLSearchParams({
        action: "query", format: "json", origin: "*", generator: "search", gsrsearch: query,
        gsrnamespace: "6", gsrlimit: "15", prop: "imageinfo", iiprop: "url", iiurlwidth: "500",
      }))));
      const pages = searches.flatMap(search => search.status === "fulfilled" ? Object.values(search.value.query && search.value.query.pages || {}) : []);
      return { body: { query: { pages: Object.fromEntries(pages.map((page, index) => [String(page.pageid || index), page])) } }, ttl: 86400 };
    });
    const pages = Object.values(result.body && result.body.query && result.body.query.pages || []);
    const exact = pages.map(page => {
      const title = String(page.title || "").replace(/^File:/i, "");
      const norm = nkp(title);
      const surname = tokens[tokens.length - 1];
      const hits = tokens.filter(token => norm.includes(token)).length;
      const matches = norm.includes(surname) && hits >= (tokens.length > 1 ? 2 : 1);
      const info = (page.imageinfo || [])[0] || {};
      return { matches, hits, url: info.thumburl || info.url || "" };
    }).filter(x => x.matches && /^https?:\/\//i.test(x.url)).sort((a,b)=>b.hits-a.hits);
    return exact.length ? [exact[0].url] : [];
  } catch (_) { return []; }
}
async function resolvePlayerPortraits(env, item, options = {}) {
  const x = item || {};
  const supplied = collectPhotoUrls(x.photos, x.photo, x.image, x.logo);
  const isGuessed = url => /a\.espncdn\.com\/i\/headshots\/soccer\/players\/full\/\d+\.png$/i.test(url)
    || /media\.api-sports\.io\/football\/players\/\d+\.png$/i.test(url);
  const providerPhotos = supplied.filter(url => !isGuessed(url));
  const apiPhoto = x.af ? ["https://media.api-sports.io/football/players/" + encodeURIComponent(String(x.af)) + ".png"] : [];
  const espnGuess = x.espn ? ["https://a.espncdn.com/i/headshots/soccer/players/full/" + encodeURIComponent(String(x.espn).replace(/\D/g, "")) + ".png"] : [];
  let fallbackPhotos = [];
  // A guessed CDN URL is not proof that a file exists. If no provider returned
  // a real portrait, query two independent image catalogues for this exact name.
  // SearchAll caps results at 18, so at most 36 fallback subrequests are made.
  if (providerPhotos.length < 2 && (options.allowSearchFallback || options.searchMissing) && x.name) {
    const results = await Promise.allSettled([
      commonsPlayerPortrait(x.name),
      wikiPlayerPortrait(x.wiki || x.name),
    ]);
    for (const result of results) {
      if (result.status === "fulfilled" && Array.isArray(result.value)) fallbackPhotos.push(...result.value);
    }
  }
  // Actual image URLs first; ID-derived URLs are last-resort candidates only.
  return collectPhotoUrls(providerPhotos, fallbackPhotos, apiPhoto, espnGuess);
}
async function tsdbSearch(q) {
  const queries = [...new Set([String(q || "").trim(), nkp(q)].filter(Boolean).map(value => value.replace(/\s+/g, "_")))];
  const results = await Promise.allSettled(queries.map(query => getJSON(TSDB + "searchplayers.php?p=" + encodeURIComponent(query))));
  const players = results.flatMap(result => result.status === "fulfilled" ? (result.value.player || []) : []);
  const unique = [...new Map(players.map(player => [String(player.idPlayer || (nkp(player.strPlayer) + "|" + nkw(player.strTeam))), player])).values()];
  return unique.filter((x) => /soccer|football/i.test(x.strSport || "Soccer")).slice(0, 15).map((x) => {
    const photos = collectPhotoUrls(x.strCutout, x.strThumb, x.strRender, x.strFanart1);
    return { name: x.strPlayer || x.strPlayerAlternate || "", tsdb: String(x.idPlayer || ""), team: x.strTeam || "", country: x.strNationality || x.strCountry || "", nationality: x.strNationality || "", pos: x.strPosition || "", logo: photos[0] || "", photo: photos[0] || "", photos };
  }).filter((x) => x.name);
}
const WIKI = "https://en.wikipedia.org/w/api.php?format=json&origin=*&";
const WIKI_KIND = {
  player: { suffix: " footballer", ok: /footballer|soccer player|football player|goalkeeper|midfielder|defender|striker|forward|winger/i, no: /\b(club|team|stadium|season|league|national football team|manager only)\b/i },
  coach: { suffix: " football manager", ok: /manager|coach|trainer/i, no: /\b(club|team|stadium|season|league)\b/i },
  team: { suffix: " football club", ok: /football club|association football|soccer club|sports club|club/i, no: /player|footballer|manager|stadium|season/i },
};
async function wikiSearch(q, kind = "player") {
  const K = WIKI_KIND[kind];
  const j = await getJSON(WIKI + new URLSearchParams({ action: "query", generator: "search", gsrsearch: q + K.suffix, gsrlimit: "10", gsrenablerewrites: "1", prop: "pageimages|description", piprop: "thumbnail", pithumbsize: "300" }), 2);
  const pages = Object.values((j.query && j.query.pages) || {}).sort((a, b) => (a.index || 0) - (b.index || 0));
  return pages.map((x, i) => ({ x, i })).filter(({ x }) => K.ok.test(x.description || "") && !K.no.test(x.description || "")).slice(0, 8).map(({ x, i }) => ({ name: String(x.title).replace(/\s*\(.*\)\s*$/, ""), wiki: x.title, team: x.description || "", pos: "", logo: (x.thumbnail && x.thumbnail.source) || "", top: i === 0 }));
}
// Wikipedia "Career statistics" bölümündeki kulüp tablosunu (kulüp / sezon / lig / toplam) okur.
const htmlText = (h) => String(h).replace(/<sup[\s\S]*?<\/sup>/g, "").replace(/<style[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, "").replace(/&#160;|&nbsp;/g, " ").replace(/&#91;.*?&#93;/g, "").replace(/&amp;/g, "&").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/\s+/g, " ").trim();
function wikiGrid(t) {
  const grid = [], pend = [];
  for (const rm of t.matchAll(/<tr[\s\S]*?<\/tr>/g)) {
    const row = [];
    let col = 0;
    const place = () => { while (pend[col] && pend[col].left > 0) { row[col] = pend[col].text; pend[col].left--; col++; } };
    for (const cm of rm[0].matchAll(/<(t[hd])([^>]*)>([\s\S]*?)<\/\1>/g)) {
      place();
      const rs = Number((cm[2].match(/rowspan="?(\d+)/) || [])[1] || 1), cs = Number((cm[2].match(/colspan="?(\d+)/) || [])[1] || 1), tx = htmlText(cm[3]);
      for (let k = 0; k < cs; k++) { row[col] = tx; if (rs > 1) pend[col] = { text: tx, left: rs - 1 }; col++; }
    }
    place();
    grid.push(row);
  }
  return grid;
}
const SEASON_RE = /^\d{4}(?:\s*(?:[–—−-]|\/)\s*\d{2,4})?$/;
const TOTAL_RE = /^(total|toplam|career total|kariyer)/i;
function wikiTableRows(html) {
  for (const tm of html.matchAll(/<table[\s\S]*?<\/table>/g)) {
    const t = tm[0];
    if (!/Club|Kul[üu]p/i.test(t) || !/Season|Sezon/i.test(t) || !/Apps|Appearances|Ma[çc]|Oynan/i.test(t)) continue;
    const grid = wikiGrid(t);
    const hi = grid.findIndex((r) => r.some((x) => /^(Club|Kul[üu]p)$/i.test(x)) && r.some((x) => /^(Season|Sezon)$/i.test(x)));
    if (hi < 0) continue;
    const h0 = grid[hi];
    const ci = h0.findIndex((x) => /^(Club|Kul[üu]p)$/i.test(x)), si = h0.findIndex((x) => /^(Season|Sezon)$/i.test(x));
    const isData = (r) => r.length >= 5 && r.length === h0.length && (SEASON_RE.test(r[si] || "") || TOTAL_RE.test((r[si] || "") + "") || TOTAL_RE.test((r[ci] || "") + ""));
    const h1 = grid[hi + 1] && !isData(grid[hi + 1]) && grid[hi + 1].length === h0.length ? grid[hi + 1] : [];
    const hasTotalGroup = h0.some((x) => /^(total|toplam)$/i.test(x));
    const out = [];
    for (const r of grid.slice(hi + 1)) {
      if (!isData(r)) continue;
      const se = r[si] || "", club = r[ci] === se ? "" : r[ci];
      const cats = emptyCats();
      let any = false;
      const groups = new Map();
      for (let i = 0; i < h0.length; i++) {
        const group = String(h0[i] || "").trim();
        if (!group || /^(club|kul[üu]p|season|sezon)$/i.test(group)) continue;
        if (!groups.has(group)) groups.set(group, []);
        groups.get(group).push(i);
      }
      const values = { m: null, g: null, a: null, s: null, y: null, red: null };
      const metric = label => /^(apps|appearances|ma[çc]|oynan)/i.test(label) ? "m" : /^(goals|gol)/i.test(label) ? "g" : /^(assists|asist)/i.test(label) ? "a" : /^(starts|started|games started|ilk 11)/i.test(label) ? "s" : /^(yellow|sarı)/i.test(label) ? "y" : /^(red|kırmızı)/i.test(label) ? "red" : "";
      for (const [group, columns] of groups) {
        const stats = { m: null, g: null, a: null, s: null, y: null, red: null };
        for (const col of columns) {
          const key = metric(String(h1[col] || "").trim());
          if (key && String(r[col] == null ? "" : r[col]).trim() !== "") stats[key] = num(r[col]);
        }
        if (/^(total|toplam)$/i.test(group)) { Object.assign(values, stats); continue; }
        if (Object.values(stats).some(v => v != null)) {
          any = true;
          addCat(cats, catOf(group), stats.m || 0, stats.g || 0, stats.a, stats.s, stats.y, stats.red);
        }
      }
      const tm = num(r[r.length - 2]), tg = num(r[r.length - 1]);
      if (!any && !hasTotalGroup) addCat(cats, "lig", tm, tg, null);
      const totalM = values.m == null ? (hasTotalGroup ? null : r[r.length - 2] || "") : values.m;
      const totalG = values.g == null ? (hasTotalGroup ? null : r[r.length - 1] || "") : values.g;
      out.push({ "Takım": club, "Sezon": TOTAL_RE.test(se) || TOTAL_RE.test(club || "") ? "Toplam" : se, "Maç": totalM, "Gol": totalG, "Asist": values.a, "İlk 11": values.s, "Sarı Kart": values.y, "Kırmızı Kart": values.red, cats });
    }
    if (out.length) return out;
  }
  return [];
}
function wikiNationalRows(html) {
  for (const tm of html.matchAll(/<table[\s\S]*?<\/table>/g)) {
    const t = tm[0];
    if (!/National team|Milli tak[ıi]m|Uluslararası/i.test(t) || !/Year|Y[ıi]l/i.test(t) || !/Apps|Ma[çc]/i.test(t)) continue;
    const grid = wikiGrid(t);
    const hi = grid.findIndex((r) => r.some((x) => /^(National team|Milli tak[ıi]m|Tak[ıi]m)$/i.test(x)) && r.some((x) => /^(Year|Y[ıi]l|Sezon)$/i.test(x)));
    if (hi < 0) continue;
    const h = grid[hi], ti = h.findIndex((x) => /^(National team|Milli tak[ıi]m|Tak[ıi]m)$/i.test(x)), yi = h.findIndex((x) => /^(Year|Y[ıi]l|Sezon)$/i.test(x));
    const ai = h.findIndex((x) => /^(Apps|Appearances|Ma[çc])/i.test(x)), gi = h.findIndex((x) => /^(Goals|Gol)/i.test(x));
    if (ai < 0 || gi < 0) continue;
    const si = h.findIndex(x => /^(Starts|Started|Games started|İlk 11)/i.test(x)), asi = h.findIndex(x => /^(Assists|Asist)/i.test(x));
    const yi2 = h.findIndex(x => /^(Yellow cards|Yellow|Sarı)/i.test(x)), ri = h.findIndex(x => /^(Red cards|Red|Kırmızı)/i.test(x));
    const out = [];
    for (const r of grid.slice(hi + 1)) {
      if (r.length !== h.length) continue;
      const team = r[ti] || "", yr = r[yi] || "";
      if (TOTAL_RE.test(team) || TOTAL_RE.test(yr) || !/\d{4}/.test(yr)) continue;
      out.push({ "Sezon": yr, "Takım": team, "Maç": r[ai] || "", "Gol": r[gi] || "", "Asist": asi < 0 || !r[asi] ? null : r[asi], "İlk 11": si < 0 || !r[si] ? null : r[si], "Sarı Kart": yi2 < 0 || !r[yi2] ? null : r[yi2], "Kırmızı Kart": ri < 0 || !r[ri] ? null : r[ri] });
    }
    if (out.length) return out;
  }
  return [];
}
function wikiManagerRows(html) {
  for (const tm of html.matchAll(/<table[\s\S]*?<\/table>/g)) {
    const t = tm[0];
    if (!/Team|Tak[ıi]m/i.test(t) || !/From|Ba[şs]lang/i.test(t) || !/\bW\b|Won|Galibiyet/i.test(t)) continue;
    const grid = wikiGrid(t);
    const hi = grid.findIndex((r) => r.some((x) => /^(Team|Tak[ıi]m)$/i.test(x)) && r.some((x) => /^From$/i.test(x)));
    if (hi < 0) continue;
    const h0 = grid[hi], h1 = grid[hi + 1] && grid[hi + 1].length === h0.length && !/\d{4}/.test(grid[hi + 1].join("")) ? grid[hi + 1] : [];
    const col = (re) => { let i = h1.findIndex((x) => re.test(x)); if (i < 0) i = h0.findIndex((x) => re.test(x)); return i; };
    const ti = h0.findIndex((x) => /^(Team|Tak[ıi]m)$/i.test(x)), fi = h0.findIndex((x) => /^From$/i.test(x)), toi = h0.findIndex((x) => /^To$/i.test(x));
    const pi = col(/^(P|G|Pld|M)$/), wi = col(/^W$/), di = col(/^D$/), li = col(/^L$/);
    if (pi < 0 || wi < 0) continue;
    const out = [];
    for (const r of grid.slice(hi + 1)) {
      if (r.length !== h0.length || !/\d{4}/.test((r[fi] || "") + (r[toi] || "")) ) continue;
      if (TOTAL_RE.test(r[ti] || "")) continue;
      out.push({ "Takım": r[ti] || "", "Dönem": (r[fi] || "").replace(/^.*?(\d{4}).*$/, "$1") + " – " + ((r[toi] || "").match(/\d{4}/) ? (r[toi] || "").replace(/^.*?(\d{4}).*$/, "$1") : "Devam"), "O": r[pi] || "", "G": r[wi] || "", "B": di >= 0 ? r[di] || "" : "", "M": li >= 0 ? r[li] || "" : "" });
    }
    if (out.length) return out;
  }
  return [];
}
// Wikipedia bilgi kutusundan: doğum tarihi, şu anki takım, mevki, boy
async function wikiInfobox(title) {
  const j = await getJSON(WIKI + "action=parse&redirects=1&prop=wikitext&section=0&page=" + encodeURIComponent(title.replace(/ /g, "_")), 2);
  const wt = String((j.parse && j.parse.wikitext && (j.parse.wikitext["*"] || j.parse.wikitext)) || "");
  const field = (n) => { const m = wt.match(new RegExp("^\\s*\\|\\s*" + n + "\\s*=\\s*(.*)$", "mi")); return m ? m[1] : ""; };
  const clean = (v) => String(v).replace(/<ref[\s\S]*?(<\/ref>|\/>)/g, "").replace(/\{\{[^}]*\}\}/g, "").replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, "$1").replace(/<[^>]+>/g, "").replace(/'{2,}/g, "").trim();
  const bio = {};
  const bd = field("birth_date");
  let m = bd.match(/(\d{4})\s*\|\s*(\d{1,2})\s*\|\s*(\d{1,2})/);
  if (m) Object.assign(bio, dateBio(m[1] + "-" + String(m[2]).padStart(2, "0") + "-" + String(m[3]).padStart(2, "0")));
  else if ((m = bd.match(/(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/)) && EN_MONTHS.indexOf(m[2].toLowerCase()) >= 0) { const mo = EN_MONTHS.indexOf(m[2].toLowerCase()) + 1; Object.assign(bio, dateBio(m[3] + "-" + String(mo).padStart(2, "0") + "-" + String(m[1]).padStart(2, "0"))); }
  const club = clean(field("currentclub"));
  if (club) bio["Şu Anki Takım"] = club;
  const pos = clean(field("position"));
  if (pos) bio["Mevki"] = pos;
  const ht = field("height").match(/m\s*=\s*([\d.]+)/) || field("height").match(/([\d.]+)\s*m/);
  if (ht) bio["Boy"] = ht[1].replace(".", ",") + " m";
  return bio;
}
const TRWIKI = "https://tr.wikipedia.org/w/api.php?format=json&origin=*&";
async function wikiSections(title, lang, re, kind) {
  const W = lang === "tr" ? TRWIKI : WIKI;
  const base = W + "action=parse&redirects=1&page=" + encodeURIComponent(title.replace(/ /g, "_"));
  const sj = await getJSON(base + "&prop=sections", 2);
  const secs = ((sj.parse && sj.parse.sections) || []).filter((x) => re.test(x.line));
  const out = { club: [], national: [], manager: [] };
  let tries = 0;
  for (const sec of secs.slice(0, 8)) {
    if (tries++ >= 8) break;
    const hj = await getJSON(base + "&prop=text&disableeditsection=1&section=" + sec.index, 2);
    const html = String((hj.parse && hj.parse.text && (hj.parse.text["*"] || hj.parse.text)) || "");
    if (kind === "manager") { const r = wikiManagerRows(html); if (r.length) { out.manager = r; break; } continue; }
    if (!out.club.length) out.club = wikiTableRows(html);
    if (!out.national.length) out.national = wikiNationalRows(html);
    if (out.club.length && out.national.length) break;
  }
  return out;
}
async function wikiStats(title, lang) {
  return wikiSections(title, lang || "en", /career|statistic|club|international|kariyer|istatistik|kul[üu]p|milli/i, "player");
}
// Tek istekle bütün makale tablolarını tara. PitchAPI etkin olduğunda eski kariyer
// kaynağı devre dışı kalmasın; çok sayıda bölüm isteği de Worker alt-istek sınırını aşmasın.
async function wikiStatsSingle(title, lang) {
  const W = lang === "tr" ? TRWIKI : WIKI;
  const key = "wiki-player-stats-single:v1:" + lang + ":" + nkp(title);
  return (await cached(key, async () => {
    const url = W + "action=parse&redirects=1&prop=text&page=" + encodeURIComponent(String(title || "").replace(/ /g, "_"));
    const j = await getJSON(url, 1);
    const html = String(j && j.parse && j.parse.text && (j.parse.text["*"] || j.parse.text) || "");
    return { body: { club: wikiTableRows(html), national: wikiNationalRows(html) }, ttl: 21600 };
  })).body;
}
function wikiCareerBaseRows(rows) {
  return (rows || []).map(row => {
    const copy = { ...row, "Asist": null, "İlk 11": null, "Sarı Kart": null, "Kırmızı Kart": null };
    if (copy.cats) {
      copy.cats = JSON.parse(JSON.stringify(copy.cats));
      for (const category of ["lig", "kupa", "intl"]) if (copy.cats[category]) {
        copy.cats[category].a = null; copy.cats[category].s = null;
        copy.cats[category].y = null; copy.cats[category].r = null;
      }
    }
    return copy;
  });
}
async function wikiManagerStats(title, lang) {
  return (await wikiSections(title, lang || "en", /manage|coach|statistic|record|teknik|antren/i, "manager")).manager;
}
async function wikiTrTitle(title) {
  const j = await getJSON(WIKI + "action=query&prop=langlinks&lllang=tr&redirects=1&titles=" + encodeURIComponent(title), 2);
  const pg = Object.values((j.query && j.query.pages) || {})[0] || {};
  const ll = pg.langlinks && pg.langlinks[0];
  return ll ? ll["*"] || ll.title || "" : "";
}
const wikiTitle = async (name) => (await cached("wt:" + nkp(name), async () => {
  const r = await wikiSearch(name);
  const target = nkp(name), m = r.find((x) => nkp(x.name) === target || nkp(x.wiki) === target) || (r.length === 1 ? r[0] : null);
  return { body: { t: m ? m.wiki : "" }, ttl: m ? 21600 : 60 };
})).body.t;
async function wikiTrAbout(title) {
  const t = await wikiTrTitle(title);
  if (!t) return "";
  const r = await getJSON("https://tr.wikipedia.org/api/rest_v1/page/summary/" + encodeURIComponent(t.replace(/ /g, "_")), 2);
  return r.extract || "";
}
async function wikiPlayer(title) {
  const j = await getJSON("https://en.wikipedia.org/api/rest_v1/page/summary/" + encodeURIComponent(title.replace(/ /g, "_")), 2);
  return { photo: (j.originalimage && j.originalimage.source) || (j.thumbnail && j.thumbnail.source) || "", about: j.extract || "", desc: j.description || "" };
}
async function tsdbTeamSearch(q) {
  const j = await getJSON(TSDB + "searchteams.php?t=" + encodeURIComponent(q.replace(/\s+/g, "_")));
  return (j.teams || []).filter((x) => /soccer|football/i.test(x.strSport || "Soccer")).slice(0, 10).map((x) => ({ name: x.strTeam || "", tsdb: String(x.idTeam || ""), team: [x.strLeague, x.strCountry].filter(Boolean).join(" · "), logo: x.strBadge || x.strLogo || "" })).filter((x) => x.name);
}
async function apiFootballTeamSearch(env, q) {
  if (!apiFootballKey(env) || String(q || "").trim().length < 3) return [];
  const j = await apiFootballJSON(env, "/teams", { search: String(q).trim() });
  return (j.response || []).map(x => x.team || {}).filter(x => x.name).map(x => ({ name: x.name, af: String(x.id || ""), apiLogo: x.logo || "", logo: x.logo || "", team: [x.country, x.code].filter(Boolean).join(" · ") }));
}
const AF_COUNTRY_NAMES = {
  turkiye:"Turkey", ingiltere:"England", ispanya:"Spain", almanya:"Germany", italya:"Italy", fransa:"France",
  hollanda:"Netherlands", portekiz:"Portugal", abd:"USA", "s arabistan":"Saudi Arabia", brezilya:"Brazil", arjantin:"Argentina",
  iskocya:"Scotland", irlanda:"Ireland", "k irlanda":"Northern Ireland", galler:"Wales", belcika:"Belgium", yunanistan:"Greece",
  rusya:"Russia", ukrayna:"Ukraine", avusturya:"Austria", isvicre:"Switzerland", danimarka:"Denmark", isvec:"Sweden",
  norvec:"Norway", finlandiya:"Finland", izlanda:"Iceland", polonya:"Poland", cekya:"Czech Republic", hirvatistan:"Croatia",
  sirbistan:"Serbia", romanya:"Romania", macaristan:"Hungary", bulgaristan:"Bulgaria", slovakya:"Slovakia", slovenya:"Slovenia",
  "bosna hersek":"Bosnia and Herzegovina", arnavutluk:"Albania", "k makedonya":"North Macedonia", kibris:"Cyprus", israil:"Israel",
  gurcistan:"Georgia", azerbaycan:"Azerbaijan", ermenistan:"Armenia", kazakistan:"Kazakhstan", letonya:"Latvia", litvanya:"Lithuania",
  estonya:"Estonia", malta:"Malta", luksemburg:"Luxembourg", japonya:"Japan", "g kore":"Korea Republic", cin:"China",
  avustralya:"Australia", hindistan:"India", tayland:"Thailand", endonezya:"Indonesia", malezya:"Malaysia", singapur:"Singapore",
  vietnam:"Vietnam", bae:"United Arab Emirates", katar:"Qatar", iran:"Iran", irak:"Iraq", "g afrika":"South Africa",
  misir:"Egypt", fas:"Morocco", tunus:"Tunisia", cezayir:"Algeria", nijerya:"Nigeria", meksika:"Mexico", kanada:"Canada",
  kolombiya:"Colombia", sili:"Chile", uruguay:"Uruguay", paraguay:"Paraguay", peru:"Peru", ekvador:"Ecuador", venezuela:"Venezuela",
};
async function apiFootballLeagueSearch(env, q) {
  const term = String(q || "").trim();
  if (!apiFootballKey(env) || term.length < 3) return [];
  const normalized = nkw(term);
  const countryHit = Object.entries(AF_COUNTRY_NAMES).find(([local, english]) => {
    const names = [local, nkw(english)];
    return names.some(name => normalized === name || normalized.includes(name + " ") || normalized.endsWith(" " + name));
  });
  const translated = term
    .replace(/şampiyonlar\s+ligi/ig, "Champions League")
    .replace(/avrupa\s+ligi/ig, "Europa League")
    .replace(/süper\s+kupa/ig, "Super Cup")
    .replace(/super\s+kupa/ig, "Super Cup")
    .replace(/kupa(sı)?/ig, "Cup")
    .replace(/süper\s+lig/ig, "Super League")
    .replace(/super\s+lig/ig, "Super League")
    .replace(/\blig\b/ig, "League");
  const params = countryHit ? { country: countryHit[1] } : { search: translated };
  const j = await apiFootballJSON(env, "/leagues", params);
  return (j.response || []).map(x => {
    const league = x.league || {}, country = x.country || {};
    const id = String(league.id || "");
    if (!id || !league.name) return null;
    return {
      name: league.name,
      code: espnCodeFromAfLeague(id) || "af-" + id,
      af: id,
      id,
      team: typeof country === "string" ? country : (country.name || ""),
      logo: league.logo || "",
    };
  }).filter(Boolean);
}
function catalogLeagueSearch(term) {
  const query = nkw(term).split(" ").filter(Boolean);
  return LEAGUES.filter(row => {
    const hay = nkw([row[2], row[3]].filter(Boolean).join(" ")).split(" ");
    return query.every(part => hay.some(word => word.startsWith(part) || (part.length >= 4 && word.includes(part))));
  }).map(row => { const af = row[1] == null ? "" : String(row[1]); return { name: row[2], code: row[0], af, id: af, team: row[3] || "", logo: /^\d+$/.test(af) ? "https://media.api-sports.io/football/leagues/" + af + ".png" : "" }; });
}
function teamSearchKey(name) {
  const value = nkw(name).split(" ").filter(x => !["jk", "sk", "fk", "spor", "kulubu", "istanbul", "football"].includes(x)).join(" ").replace(/\bs\s+k\b/g, "").replace(/\s+/g, " ").trim();
  const aliases = {
    "man u": "manchester united", "man utd": "manchester united", "man united": "manchester united", "manchester utd": "manchester united",
    "man city": "manchester city", "psg": "paris saint germain", "paris sg": "paris saint germain",
    "internazionale": "inter milan", "internazionale milano": "inter milan", "inter": "inter milan",
    "bayern": "bayern munich", "fc bayern": "bayern munich", "bayern munchen": "bayern munich", "bayern munih": "bayern munich", "bayern munich": "bayern munich",
    "koln": "cologne", "koeln": "cologne", "cologne": "cologne", "fc cologne": "cologne", "1 koln": "cologne", "1 fc koln": "cologne",
    "bvb": "borussia dortmund", "barca": "barcelona", "fc barcelona": "barcelona",
    "fenerbahce sk": "fenerbahce", "galatasaray sk": "galatasaray", "besiktas jk": "besiktas",
    "partizan belgrade": "partizan", "partizan beograd": "partizan", "fk partizan": "partizan",
  };
  return aliases[value] || value;
}
async function espnTeamSearch(q) {
  const j = await getJSON("https://site.web.api.espn.com/apis/common/v3/search?" + new URLSearchParams({ query: q, limit: "10", type: "team" }));
  const image = x => typeof x === "string" ? x : x && (x.href || x.default || x.url) || "";
  // ESPN'in arama sonucunda bazen sport/league alanı yok, bazen de lig adı var
  // ("Turkish Super Lig"). Eski filtre bu sonuçları hatalı biçimde eliyordu.
  return (j.items || j.results || []).filter(x => {
    const type = String(x.type || x.typeName || x.entityType || "team");
    return /team/i.test(type);
  }).slice(0, 10).map(x => {
    const logos = Array.isArray(x.logos) ? x.logos : [];
    const logo = image((x.image && (x.image.default || x.image)) || x.logo || logos[0]);
    return { name: x.displayName || x.name || "", id: String(x.id || ""), code: x.defaultLeagueSlug || x.leagueSlug || "", team: x.description || x.subtitle || "", logo };
  }).filter(x => x.name && x.id);
}
async function tsdbLeagueSearch(term) {
  const q = String(term || "").trim();
  if (q.length < 2) return [];
  const tsdbQuery = q
    .replace(/şampiyonlar\s+ligi/ig, "Champions League")
    .replace(/avrupa\s+ligi/ig, "Europa League")
    .replace(/süper\s+kupa/ig, "Super Cup")
    .replace(/super\s+kupa/ig, "Super Cup")
    .replace(/kupa(sı)?/ig, "Cup")
    .replace(/süper\s+lig/ig, "Super League")
    .replace(/super\s+lig/ig, "Super League")
    .replace(/\blig\b/ig, "League");
  const countryHit = Object.entries(AF_COUNTRY_NAMES).find(([local, english]) => {
    const key = nkw(q);
    return key === nkw(local) || key.startsWith(nkw(local) + " ") || key.endsWith(" " + nkw(local)) || key === nkw(english) || key.startsWith(nkw(english) + " ") || key.endsWith(" " + nkw(english));
  });
  const urls = [TSDB + "search_all_leagues.php?l=" + encodeURIComponent(tsdbQuery)];
  if (countryHit) urls.push(TSDB + "search_all_leagues.php?" + new URLSearchParams({ c: countryHit[1], s: "Soccer" }));
  const responses = await Promise.all(urls.map(url => getJSON(url).catch(() => ({ leagues: [] }))));
  const rows = [...new Map(responses.flatMap(data => data.leagues || []).map(x => [String(x.idLeague || nkw(x.strLeague) + "|" + nkw(x.strCountry)), x])).values()];
  const countryAliases = {
    ...Object.fromEntries(Object.entries(AF_COUNTRY_NAMES).map(([local, english]) => [nkw(english), local])),
    england: "ingiltere", spain: "ispanya", germany: "almanya", italy: "italya",
    france: "fransa", turkey: "turkiye", netherlands: "hollanda", portugal: "portekiz",
    scotland: "iskocya", belgium: "belcika", greece: "yunanistan", austria: "avusturya",
    switzerland: "isvicre", denmark: "danimarka", sweden: "isvec", norway: "norvec",
    serbia: "sirbistan", croatia: "hirvatistan", romania: "romanya", poland: "polonya",
    czechia: "cekya", "czech republic": "cekya", hungary: "macaristan", bulgaria: "bulgaristan",
    japan: "japonya", brazil: "brezilya", argentina: "arjantin", usa: "abd",
    "united states": "abd", "saudi arabia": "s arabistan", "south africa": "g afrika",
    "northern ireland": "k irlanda", "united arab emirates": "bae",
    europe: "avrupa", asia: "asya", africa: "afrika", world: "dunya",
    "south america": "g amerika", "north america": "k amerika",
  };
  const leagueAliases = {
    "eng.1": ["premier league", "english premier league"],
    "eng.2": ["english championship", "efl championship"],
    "esp.1": ["la liga", "laliga", "spanish la liga"],
    "ger.1": ["bundesliga", "german bundesliga"],
    "ita.1": ["serie a", "italian serie a"],
    "fra.1": ["ligue 1", "french ligue 1"],
    "tur.1": ["turkish super lig", "turkey super lig", "super league turkey"],
    "tur.2": ["tff first league", "turkish first league"],
    "gre.1": ["greek super league", "greek super league 1", "super league greece", "super league 1"],
    "den.1": ["danish superliga", "superliga denmark", "denmark superliga"],
    "swe.1": ["allsvenskan", "swedish allsvenskan"],
    "swe.2": ["superettan", "swedish superettan"],
    "srb.1": ["serbian super liga", "serbian super league", "super liga serbia"],
    "uefa.champions": ["uefa champions league", "champions league"],
    "uefa.europa": ["uefa europa league", "europa league"],
    "uefa.europa.conf": ["uefa conference league", "europa conference league", "conference league"],
    "uefa.super_cup": ["uefa super cup", "uefa supercup", "super cup"],
  };
  const countryKey = value => {
    const key = nkw(value);
    return countryAliases[key] ? nkw(countryAliases[key]) : key;
  };
  const mapped = rows.map(x => {
    const name = String(x.strLeague || x.strLeagueAlternate || "").trim();
    const country = String(x.strCountry || "").trim();
    const badge = x.strBadge || x.strLogo || x.strPoster || x.strTrophy || "";
    if (!name) return null;
    const n = nkw(name), c = countryKey(country);
    const candidates = LEAGUES.map(row => {
      const rn = nkw(row[2]), rc = countryKey(row[3]);
      const aliases = (leagueAliases[row[0]] || []).map(nkw);
      let score = rn === n || aliases.includes(n) ? 100
        : (rn && n && (rn.includes(n) || n.includes(rn)) || aliases.some(a => a && (a.includes(n) || n.includes(a))) ? 70 : 0);
      if (c && rc && c === rc) score += 35;
      else if (score && c && rc) score -= score >= 90 ? 10 : 35;
      return { row, score };
    }).sort((a, b) => b.score - a.score);
    const best = candidates[0];
    const row = best && best.score >= 70 ? best.row : null;
    // Katalogda olmayan bir ülke ligi veya kupa da arama sonucundan çıkarılmasın.
    // Bu durumda TheSportsDB'nin kendi adı ve rozeti gösterilir; API-Football kimliği uydurulmaz.
    return {
      name: row ? row[2] : name,
      code: row ? row[0] : "",
      af: row && row[1] != null ? String(row[1]) : "",
      id: row && row[1] != null ? String(row[1]) : "",
      team: row ? (row[3] || country) : country,
      logo: badge,
      tsdb: String(x.idLeague || ""),
    };
  }).filter(Boolean);
  // Arama özetinde rozeti olmayan her lig/kupa için detay kaydını da kontrol et.
  const missingBadges = mapped.filter(x => !x.logo && x.tsdb).slice(0, 4);
  for (let i = 0; i < missingBadges.length; i += 6) {
    await Promise.all(missingBadges.slice(i, i + 6).map(async item => {
      try {
        const detail = await cached("tsdb-league-logo:v3:" + item.tsdb, async () => ({
          body: await getJSON(TSDB + "lookupleague.php?id=" + encodeURIComponent(item.tsdb)), ttl: 86400,
        }));
        const league = ((detail.body || {}).leagues || [])[0] || {};
        item.logo = league.strBadge || league.strLogo || league.strPoster || league.strTrophy || "";
      } catch (_) {}
    }));
  }
  return mapped;
}
async function commonsLeagueLogoSearch(name, country = "") {
  const fullName = String(name || "").trim().slice(0, 100);
  if (!fullName) return [];
  const stop = new Set(["the", "league", "lig", "football", "soccer", "cup", "kupa", "division", "championship", "national", "men", "women"]);
  const nameTokens = nkp(fullName).split(" ").filter(x => x.length > 2 && !stop.has(x));
  const countryKey = nkp(country);
  const countryEnglish = Object.entries(AF_COUNTRY_NAMES).find(([local]) => nkw(local) === countryKey)?.[1] || country;
  const demonyms = {
    turkey: "Turkish", greece: "Greek", england: "English", scotland: "Scottish", wales: "Welsh",
    germany: "German", france: "French", italy: "Italian", spain: "Spanish", portugal: "Portuguese",
    netherlands: "Dutch", belgium: "Belgian", switzerland: "Swiss", austria: "Austrian", denmark: "Danish",
    sweden: "Swedish", norway: "Norwegian", finland: "Finnish", poland: "Polish", serbia: "Serbian",
    croatia: "Croatian", romania: "Romanian", hungary: "Hungarian", bulgaria: "Bulgarian", slovakia: "Slovak",
    slovenia: "Slovenian", albania: "Albanian", cyprus: "Cypriot", ukraine: "Ukrainian", russia: "Russian",
    japan: "Japanese", china: "Chinese", brazil: "Brazilian", argentina: "Argentine", mexico: "Mexican",
    canada: "Canadian", australia: "Australian", india: "Indian", egypt: "Egyptian", morocco: "Moroccan",
    tunisia: "Tunisian", algeria: "Algerian", nigeria: "Nigerian", iran: "Iranian", iraq: "Iraqi",
    "south africa": "South African", "saudi arabia": "Saudi Arabian", "united states": "American",
  };
  const countryVariants = [...new Set([countryEnglish, demonyms[nkp(countryEnglish)]].filter(Boolean))];
  const countryTokens = [...new Set(countryVariants.flatMap(value => nkp(value).split(" ").filter(x => x.length > 2 && !stop.has(x))))];
  const countrySearch = countryVariants.join(" ");
  const required = [...new Set([...nameTokens, ...countryTokens])];
  try {
    const key = "commons-league-logo:v5:" + nkp(fullName + " " + country);
    const result = await cached(key, async () => ({
      body: await getJSON("https://commons.wikimedia.org/w/api.php?" + new URLSearchParams({
        action: "query", format: "json", origin: "*", generator: "search",
        gsrsearch: fullName + " " + countrySearch + " football league logo badge", gsrnamespace: "6", gsrlimit: "30",
        prop: "imageinfo", iiprop: "url", iiurlwidth: "500",
      })), ttl: 86400,
    }));
    const pages = Object.values(result.body && result.body.query && result.body.query.pages || []);
    const rows = pages.map(page => {
      const title = String(page.title || "").replace(/^File:/i, "");
      const norm = nkp(title);
      const nameHits = nameTokens.filter(token => norm.includes(token)).length;
      const countryHits = countryTokens.filter(token => norm.includes(token)).length;
      const hits = nameHits * 3 + countryHits;
      const info = (page.imageinfo || [])[0] || {};
      return { hits, nameHits, countryHits, title, url: normalizePhotoUrl(info.thumburl || info.url || "") };
    }).filter(x => x.url && x.nameHits >= 1 && (!countryTokens.length || x.countryHits >= 1 || nameTokens.length >= 2));
    rows.sort((a, b) => b.hits - a.hits || a.title.length - b.title.length);
    return [...new Set(rows.slice(0, 4).map(x => x.url))];
  } catch (_) { return []; }
}

async function apiFootballCoachSearch(env, query) {
  const term = String(query || "").trim().slice(0, 80);
  if (!apiFootballKey(env) || term.length < 3) return [];
  const data = await cached("af-coach-search:v1:" + nkp(term), async () => ({ body: await apiFootballJSON(env, "/coachs", { search: term }), ttl: 86400 }));
  return (data.body.response || []).map(x => x.coach || x).filter(x => x && x.id && x.name)
    .map(x => ({ name: x.name, af: String(x.id), team: x.team && x.team.name || "", logo: x.photo || "https://media.api-sports.io/football/coachs/" + x.id + ".png", role: "coach" }));
}
async function apiFootballCoachCareer(env, name, knownCoachId = "") {
  if (!apiFootballKey(env) || (!knownCoachId && String(name || "").trim().length < 3)) return null;
  const key = knownCoachId || nkp(name);
  const data = await cached("af-coach-career:v1:" + key, async () => ({
    body: await apiFootballJSON(env, "/coachs", knownCoachId ? { id: String(knownCoachId) } : { search: String(name).trim() }), ttl: 86400,
  }));
  const coaches = (data.body.response || []).map(x => x.coach || x).filter(x => x && x.id);
  let coach = knownCoachId ? coaches.find(x => String(x.id) === String(knownCoachId)) : null;
  const exact = coaches.filter(x => nkp(x.name || [x.firstname, x.lastname].filter(Boolean).join(" ")) === nkp(name));
  if (!coach && exact.length === 1) coach = exact[0];
  if (!coach && !knownCoachId && coaches.length === 1) coach = coaches[0];
  if (!coach) return null;
  const career = (coach.career || []).map(c => {
    const team = c.team || c.club || {};
    const teamName = team.name || c.teamName || c.name || "";
    if (!teamName) return null;
    const start = String(c.start || c.from || c.startDate || "").slice(0, 10);
    const end = String(c.end || c.to || c.endDate || "").slice(0, 10);
    const sy = (start.match(/(?:19|20)\d{2}/) || [])[0] || "";
    const ey = (end.match(/(?:19|20)\d{2}/) || [])[0] || "Devam";
    return { "Takım": teamName, "Dönem": (sy || "—") + " – " + ey, "O": null, "G": null, "B": null, "M": null,
      teamAfId: team.id == null ? "" : String(team.id), logo: team.logo || "", careerOnly: true, careerOrder: Date.parse(start) || 0 };
  }).filter(Boolean).sort((a,b)=>(Number(b.careerOrder)||0)-(Number(a.careerOrder)||0));
  const birth = coach.birth && (coach.birth.date || coach.birth) || "";
  return { coach, career, photo: coach.photo || (coach.id ? "https://media.api-sports.io/football/coachs/" + coach.id + ".png" : ""),
    bio: { ...dateBio(birth), "Yaş": coach.age || "", "Uyruk": coach.nationality || "", "Şu Anki Takım": coach.team && coach.team.name || "" } };
}
async function searchAll(env, term, type, fast = false) {
  const st = {}, lists = {};
  const run = async (k, f) => {
    try {
      if (fast) {
        const TIMEOUT = Symbol("fast-timeout");
        const value = await Promise.race([f(), new Promise(resolve => setTimeout(() => resolve(TIMEOUT), 1600))]);
        if (value === TIMEOUT) { lists[k] = []; st[k] = "hızlı arama zaman aşımı"; return; }
        lists[k] = Array.isArray(value) ? value : []; st[k] = "ok " + lists[k].length;
      } else { lists[k] = await f(); st[k] = "ok " + lists[k].length; }
    } catch (e) { lists[k] = []; st[k] = "hata: " + (e.message || e); }
  };
  let raw = null;
  const jobs = [];
  const ssq = () => ssGet(env, "v1/search/", { q: term, sport: "football", limit: 20, src: "canliskor" });
  if (type === "team") {
    jobs.push(run("espn", () => espnTeamSearch(term)));
    if (apiFootballKey(env)) jobs.push(run("api_football", () => apiFootballTeamSearch(env, term)));
    else st.api_football = "API_FOOTBALL_KEY tanımlı değil";
    if (!fast) {
      jobs.push(run("thesportsdb", () => tsdbTeamSearch(term)));
      jobs.push(run("sportscore", async () => { raw = await ssq(); return (raw.teams || []).map((x) => ({ name: String(x.name || x.title || "").trim(), slug: x.slug || "", team: x.country || x.league || "", logo: x.logo || x.image || "" })).filter((x) => x.name); }));
      jobs.push(run("wikipedia", () => wikiSearch(term, "team")));
    }
  } else if (type === "league") {
    jobs.push(run("catalog", async () => catalogLeagueSearch(term)));
    // Include real badge metadata in the fast pass too; the catalogue's generated
    // media URL is only a fallback and must not be the first visible logo.
    jobs.push(run("thesportsdb", () => tsdbLeagueSearch(term)));
    if (apiFootballKey(env)) jobs.push(run("api_football", () => apiFootballLeagueSearch(env, term)));
    else st.api_football = "API_FOOTBALL_KEY tanımlı değil; kayıtlı lig kataloğu kullanıldı";
  } else if (type === "coach") {
    if (!fast) jobs.push(run("wikipedia", () => wikiSearch(term, "coach")));
    if (apiFootballKey(env) && term.length >= 3) jobs.push(run("api_football", () => apiFootballCoachSearch(env, term)));
    else if (!fast) st.api_football = "Teknik direktör araması için en az 3 karakter ve API_FOOTBALL_KEY gerekir";
  } else {
    // First pass is deliberately small/quick. The UI displays these matches and
    // then replaces them with the complete multi-provider search result.
    jobs.push(run("espn", () => espnPlayerSearch(term)));
    if (fast) {
      jobs.push(run("thesportsdb", () => tsdbSearch(term)));
      if (apiFootballKey(env) && term.length >= 4) jobs.push(run("api_football", () => apiFootballPlayerSearch(env, term)));
    } else {
      jobs.push(run("sportscore", async () => { raw = await ssq(); return ssPlayers(raw); }));
      if (apiFootballKey(env) && term.length >= 4) jobs.push(run("api_football", () => apiFootballPlayerSearch(env, term)));
      else st.api_football = "API-Football oyuncu profili araması en az 4 karakter ister";
      jobs.push(run("thesportsdb", () => tsdbSearch(term)));
      if (term.length >= 2) {
        jobs.push(run("transfermarkt", () => tmSearch(env, term)));
        jobs.push(run("wikipedia", () => wikiSearch(term, "player")));
      }
    }
  }
  await Promise.all(jobs);
  if (type === "team" && !fast) {
    const items = Object.values(lists).flat().filter(x => !x.logo && x.code);
    const codes = [...new Set(items.map(x => x.code))];
    const teamsByCode = new Map();
    await Promise.all(codes.map(async code => {
      try {
        const j = await getJSON(SITE + code + "/teams");
        const teams = ((j.sports && j.sports[0] && j.sports[0].leagues && j.sports[0].leagues[0] && j.sports[0].leagues[0].teams) || []).map(x => x.team);
        teamsByCode.set(code, teams);
      } catch (_) { teamsByCode.set(code, []); }
    }));
    for (const item of items) {
      const team = (teamsByCode.get(item.code) || []).find(t => nameLike(t.displayName || t.name, item.name) || nameLike(t.shortDisplayName, item.name));
      const logo = team && ((team.logos && team.logos[0] && team.logos[0].href) || team.logo);
      if (logo) item.logo = logo;
    }
  }
  const map = new Map();
  const leagueKey = it => {
    const norm = value => nkw(value).split(" ").map(word => ({ lig: "league", kupa: "cup", kupasi: "cup", super: "super" }[word] || word)).join(" ");
    const country = countryAliasesForSearch(it.team || "");
    return "league:" + norm(it.name) + "|" + country;
  };
  function countryAliasesForSearch(value) {
    const aliases = Object.fromEntries(Object.entries(AF_COUNTRY_NAMES).flatMap(([local, english]) => [[local, nkw(english)], [nkw(english), nkw(english)]]));
    const key = nkw(value);
    return aliases[key] || key;
  }
  for (const k of ["catalog", "espn", "api_football", "sportscore", "transfermarkt", "thesportsdb", "wikipedia"]) {
    for (const rawItem of lists[k] || []) {
      const it = { ...rawItem };
      if (type === "league") {
        if (k === "api_football" && it.logo) it.apiLogo = it.logo;
        else if (k === "thesportsdb" && it.logo) it.badge = it.logo;
        else if (k === "espn" && it.logo) it.espnLogo = it.logo;
        else if (k === "catalog" && it.logo) it.catalogLogo = it.logo;
      }
      let key;
      if (type === "team") key = teamSearchKey(it.name);
      else if (type === "league") key = leagueKey(it);
      else if (type === "player") {
        const playerNameKey = nkp(it.name);
        if (!playerNameKey) continue;
        const sameName = [...map.entries()].filter(([, value]) => nkp(value.name) === playerNameKey);
        const incomingTeam = teamSearchKey(it.team || "");
        const compatible = sameName.filter(([, value]) => {
          const existingTeam = teamSearchKey(value.team || "");
          return !incomingTeam || !existingTeam || incomingTeam === existingTeam;
        });
        if (compatible.length === 1) key = compatible[0][0];
        else if (sameName.length === 0) key = playerNameKey + (incomingTeam ? "|" + incomingTeam : "");
        else {
          const discriminator = it.tm || it.tsdb || it.af || it.espn || it.slug || it.url || k;
          key = playerNameKey + "|" + (incomingTeam || (k + ":" + String(discriminator)));
        }
      } else key = nkp(it.name);
      if (!key) continue;
      const cur = map.get(key);
      if (!cur) {
        const initialLogos = type === "league"
          ? collectPhotoUrls(it.apiLogo, it.badge, it.espnLogo, it.logoCandidates, it.catalogLogo, it.logo)
          : collectPhotoUrls(it.logoCandidates, it.logo, it.apiLogo, it.badge);
        map.set(key, { ...it, logoCandidates: initialLogos });
        continue;
      }
      for (const f of ["slug", "tm", "tsdb", "wiki", "af", "espn", "id", "code", "team", "country", "nationality", "pos", "apiLogo", "badge", "espnLogo", "catalogLogo", "top"]) if (!cur[f] && it[f]) cur[f] = it[f];
      if (type === "player") {
        const portraitCandidates = collectPhotoUrls(cur.photos, it.photos, cur.photo, it.photo, cur.image, it.image, cur.logo, it.logo);
        if (portraitCandidates.length) { cur.photos = portraitCandidates; if (!cur.photo) cur.photo = portraitCandidates[0]; if (!cur.logo) cur.logo = portraitCandidates[0]; }
      }
      if (type === "league") {
        const leagueCandidates = collectPhotoUrls(cur.apiLogo, it.apiLogo, cur.badge, it.badge, cur.espnLogo, it.espnLogo, cur.logoCandidates, it.logoCandidates, cur.catalogLogo, it.catalogLogo, cur.logo, it.logo);
        if (leagueCandidates.length) cur.logoCandidates = leagueCandidates;
      }
    }
  }
  const toks = nkp(term).split(" ").filter(Boolean);
  const lev = (a, b) => { const d = Array.from({ length: a.length + 1 }, (_, i) => [i]); for (let j = 1; j <= b.length; j++) d[0][j] = j; for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); return d[a.length][b.length]; };
  const relevant = (it) => {
    if (it.top) return true; // Wikipedia'nın kendi en iyi eşleşmesi (örn. "Alex (footballer, born 1977)" için "Alex de Souza")
    if (type === "league") {
      const aliases = { ...Object.fromEntries(Object.entries(AF_COUNTRY_NAMES).map(([local, english]) => [local, nkw(english)])), yunanistan: "greece", greece: "greece", danimarka: "denmark", denmark: "denmark", isvec: "sweden", sweden: "sweden", sirbistan: "serbia", serbia: "serbia", kupa: "cup", kupasi: "cup", cup: "cup", lig: "league", league: "league", sampiyonlar: "champions", champions: "champions" };
      const parts = nkp(term).split(" ").filter(Boolean).map(part => aliases[part] || part);
      const words = nkp([it.name, it.team || ""].join(" ")).split(" ").map(word => aliases[word] || word);
      return parts.every(part => words.some(word => word.startsWith(part) || (part.length >= 4 && word.includes(part))));
    }
    if (type === "team") {
      const query = teamSearchKey(term), candidate = teamSearchKey(it.name);
      if (!query || !candidate) return false;
      const qParts = query.split(" ").filter(Boolean), cParts = candidate.split(" ").filter(Boolean);
      return candidate === query || candidate.startsWith(query) || query.startsWith(candidate)
        || qParts.every(part => cParts.some(value => value.startsWith(part) || (part.length >= 4 && value.includes(part))));
    }
    const parts = nkp(it.name).split(" ").filter(Boolean);
    return toks.every((t) => parts.some((pt) => pt.startsWith(t) || (pt.includes(t) && t.length >= 4) || (t.length >= 4 && lev(pt.slice(0, t.length + 1), t) <= (t.length > 5 ? 2 : 1))));
  };
  const score = (it) => { const n = nkp(it.name); return n === toks.join(" ") ? 0 : n.startsWith(toks.join(" ")) ? 1 : 2; };
  const maxResults = type === "league" ? 60 : 18;
  const items = [...new Set(map.values())].filter(relevant)
    .filter(x => type !== "team" || (x.tsdb || (x.id && x.code) || x.af))
    .sort((x, y) => score(x) - score(y)).slice(0, maxResults);
  if (type === "team") for (const item of items) if (item.apiLogo) item.logo = item.apiLogo;
  if (type === "league") {
    const enrichLeague = async (item, index) => {
      const afId = String(item.af || (/^af-(\d+)$/i.exec(item.code || "") || [])[1] || "");
      const trusted = collectPhotoUrls(item.apiLogo, item.badge, item.espnLogo);
      // Verify the most relevant IDs against their provider's league detail endpoint.
      if (afId && !item.apiLogo && apiFootballKey(env)) {
        try {
          const af = await cached("af-league-logo:v7:" + afId, async () => ({ body: await apiFootballJSON(env, "/leagues", { id: String(afId) }), ttl: 86400 }));
          const league = ((af.body.response || [])[0] || {}).league || {};
          if (league.logo && !trusted.includes(league.logo)) trusted.unshift(league.logo);
        } catch (_) {}
      }
      if (item.tsdb && !item.badge) {
        try {
          const ts = await cached("tsdb-league-logo:v7:" + item.tsdb, async () => ({ body: await getJSON(TSDB + "lookupleague.php?id=" + encodeURIComponent(item.tsdb)), ttl: 86400 }));
          const league = ((ts.body || {}).leagues || [])[0] || {};
          const badge = league.strBadge || league.strLogo || league.strPoster || league.strTrophy || "";
          if (badge && !trusted.includes(badge)) trusted.unshift(badge);
        } catch (_) {}
      }
      let commons = [];
      // Source logos first; Commons supplies an alternate when a provider is missing/unavailable.
      if (!fast && trusted.length < 2) commons = await commonsLeagueLogoSearch(item.name, item.team || "");
      if (fast && !trusted.length && index < 16) commons = await commonsLeagueLogoSearch(item.name, item.team || "");
      const catalogLogo = item.catalogLogo || "";
      const guessed = [];
      if (item.code && !/^af-\d+$/i.test(item.code)) guessed.push("https://a.espncdn.com/i/leaguelogos/soccer/500/" + encodeURIComponent(item.code.toLowerCase()) + ".png");
      if (afId) guessed.push("https://media.api-sports.io/football/leagues/" + encodeURIComponent(afId) + ".png");
      const all = collectPhotoUrls(trusted, commons, item.logoCandidates, catalogLogo, guessed);
      item.logoCandidates = all;
      item.logo = all[0] || "";
    };
    // Hydrate logo candidates concurrently; serial Commons lookups could outlive the UI request timeout.
    await Promise.all(items.map((item, index) => enrichLeague(item, index)));
  }
  if (type === "player") {
    // Search portraits are PitchAPI-only. Its documented player endpoint needs a p_ ID,
    // so resolve a player's ID/photo through that player's club in recent PitchAPI match rosters.
    // The fast pass stays instant; the full result performs the cached roster enrichment.
    if(fast){for(const item of items){item.photos=[];item.photo='';item.logo='';}}
    else await pitchHydratePlayerSearchPhotos(env,items);
  }
  return { items, sources: st, raw, type, allFailed: Object.values(st).every((v) => /^hata/.test(v)) };
}
// Understat: asist verisi (yalnızca Premier Lig, La Liga, Bundesliga, Serie A, Ligue 1 ve Rusya Ligi; lig asistleri)
async function usJSON(path) {
  const r = await fetch("https://understat.com/" + path, { signal: AbortSignal.timeout(8000), headers: { "X-Requested-With": "XMLHttpRequest", Referer: "https://understat.com/", "User-Agent": BROWSER_H["User-Agent"], Accept: "application/json, text/javascript, */*" } });
  if (!r.ok) throw new Error("Understat HTTP " + r.status);
  return r.json();
}
async function understat(name) {
  const sj = await usJSON("main/getPlayersName/" + encodeURIComponent(name));
  const pl = (sj.response && sj.response.players) || sj.players || [];
  const m = pl.find((x) => nkp(x.player_name) === nkp(name));
  if (!m) throw new Error("oyuncu bulunamadı");
  const d = await usJSON("getPlayerData/" + m.id);
  const rows = (d.groups && d.groups.season) || [];
  return rows.map((x) => ({ year: Number(x.season), team: String(x.team || ""), m: Number(x.games), g: Number(x.goals), a: Number(x.assists) })).filter((x) => x.year);
}
async function tmPlayer(env, id) {
  const out = { photo: "", bio: {}, seasons: [], transfers: [], marketValueHistory: [], injuries: [], absences: [] };
  const playerId = String(id || "").replace(/\D/g, "");
  if (!playerId) return { ...out, err: "geçersiz Transfermarkt oyuncu kimliği" };
  const rows = await tmDbRows(env, "tm_players?select=*&tm_id=eq." + encodeURIComponent(playerId) + "&limit=1");
  const row = rows[0];
  if (!row) return { ...out, err: "Transfermarkt oyuncusu henüz veritabanına senkronize edilmemiş" };
  const profileRaw = row.profile_payload || {};
  const b = profileRaw.player || profileRaw.data || profileRaw.profile || profileRaw;
  const statsRaw = row.stats_payload || {};
  let statsRows = Array.isArray(statsRaw) ? statsRaw : (statsRaw.stats || statsRaw.data || statsRaw.items || []);
  // Merge two DB-backed sources: felipeall's active-season totals and
  // dcaribou's one-time historical appearance aggregates. Do not let the
  // presence of current-season rows hide the older seasons.
  try {
    const selectStats = "select=season_id,competition_name,club_name,appearances,starts,goals,assists,minutes,yellow_cards,second_yellow_cards,red_cards&tm_id=eq." + encodeURIComponent(playerId) + "&order=season_id.desc&limit=1000";
    const [dbStats, historyStats] = await Promise.all([
      tmDbRows(env, "tm_player_season_stats?" + selectStats),
      tmDbRows(env, "tm_appearance_season_totals?" + selectStats)
    ]);
    const normalizeRows = rows => rows.map(x => ({
      seasonID: x.season_id, competitionName: x.competition_name, clubName: x.club_name,
      appearances: x.appearances, starts: x.starts, goals: x.goals, assists: x.assists,
      minutes: x.minutes, yellowCards: x.yellow_cards, secondYellowCards: x.second_yellow_cards,
      redCards: x.red_cards
    }));
    const normalized = [...normalizeRows(dbStats), ...normalizeRows(historyStats)];
    if (normalized.length) statsRows = normalized;
  } catch (_) {}
  const currentSeason = row.current_season_payload || {};
  if ((!Array.isArray(statsRows) || !statsRows.length) && Array.isArray(currentSeason.stats)) statsRows = currentSeason.stats;
  const transferRaw = row.transfers_payload || {};
  try {
    const transferRows = await tmDbRows(env, "tm_transfers?select=transfer_date,from_club,to_club,transfer_type,fee_text,fee_eur&tm_id=eq." + encodeURIComponent(playerId) + "&order=transfer_date.desc&limit=100");
    out.transfers = transferRows.map(x => ({
      date: x.transfer_date || "", from: x.from_club || "", to: x.to_club || "",
      kind: x.transfer_type || "", fee: x.fee_text || (x.fee_eur != null ? Number(x.fee_eur).toLocaleString("tr-TR") + " €" : "")
    }));
  } catch (_) {
    out.transfers = Array.isArray(transferRaw) ? transferRaw : (transferRaw.transfers || transferRaw.data || []);
  }
  try {
    const marketRows = await tmDbRows(env, "tm_market_values?select=valuation_date,value_eur,display_value,club_name&tm_id=eq." + encodeURIComponent(playerId) + "&order=valuation_date.desc&limit=100");
    out.marketValueHistory = marketRows;
  } catch (_) { out.marketValueHistory = row.market_value_payload || []; }
  const listPayload = (raw, keys) => Array.isArray(raw) ? raw : (raw && typeof raw === "object" ? keys.map(k => raw[k]).find(Array.isArray) || [] : []);
  out.injuries = listPayload(row.injuries_payload || {}, ["injuries", "data", "items"]);
  out.absences = listPayload(row.absences_payload || {}, ["absences", "data", "items"]);
  out.photo = row.photo_url || b.imageUrl || b.image_url || b.image || b.photo || "";
  const nationality = pick(b, "citizenship", "nationality", "nationalities");
  const nat = Array.isArray(nationality) ? nationality.join(", ") : nationality || "";
  const club = b.club || b.team || {};
  const clubName = typeof club === "string" ? club : (club && (club.name || club.displayName)) || b.clubName || b.currentClub || row.team_name || "";
  const position = b.position || {};
  const height = pick(b, "height", "heightM", "heightMeters", "height_cm");
  out.bio = {
    ...dateBio(pick(b, "dateOfBirth", "date_of_birth")),
    "Ayak": footTr(pick(b, "foot", "preferredFoot", "preferred_foot")),
    "Piyasa Değeri": valueTr(pick(b, "marketValue", "marketValueFormatted", "market_value")) || valueTr(row.current_market_value_text) || (row.current_market_value_eur != null ? valueTr(Number(row.current_market_value_eur)) : ""),
    "Şu Anki Takım": clubName,
    "Boy": height ? (typeof height === "number" && height < 3 ? String(height).replace(".", ",") + " m" : height + "") : "",
    "Uyruk": nat,
    "Mevki": (typeof position === "string" ? position : (position && (position.main || position.name || position.displayName))) || row.position || "",
    "Forma No": pick(b, "shirtNumber", "squad_shirt_number", "shirt_number")
  };
  if ((club && (club.contractExpires || club.contract_expires)) || b.contractUntil || b.contract_until || b.contractExpires || b.contract_expires) out.bio["Sözleşme Bitişi"] = (club && (club.contractExpires || club.contract_expires)) || b.contractUntil || b.contract_until || b.contractExpires || b.contract_expires;
  if (Array.isArray(statsRows)) {
    const mp = new Map();
    for (const x of statsRows) {
      const rawSeason = pick(x, "seasonID", "seasonId", "season_id", "season", "seasonName");
      const sm = String(rawSeason && typeof rawSeason === "object" ? pick(rawSeason, "name", "displayName", "year", "id") : rawSeason).match(/(?:19|20)\d{2}(?:\s*[-/–]\s*\d{2,4})?/);
      if (!sm) continue;
      let se = sm[0].replace(/\s+/g, "").replace(/[–-]/g, "/");
      if (/^\d{4}$/.test(se)) se = se + "/" + String(Number(se) + 1).slice(2);
      else se = se.replace(/\/(\d{4})$/, (_, y) => "/" + y.slice(2));
      const clubRaw = pick(x, "clubName", "club_name", "teamName", "team_name", "club", "team", "clubID", "club_id");
      const clubName = clubRaw && typeof clubRaw === "object" ? pick(clubRaw, "name", "displayName", "shortName") : clubRaw;
      const clubLabel = clubName == null ? "" : String(clubName).trim();
      if (!clubLabel || /^(?:[a-z]{2,5}\.)[a-z0-9._-]+$/i.test(clubLabel) || /^(?:undefined|null|\[object object\]|\d+)$/i.test(clubLabel) || /\b(?:super lig|bundesliga|premier league|serie a|la liga|ligue 1|champions league|europa league)\b/i.test(clubLabel)) continue;
      const k = se + "|" + clubLabel;
      const r = mp.get(k) || { "Sezon": se, "Takım": clubLabel, "Maç": 0, "Gol": 0, "Asist": null, "İlk 11": null, "Sarı Kart": null, "Kırmızı Kart": null, cats: emptyCats() };
      const m = num(pick(x, "appearances", "apps", "matches")), g = num(pick(x, "goals")), rawAssists = pick(x, "assists"), a = num(rawAssists);
      const rawStarts = pick(x, "starts", "gamesStarted", "appearancesAsStarter", "is_starting"), starts = rawStarts === "" ? null : num(rawStarts);
      const rawYellow = pick(x, "yellowCards", "yellow_cards", "yellow", "bookingsYellow"), yellow = rawYellow === "" ? null : num(rawYellow);
      const rawRed = pick(x, "redCards", "red_cards", "red", "bookingsRed"), red = rawRed === "" ? null : num(rawRed);
      r["Maç"] += m; r["Gol"] += g;
      if (rawAssists !== "") r["Asist"] = (r["Asist"] || 0) + a;
      if (starts != null) r["İlk 11"] = (r["İlk 11"] || 0) + starts;
      if (yellow != null) r["Sarı Kart"] = (r["Sarı Kart"] || 0) + yellow;
      if (red != null) r["Kırmızı Kart"] = (r["Kırmızı Kart"] || 0) + red;
      addCat(r.cats, catOf(pick(x, "competitionName", "competition_name", "competition", "competitionID", "competition_id")), m, g, rawAssists === "" ? null : a, starts, yellow, red);
      mp.set(k, r);
    }
    out.seasons = [...mp.values()];
  }
  if (!out.seasons.length) {
    try {
      const history = await tmDbRows(env, "tm_appearance_season_totals?select=season_id,competition_name,club_name,appearances,starts,goals,assists,minutes,yellow_cards,red_cards&tm_id=eq." + encodeURIComponent(playerId) + "&order=season_id.desc");
      out.seasons = history.map(x => ({
        "Sezon": x.season_id || "",
        "Takım": x.club_name || "",
        "Maç": x.appearances == null ? 0 : Number(x.appearances),
        "Gol": x.goals == null ? 0 : Number(x.goals),
        "Asist": x.assists == null ? null : Number(x.assists),
        "İlk 11": x.starts == null ? null : Number(x.starts),
        "Sarı Kart": x.yellow_cards == null ? null : Number(x.yellow_cards),
        "Kırmızı Kart": x.red_cards == null ? null : Number(x.red_cards),
        cats: emptyCats()
      }));
      for (const item of out.seasons) addCat(item.cats, "Maç geçmişi", item["Maç"], item["Gol"], item["Asist"], item["İlk 11"], item["Sarı Kart"], item["Kırmızı Kart"]);
    } catch (_) {}
  }
  return out;
}
async function tsdbPlayer(id) {
  const j = await getJSON(TSDB + "lookupplayer.php?id=" + id);
  const x = (j.players && j.players[0]) || {};
  const photos = [x.strCutout, x.strThumb, x.strRender].filter((v, i, a) => typeof v === "string" && v && a.indexOf(v) === i);
  return { photo: photos[0] || "", photos, bio: { "Doğum Tarihi": x.dateBorn || "", "Boy": x.strHeight || "", "Kilo": x.strWeight || "", "Uyruk": x.strNationality || "", "Mevki": x.strPosition || "", "Takım": x.strTeam || "", "Forma No": x.strNumber || "" } };
}
async function tsdbPlayerStats(id) {
  const j = await getJSON(TSDB + "lookupplayerstats.php?id=" + encodeURIComponent(id));
  const competitions = new Map();
  for (const x of j.playerstats || []) {
    const seasonRaw = String(x.strSeason || "").trim();
    const seasonMatch = seasonRaw.match(/(?:19|20)\d{2}(?:\s*[-/–]\s*\d{2,4})?/);
    const team = String(x.strTeam || "").trim(), league = String(x.strLeague || "").trim();
    if (!seasonMatch || !team || !league || /^(?:[a-z]{2,5}\.)[a-z0-9._-]+$/i.test(team) || /^(?:undefined|null|\d+)$/i.test(team)) continue;
    let season = seasonMatch[0].replace(/\s+/g, "").replace(/[–-]/g, "/");
    if (/^\d{4}$/.test(season)) season += "/" + String(Number(season) + 1).slice(2);
    else season = season.replace(/\/(\d{4})$/, (_, y) => "/" + y.slice(2));
    const key = season + "|" + nkw(team) + "|" + nkp(league);
    const row = competitions.get(key) || { season, team, league, m: null, g: null, a: null, starts: null, yellow: null, red: null };
    const label = nkp(x.strStatistic), value = Number(String(x.strValue || "").replace(/,/g, ""));
    if (!Number.isFinite(value)) continue;
    if (/^(appearances|appearance|matches|apps|games played)$/.test(label)) row.m = value;
    else if (/^(goals|goal|goals scored)$/.test(label)) row.g = value;
    else if (/^(assists|assist|goal assists)$/.test(label)) row.a = value;
    else if (/^(starts|started|games started|appearances started|games as starter)$/.test(label)) row.starts = value;
    else if (/^(yellow cards|yellow card|yellow)$/.test(label)) row.yellow = value;
    else if (/^(red cards|red card|red)$/.test(label)) row.red = value;
    competitions.set(key, row);
  }
  const seasons = new Map();
  for (const c of competitions.values()) {
    const key = c.season + "|" + nkw(c.team);
    const row = seasons.get(key) || { "Sezon": c.season, "Takım": c.team, "Maç": 0, "Gol": 0, "Asist": null, "İlk 11": null, "Sarı Kart": null, "Kırmızı Kart": null, cats: emptyCats() };
    row["Maç"] += c.m || 0;
    row["Gol"] += c.g || 0;
    if (c.a != null) row["Asist"] = (row["Asist"] || 0) + c.a;
    if (c.starts != null) row["İlk 11"] = (row["İlk 11"] || 0) + c.starts;
    if (c.yellow != null) row["Sarı Kart"] = (row["Sarı Kart"] || 0) + c.yellow;
    if (c.red != null) row["Kırmızı Kart"] = (row["Kırmızı Kart"] || 0) + c.red;
    addCat(row.cats, catOf(c.league), c.m || 0, c.g || 0, c.a, c.starts, c.yellow, c.red);
    seasons.set(key, row);
  }
  return [...seasons.values()];
}
const MENU_LEAGUES = [
  { code: "eng.1", name: "Premier League", id: "4328" }, { code: "esp.1", name: "LaLiga", id: "4335" },
  { code: "ger.1", name: "Bundesliga", id: "4331" }, { code: "ita.1", name: "Serie A", id: "4332" },
  { code: "fra.1", name: "Ligue 1", id: "4334" }, { code: "tur.1", name: "Süper Lig", id: "4339" },
  { code: "uefa.champions", name: "Şampiyonlar Ligi", id: "4480" }, { code: "uefa.europa", name: "Avrupa Ligi", id: "4481" },
  { code: "uefa.europa.conf", name: "Konferans Ligi", id: "5071" },
];
async function leagueLogos() {
  // Every competition in the app's catalogue gets a direct API-Sports badge URL.
  // Image requests are served by the media CDN and do not consume API data quota.
  const byCode = new Map();
  for (const row of LEAGUES) {
    const code = String(row[0] || ""), id = String(row[1] || "");
    if (!code) continue;
    const logo = /^\d+$/.test(id) ? "https://media.api-sports.io/football/leagues/" + id + ".png" :
      (!/^af-\d+$/i.test(code) ? "https://a.espncdn.com/i/leaguelogos/soccer/500/" + encodeURIComponent(code.toLowerCase()) + ".png" : "");
    if (logo) byCode.set(code, { code, logo });
  }
  // Keep TheSportsDB's richer crest/logo where it is known for the fixed menu leagues.
  const extras = await Promise.all(MENU_LEAGUES.map(async league => {
    try {
      const data = await cached("tsdb-league-logo:v3:" + league.id, async () => ({ body: await getJSON(TSDB + "lookupleague.php?id=" + league.id), ttl: 86400 }));
      const x = (data.body.leagues || [])[0] || {};
      return x.strBadge || x.strLogo ? { code: league.code, logo: x.strBadge || x.strLogo } : null;
    } catch (_) { return null; }
  }));
  for (const item of extras) if (item) byCode.set(item.code, item);
  return { logos: [...byCode.values()] };
}
const TR_MONTHS = ["Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran", "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık"];
const EN_MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
function trDate(y, m, d) { return d + " " + TR_MONTHS[m - 1] + " " + y; }
function ageOf(y, m, d) { const n = new Date(Date.now() + 3 * 3600e3); let a = n.getUTCFullYear() - y; if (n.getUTCMonth() + 1 < m || (n.getUTCMonth() + 1 === m && n.getUTCDate() < d)) a--; return a; }
function dateBio(iso) { const m = String(iso || "").match(/(\d{4})-(\d{2})-(\d{2})/); if (!m) return {}; const y = +m[1], mo = +m[2], d = +m[3]; return { "Doğum Tarihi": trDate(y, mo, d), "Yaş": ageOf(y, mo, d) }; }
const footTr = (f) => ({ right: "Sağ", left: "Sol", both: "İki ayak" })[String(f || "").toLowerCase()] || f || "";
function valueTr(v) {
  if (v == null || v === "") return "";
  if (typeof v === "number") return "€" + (v >= 1e6 ? (v / 1e6).toFixed(v % 1e6 ? 1 : 0).replace(".", ",") + " Mn" : Math.round(v / 1e3) + " Bin");
  return String(v).replace(/(\d)\.(\d+)\s*m\b/i, "$1,$2 Mn").replace(/(\d)\s*m\b/i, "$1 Mn").replace(/(\d)\s*k\b/i, "$1 Bin");
}
const catOf = (g) => {
  g = String(g || "").trim();
  if (/europe|avrupa|uluslararası|kıta|şampiyonlar|continental|champions\s+league|uefa|libertadores|sudamericana|afc\b|caf\b|concacaf|conmebol|international|intercontinental|club world|world cup|^(cl|el|ecl|ucl|uel|uecl)$/i.test(g)) return "intl";
  if (/^(league|division|lig|süper lig|super lig|gb1|es1|l1|it1|fr1|tr1|nl1|po1|br1|ar1|us1|sa1)$/i.test(g)) return "lig";
  if (/cup|copa|coupe|pokal|taça|coppa|trophy|shield|supercup|super cup|kupa|^(fac|cgb|cit|cdr|dfb|trc|coc|coup)$/i.test(g)) return "kupa";
  if (/league|liga|ligue|lig\b|serie|bundesliga|division/i.test(g)) return "lig";
  return null;
};
const emptyCats = () => ({ lig: { m: 0, g: 0, a: null, s: null, y: null, r: null }, kupa: { m: 0, g: 0, a: null, s: null, y: null, r: null }, intl: { m: 0, g: 0, a: null, s: null, y: null, r: null } });
function addCat(cats, c, m, g, a, s, y, r) {
  if (!c || !cats[c]) return;
  const x = cats[c]; x.m += Number(m) || 0; x.g += Number(g) || 0;
  for (const [key, value] of [["a", a], ["s", s], ["y", y], ["r", r]]) if (value != null && Number.isFinite(Number(value))) x[key] = (x[key] || 0) + Number(value);
}
const num = (v) => parseInt(String(v == null ? "" : v).replace(/[^\d]/g, ""), 10) || 0;
function splitSeasons(rows) {
  // Yeni sezon üstte; toplam satırları tabloya karışmaz. Takım/lig/kupa toplamlarını sayfa filtreye göre hesaplar.
  const seasons = rows.filter((r) => r["Sezon"] && r["Sezon"] !== "Toplam" && r["Takım"]).map((r) => ({ ...r, "Sezon": String(r["Sezon"]).trim().replace(/[–—−]/g, "-"), cats: r.cats || null, "Asist": r["Asist"] === undefined || r["Asist"] === "" ? null : r["Asist"] }));
  seasons.sort((x, y) => {
    const yearDiff = (parseInt(String(y["Sezon"]).slice(0, 4), 10) || 0) - (parseInt(String(x["Sezon"]).slice(0, 4), 10) || 0);
    if (yearDiff) return yearDiff;
    // Aynı sezonda son/current takımı en üste koy; tarih varsa en yeni transfer önce gelir.
    const xo = Number(x.careerTimestamp || x.careerOrder) || 0, yo = Number(y.careerTimestamp || y.careerOrder) || 0;
    const xLast = !!(x.transferLastTeam || x.seasonLastTeam || x.currentTeam), yLast = !!(y.transferLastTeam || y.seasonLastTeam || y.currentTeam);
    if (xLast !== yLast) return xLast ? -1 : 1;
    if (xo && yo && xo !== yo) return yo - xo;
    if (xo !== yo) return xo ? -1 : 1;
    return 0;
  });
  return { seasons };
}
function seasonYear(v) { const m = String(v || "").match(/\d{4}/); return m ? m[0] : String(v || "").trim().toLowerCase(); }
function careerKey(r) { return seasonYear(r["Sezon"]) + "|" + teamSearchKey(r["Takım"]); }
function mergeCareerRows(sources) {
  const merged = new Map();
  for (const rows of sources) for (const raw of rows || []) {
    if (!raw || !raw["Sezon"] || !raw["Takım"] || TOTAL_RE.test(String(raw["Sezon"]))) continue;
    const key = careerKey(raw);
    if (!key.split("|")[1]) continue;
    const existing = merged.get(key);
    if (!existing) { merged.set(key, { ...raw, cats: raw.cats ? JSON.parse(JSON.stringify(raw.cats)) : null }); continue; }
    // Primary source owns numeric totals. Other sources only fill fields that are genuinely absent.
    for (const k of Object.keys(raw)) if (k !== "cats" && k !== "careerOrder" && k !== "careerTimestamp" && ((existing[k] == null || existing[k] === "") || (["Maç", "Gol", "Asist", "İlk 11", "Sarı Kart", "Kırmızı Kart"].includes(k) && Number(existing[k]) === 0 && Number(raw[k]) > 0)) && raw[k] != null && raw[k] !== "") existing[k] = raw[k];
    if (raw.seasonLastTeam) existing.seasonLastTeam = true;
    if (raw.transferLastTeam) existing.transferLastTeam = true;
    const incomingStamp = Number(raw.careerTimestamp || raw.careerOrder) || 0;
    const existingStamp = Number(existing.careerTimestamp || existing.careerOrder) || 0;
    if (incomingStamp > 0 && (!existingStamp || incomingStamp > existingStamp)) {
      existing.careerTimestamp = incomingStamp;
      existing.careerOrder = incomingStamp;
    }
    if (raw.cats) {
      if (!existing.cats) existing.cats = emptyCats();
      for (const cat of ["lig", "kupa", "intl"]) {
        const a = existing.cats[cat], b = raw.cats[cat];
        if (!a || !b) continue;
        a.m = Math.max(Number(a.m) || 0, Number(b.m) || 0);
        a.g = Math.max(Number(a.g) || 0, Number(b.g) || 0);
        for (const k of ["a", "s", "y", "r"]) if ((a[k] == null || a[k] === "" || Number(a[k]) === 0) && b[k] != null && Number(b[k]) > 0) a[k] = b[k];
      }
    }
  }
  return [...merged.values()];
}
// API-Football is authoritative for exactly these four career fields. Keep the
// existing Maç/Gol columns and their source untouched. Create a season row only
// when API-Football has one of the four requested values but the legacy source
// has no matching season/team row at all.
function overlayApiFootballCareerFields(rows, apiRows) {
  const list = Array.isArray(rows) ? rows : [];
  for (const raw of Array.isArray(apiRows) ? apiRows : []) {
    if (!raw || !raw["Sezon"] || !raw["Takım"]) continue;
    const key = careerKey(raw);
    const fields = ["Asist", "İlk 11", "Sarı Kart", "Kırmızı Kart"];
    const hasAny = fields.some(field => raw[field] != null && raw[field] !== "" && Number.isFinite(Number(raw[field])));
    if (!hasAny) continue;
    let target = list.find(row => careerKey(row) === key);
    if (!target) {
      target = {
        "Sezon": raw["Sezon"], "Takım": raw["Takım"],
        // Do not import or overwrite match/goal totals from this supplemental feed.
        "Maç": null, "Gol": null, "Asist": null, "İlk 11": null,
        "Sarı Kart": null, "Kırmızı Kart": null,
        logo: raw.logo || "", teamAfId: raw.teamAfId || "",
        teamCode: raw.teamCode || "", careerOrder: raw.careerOrder || 0,
        careerTimestamp: raw.careerTimestamp || 0,
        cats: emptyCats(), apiFootballOnlyFields: true,
      };
      list.push(target);
    }
    for (const field of fields) {
      const value = raw[field];
      if (value != null && value !== "" && Number.isFinite(Number(value))) target[field] = Number(value);
    }
    // Keep competition split for the existing Lig / Uluslararası filters.
    // Keep API-Football category values separate from legacy cats, which are
    // still used for the original Maç/Gol columns.
    if (!target.apiFootballCats) target.apiFootballCats = { lig: { a:null,s:null,y:null,r:null }, kupa: { a:null,s:null,y:null,r:null }, intl: { a:null,s:null,y:null,r:null } };
    const sourceCats = raw.cats || {};
    for (const category of ["lig", "kupa", "intl"]) {
      const from = sourceCats[category];
      if (!from) continue;
      for (const keyField of ["a", "s", "y", "r"]) {
        const value = from[keyField];
        if (value != null && value !== "" && Number.isFinite(Number(value))) target.apiFootballCats[category][keyField] = Number(value);
      }
    }
    target.apiFootballFields = { ...(target.apiFootballFields || {}) };
    for (const [field, keyField] of [["Asist", "a"], ["İlk 11", "s"], ["Sarı Kart", "y"], ["Kırmızı Kart", "r"]]) {
      if (raw[field] != null && raw[field] !== "" && Number.isFinite(Number(raw[field]))) target.apiFootballFields[keyField] = true;
    }
  }
  return list;
}
async function playerFull(env, slug, name, tmId, tsdbId, wikiT, part, role, afId, teamHint = "", posHint = "", espnId = "", initialPhoto = "", pitchId = "", pitchCode = "", pitchYear = "") {
  const st = {};
  const out = { name, photo: "", photos: initialPhoto && /^https?:\/\//i.test(initialPhoto) ? [initialPhoto] : [], bio: {}, seasons: [], sources: st };
  const coach = role === "coach";
  const wantInfo = part !== "stats", wantStats = part !== "info";
  let ss = null;
  const tasks = [];
  const title = async () => wikiT || (name ? await cached("wt2:" + role + ":" + nkp(name), async () => { const r = await wikiSearch(name, coach ? "coach" : "player"); const target=nkp(name); const exact=r.filter(x => nkp(x.name) === target || nkp(x.wiki) === target); const m = exact.length === 1 ? exact[0] : (r.length===1?r[0]:null); return { body: { t: m ? m.wiki : "" }, ttl: m ? 21600 : 60 }; }).then((c) => c.body.t) : "");
  if (wantInfo && slug && !coach) tasks.push((async () => { try { ss = await ssPlayerInfo(env, slug); st.sportscore = "ok"; } catch (e) { st.sportscore = "hata: " + e.message; } })());
  if (wantInfo && name && espnId && !coach) tasks.push((async () => { try { out.es = await espnPlayer(name, 1, espnId); st.espn_profil = out.es && (out.es.headshot || Object.values(out.es.bio || {}).some(Boolean)) ? "ok" : (out.es.note || "profil verisi yok"); } catch (e) { st.espn_profil = "hata: " + (e.message || e); } })());
  if (coach && apiFootballKey(env)) tasks.push((async () => { try { out.afCoach = await apiFootballCoachCareer(env, name, afId); st.api_football_coach = out.afCoach && out.afCoach.career.length ? "ok " + out.afCoach.career.length + " takım" : "kariyer verisi yok"; } catch (e) { st.api_football_coach = "hata: " + (e.message || e); } })());
  if (wantInfo && !coach) {
    // Profil cevabını fotoğraf aramasına kilitleme. Fotoğraf, istemcide ayrı
    // /pitch-player-photo isteğiyle paralel yüklenir; profil kartı beklemez.
    st.pitchapi_photo = "fotoğraf ayrı istekle yükleniyor";
    st.player_photos = "fotoğraf ayrı istekle yükleniyor";
  }
  if (wantInfo) tasks.push((async () => {
    try {
      const t = await title();
      if (!t) { st.wikipedia = "bulunamadı"; return; }
      const [w, tr] = await Promise.allSettled([wikiPlayer(t), wikiTrAbout(t)]);
      if (w.status === "fulfilled") { out.wk = w.value; st.wikipedia = "ok"; } else st.wikipedia = "hata: " + (w.reason && w.reason.message);
      out.trAbout = tr.status === "fulfilled" ? tr.value : "";
      try { out.wbio = await wikiInfobox(t); st.wikipedia_profil = Object.keys(out.wbio).length ? "ok" : "bilgi kutusu boş"; } catch (e) { st.wikipedia_profil = "hata: " + (e.message || e); }
    } catch (e) { st.wikipedia = "hata: " + (e.message || e); }
  })());
  if (wantStats && coach) {
    tasks.push((async () => {
      try {
        const t = await title();
        if (!t) return;
        let rows = await wikiManagerStats(t, "en");
        if (!rows.length) { const tt = await wikiTrTitle(t).catch(() => ""); if (tt) rows = await wikiManagerStats(tt, "tr"); }
        out.coachRows = rows; st.wikipedia_teknik_direktor = rows.length ? "ok " + rows.length : "tablo bulunamadı";
      } catch (e) { st.wikipedia_teknik_direktor = "hata: " + (e.message || e); }
    })());
  } else if (wantStats) {
    tasks.push((async () => {
      try {
        let id = tmId;
        if (!id && name) {
          const candidates = await tmSearch(env, name);
          const match = selectPlayerCandidate(candidates, name, teamHint, posHint);
          id = match && match.tm;
        }
        if (!id) {
          st.transfermarkt = "Transfermarkt oyuncusu bulunamadı";
          return;
        }
        const result = await tmPlayer(env, id);
        out.tm = result;
        out.tmId = id;
        st.transfermarkt = result.err ? "hata: " + result.err : "ok";
      } catch (error) {
        st.transfermarkt = "hata: " + (error && error.message || error);
      }
    })());
  }
  await Promise.all(tasks);
  // Oyuncu sezon/kariyer verilerinde tek kaynak Transfermarkt veritabanıdır.

  const nm = (ss && ss.player && ss.player.name) || (out.af && out.af.player) || (out.sm && out.sm.player) || name;
  const bio = {};
  [out.ts && out.ts.bio, out.es && out.es.bio, out.wbio, out.af && out.af.bio, out.afCoach && out.afCoach.bio, out.sm && out.sm.bio, out.tm && out.tm.bio].forEach((b) => Object.entries(b || {}).forEach(([k, v]) => { if (v !== "" && v != null) bio[k] = v; }));
  // API-Football's /transfers endpoint is the freshest current-club record; don't
  // let an older Transfermarkt profile override it when the providers disagree.
  if (coach && out.afCoach && out.afCoach.bio && out.afCoach.bio["Şu Anki Takım"]) bio["Şu Anki Takım"] = out.afCoach.bio["Şu Anki Takım"];
  const esRows = (out.es && out.es.seasons || []).map((r) => ({ ...r, "Sezon": String(r["Sezon"] || ""), "Takım": r["Takım"] || "", "Maç": r["Maç"] == null ? null : num(r["Maç"]), "Gol": r["Gol"] == null ? null : num(r["Gol"]), "Asist": r["Asist"] == null ? null : num(r["Asist"]), "İlk 11": r["İlk 11"] == null ? null : num(r["İlk 11"]), "Sarı Kart": r["Sarı Kart"] == null ? null : num(r["Sarı Kart"]), "Kırmızı Kart": r["Kırmızı Kart"] == null ? null : num(r["Kırmızı Kart"]), cats: r.cats || null }));
  const rows = mergeCareerRows([out.tm && out.tm.seasons, out.sd && out.sd.seasons, esRows, out.tsStats, out.wrows, out.sm && out.sm.seasons]);
  // API-Football is intentionally excluded from the general career-row merge:
  // its supplemental feed must not replace Maç/Gol or any other table columns.
  // Override only Asist / İlk 11 / Sarı Kart / Kırmızı Kart with verified
  // API-Football values. Other career columns remain exactly as before.
  overlayApiFootballCareerFields(rows, out.af && out.af.seasons);
  // Cross-check API-Football's transfer chronology with Transfermarkt transfer history.
  // Both sources write chronological timestamps onto the season/team rows, oldest stint first.
  if (out.tm && out.tm.transfers) applyTransferOrderToCareerRows(rows, out.tm.transfers);
  const currentTeamKey = teamSearchKey(careerTeamLogoLookupName(bio["Şu Anki Takım"] || teamHint || ""));
  if (currentTeamKey) for (const row of rows) row.currentTeam = teamSearchKey(careerTeamLogoLookupName(row["Takım"])) === currentTeamKey;
  // Last-team-per-season fallback: prefer the transfer-date marker; otherwise use
  // provider transfer timestamps, then the verified current club if present in the same season.
  const byCareerSeason = new Map();
  for (const row of rows) {
    const sy = Number(String(row["Sezon"] || "").match(/(?:19|20)\d{2}/)?.[0] || 0);
    if (!sy) continue;
    if (!byCareerSeason.has(sy)) byCareerSeason.set(sy, []);
    byCareerSeason.get(sy).push(row);
  }
  for (const seasonRows of byCareerSeason.values()) {
    if (seasonRows.length < 2) continue;
    const transferMarked = seasonRows.filter(row => row.transferLastTeam);
    if (transferMarked.length === 1) {
      for (const row of seasonRows) row.seasonLastTeam = row === transferMarked[0];
      continue;
    }
    // Rebuild the marker from transfer timestamps first; stale flags from secondary
    // sources must not decide the order when an authoritative transfer date exists.
    const ranked = seasonRows.map(row => ({ row, stamp: Number(row.careerTimestamp || row.careerOrder) || 0 }));
    const dated = ranked.filter(x => x.stamp > 0);
    if (dated.length >= 2) {
      const maxStamp = Math.max(...dated.map(x => x.stamp));
      const last = dated.filter(x => x.stamp === maxStamp);
      if (last.length === 1) {
        for (const x of seasonRows) x.seasonLastTeam = x === last[0].row;
        continue;
      }
    }
    // When some transfer rows have no date, current club is a safe tie-breaker.
    if (currentTeamKey) {
      const currentRows = seasonRows.filter(row => teamSearchKey(careerTeamLogoLookupName(row["Takım"])) === currentTeamKey);
      if (currentRows.length === 1) {
        for (const row of seasonRows) row.seasonLastTeam = row === currentRows[0];
        continue;
      }
    }
    // Keep one trusted provider marker only when no better ordering information exists.
    const marked = seasonRows.filter(row => row.seasonLastTeam);
    if (marked.length > 1) for (const row of seasonRows) row.seasonLastTeam = false;
  }
  const sp = splitSeasons(rows);
  await attachCareerTeamLogos(env, [...sp.seasons, ...(out.national || [])]);
  if (out.us && out.us.length) {
    // Understat lig asistlerini sezon satırlarına ekle (Transfermarkt asisti zaten varsa dokunma)
    for (const r of sp.seasons) {
      if (r["Asist"] != null && Number(r["Asist"]) > 0) continue;
      const y = parseInt(String(r["Sezon"]).slice(0, 4), 10);
      const u = out.us.find((x) => x.year === y && nameLike(x.team, r["Takım"]));
      if (!u) continue;
      r.aLig = u.a;
      if (!r.cats) r.cats = emptyCats();
      r.cats.lig.a = u.a;
    }
  }
  if (coach && out.afCoach && out.afCoach.career.length) {
    const apiRows = out.afCoach.career;
    const wikiRows = out.coachRows || [];
    for (const apiRow of apiRows) {
      const match = wikiRows.find(r => teamSearchKey(r["Takım"]) === teamSearchKey(apiRow["Takım"]) && String(r["Dönem"] || "").slice(0,4) === String(apiRow["Dönem"] || "").slice(0,4));
      if (match) Object.assign(apiRow, { "O": match["O"] ?? null, "G": match["G"] ?? null, "B": match["B"] ?? null, "M": match["M"] ?? null, careerOnly: false });
    }
    const apiKeys = new Set(apiRows.map(r => teamSearchKey(r["Takım"]) + "|" + String(r["Dönem"] || "").slice(0,4)));
    for (const row of wikiRows) if (!apiKeys.has(teamSearchKey(row["Takım"]) + "|" + String(row["Dönem"] || "").slice(0,4))) apiRows.push(row);
    out.coachRows = apiRows.sort((a,b)=>(Number(b.careerOrder)||0)-(Number(a.careerOrder)||0));
    await attachCareerTeamLogos(env, out.coachRows);
  }
  const photos = [...new Set([out.pitchPhoto, ...(out.profilePhotos || []), ...out.photos, out.afCoach && out.afCoach.photo, out.es && out.es.headshot, ss && ss.player && ss.player.logo, ...(out.ts && out.ts.photos || []), out.wk && out.wk.photo, out.tm && out.tm.photo, out.af && out.af.photo, out.sm && out.sm.photo].filter(x => typeof x === "string" && /^https?:\/\//i.test(x)))];
  const photo = photos[0] || "";
  const afTransfers=out.af&&Array.isArray(out.af.transfers)?out.af.transfers:[];
  const tmRaw=out.tm&&out.tm.transfers;
  const tmRows=Array.isArray(tmRaw)?tmRaw:Array.isArray(tmRaw&&tmRaw.transfers)?tmRaw.transfers:Array.isArray(tmRaw&&tmRaw.history)?tmRaw.history:Array.isArray(tmRaw&&tmRaw.data)?tmRaw.data:[];
  const tmTransfers=tmRows.map(move=>{
    const teamName=value=>typeof value==='string'?value:value&& (value.name||value.clubName||value.teamName)||'';
    const from=teamName(move.from||move.fromClub||move.fromTeam||move.oldClub||move.previousClub||move.fromClubName);
    const to=teamName(move.to||move.toClub||move.toTeam||move.newClub||move.currentClub||move.toClubName);
    const rawDate=move.date||move.transferDate||move.dateOfTransfer||move.timestamp||'';
    const date=typeof rawDate==='number'?new Date(rawDate<1e12?rawDate*1000:rawDate).toISOString().slice(0,10):String(rawDate).slice(0,10);
    const rawType=String(move.type||move.transferType||move.fee||move.transferFee||move.feeText||'').trim();
    const loan=/loan|kiral/i.test(rawType),free=/free|bedelsiz/i.test(rawType),fee=/€|£|\$|\b\d/.test(rawType)&&!loan?rawType:'';
    return {date,from,to,kind:loan?'Kiralık':free?'Bedelsiz':fee?'Bonservis':rawType?'Transfer':'Detay belirtilmemiş',fee};
  }).filter(x=>x.from||x.to||x.date).sort((a,b)=>String(b.date).localeCompare(String(a.date)));
  const transfers=tmTransfers;
  return { part: part || "all", role: coach ? "coach" : "player", player: { name: nm, logo: photo, photos, slug: slug || "" }, about: out.trAbout || (out.wk && out.wk.about) || "", aboutLang: out.trAbout ? "tr" : out.wk && out.wk.about ? "en" : "", bio, seasons: sp.seasons, national: out.national || [], coach: out.coachRows || [], transfers, injuries: out.tm && out.tm.injuries || [], absences: out.tm && out.tm.absences || [], marketValueHistory: out.tm && out.tm.marketValueHistory || [], sources: st, stats: null };
}

// ---------- PitchAPI: seçilen oyuncunun erişilebilir geçmiş sezonlarını maç maç birleştir ----------
// PitchAPI oyuncu profili endpoint'i kimlik bilgisi döndürür; sezon toplamı endpoint'i yoktur.
// Bu nedenle seçilen ligdeki maç listesi, oyuncu satırı, olaylar ve ilk 11 verileri birleştirilir.
const PITCH_PLAYER_CAREER_PAGE_SIZE = 8;
function pitchMetricValue(entry, wanted) {
  const aliases = new Set((wanted || []).map(pitchNorm));
  const candidates = [];
  const add = (item, label) => {
    if (item == null || typeof item !== "object") return;
    const stat = item.stat && typeof item.stat === "object" ? item.stat : item;
    const keys = [label,item.key,item.title,item.name,item.label,item.type,stat.key,stat.title,stat.name,stat.label,stat.type]
      .filter(Boolean).map(pitchNorm);
    if (!keys.some(key => aliases.has(key))) return;
    const raw = stat.value ?? stat.total ?? item.value ?? item.total ?? item.count;
    if (raw == null || raw === "") return;
    const n = Number(raw);
    if (Number.isFinite(n)) candidates.push(n);
  };
  const walk = (node, label="", depth=0) => {
    if (node == null || depth > 9) return;
    if (Array.isArray(node)) { for (const item of node) walk(item,label,depth+1); return; }
    if (typeof node !== "object") return;
    add(node,label);
    for (const [key,value] of Object.entries(node)) {
      if (aliases.has(pitchNorm(key)) && value != null && typeof value !== "object") {
        const n=Number(value); if(Number.isFinite(n))candidates.push(n);
      }
      if (value && typeof value === "object") walk(value,key,depth+1);
    }
  };
  // Documented PitchAPI shape: stats[] -> {key:"top_stats",stats:{Rating:{key:"rating_title",stat:{type:"double",value:8.9}}}}
  // Also accept alternative provider wrappers and direct games.rating fields.
  walk(entry && (entry.stats ?? entry.statistics ?? entry.player_stats ?? entry), "stats");
  if (candidates.length) return candidates[0];
  const directPaths=[entry&&entry.rating,entry&&entry.rating_title,entry&&entry.average_rating,
    entry&&entry.player&&entry.player.rating,entry&&entry.player&&entry.player.rating_title,
    entry&&entry.games&&entry.games.rating,entry&&entry.statistics&&entry.statistics[0]&&entry.statistics[0].games&&entry.statistics[0].games.rating];
  for(const raw of directPaths){if(raw!=null&&raw!==""){const n=Number(raw);if(Number.isFinite(n))return n;}}
  return null;
}
function pitchUnwrapList(value, keys) {
  if (Array.isArray(value)) return value;
  if (value && value.data != null) return pitchUnwrapList(value.data, keys);
  for (const key of keys) if (value && Array.isArray(value[key])) return value[key];
  return [];
}
function pitchHasPlayerStatValues(stats) {
  const seen=new Set();
  const walk=(node,depth=0)=>{
    if(node==null||depth>9)return false;
    if(typeof node==='number')return Number.isFinite(node);
    if(typeof node==='string')return node.trim()!==''&&Number.isFinite(Number(node));
    if(typeof node!=='object')return false;
    if(seen.has(node))return false;seen.add(node);
    if(Array.isArray(node))return node.some(value=>walk(value,depth+1));
    const stat=node.stat&&typeof node.stat==='object'?node.stat:node;
    const value=stat.value??stat.total??stat.count;
    if(value!=null&&value!==''&&typeof value!=='boolean'&&Number.isFinite(Number(value)))return true;
    for(const [key,value2] of Object.entries(node)){
      if(['type','format_type','description','unit','id','key','title','name','label'].includes(key.toLowerCase()))continue;
      if(walk(value2,depth+1))return true;
    }
    return false;
  };
  return walk(stats);
}
const PITCH_PLAYER_RESOLVE_PAGE_SIZE = 5;
function pitchPlayerNameMatches(wanted, candidate) {
  const a = pitchNorm(wanted).split(/\s+/).filter(Boolean);
  const b = pitchNorm(candidate).split(/\s+/).filter(Boolean);
  if (!a.length || !b.length) return false;
  if (a.join(" ") === b.join(" ")) return true;
  // Providers sometimes abbreviate first names ("M. Greenwood").
  if (a.length >= 2 && b.length >= 2 && a[a.length - 1] === b[b.length - 1]) {
    return a[0][0] === b[0][0] && (a[0].length === 1 || b[0].length === 1 || a[0] === b[0]);
  }
  return false;
}
function pitchTeamNameMatches(wanted, candidate) {
  const a = pitchNorm(wanted), b = pitchNorm(candidate);
  return !!a && !!b && (a === b || (Math.min(a.length, b.length) >= 6 && (a.includes(b) || b.includes(a))));
}
async function pitchPlayerPhotoFromProfile(env, playerId) {
  const id = String(playerId || "").trim();
  if (!/^p_[A-Za-z0-9]+$/.test(id) || !pitchApiKey(env)) return "";
  try {
    const result = await cached("pitch:player-profile-photo:v4:" + id, async () => {
      const body = await pitchApiJSON(env, "/v1/players/" + encodeURIComponent(id));
      const player = body && (body.player || body.data && (body.data.player || body.data) || body) || {};
      const photo = String(player.image_url || player.photo || "");
      const validPhoto = /^https:\/\//i.test(photo) ? photo : "";
      return { body: { photo: validPhoto }, ttl: validPhoto ? 2592000 : 21600 };
    });
    return result.body && result.body.photo || "";
  } catch (_) { return ""; }
}
async function pitchResolvePlayerPhoto(env, playerId, name, teamName, leagueCode, seasonYear) {
  const directId = String(playerId || "").trim();
  const direct = await pitchPlayerPhotoFromProfile(env, directId);
  if (direct) return direct;
  if (!name || !teamName || !leagueCode || !pitchApiKey(env)) return "";
  const code = canonicalPitchLeagueCode(leagueCode);
  if (!code) return "";
  const year = Number(seasonYear) || seasonStartYear();
  const cacheKey = "pitch:player-photo-resolve:v3:" + [pitchNorm(name),pitchNorm(teamName),code,year].join(":");
  try {
    const result = await cached(cacheKey, async () => {
      const league = await pitchLeagueForCode(env, code, year);
      const matches = await pitchLeagueMatches(env, league.id, league.season, "played");
      const relevant = matches.filter(match => {
        const home = match && match.home_team || {}, away = match && match.away_team || {};
        return pitchTeamNameMatches(teamName, home.name) || pitchTeamNameMatches(teamName, away.name);
      }).sort((a,b) => String(pitchDateString(b)).localeCompare(String(pitchDateString(a)))).slice(0,20);
      const settled = await Promise.allSettled(relevant.map(async match => {
        const id = String(match && (match.id || match.match_id) || "");
        if (!id) return null;
        const result = await cached("pitch:photo-match-players:v3:" + id, async () => ({
          body: await pitchApiJSON(env, "/v1/matches/" + encodeURIComponent(id) + "/players"), ttl: 2592000,
        }));
        const rows = pitchUnwrapList(result.body, ["players"]);
        const home = match.home_team || {}, away = match.away_team || {};
        const candidates = [];
        for (const row of rows) {
          const player = row && (row.player || row.person) || {};
          const names = [player.name,player.full_name,player.short_name,row && row.player_name].filter(Boolean);
          if (!names.some(candidate => pitchPlayerNameMatches(name,candidate))) continue;
          const teamId = String(row && (row.team_id || row.team && row.team.id) || "");
          const actualTeam = row && row.team && row.team.name || (teamId && teamId === String(home.id || "") ? home.name : teamId && teamId === String(away.id || "") ? away.name : "");
          if (actualTeam && !pitchTeamNameMatches(teamName, actualTeam)) continue;
          const photo = String(player.image_url || player.photo || row.image_url || "");
          const idValue = String(player.id || player.player_id || row.player_id || "");
          candidates.push({ id:idValue, photo:/^https:\/\//i.test(photo)?photo:"", exact:names.some(candidate=>pitchNorm(candidate)===pitchNorm(name))?1:0 });
        }
        candidates.sort((a,b)=>b.exact-a.exact);
        return candidates[0] || null;
      }));
      let found = settled.filter(x=>x.status==="fulfilled"&&x.value).map(x=>x.value).sort((a,b)=>b.exact-a.exact)[0] || null;
      // Player match-stat lists can omit unused substitutes. If the player was not found,
      // inspect the recent match lineups as a secondary ID-discovery source.
      if (!found) {
        const lineupSettled = await Promise.allSettled(relevant.map(async match => {
          const id = String(match && (match.id || match.match_id) || "");
          if (!id) return null;
          const result = await cached("pitch:photo-match-lineups:v1:" + id, async () => ({
            body: await pitchApiJSON(env, "/v1/matches/" + encodeURIComponent(id) + "/lineups"), ttl: 2592000,
          }));
          const root = result.body && (result.body.lineups || result.body.data && (result.body.data.lineups || result.body.data)) || result.body || {};
          const home = match.home_team || {}, away = match.away_team || {};
          const candidates = [];
          for (const sideKey of ["home", "away"]) {
            const side = root[sideKey] || root[sideKey + "_team_lineup"] || {};
            const sideTeam = sideKey === "home" ? home : away;
            const rows = [...(Array.isArray(side.starters) ? side.starters : []), ...(Array.isArray(side.subs) ? side.subs : Array.isArray(side.substitutes) ? side.substitutes : Array.isArray(side.bench) ? side.bench : [])];
            for (const row of rows) {
              const player = row && row.player && typeof row.player === "object" ? { ...row, ...row.player } : (row || {});
              const candidateNames = [player.name, player.full_name, player.short_name].filter(Boolean);
              if (!candidateNames.some(candidate => pitchPlayerNameMatches(name, candidate))) continue;
              const actualTeam = side.team && side.team.name || sideTeam.name || "";
              if (actualTeam && !pitchTeamNameMatches(teamName, actualTeam)) continue;
              const photo = String(player.image_url || player.photo || "");
              candidates.push({ id:String(player.player_id || player.id || ""), photo:/^https:\/\//i.test(photo)?photo:"", exact:candidateNames.some(candidate=>pitchNorm(candidate)===pitchNorm(name))?1:0 });
            }
          }
          return candidates.sort((a,b)=>b.exact-a.exact)[0] || null;
        }));
        found = lineupSettled.filter(x=>x.status==="fulfilled"&&x.value).map(x=>x.value).sort((a,b)=>b.exact-a.exact)[0] || null;
      }
      if (!found) return { body:"", ttl:172800 };
      const profilePhoto = found.id ? await pitchPlayerPhotoFromProfile(env, found.id) : "";
      const photo = profilePhoto || found.photo || "";
      return { body: photo, ttl: photo ? 2592000 : 172800 };
    });
    return typeof result.body === "string" ? result.body : "";
  } catch (_) { return ""; }
}
const PITCH_SEARCH_TEAM_LEAGUES={
  'fenerbahce':'tur.1','galatasaray':'tur.1','besiktas':'tur.1','trabzonspor':'tur.1','basaksehir':'tur.1','istanbul basaksehir':'tur.1','kasimpasa':'tur.1','goztepe':'tur.1','samsunspor':'tur.1','antalyaspor':'tur.1','konyaspor':'tur.1','gaziantep fk':'tur.1','rizespor':'tur.1','alanyaspor':'tur.1','kayserispor':'tur.1','eyupspor':'tur.1','hatayspor':'tur.1','sivasspor':'tur.1','adana demirspor':'tur.1','kocaelispor':'tur.1','genclerbirligi':'tur.1',
  'manchester city':'eng.1','manchester united':'eng.1','liverpool':'eng.1','arsenal':'eng.1','chelsea':'eng.1','tottenham hotspur':'eng.1','newcastle united':'eng.1','aston villa':'eng.1','brighton':'eng.1','fulham':'eng.1','wolverhampton wanderers':'eng.1','nottingham forest':'eng.1','leicester city':'eng.1','southampton':'eng.1','west ham united':'eng.1','crystal palace':'eng.1','everton':'eng.1',
  'real madrid':'esp.1','barcelona':'esp.1','atletico madrid':'esp.1','athletic club':'esp.1','real sociedad':'esp.1','getafe cf':'esp.1','girona':'esp.1','osasuna':'esp.1','celta vigo':'esp.1','villarreal':'esp.1','sevilla':'esp.1','valencia':'esp.1',
  'bayern munich':'ger.1','borussia dortmund':'ger.1','eintracht frankfurt':'ger.1','wolfsburg':'ger.1','bayer leverkusen':'ger.1','rb leipzig':'ger.1','stuttgart':'ger.1',
  'inter':'ita.1','inter milan':'ita.1','ac milan':'ita.1','fiorentina':'ita.1','bologna':'ita.1','torino':'ita.1','juventus':'ita.1','napoli':'ita.1','roma':'ita.1','lazio':'ita.1','atalanta':'ita.1',
  'paris saint germain':'fra.1','psg':'fra.1','marseille':'fra.1','olympique marseille':'fra.1','olympique de marseille':'fra.1','getafe':'esp.1','olympique lyonnais':'fra.1','monaco':'fra.1','lyon':'fra.1','lille':'fra.1','nice':'fra.1',
  'ajax':'ned.1','psv':'ned.1','feyenoord':'ned.1','benfica':'por.1','porto':'por.1','sporting cp':'por.1'
};
function pitchPlayerSearchLeagueCode(item){
  const values=[item&&item.pitchCode,item&&item.pitchLeagueCode,item&&item.leagueCode,item&&item.competitionCode,item&&item.code];
  for(const value of values){const code=canonicalPitchLeagueCode(value);if(code)return code;}
  const team=pitchNorm(item&& (item.team||item.teamName||item.club||item.clubName)||'').replace(/[^a-z0-9]+/g,' ').trim();
  if(!team)return '';
  const entries=Object.entries(PITCH_SEARCH_TEAM_LEAGUES).sort((a,b)=>b[0].length-a[0].length);
  for(const [name,code] of entries)if(team===name||team.includes(name)||name.includes(team))return code;
  return '';
}
async function pitchHydratePlayerSearchPhotos(env,items){
  const rows=Array.isArray(items)?items:[];
  if(!pitchApiKey(env)){for(const item of rows){item.photos=[];item.photo='';item.logo='';item.pitchPhotoSource='';}return;}
  const groups=new Map();
  for(const item of rows){
    const code=pitchPlayerSearchLeagueCode(item);
    const team=String(item.team||item.teamName||item.club||item.clubName||'').trim();
    item.pitchCode=code||item.pitchCode||'';item.pitchYear=seasonStartYear();
    if(code&&team){const key=code+'|'+pitchNorm(team);if(!groups.has(key))groups.set(key,{code,team,items:[]});groups.get(key).items.push(item);}
  }
  const grouped=[...groups.values()];
  for(let i=0;i<grouped.length;i+=4){
    await Promise.all(grouped.slice(i,i+4).map(async group=>{
      try{
        const map=await pitchTeamRosterPhotoMap(env,group.team,group.code,seasonStartYear());
        for(const item of group.items){
          const key=pitchNorm(item.name||''),found=map[key]||Object.entries(map).find(([name])=>pitchPlayerNameMatches(item.name,name))?.[1]||'';
          if(found&&/^https:\/\//i.test(found)){item.photos=[found];item.photo=found;item.logo=found;item.pitchPhotoSource='PitchAPI';}
        }
      }catch(_){}
    }));
  }
  // Team adı mevcut sabit eşleme listesinde olmayan liglerde de PitchAPI'nin
  // tam lig kataloğunu kullanarak takımın lig/sezonunu bul.
  const unresolved=rows.filter(item=>!(item.pitchPhotoSource)&&String(item.team||item.teamName||item.club||item.clubName||'').trim());
  if(unresolved.length){
    try{
      const index=await pitchSearchTeamLeagueIndex(env),leagueGroups=new Map();
      for(const item of unresolved){
        const team=String(item.team||item.teamName||item.club||item.clubName||'').trim(),key=pitchNorm(team);
        let refs=index[key]||Object.entries(index).filter(([name])=>pitchTeamNameMatches(key,name)).flatMap(([,refs])=>refs);
        if(!refs.length)continue;
        // Same team can be found in a league and its cup; choose the league with
        // most recent season and prefer a top-flight competition when present.
        refs=refs.slice().sort((a,b)=>Number((b.season.match(/\d{4}/)||[])[0]||0)-Number((a.season.match(/\d{4}/)||[])[0]||0));
        const ref=refs[0],groupKey=ref.id+'|'+ref.season+'|'+key;
        if(!leagueGroups.has(groupKey))leagueGroups.set(groupKey,{team,ref,items:[]});
        leagueGroups.get(groupKey).items.push(item);
      }
      const groups2=[...leagueGroups.values()];
      for(let i=0;i<groups2.length;i+=4)await Promise.all(groups2.slice(i,i+4).map(async group=>{
        try{
          const map=await pitchTeamRosterPhotoMapFromLeague(env,group.team,group.ref);
          for(const item of group.items){const key=pitchNorm(item.name||''),found=map[key]||Object.entries(map).find(([name])=>pitchPlayerNameMatches(item.name,name))?.[1]||'';
            if(found&&/^https:\/\//i.test(found)){item.photos=[found];item.photo=found;item.logo=found;item.pitchPhotoSource='PitchAPI';item.pitchLeague=group.ref.league;}
          }
        }catch(_){}
      }));
    }catch(_){}
  }
  // Player profile p_ IDs are a final direct PitchAPI source.
  const direct=rows.filter(item=>!item.pitchPhotoSource&&/^p_[A-Za-z0-9]{6}$/.test(String(item.pitchId||'')));
  for(let i=0;i<direct.length;i+=6)await Promise.all(direct.slice(i,i+6).map(async item=>{
    const photo=await pitchPlayerPhotoFromProfile(env,item.pitchId);
    if(photo){item.photos=[photo];item.photo=photo;item.logo=photo;item.pitchPhotoSource='PitchAPI';}
  }));
  // Never silently substitute portraits from other providers in the result list.
  for(const item of rows)if(!item.pitchPhotoSource){item.photos=[];item.photo='';item.logo='';item.image='';}
}

async function pitchTeamRosterPhotoMap(env, teamName, leagueCode, seasonYear) {
  const code = canonicalPitchLeagueCode(leagueCode);
  if (!code || !teamName || !pitchApiKey(env)) return {};
  const year = Number(seasonYear) || seasonStartYear();
  const key = "pitch:team-roster-photo-map:v4:" + [code, year, pitchNorm(teamName)].join(":");
  try {
    const result = await cached(key, async () => {
      const league = await pitchLeagueForCode(env, code, year);
      const matches = await pitchLeagueMatches(env, league.id, league.season, "played");
      const relevant = matches.filter(match => {
        const home = match && match.home_team || {}, away = match && match.away_team || {};
        return pitchTeamNameMatches(teamName, home.name) || pitchTeamNameMatches(teamName, away.name);
      }).sort((a,b) => String(pitchDateString(b)).localeCompare(String(pitchDateString(a)))).slice(0,20);
      const settled = await Promise.allSettled(relevant.map(async match => {
        const id = String(match && (match.id || match.match_id) || "");
        if (!id) return [];
        const matchResult = await cached("pitch:photo-match-players:v3:" + id, async () => ({
          body: await pitchApiJSON(env, "/v1/matches/" + encodeURIComponent(id) + "/players"), ttl: 2592000,
        }));
        const rows = pitchUnwrapList(matchResult.body, ["players"]);
        const output = [];
        for (const row of rows) {
          const player = row && (row.player || row.person) || {};
          const teamId = String(row && (row.team_id || row.team && row.team.id) || "");
          const home = match.home_team || {}, away = match.away_team || {};
          const actualTeam = row && row.team && row.team.name || (teamId && teamId === String(home.id || "") ? home.name : teamId && teamId === String(away.id || "") ? away.name : "");
          if (actualTeam && !pitchTeamNameMatches(teamName, actualTeam)) continue;
          const photo = String(player.image_url || player.photo || row.image_url || "");
          if (/^https:\/\//i.test(photo) && player.name) output.push({ name: player.name, photo });
        }
        return output;
      }));
      const photos = {};
      for (const entry of settled) if (entry.status === "fulfilled") for (const row of entry.value || []) photos[pitchNorm(row.name)] = row.photo;
      const count = Object.keys(photos).length;
      return { body: photos, ttl: count ? 604800 : 21600 };
    });
    return result.body && typeof result.body === "object" ? result.body : {};
  } catch (_) { return {}; }
}
async function pitchSearchTeamLeagueIndex(env) {
  const result = await cached("pitch:search-team-league-index:v1", async () => {
    const listing = await pitchApiJSON(env, "/v1/leagues");
    const leagues = pitchUnwrapList(listing, ["leagues"]);
    const year = seasonStartYear();
    const chosen = leagues.filter(item => item && item.id).map(item => {
      const seasons = (Array.isArray(item.seasons) ? item.seasons : []).map(value => String(value && (value.name || value.season || value.year) || value));
      const season = seasons.find(value => value === String(year) || value.startsWith(String(year) + "/")) ||
        seasons.sort((a,b) => Number((b.match(/\d{4}/)||[])[0]||0) - Number((a.match(/\d{4}/)||[])[0]||0))[0] || item.season || "";
      return season ? {id:String(item.id),name:String(item.name||""),season:String(season)} : null;
    }).filter(Boolean);
    const index = {};
    const concurrency = 8;
    for (let i=0;i<chosen.length;i+=concurrency) {
      const batch = chosen.slice(i,i+concurrency);
      const settled = await Promise.allSettled(batch.map(async league => {
        const path = "/v1/leagues/" + encodeURIComponent(league.id) + "/matches?" + new URLSearchParams({season:league.season,status:"played"});
        const body = await pitchApiJSON(env,path);
        return {league,matches:pitchUnwrapList(body,["matches","fixtures"])};
      }));
      for (const item of settled) if (item.status === "fulfilled") {
        const {league,matches} = item.value;
        for (const match of matches) for (const team of [match && match.home_team,match && match.away_team]) {
          if (!team || !team.name) continue;
          const key = pitchNorm(team.name);
          if (!index[key]) index[key] = [];
          if (!index[key].some(entry=>entry.id===league.id&&entry.season===league.season))
            index[key].push({id:league.id,league:league.name,season:league.season,team:team.name,teamId:String(team.id||"")});
        }
      }
    }
    return {body:index,ttl:43200};
  });
  return result.body && typeof result.body === "object" ? result.body : {};
}
async function pitchTeamRosterPhotoMapFromLeague(env, teamName, leagueRef) {
  if (!pitchApiKey(env) || !teamName || !leagueRef || !leagueRef.id || !leagueRef.season) return {};
  const cacheKey = "pitch:search-roster-photo-map:v1:" + [leagueRef.id,leagueRef.season,pitchNorm(teamName)].join(":");
  try {
    const result = await cached(cacheKey, async () => {
      const path = "/v1/leagues/" + encodeURIComponent(leagueRef.id) + "/matches?" + new URLSearchParams({season:leagueRef.season,status:"played"});
      const body = await pitchApiJSON(env,path);
      const matches = pitchUnwrapList(body,["matches","fixtures"]).filter(match => {
        const home=match&&match.home_team||{},away=match&&match.away_team||{};
        return pitchTeamNameMatches(teamName,home.name)||pitchTeamNameMatches(teamName,away.name);
      }).sort((a,b)=>String(pitchDateString(b)).localeCompare(String(pitchDateString(a)))).slice(0,24);
      const settled = await Promise.allSettled(matches.map(async match => {
        const id=String(match&&(match.id||match.match_id)||""); if(!id)return [];
        const data=await cached("pitch:photo-match-players:v4:"+id,async()=>({body:await pitchApiJSON(env,"/v1/matches/"+encodeURIComponent(id)+"/players"),ttl:2592000}));
        const rows=pitchUnwrapList(data.body,["players"]),out=[];
        for(const row of rows){
          const player=row&&(row.player||row.person)||{};
          const teamId=String(row&&(row.team_id||row.team&&row.team.id)||"");
          const home=match.home_team||{},away=match.away_team||{};
          const actual=row&&row.team&&row.team.name||(teamId&&teamId===String(home.id||"")?home.name:teamId&&teamId===String(away.id||"")?away.name:"");
          if(actual&&!pitchTeamNameMatches(teamName,actual))continue;
          const photo=String(player.image_url||row&&row.image_url||player.photo||"");
          if(player.name&&/^https:\/\//i.test(photo))out.push({name:player.name,photo});
        }
        return out;
      }));
      const photos={};
      for(const item of settled)if(item.status==="fulfilled")for(const row of item.value||[])photos[pitchNorm(row.name)]=row.photo;
      return {body:photos,ttl:Object.keys(photos).length?604800:21600};
    });
    return result.body&&typeof result.body==="object"?result.body:{};
  } catch (_) { return {}; }
}
async function pitchApplyRosterPhotos(env, players, teamName, leagueCode, seasonYear) {
  if (!Array.isArray(players) || !players.length || !leagueCode || !teamName) return players || [];
  const map = await pitchTeamRosterPhotoMap(env, teamName, leagueCode, seasonYear);
  if (!Object.keys(map).length) return players;
  return players.map(player => {
    const exact = map[pitchNorm(player && player.name)];
    const relaxed = exact || Object.entries(map).find(([name]) => pitchPlayerNameMatches(player && player.name, name))?.[1] || "";
    if (!relaxed) return player;
    const oldPhotos = Array.isArray(player.photos) ? player.photos : [];
    const photos = [...new Set([relaxed, ...oldPhotos, player.photo, player.logo].filter(value => typeof value === "string" && /^https?:\/\//i.test(value)))];
    return { ...player, photo: relaxed, logo: relaxed, photos, pitchPhoto: relaxed };
  });
}
function pitchCareerCategory(code, leagueName) {
  const c = String(code || "").toLowerCase();
  const n = pitchNorm(leagueName || "");
  if (/^(uefa|conmebol|afc|caf|concacaf|ofc|fifa)\./.test(c) || /champions league|europa league|conference league|libertadores|sudamericana|world cup|nations league/.test(n)) return "intl";
  // Yerel kupalar istenen üç filtreli arayüzde Lig altında gösterilir.
  return "lig";
}
function pitchEntityPlayerId(value) {
  return String(value && (value.player_id || value.id || (value.player && (value.player.id || value.player.player_id))) || "");
}
async function pitchPlayerResolveBatch(env, name, team, code, season, offset) {
  if (!pitchApiKey(env)) throw new Error("PitchAPI için PITCH_API_KEY gizli değişkeni gerekli.");
  const league = await pitchLeagueInfoForCode(env, code);
  if (!league.seasons.includes(season)) throw new Error("PitchAPI bu lig için " + season + " sezonunu sunmuyor.");
  const matchResult = await cached("pitch:player-matches:v7:" + league.id + ":" + season, async () => ({
    body: await pitchApiJSON(env, "/v1/leagues/" + encodeURIComponent(league.id) + "/matches?" + new URLSearchParams({ season, status: "played" })), ttl: 900,
  }));
  const matches = pitchUnwrapList(matchResult.body, ["matches"]);
  const batch = matches.slice(offset, offset + PITCH_PLAYER_RESOLVE_PAGE_SIZE);
  const settled = await Promise.allSettled(batch.map(async match => {
    if (!match || !(match.id || match.match_id)) return null;
    const home = match.home_team || {}, away = match.away_team || {};
    if (team && !pitchTeamNameMatches(team, home.name) && !pitchTeamNameMatches(team, away.name)) return null;
    const matchId = String(match.id || match.match_id);
    const playerResult = await cached("pitch:player-match-line:v7:" + matchId, async () => ({
      body: await pitchApiJSON(env, "/v1/matches/" + encodeURIComponent(matchId) + "/players"), ttl: 2592000,
    }));
    const players = pitchUnwrapList(playerResult.body, ["players"]);
    const candidates = [];
    for (const row of players) {
      const p = row && row.player || {};
      const names = [p.name, p.short_name, p.full_name].filter(Boolean);
      if (!names.some(candidate => pitchPlayerNameMatches(name, candidate))) continue;
      const teamId = String(row.team_id || "");
      const teamName = teamId && String(home.id || "") === teamId ? home.name : teamId && String(away.id || "") === teamId ? away.name : (row.team && row.team.name) || "";
      if (team && !pitchTeamNameMatches(team, teamName)) continue;
      const exact = names.some(candidate => pitchNorm(candidate) === pitchNorm(name));
      candidates.push({ playerId: p.id || p.player_id || row.player_id || "", playerName: p.name || p.short_name || name, playerPhoto: p.image_url || "", team: teamName, exact: exact ? 1 : 0 });
    }
    candidates.sort((a,b) => b.exact - a.exact);
    return candidates[0] || null;
  }));
  const found = settled.filter(x => x.status === "fulfilled" && x.value && x.value.playerId).map(x => x.value).sort((a,b) => b.exact - a.exact);
  const nextOffset = offset + batch.length;
  return {
    league: league.name, season, totalMatches: matches.length, offset,
    nextOffset, done: nextOffset >= matches.length,
    playerId: found.length ? String(found[0].playerId) : "",
    playerName: found.length ? found[0].playerName : "",
    playerPhoto: found.length ? found[0].playerPhoto : "",
    team: found.length ? found[0].team : "",
    failedMatches: settled.filter(x => x.status === "rejected").length,
  };
}
async function pitchPlayerSeasonBatch(env, playerId, code, season, offset, requestedName = "") {
  const league = await pitchLeagueInfoForCode(env, code);
  if (!league.seasons.includes(season)) throw new Error("PitchAPI bu lig için " + season + " sezonunu sunmuyor.");
  const matchResult = await cached("pitch:player-matches:v7:" + league.id + ":" + season, async () => ({
    body: await pitchApiJSON(env, "/v1/leagues/" + encodeURIComponent(league.id) + "/matches?" + new URLSearchParams({ season, status: "played" })), ttl: 900,
  }));
  const matches = pitchUnwrapList(matchResult.body, ["matches"]);
  const batch = matches.slice(offset, offset + PITCH_PLAYER_CAREER_PAGE_SIZE);
  const settled = await Promise.allSettled(batch.map(async match => {
    if (!match || !(match.id || match.match_id)) return null;
    const matchId = String(match.id || match.match_id);
    const playerResult = await cached("pitch:player-match-line:v7:" + matchId, async () => ({
      body: await pitchApiJSON(env, "/v1/matches/" + encodeURIComponent(matchId) + "/players"), ttl: 900,
    }));
    const playerRows = pitchUnwrapList(playerResult.body, ["players"]);
    const entry = playerRows.find(row => {
      const p = row && (row.player || row.person) || {};
      const ids = [p.id, p.player_id, row && row.player_id, row && row.playerId, row && row.id].filter(v => v != null).map(String);
      return ids.includes(String(playerId));
    }) || (requestedName ? playerRows.find(row => {
      const p = row && (row.player || row.person) || {};
      return [p.name, p.full_name, p.short_name, row && row.player_name].filter(Boolean).some(name => pitchPlayerNameMatches(requestedName, name));
    }) : null);
    if (!entry) return null;

    const [eventResult, lineupResult] = await Promise.allSettled([
      cached("pitch:player-match-events:v7:" + matchId, async () => {
        const body = await pitchApiJSON(env, "/v1/matches/" + encodeURIComponent(matchId) + "/events");
        const events = pitchUnwrapList(body, ["events"]);
        return { body, ttl: events.length ? 900 : 300 };
      }),
      cached("pitch:player-match-lineups:v7:" + matchId, async () => {
        const body = await pitchApiJSON(env, "/v1/matches/" + encodeURIComponent(matchId) + "/lineups");
        const raw = body && (body.lineups || body);
        const sidePlayers = side => {
          if (Array.isArray(side)) return side;
          if (!side) return [];
          for (const key of ["starters", "startXI", "start_xi", "starting_xi", "startingXI", "starting_players"]) if (Array.isArray(side[key])) return side[key];
          return [];
        };
        const hasLineups = sidePlayers(raw && (raw.home || raw.home_team || raw.homeTeam)).length > 0 || sidePlayers(raw && (raw.away || raw.away_team || raw.awayTeam)).length > 0;
        return { body, ttl: hasLineups ? 900 : 300 };
      }),
    ]);
    const home = match.home_team || {}, away = match.away_team || {};
    const playerObj = entry.player || entry.person || {};
    const playerName = playerObj.name || playerObj.short_name || entry.player_name || requestedName || "";
    const teamId = String(entry.team_id || entry.team && (entry.team.id || entry.team.team_id) || "");
    const teamName = teamId && String(home.id || "") === teamId ? home.name : teamId && String(away.id || "") === teamId ? away.name : (entry.team && entry.team.name) || entry.team_name || (teamId && String(match.home_team_id || "")===teamId ? home.name : teamId && String(match.away_team_id || "")===teamId ? away.name : "");
    const samePlayer = candidate => {
      const p = candidate && (candidate.player || candidate.person || candidate) || {};
      const ids = [p.id, p.player_id, candidate && candidate.player_id, candidate && candidate.playerId, candidate && candidate.id].filter(v => v != null).map(String);
      if (ids.includes(String(playerId))) return true;
      const name = p.name || p.full_name || p.short_name || candidate && candidate.player_name || "";
      return !!playerName && !!name && pitchPlayerNameMatches(playerName, name);
    };

    // Cards and assists are read from direct stats first, then reconciled against the match event feed.
    const directYellow = pitchMetricValue(entry, ["yellow_cards", "yellow_card", "yellow"]);
    const directRed = pitchMetricValue(entry, ["red_cards", "red_card", "red"]);
    let yellow = directYellow, red = directRed;
    let yellowKnown = directYellow != null, redKnown = directRed != null;
    let assists = pitchMetricValue(entry, ["assists"]), assistsKnown = assists != null;
    let eventGoals = 0, missingEventData = false;
    if (eventResult.status === "fulfilled") {
      const events = pitchUnwrapList(eventResult.value.body, ["events"]);
      missingEventData = events.length === 0;
      if (events.length) {
        let eventYellow = 0, eventRed = 0, eventAssists = 0, eventAssistSchemaSeen = false;
        for (const ev of events) {
          const cardObject = ev && (ev.card || ev.card_event || ev.card_detail) || {};
          const kind = pitchNorm([ev && ev.event_type, ev && ev.type, ev && ev.detail, ev && ev.description, ev && ev.card_type, ev && ev.comment, cardObject.type, cardObject.name, cardObject.detail].filter(Boolean).join(" ")).replace(/[^a-z]/g, "");
          const actors = [ev && ev.player, ev && ev.actor, ev && ev.card_player, cardObject.player, ev && ev.offender].filter(Boolean);
          const eventIds = [ev && ev.player_id, ev && ev.actor_id, ev && ev.card_player_id, ev && ev.offender_id, cardObject.player_id, cardObject.playerId].filter(v => v != null).map(String);
          const directActorMatch = eventIds.includes(String(playerId)) || actors.some(samePlayer);
          if (directActorMatch && (kind.includes("yellow") || kind.includes("red") || kind.includes("card"))) {
            if (kind.includes("secondyellow") || kind.includes("yellow2") || kind.includes("2ndyellow")) { eventYellow++; eventRed++; }
            else if (kind.includes("yellow")) eventYellow++;
            else if (kind.includes("red")) eventRed++;
          }

          const isGoal = kind.includes("goal") && !kind.includes("own") && !kind.includes("missed") && !kind.includes("disallowed");
          if (isGoal && directActorMatch) eventGoals++;
          if (isGoal && !assistsKnown) {
            const assistObj = ev && (ev.assist_player || ev.assist || ev.assisted_by || ev.assistPlayer) || {};
            const assistIds = [assistObj.id, assistObj.player_id, ev && ev.assist_player_id, ev && ev.assist_id].filter(v => v != null).map(String);
            const assistName = assistObj.name || assistObj.full_name || ev && (ev.assist_player_name || ev.assist_name) || "";
            const hasAssistField = assistIds.length > 0 || !!assistName;
            if (hasAssistField) eventAssistSchemaSeen = true;
            if (assistIds.includes(String(playerId)) || (!!playerName && !!assistName && pitchPlayerNameMatches(playerName, assistName))) eventAssists++;
          }
        }
        if (!yellowKnown) { yellow = eventYellow; yellowKnown = true; }
        if (!redKnown) { red = eventRed; redKnown = true; }
        if (!assistsKnown && eventAssistSchemaSeen) { assists = eventAssists; assistsKnown = true; }
      }
    }

    // A valid lineup side lets us count both starts and non-starts; no lineup feed means unknown, not zero.
    const directStarts = pitchMetricValue(entry, ["starts", "started", "starting_appearances", "lineup_starts"]);
    let starts = directStarts, startsKnown = directStarts != null, missingLineupData = false;
    if (!startsKnown && lineupResult.status === "fulfilled") {
      const body = lineupResult.value.body || {}, root = body.data || body, raw = root.lineups || root;
      const sideFor = side => Array.isArray(side) ? { starters: side } : side || {};
      const startersOf = side => {
        const x = sideFor(side);
        for (const key of ["starters", "startXI", "start_xi", "starting_xi", "startingXI", "starting_players"]) if (Array.isArray(x[key])) return x[key];
        return [];
      };
      const homeSide = sideFor(raw.home || raw.home_team || raw.homeTeam);
      const awaySide = sideFor(raw.away || raw.away_team || raw.awayTeam);
      const homeId = String(homeSide.team && (homeSide.team.id || homeSide.team.team_id) || homeSide.team_id || raw.home_team && raw.home_team.id || home.id || "");
      const awayId = String(awaySide.team && (awaySide.team.id || awaySide.team.team_id) || awaySide.team_id || raw.away_team && raw.away_team.id || away.id || "");
      const homeName = homeSide.team && homeSide.team.name || raw.home_team && raw.home_team.name || home.name || "";
      const awayName = awaySide.team && awaySide.team.name || raw.away_team && raw.away_team.name || away.name || "";
      const sides = [
        {side:homeSide,id:homeId,name:homeName},
        {side:awaySide,id:awayId,name:awayName},
      ].filter(x => startersOf(x.side).length);
      let own = sides.find(x => teamId && x.id === teamId) || null;
      if (!own && teamName) own = sides.find(x => pitchTeamNameMatches(teamName, x.name)) || null;
      if (!own) own = sides.find(x => startersOf(x.side).some(samePlayer)) || null;
      if (own) {
        const starters = startersOf(own.side);
        startsKnown = true;
        starts = starters.some(samePlayer) ? 1 : 0;
      }
    }
    missingLineupData = !startsKnown;
    const directGoals = pitchMetricValue(entry, ["goals"]);
    const eventGoalsKnown = eventResult.status === "fulfilled" && pitchUnwrapList(eventResult.value.body, ["events"]).length > 0;
    const reconciledGoals = directGoals != null ? Number(directGoals) : eventGoalsKnown ? eventGoals : null;
    const directMinutes = pitchMetricValue(entry, ["minutes_played", "minutes"]);
    const directRating = pitchMetricValue(entry, ["rating", "average_rating", "rating_title"]);
    const teamLogo = (teamId && String(home.id || "") === teamId ? (home.image_url || home.logo || "") : teamId && String(away.id || "") === teamId ? (away.image_url || away.logo || "") : (entry.team && (entry.team.image_url || entry.team.logo)) || "");
    return {
      team: teamName || "Bilinmeyen Takım", teamLogo,
      appearances: 1, goals: reconciledGoals, minutes: directMinutes, rating: directRating,
      a: assistsKnown ? assists : null, s11: startsKnown ? starts : null,
      y: yellowKnown ? yellow : null, r: redKnown ? red : null,
      assistsKnown, startsKnown, yellowKnown, redKnown,
      goalsKnown: reconciledGoals != null, minutesKnown: directMinutes != null, ratingKnown: directRating != null,
      eventFailed: eventResult.status !== "fulfilled", lineupFailed: lineupResult.status !== "fulfilled",
      missingEventData, missingLineupData,
    };
  }));
  const byTeam = new Map();
  let failedMatches = 0, failedEvents = 0, failedLineups = 0, missingEvents = 0, missingLineups = 0;
  for (const result of settled) {
    if (result.status !== "fulfilled") { failedMatches++; continue; }
    const item = result.value;
    if (!item) continue;
    if (!byTeam.has(item.team)) byTeam.set(item.team, { team: item.team, logo: item.teamLogo || "", appearances: 0, goals: 0, goalsKnown: true, minutes: 0, minutesKnown: true, ratingTotal: 0, ratingCount: 0, a: 0, s11: 0, y: 0, r: 0, assistsKnown: true, startsKnown: true, yellowKnown: true, redKnown: true });
    const row = byTeam.get(item.team);
    row.appearances += Number(item.appearances) || 1;
    if (item.goalsKnown && item.goals != null) row.goals += Number(item.goals) || 0; else row.goalsKnown = false;
    if (item.minutesKnown && item.minutes != null) row.minutes += Number(item.minutes) || 0; else row.minutesKnown = false;
    if (item.ratingKnown && item.rating != null && Number.isFinite(Number(item.rating))) { row.ratingTotal += Number(item.rating); row.ratingCount++; }
    if (!row.logo && item.teamLogo) row.logo = item.teamLogo;
    if (item.assistsKnown && item.a != null) row.a += Number(item.a) || 0; else row.assistsKnown = false;
    if (item.startsKnown && item.s11 != null) row.s11 += Number(item.s11) || 0; else row.startsKnown = false;
    if (item.yellowKnown && item.y != null) row.y += Number(item.y) || 0; else row.yellowKnown = false;
    if (item.redKnown && item.r != null) row.r += Number(item.r) || 0; else row.redKnown = false;
    if (item.eventFailed) failedEvents++;
    if (item.lineupFailed) failedLineups++;
    if (item.missingEventData) missingEvents++;
    if (item.missingLineupData) missingLineups++;
  }
  const category = pitchCareerCategory(code, league.name);
  const rows = [...byTeam.values()].map(row => ({
    "Sezon": season, "Takım": row.team, "Takım Logosu": row.logo || "", "Turnuva": league.name, "Turnuva Türü": category,
    "Maç": row.appearances, "Gol": row.goalsKnown ? row.goals : null,
    "Toplam Dakika": row.minutesKnown ? row.minutes : null,
    "Puan Toplam": row.ratingCount ? Number(row.ratingTotal.toFixed(4)) : null,
    "Puan Maç": row.ratingCount, "Ort. Puan": row.ratingCount ? Number((row.ratingTotal / row.ratingCount).toFixed(2)) : null,
    "İlk 11": row.startsKnown ? row.s11 : null,
    "Asist": row.assistsKnown ? row.a : null,
    "Sarı Kart": row.yellowKnown ? row.y : null, "Kırmızı Kart": row.redKnown ? row.r : null,
    pitchApi: true, pitchCode: code, pitchCategory: category,
  }));
  const nextOffset = offset + batch.length;
  return {
    league: league.name, category, season, rows, totalMatches: matches.length,
    nextOffset, done: nextOffset >= matches.length,
    failedMatches, failedEvents, failedLineups, missingEvents, missingLineups,
  };
}

// ---------- PitchAPI takım puan durumu ve takım/oyuncu sezon istatistikleri ----------
async function pitchTeamStandingsForCode(env, code, year) {
  const league=await pitchLeagueForCode(env,code,year),matches=await pitchLeagueMatches(env,league.id,league.season,"played"),table=new Map();
  const ensure=team=>{const id=String(team&&team.id||team&&team.team_id||team&&team.name||"");if(!table.has(id))table.set(id,{team:{id,name:team&&team.name||"Bilinmeyen Takım",logo:team&&(team.image_url||team.logo)||""},played:0,win:0,draw:0,lose:0,for:0,against:0,diff:0,points:0});return table.get(id)};
  for(const m of matches){const h=m&&m.home_team||{},a=m&&m.away_team||{},rawHg=m&&m.score_home,rawAg=m&&m.score_away;if(rawHg==null||rawAg==null||rawHg===""||rawAg==="")continue;const hg=Number(rawHg),ag=Number(rawAg);if(!h.name||!a.name||!Number.isFinite(hg)||!Number.isFinite(ag))continue;const hr=ensure(h),ar=ensure(a);hr.played++;ar.played++;hr.for+=hg;hr.against+=ag;ar.for+=ag;ar.against+=hg;if(hg>ag){hr.win++;hr.points+=3;ar.lose++}else if(hg<ag){ar.win++;ar.points+=3;hr.lose++}else{hr.draw++;ar.draw++;hr.points++;ar.points++}}
  const rows=[...table.values()].map(r=>({...r,diff:r.for-r.against})).sort((a,b)=>b.points-a.points||b.diff-a.diff||b.for-a.for||a.team.name.localeCompare(b.team.name));
  rows.forEach((r,i)=>r.rank=i+1);
  return {tables:rows.length?[{name:league.name,rows:rows.map(r=>({rank:r.rank,team:r.team,played:r.played,win:r.win,draw:r.draw,lose:r.lose,diff:r.diff,points:r.points}))}]:[],league:league.name,season:league.season,source:"PitchAPI maç sonuçları"};
}
async function pitchAllSettledLimit(items, concurrency, handler) {
  const list = Array.isArray(items) ? items : [];
  const results = new Array(list.length);
  let cursor = 0;
  const count = Math.max(1, Math.min(Number(concurrency) || 1, list.length || 1));
  await Promise.all(Array.from({ length: count }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= list.length) return;
      try { results[index] = { status: "fulfilled", value: await handler(list[index], index) }; }
      catch (reason) { results[index] = { status: "rejected", reason }; }
    }
  }));
  return results;
}
async function pitchTeamStatsBatch(env,code,year,teamName,offset,limit){
  const league=await pitchLeagueForCode(env,code,year),all=await pitchLeagueMatches(env,league.id,league.season,"played");
  const matches=all.filter(m=>pitchTeamNameMatches(teamName,m&&m.home_team&&m.home_team.name)||pitchTeamNameMatches(teamName,m&&m.away_team&&m.away_team.name));
  const batch=matches.slice(offset,offset+limit),settled=await pitchAllSettledLimit(batch,4,async m=>{
    const home=m.home_team||{},away=m.away_team||{},isHome=pitchTeamNameMatches(teamName,home.name),side=isHome?home:away;
    const rawGf=isHome?m.score_home:m.score_away,rawGa=isHome?m.score_away:m.score_home;
    if(rawGf==null||rawGa==null||rawGf===""||rawGa==="")return null;
    const gf=Number(rawGf),ga=Number(rawGa),team={matches:1,wins:0,draws:0,losses:0,goalsFor:Number.isFinite(gf)?gf:0,goalsAgainst:Number.isFinite(ga)?ga:0,points:0,cleanSheets:Number.isFinite(ga)&&ga===0?1:0};
    if(Number.isFinite(gf)&&Number.isFinite(ga)){if(gf>ga){team.wins=1;team.points=3}else if(gf===ga){team.draws=1;team.points=1}else team.losses=1}
    const id=String(m.id||m.match_id||""),cache=await cached("pitch:team-player-lines:v10:"+id,async()=>({body:await pitchApiJSON(env,"/v1/matches/"+encodeURIComponent(id)+"/players"),ttl:300}));
    let penaltyGoals=0,penaltyEventsKnown=false,eventRows=[];
    try{const eventCache=await cached("pitch:team-player-events:v8:"+id,async()=>({body:await pitchApiJSON(env,"/v1/matches/"+encodeURIComponent(id)+"/events"),ttl:300}));eventRows=pitchUnwrapList(eventCache.body,["events"]);penaltyEventsKnown=Array.isArray(eventRows);for(const ev of eventRows){const isGoal=pitchEventPlayerMetricRows([ev],"goals").length>0;const isPenalty=ev&&(ev.is_penalty===true||ev.is_penalty===1||String(ev.is_penalty).toLowerCase()==="true");const eventTeam=String(ev&& (ev.team_id||ev.team&&ev.team.id||ev.teamId)||"");if(isGoal&&isPenalty&&eventTeam&&side.id&&eventTeam===String(side.id))penaltyGoals++;}}catch(_){}
    const selectedEvents=eventRows.filter(ev=>{const eventTeam=String(ev&&(ev.team_id||ev.team&&ev.team.id||ev.teamId)||""),eventTeamName=String(ev&&(ev.team_name||ev.team&&ev.team.name||ev.teamName)||"");if(eventTeam&&side.id&&eventTeam===String(side.id))return true;if(eventTeamName&&pitchTeamNameMatches(teamName,eventTeamName))return true;if(!eventTeam&&!eventTeamName)return true;return !side.id&&!eventTeamName;});
    const eventGoalRows=pitchEventPlayerMetricRows(selectedEvents,"goals"),eventAssistRows=pitchEventPlayerMetricRows(selectedEvents,"assists"),eventYellowRows=pitchEventPlayerMetricRows(selectedEvents,"yellow"),eventRedRows=pitchEventPlayerMetricRows(selectedEvents,"red");
    const eventGoalsById=new Map(),eventGoalsByName=new Map(),eventAssistsById=new Map(),eventAssistsByName=new Map(),eventYellowById=new Map(),eventYellowByName=new Map(),eventRedById=new Map(),eventRedByName=new Map();
    const addEventCounts=(rows,byId,byName)=>{for(const r of rows){byId.set(String(r.id),(byId.get(String(r.id))||0)+1);if(r.name)byName.set(pitchNorm(r.name),(byName.get(pitchNorm(r.name))||0)+1)}};
    addEventCounts(eventGoalRows,eventGoalsById,eventGoalsByName);addEventCounts(eventAssistRows,eventAssistsById,eventAssistsByName);addEventCounts(eventYellowRows,eventYellowById,eventYellowByName);addEventCounts(eventRedRows,eventRedById,eventRedByName);
    const rawRows=pitchUnwrapList(cache.body,["players"]),rowsByPlayer=new Map();
    const rowPlayerInfo=line=>{const p=line&&(line.player||line.person)||{};return {p,name:p.name||p.full_name||p.short_name||line&&line.player_name||"",id:String(p.id||p.player_id||line&&line.player_id||line&&line.playerId||""),teamId:String(line&& (line.team_id||line.team&&line.team.id)||"")}};
    for(const line of rawRows){const info=rowPlayerInfo(line);if(!info.name&&!info.id)continue;const key=(pitchNorm(info.name)||info.id)+"|"+info.teamId;const old=rowsByPlayer.get(key);if(!old){rowsByPlayer.set(key,{...line});continue;}for(const [field,keys] of Object.entries({goals:["goals","goal","goals_scored","scored"],assists:["assists","assist","goal_assists","assists_made"],minutes:["minutes_played","minutes"],rating:["rating","average_rating","rating_title"],yellow_cards:["yellow_cards","yellow_card","yellow"],red_cards:["red_cards","red_card","red"],shots:["total_shots","shots"],shotsOnTarget:["shots_on_target"],passes:["total_passes","passes"],accuratePasses:["accurate_passes"],tackles:["tackles"],interceptions:["interceptions"],saves:["saves"]})){const a=pitchMetricValue(old,keys),b=pitchMetricValue(line,keys);if(b!=null&&(a==null||Number(b)>Number(a)))old[field]=b;}}
    const appendEventPlayers=(eventList,field)=>{for(const eventPlayer of eventList){const pid=String(eventPlayer.id||""),pname=String(eventPlayer.name||"");if(!pid&&!pname)continue;const nameKey=pitchNorm(pname),teamId=String(eventPlayer.teamId||"");const existing=[...rowsByPlayer.entries()].find(([,line])=>{const info=rowPlayerInfo(line);return (pid&&info.id===pid)||(nameKey&&pitchNorm(info.name)===nameKey&&(!teamId||!info.teamId||teamId===info.teamId))});if(existing)continue;const key=(nameKey||pid)+"|"+teamId;rowsByPlayer.set(key,{player:{id:pid||key,name:pname},team_id:teamId,[field]:1});}};
    appendEventPlayers(eventGoalRows,"goals");appendEventPlayers(eventAssistRows,"assists");appendEventPlayers(eventYellowRows,"yellow_cards");appendEventPlayers(eventRedRows,"red_cards");
    const rows=[...rowsByPlayer.values()],players=[];
    let startingIds=new Set(),startingNames=new Set(),lineupKnown=false;
    try{
      const lineupCache=await cached("pitch:team-player-lineups:v7:"+id,async()=>({body:await pitchApiJSON(env,"/v1/matches/"+encodeURIComponent(id)+"/lineups"),ttl:300}));
      const root=lineupCache.body&&lineupCache.body.data||lineupCache.body||{},raw=root.lineups||root;
      const getSide=value=>Array.isArray(value)?{starters:value}:value||{};
      const getStarters=value=>{const obj=getSide(value);for(const key of ["starters","startXI","start_xi","starting_xi","startingXI","starting_players"])if(Array.isArray(obj[key]))return obj[key];return []};
      const homeSide=getSide(raw.home||raw.home_team||raw.homeTeam),awaySide=getSide(raw.away||raw.away_team||raw.awayTeam);
      const candidates=[{side:homeSide,team:home},{side:awaySide,team:away}];
      const selectedSide=candidates.find(x=>String(x.team.id||x.team.team_id||"")===String(side.id||"")||pitchTeamNameMatches(teamName,x.team.name))||candidates.find(x=>x===candidates[isHome?0:1]);
      const starters=getStarters(selectedSide&&selectedSide.side);
      if(starters.length){
        lineupKnown=true;
        for(const item of starters){
          const p=item&& (item.player||item.person)||item||{},pid=String(p.id||p.player_id||item&&item.player_id||""),pname=p.name||p.full_name||p.short_name||item&&item.player_name||"";
          if(pid)startingIds.add(pid);if(pname)startingNames.add(pitchNorm(pname));
          // Players endpointinde eksik bırakılmış bir ilk 11 oyuncusunu da kadro
          // kaydından tamamla; dakika/puan alanı boş olsa bile forma giydiği kesindir.
          if(pname){
            const alreadyPresent=[...rowsByPlayer.values()].some(line=>{const info=rowPlayerInfo(line);return (pid&&info.id===pid)||(pitchNorm(info.name)===pitchNorm(pname)&&(!info.teamId||!side.id||info.teamId===String(side.id)))});
            if(!alreadyPresent){const position=p.position&&typeof p.position==="object"?(p.position.short_name||p.position.name||""):p.position||p.position_name||"";const key=pitchNorm(pname)+"|"+String(side.id||"");rowsByPlayer.set(key,{player:{id:pid||key,name:pname,image_url:p.image_url||p.photo||"",position},team_id:String(side.id||""),is_starting:true});}
          }
        }
      }
    }catch(_){}
    const seenPlayerInMatch=new Set();
    for(const line of rows){const tid=String(line&&line.team_id||line&&line.team&&line.team.id||""),tn=line&&line.team&&line.team.name||"";const other=isHome?away:home;const isOther=(tid&&other.id&&tid===String(other.id))||(tn&&other.name&&pitchTeamNameMatches(other.name,tn));const p=line&&(line.player||line.person)||{};const pname=p.name||p.full_name||p.short_name||line&&line.player_name||"";if(!pname)continue;const playerId=String(p.id||p.player_id||line.player_id||line.playerId||pname);const inSelectedLineup=startingIds.has(playerId)||startingNames.has(pitchNorm(pname));const noTeamIdentity=!tid&&!tn;const matchesSelected=(tid&&side.id&&tid===String(side.id))||(tn&&pitchTeamNameMatches(teamName,tn))||(tn&&side.name&&pitchTeamNameMatches(side.name,tn))||(noTeamIdentity&&inSelectedLineup);if(isOther||!matchesSelected)continue;const val=keys=>pitchMetricValue(line,keys);const matchIdentity=pitchNorm(pname)||playerId;if(seenPlayerInMatch.has(matchIdentity))continue;seenPlayerInMatch.add(matchIdentity);const isStarter=lineupKnown?(startingIds.has(playerId)||startingNames.has(pitchNorm(pname))?1:0):null;
      // Bazı maçlarda aynı futbolcu olay akışında farklı ID ile, oyuncu
      // istatistik satırında başka ID ile gelir. İsim eşleşmesini de kontrol et;
      // ID tarafındaki eksik/az sayıdaki kayıt ismi gölgelememeli.
      const playerNameKey=pitchNorm(pname);
      const eventGoalCount=Math.max(eventGoalsById.get(playerId)||0,eventGoalsByName.get(playerNameKey)||0);
      const eventAssistCount=Math.max(eventAssistsById.get(playerId)||0,eventAssistsByName.get(playerNameKey)||0);
      const eventYellowCount=Math.max(eventYellowById.get(playerId)||0,eventYellowByName.get(playerNameKey)||0);
      const eventRedCount=Math.max(eventRedById.get(playerId)||0,eventRedByName.get(playerNameKey)||0);
      const playerGoals=val(["goals","goal","goals_scored","scored"]),playerAssists=val(["assists","assist","goal_assists","assists_made"]);
      const minutes=val(["minutes_played","minutes"]),rating=val(["rating","average_rating","rating_title"]);
      const yellowCards=val(["yellow_cards","yellow_card","yellow"]),redCards=val(["red_cards","red_card","red"]);
      const shots=val(["total_shots","shots"])||0,shotsOnTarget=val(["shots_on_target"])||0,passes=val(["total_passes","passes"])||0,accuratePasses=val(["accurate_passes"])||0,tackles=val(["tackles"])||0,interceptions=val(["interceptions"])||0,saves=val(["saves"])||0;
      const goals=Math.max(Number(playerGoals)||0,eventGoalCount),assists=Math.max(Number(playerAssists)||0,eventAssistCount),yellow=Math.max(Number(yellowCards)||0,eventYellowCount),red=Math.max(Number(redCards)||0,eventRedCount);
      const appeared=isStarter===1||(minutes!=null&&Number(minutes)>0)||(rating!=null&&Number(rating)>0)||[goals,assists,yellow,red,shots,shotsOnTarget,passes,accuratePasses,tackles,interceptions,saves].some(v=>Number(v)>0);
      // Players API can include unused substitutes. Count an appearance only when the player
      // started, played minutes, received a rating or has a match contribution/event.
      if(!appeared)continue;
      players.push({id:playerId,name:pname,photo:p.image_url||p.photo||p.photo_url||line.image_url||line.photo||"",position:p.position||p.position_name||line.position||line.position_name||"",apps:1,starts:isStarter,goals,assists,minutes,rating,shots,shotsOnTarget,passes,accuratePasses,tackles,interceptions,saves,yellowCards:yellow,redCards:red});
    }team.penaltyGoals=penaltyGoals;team.penaltyEventsKnownMatches=penaltyEventsKnown?1:0;return {team,players};
  });
  const team={matches:0,wins:0,draws:0,losses:0,goalsFor:0,goalsAgainst:0,points:0,cleanSheets:0,penaltyGoals:0,penaltyEventsKnownMatches:0,penaltyEventsAllKnown:false},players=new Map();let failedMatches=0;
  for(const item of settled){if(item.status!=="fulfilled"){failedMatches++;continue}const v=item.value;if(!v)continue;for(const k of Object.keys(team))team[k]+=Number(v.team[k])||0;for(const p of v.players){const id=pitchNorm(p.name)||String(p.id||p.name);if(!players.has(id))players.set(id,{...p,apps:0,starts:0,startsKnown:true,goals:0,assists:0,minutes:0,minutesKnown:true,ratingTotal:0,ratingCount:0,shots:0,shotsOnTarget:0,passes:0,accuratePasses:0,tackles:0,interceptions:0,saves:0,yellowCards:0,redCards:0});const r=players.get(id);r.apps++;if(p.starts==null)r.startsKnown=false;else if(r.startsKnown)r.starts+=Number(p.starts)||0;for(const k of ["goals","assists","shots","shotsOnTarget","passes","accuratePasses","tackles","interceptions","saves","yellowCards","redCards"])r[k]+=Number(p[k])||0;if(p.minutes==null)r.minutesKnown=false;else r.minutes+=Number(p.minutes)||0;if(p.rating!=null){r.ratingTotal+=Number(p.rating);r.ratingCount++}}}
  const nextOffset=offset+batch.length;team.penaltyEventsAllKnown=team.matches>0&&team.penaltyEventsKnownMatches===team.matches;return {league:league.name,season:league.season,totalMatches:matches.length,offset,nextOffset,done:nextOffset>=matches.length,team,players:[...players.values()].map(row=>({...row,starts:row.startsKnown?row.starts:null})),failedMatches};
}

// ---------- PitchAPI ultra maç merkezi ve lig fikstürü ----------
const PITCH_MATCH_CACHE_VERSION = "v66-team-event-identity-stats";
function pitchMatchStatus(status) {
  const raw = status && typeof status === "object" ? (status.short || status.long || status.name || status.status || "") : status;
  const s = pitchNorm(raw).replace(/\s+/g, "_");
  // Scheduled states must be checked first: "Not Started" contains the word "started".
  if (/^(ns|not_started|notstarted|not_yet_started|scheduled|upcoming|pending|fixture|pre_match|prematch|pre_game|pregame|timed|to_be_played|yet_to_start|not_begun|tbd)$/.test(s)) return "NS";
  if (/^(ht|half_time|halftime|half_time_break|interval)$/.test(s)) return "HT";
  if (/^(bt|break|break_time|between_halves)$/.test(s)) return "BT";
  if (/^(1h|first_half|1st_half|firsthalf|in_progress|inprogress|in_play|inplay|playing|live|started)$/.test(s)) return "1H";
  if (/^(2h|second_half|2nd_half|secondhalf)$/.test(s)) return "2H";
  if (/^(et|extra_time|extra_time_first_half|extra_time_second_half|extratime)$/.test(s)) return "ET";
  if (/^(p|penalties|penalty_shootout|penaltyshootout|shootout|in_penalties)$/.test(s)) return "P";
  if (/^(ft|full_time|fulltime|finished|ended|completed|after_extra_time|after_extra|aet|after_penalties)$/.test(s)) return s === "after_penalties" ? "PEN" : s === "aet" || s.includes("extra") ? "AET" : "FT";
  if (/^(pen|pen|after_penalty_shootout|penalties_finished)$/.test(s)) return "PEN";
  if (/^(awd|awarded)$/.test(s)) return "AWD";
  if (/^(wo|walkover)$/.test(s)) return "WO";
  if (/^(pst|postponed)$/.test(s)) return "PST";
  if (/^(canc|cancelled|canceled)$/.test(s)) return "CANC";
  if (/^(susp|suspended)$/.test(s)) return "SUSP";
  if (/^(int|interrupted)$/.test(s)) return "INT";
  if (/^(abd|abandoned)$/.test(s)) return "ABD";
  return "NS";
}
function pitchPositionShort(id) {
  // PitchAPI's substitute position_id is a category: 0 GK, 1 DF, 2 MF, 3 FW.
  // A starter's position_id is a formation slot and must never be decoded as a role.
  return ({ 0:"GK", 1:"DF", 2:"MF", 3:"FW" })[Number(id)] || "";
}
function pitchDateString(match) {
  const value = match && (match.time_utc || match.date || match.kickoff || match.start_time) || "";
  if (!value) return "";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value).slice(0,10) : d.toISOString().slice(0,10);
}
function pitchDateDistance(a, b) {
  if (!a || !b) return 99;
  const x = Date.parse(a + "T12:00:00Z"), y = Date.parse(b + "T12:00:00Z");
  return Number.isFinite(x) && Number.isFinite(y) ? Math.abs(Math.round((x-y)/86400000)) : 99;
}
function pitchFixtureScore(fixture, date, home, away) {
  const h = fixture && fixture.home_team || {}, a = fixture && fixture.away_team || {};
  const direct = pitchTeamNameMatches(home, h.name) && pitchTeamNameMatches(away, a.name);
  const reverse = pitchTeamNameMatches(home, a.name) && pitchTeamNameMatches(away, h.name);
  if (!direct && !reverse) return -1;
  const day = pitchDateString(fixture), diff = pitchDateDistance(date, day);
  if (diff > 1) return -1;
  return (direct ? 100 : 80) - diff * 20;
}
async function pitchLeagueMatches(env, leagueId, season, status="all") {
  const key = "pitch:league-matches:" + PITCH_MATCH_CACHE_VERSION + ":" + leagueId + ":" + season + ":" + status;
  const result = await cached(key, async () => ({
    body: await pitchApiJSON(env, "/v1/leagues/" + encodeURIComponent(leagueId) + "/matches?" + new URLSearchParams({ season, status })),
    ttl: status === "all" ? 300 : 300,
  }));
  return pitchUnwrapList(result.body, ["matches"]).map(match => {
    if (match.matchday != null) return match;
    const raw = match.round_number ?? match.matchday_number ?? match.round ?? match.round_name ?? (match.league && match.league.round) ?? "";
    const text = String(raw || "").trim();
    const found = text.match(/(?:matchday|gameweek|week|hafta|round)\D*(\d+)|(?:regular season|league stage)\s*[-–:]\s*(\d+)|^(\d+)$/i);
    const number = found ? Number(found[1] || found[2] || found[3]) : null;
    return number ? { ...match, matchday:number } : match;
  });
}

async function pitchPlayerRecentBatch(env, playerId, playerName, teamName, code, year, requestedLimit=36) {
  const league = await pitchLeagueForCode(env, code, year);
  const all = await pitchLeagueMatches(env, league.id, league.season, "played");
  const relevant = all.filter(match => {
    if (!teamName) return true;
    const home = match && match.home_team || {}, away = match && match.away_team || {};
    return pitchTeamNameMatches(teamName, home.name) || pitchTeamNameMatches(teamName, away.name);
  }).sort((a, b) => String(pitchDateString(b)).localeCompare(String(pitchDateString(a)))).slice(0, Math.max(13, Math.min(60, Number(requestedLimit)||60)));
  const settled = await pitchAllSettledLimit(relevant, 8, async match => {
    const matchId = String(match && (match.id || match.match_id) || "");
    if (!matchId) return null;
    const result = await cached("pitch:player-recent-lines:v3:" + matchId, async () => ({
      body: await pitchApiJSON(env, "/v1/matches/" + encodeURIComponent(matchId) + "/players"), ttl: 900,
    }));
    const rows = pitchUnwrapList(result.body, ["players"]);
    const home = match.home_team || {}, away = match.away_team || {};
    const candidates = rows.map(row => {
      const player = row && (row.player || row.person) || {};
      const rowTeamId = String(row && (row.team_id || row.team && (row.team.id || row.team.team_id)) || "");
      const rowTeam = String(row && row.team && row.team.name || (rowTeamId && String(home.id || "") === rowTeamId ? home.name : rowTeamId && String(away.id || "") === rowTeamId ? away.name : row && row.team_name || ""));
      const ids = [player.id, player.player_id, row && row.player_id, row && row.playerId].filter(v => v != null).map(String);
      const names = [player.name, player.full_name, player.short_name, row && row.player_name].filter(Boolean);
      const byId = /^p_[A-Za-z0-9]+$/.test(String(playerId || "")) && ids.includes(String(playerId));
      const byName = playerName && names.some(name => pitchPlayerNameMatches(playerName, name));
      if (!byId && !byName) return null;
      if (teamName && rowTeam && !pitchTeamNameMatches(teamName, rowTeam)) return null;
      const exact = names.some(name => pitchNorm(name) === pitchNorm(playerName)) ? 1 : 0;
      return { row, player, rowTeam, rowTeamId, exact, byId };
    }).filter(Boolean).sort((a, b) => Number(b.byId) - Number(a.byId) || b.exact - a.exact);
    const found = candidates[0];
    if (!found) return null;
    const row = found.row, player = found.player;
    const rowTeam = found.rowTeam || teamName || "";
    const isHome = (found.rowTeamId && home.id && String(home.id) === found.rowTeamId) || (rowTeam && home.name && pitchTeamNameMatches(rowTeam, home.name));
    const photo = String(player.image_url || player.photo || row.image_url || "");
    const scoreHomeRaw = match.score_home ?? (match.score && match.score.home);
    const scoreAwayRaw = match.score_away ?? (match.score && match.score.away);
    const scoreHome = scoreHomeRaw == null || scoreHomeRaw === "" ? null : Number(scoreHomeRaw);
    const scoreAway = scoreAwayRaw == null || scoreAwayRaw === "" ? null : Number(scoreAwayRaw);
    const val = keys => pitchMetricValue(row, keys);
    return {
      id: matchId, date: pitchDateString(match), league: league.name, leagueCode: code,
      home: { name: home.name || "", logo: home.image_url || home.logo || "" },
      away: { name: away.name || "", logo: away.image_url || away.logo || "" },
      scoreHome: Number.isFinite(scoreHome) ? scoreHome : null,
      scoreAway: Number.isFinite(scoreAway) ? scoreAway : null,
      player: { id: String(player.id || player.player_id || row.player_id || ""), name: player.name || player.full_name || player.short_name || playerName, photo: /^https:\/\//i.test(photo) ? photo : "" },
      team: rowTeam, teamLogo: isHome ? (home.image_url || home.logo || "") : (away.image_url || away.logo || ""),
      opponent: isHome ? (away.name || "") : (home.name || ""), isHome: !!isHome,
      rating: val(["rating", "rating_title", "average_rating"]),
      minutes: val(["minutes", "minutes_played"]), goals: val(["goals"]), assists: val(["assists"]),
      source: "PitchAPI",
    };
  });
  const allPlayerMatches = settled.filter(item => item.status === "fulfilled" && item.value).map(item => item.value)
    .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
  const matches = allPlayerMatches.slice(0, 13);
  const rated = allPlayerMatches.filter(item => item.rating != null && Number.isFinite(Number(item.rating)));
  const seasonStats = {
    matches: allPlayerMatches.length,
    goals: allPlayerMatches.reduce((sum, item) => sum + (Number(item.goals) || 0), 0),
    assists: allPlayerMatches.reduce((sum, item) => sum + (Number(item.assists) || 0), 0),
    totalMinutes: allPlayerMatches.some(item => item.minutes == null) ? null : allPlayerMatches.reduce((sum, item) => sum + (Number(item.minutes) || 0), 0),
    averageRating: rated.length ? Number((rated.reduce((sum, item) => sum + Number(item.rating), 0) / rated.length).toFixed(2)) : null,
    ratingMatches: rated.length,
  };
  const current = allPlayerMatches[0] || null;
  return { playerId: String(playerId || (current && current.player && current.player.id) || ""), playerName, team: teamName || (current && current.team) || "", teamLogo: current && current.teamLogo || "", league: league.name, season: league.season, matches, seasonStats,
    failedMatches: settled.filter(item => item.status === "rejected").length };
}
function pitchH2HExtract(raw) {
  let value = raw;
  for (let i = 0; i < 4 && value; i++) {
    if (value.data != null) { value = value.data; continue; }
    if (value.h2h != null) { value = value.h2h; continue; }
    break;
  }
  return value || {};
}
function pitchH2HRows(raw) {
  const value = pitchH2HExtract(raw);
  if (Array.isArray(value)) return value;
  for (const key of ["recent_matches", "matches", "fixtures", "results", "items"]) if (Array.isArray(value[key])) return value[key];
  return [];
}
function pitchH2HHasRecords(value) {
  if (!value || typeof value !== "object") return false;
  const summary = pitchH2HExtract(value);
  if (Number(summary.total_matches) > 0 || Number(summary.home_wins) + Number(summary.draws) + Number(summary.away_wins) > 0) return true;
  return pitchH2HRows(summary).some(row => {
    const score = row && (row.score || row.scores || row.result) || {};
    const home = row && (row.score_home ?? row.home_score ?? score.home ?? score.home_score);
    const away = row && (row.score_away ?? row.away_score ?? score.away ?? score.away_score);
    return home != null && home !== "" && away != null && away !== "" && Number.isFinite(Number(home)) && Number.isFinite(Number(away));
  });
}
function pitchH2HSummaryFromRows(rows, homeName, awayName) {
  let homeWins = 0, draws = 0, awayWins = 0;
  const norm = pitchNorm;
  const relevant = (rows || []).filter(row => row && (row.finished === true || row.status && /finished|full.?time|ft|aet|pen/i.test(String(row.status)) || row.score_home != null && row.score_away != null));
  for (const row of relevant) {
    const score = row.score || row.scores || row.result || {};
    const sh = Number(row.score_home ?? row.home_score ?? score.home ?? score.home_score);
    const sa = Number(row.score_away ?? row.away_score ?? score.away ?? score.away_score);
    if (!Number.isFinite(sh) || !Number.isFinite(sa)) continue;
    const hn = row.home && row.home.name || row.home_team && row.home_team.name || row.homeTeam && row.homeTeam.name || "";
    const an = row.away && row.away.name || row.away_team && row.away_team.name || row.awayTeam && row.awayTeam.name || "";
    if (sh === sa) draws++;
    else if ((norm(hn) === norm(homeName) && sh > sa) || (norm(an) === norm(homeName) && sa > sh)) homeWins++;
    else if ((norm(hn) === norm(awayName) && sh > sa) || (norm(an) === norm(awayName) && sa > sh)) awayWins++;
  }
  return { home_wins: homeWins, draws, away_wins: awayWins, total_matches: relevant.length, recent_matches: relevant };
}
function pitchSameTeamsInMatch(match, home, away) {
  const mh = match && match.home_team || {}, ma = match && match.away_team || {};
  const same = (a, b) => !!(a && b && ((a.id && b.id && String(a.id) === String(b.id)) || pitchTeamNameMatches(a.name || a, b.name || b)));
  return (same(mh, home) && same(ma, away)) || (same(mh, away) && same(ma, home));
}
async function pitchH2HFallback(env, bundle, code) {
  const detail = bundle.detail || {}, fixture = bundle.fixture || {};
  const home = detail.home_team || fixture.home_team || {}, away = detail.away_team || fixture.away_team || {};
  if (!home.name || !away.name) return null;
  const leagueId = String(detail.league && detail.league.id || fixture.league && fixture.league.id || "");
  const season = String(detail.season || fixture.season || "");
  // First use all completed fixtures already catalogued for this competition.
  if (leagueId && season) {
    try {
      let seasonList = [season];
      if (code) {
        try {
          const info = await pitchLeagueInfoForCode(env, code);
          const currentYear = String(season).match(/(?:19|20)\d{2}/);
          const currentIndex = info.seasons.findIndex(value => String(value) === String(season) || currentYear && String(value).startsWith(currentYear[0] + "/"));
          const earlier = currentIndex >= 0 ? info.seasons.slice(currentIndex + 1, currentIndex + 5) : [];
          seasonList = [...seasonList, ...earlier];
        } catch (_) {}
      }
      const pages = await Promise.allSettled(seasonList.map(y => pitchLeagueMatches(env, leagueId, y, "played")));
      const all = pages.flatMap(result => result.status === "fulfilled" ? result.value : []);
      const seen = new Set();
      const unique = all.filter(m => { const id=String(m&& (m.id||m.match_id) || ""); const date=String(m&& (m.time_utc||m.date) || ""); const teams=[m&&m.home_team&&m.home_team.name,m&&m.away_team&&m.away_team.name].map(pitchNorm).join("|"); const score=String(m&&m.score_home)+"-"+String(m&&m.score_away); const key=id?"id:"+id:"row:"+date+"|"+teams+"|"+score; if(seen.has(key))return false;seen.add(key);return true; });
      const rows = unique.filter(m => pitchSameTeamsInMatch(m, home, away)).sort((a,b) => String(b.time_utc || b.date || "").localeCompare(String(a.time_utc || a.date || ""))).slice(0,12).map(m => ({
        time_utc: m.time_utc || m.date || "", home: {id:String(m.home_team && m.home_team.id || ""),name:m.home_team && m.home_team.name || ""},
        away: {id:String(m.away_team && m.away_team.id || ""),name:m.away_team && m.away_team.name || ""},
        score_home:m.score_home ?? null, score_away:m.score_away ?? null, finished:true,
      }));
      if (rows.length) return pitchH2HSummaryFromRows(rows, home.name, away.name);
    } catch (_) {}
  }
  // If API-Football is also connected, it can supply cross-competition history.
  if (apiFootballKey(env)) {
    try {
      const [afHome, afAway] = await Promise.all([resolveApiFootballTeam(env, home.name), resolveApiFootballTeam(env, away.name)]);
      if (afHome && afAway && afHome.id !== afAway.id) {
        const result = await cached("pitch:h2h:api-football:v3:" + afHome.id + "-" + afAway.id, async () => ({
          body: await apiFootballJSON(env, "/fixtures/headtohead", { h2h: afHome.id + "-" + afAway.id, last: "12" }), ttl: 86400,
        }));
        const rows = (result.body && result.body.response || []).map(item => {
          const goals = item.goals || {}, full = item.score && item.score.fulltime || {};
          const status = item.fixture && item.fixture.status && item.fixture.status.short || "";
          return {time_utc:item.fixture && item.fixture.date || "",home:{id:String(item.teams && item.teams.home && item.teams.home.id || ""),name:item.teams && item.teams.home && item.teams.home.name || ""},away:{id:String(item.teams && item.teams.away && item.teams.away.id || ""),name:item.teams && item.teams.away && item.teams.away.name || ""},score_home:full.home ?? goals.home ?? null,score_away:full.away ?? goals.away ?? null,finished:["FT","AET","PEN"].includes(status)};
        }).filter(item => item.finished && item.score_home != null && item.score_away != null);
        if (rows.length) return pitchH2HSummaryFromRows(rows, home.name, away.name);
      }
    } catch (_) {}
  }
  return null;
}
async function pitchH2HByNamesInLeague(env, code, seasonHint, homeName, awayName) {
  const normalizedCode = canonicalPitchLeagueCode(code);
  if (!normalizedCode || !homeName || !awayName || !pitchApiKey(env)) return null;
  const cacheKey = "pitch:h2h:names:v1:" + normalizedCode + ":" + String(seasonHint || "") + ":" + pitchNorm(homeName) + ":" + pitchNorm(awayName);
  const cachedResult = await cached(cacheKey, async () => {
    const info = await pitchLeagueInfoForCode(env, normalizedCode);
    let seasons = info.seasons.slice();
    const hint = String(seasonHint || "").match(/(?:19|20)\d{2}/);
    if (hint) {
      const index = seasons.findIndex(value => value === String(seasonHint) || value.startsWith(hint[0]));
      if (index >= 0) seasons = seasons.slice(index);
    }
    seasons = seasons.slice(0, 5);
    if (!seasons.length) return { body: null, ttl: 600 };
    const requests = await Promise.allSettled(seasons.map(season => pitchLeagueMatches(env, info.id, season, "played")));
    const all = requests.flatMap(item => item.status === "fulfilled" ? item.value : []);
    const seen = new Set();
    const unique = all.filter(match => { const id=String(match&& (match.id||match.match_id) || ""); const date=String(match&& (match.time_utc||match.date) || ""); const teams=[match&&match.home_team&&match.home_team.name,match&&match.away_team&&match.away_team.name].map(pitchNorm).join("|"); const score=String(match&&match.score_home)+"-"+String(match&&match.score_away); const key=id?"id:"+id:"row:"+date+"|"+teams+"|"+score; if(seen.has(key))return false;seen.add(key);return true; });
    const wantedHome = { name: homeName }, wantedAway = { name: awayName };
    const rows = unique.filter(match => pitchSameTeamsInMatch(match, wantedHome, wantedAway))
      .filter(match => match && match.score_home != null && match.score_away != null)
      .sort((a,b) => String(b.time_utc || b.date || "").localeCompare(String(a.time_utc || a.date || "")))
      .slice(0, 20)
      .map(match => ({
        time_utc: match.time_utc || match.date || "",
        home: { id: String(match.home_team && match.home_team.id || ""), name: match.home_team && match.home_team.name || "" },
        away: { id: String(match.away_team && match.away_team.id || ""), name: match.away_team && match.away_team.name || "" },
        score_home: match.score_home, score_away: match.score_away, finished: true,
      }));
    return { body: rows.length ? pitchH2HSummaryFromRows(rows, homeName, awayName) : null, ttl: rows.length ? 21600 : 600 };
  });
  return cachedResult.body || null;
}
function pitchLineupStarters(side) {
  if (!side) return [];
  if (Array.isArray(side)) return side;
  for (const key of ["starters", "startXI", "start_xi", "starting_xi", "startingXI", "starting_players"]) if (Array.isArray(side[key])) return side[key];
  return [];
}
function pitchLineupSideForTeam(raw, team) {
  if (!raw || !team) return null;
  const sideRows = Array.isArray(raw)
    ? raw
    : [raw.home || raw.home_team_lineup || raw.homeTeam || null,
       raw.away || raw.away_team_lineup || raw.awayTeam || null].filter(Boolean);
  const sideId = side => String(side && (side.team_id || side.teamId || side.team && (side.team.id || side.team.team_id) || side.team_id) || "");
  for (const side of sideRows) {
    const sideTeam = side && side.team || {};
    const id = sideId(side) || String(sideTeam.id || "");
    const name = sideTeam.name || side.team_name || side.name || "";
    if ((team.id && id && String(team.id) === id) || (team.name && name && pitchTeamNameMatches(team.name, name))) return side;
  }
  // Some PitchAPI wrappers put only the canonical home/away team objects beside
  // the lineup data. Keep the side-key fallback, but never choose a side by array order.
  const home = raw.home || raw.home_team_lineup || raw.homeTeam || null;
  const away = raw.away || raw.away_team_lineup || raw.awayTeam || null;
  const homeMeta = raw.home_team || {}, awayMeta = raw.away_team || {};
  const matches = (side, meta) => {
    if (!side) return false;
    const id = sideId(side) || String(meta.id || "");
    const name = side.team && side.team.name || side.team_name || meta.name || "";
    return !!((team.id && id && String(team.id) === id) || (team.name && name && pitchTeamNameMatches(team.name, name)));
  };
  if (matches(home, homeMeta)) return home;
  if (matches(away, awayMeta)) return away;
  return null;
}
async function apiFootballPreviousLineupForTeam(env, team, beforeDate) {
  if (!apiFootballKey(env) || !team || !team.name) return null;
  try {
    const resolved = await resolveApiFootballTeam(env, team.name);
    if (!resolved || !resolved.id) return null;
    const fixturesResult = await cached("pitch:previous-af-fixtures:v2:" + resolved.id, async () => ({
      body: await apiFootballJSON(env, "/fixtures", { team: String(resolved.id), last: "8" }), ttl: 3600,
    }));
    const fixtures = fixturesResult.body && fixturesResult.body.response || [];
    const cutoff = Date.parse(beforeDate || "");
    const prior = fixtures.filter(item => {
      const date = Date.parse(item && item.fixture && item.fixture.date || "");
      return !!(item && item.fixture && item.fixture.id) && (!Number.isFinite(cutoff) || !Number.isFinite(date) || date < cutoff);
    }).sort((a,b) => String(b.fixture.date || "").localeCompare(String(a.fixture.date || "")));
    for (const fixture of prior.slice(0,5)) {
      const fixtureId = String(fixture.fixture.id);
      try {
        const result = await cached("pitch:previous-af-lineup:v2:" + fixtureId, async () => ({
          body: await apiFootballJSON(env, "/fixtures/lineups", { fixture: fixtureId }), ttl: 86400,
        }));
        const response = result.body && result.body.response || [];
        const found = response.find(item => {
          const sourceTeam = item && item.team || {};
          return String(sourceTeam.id || "") === String(resolved.id) || pitchTeamNameMatches(team.name, sourceTeam.name);
        });
        if (!found || !Array.isArray(found.startXI) || found.startXI.length < 8) continue;
        const convert = row => {
          const p = row && (row.player || row) || {};
          return { player_id:String(p.id || p.player_id || ""), name:p.name || p.full_name || "", shirt_number:p.number ?? p.shirt_number ?? null, position:p.pos || p.position || "", is_captain:!!(p.isCaptain || p.is_captain) };
        };
        return {
          team_id:String(found.team && found.team.id || resolved.id), team:{id:String(found.team && found.team.id || resolved.id),name:found.team && found.team.name || resolved.name},
          formation:found.formation || "", coach:found.coach || null,
          starters:found.startXI.map(convert), subs:(found.substitutes || []).map(convert),
          confirmed:false, lineup_type:"Son oynanan maçın ilk 11'i referans alındı",
        };
      } catch (_) {}
    }
  } catch (_) {}
  return null;
}

async function pitchPreviousLineupForTeam(env, leagueId, season, team, beforeDate, excludeMatchId, code="") {
  if (!team || !(team.id || team.name)) return null;
  const seasons = [season].filter(Boolean);
  // Yeni sezonda henüz kendi liginde oynamamış ekipler için, aynı PitchAPI liginin
  // önceki sezonlarını da tarar. Takım kimliği korunuyorsa son gerçek 11 bulunabilir.
  if (code) {
    try {
      const info = await pitchLeagueInfoForCode(env, code);
      const active = info.seasons.findIndex(value => String(value) === String(season));
      if (active >= 0) seasons.push(...info.seasons.slice(active + 1, active + 4));
    } catch (_) {}
  }
  const matchSets = await Promise.allSettled(seasons.map(y => pitchLeagueMatches(env, leagueId, y, "played")));
  const matches = matchSets.flatMap(result => result.status === "fulfilled" ? result.value : []);
  const targetTime = Date.parse(beforeDate || "");
  const candidates = matches.filter(match => {
    const id = String(match && (match.id || match.match_id) || "");
    if (!id || id === String(excludeMatchId || "")) return false;
    const date = Date.parse(match.time_utc || match.date || "");
    if (Number.isFinite(targetTime) && Number.isFinite(date) && date >= targetTime) return false;
    const h = match.home_team || {}, a = match.away_team || {};
    return (team.id && (String(h.id || "") === String(team.id) || String(a.id || "") === String(team.id))) || pitchTeamNameMatches(team.name, h.name) || pitchTeamNameMatches(team.name, a.name);
  }).sort((a,b) => String(b.time_utc || b.date || "").localeCompare(String(a.time_utc || a.date || "")));
  const pool = new Map();
  let latestSide = null, matchCount = 0;
  const playerTokens = player => {
    const p = player && (player.player || player) || {};
    const id = String(p.player_id || p.id || "");
    const name = pitchNorm(p.name || p.player_name || p.full_name || "");
    return [id && "id:" + id, name && "name:" + name].filter(Boolean);
  };
  for (const match of candidates.slice(0, 6)) {
    const id = String(match.id || match.match_id);
    try {
      const cachedLineup = await cached("pitch:previous-lineup:v3:" + id, async () => ({ body: await pitchApiJSON(env, "/v1/matches/" + encodeURIComponent(id) + "/lineups"), ttl: 86400 }));
      const root = cachedLineup.body && (cachedLineup.body.data || cachedLineup.body) || {};
      const raw = root.lineups || root;
      const side = pitchLineupSideForTeam(raw, team);
      const starters = pitchLineupStarters(side);
      if (!side || starters.length < 8) continue;
      if (!latestSide) latestSide = side;
      matchCount++;
      for (const player of starters) {
        const keys = playerTokens(player);
        if (!keys.length) continue;
        let found = [...keys].map(key => pool.get(key)).find(Boolean);
        if (found) { found.count++; for (const key of keys) pool.set(key, found); continue; }
        found = { player, count:1, order:pool.size };
        for (const key of keys) pool.set(key, found);
      }
      const unique = [...new Set(pool.values())];
      if (unique.length >= 11) break;
    } catch (_) {}
  }
  let referencePlayers = [...new Set(pool.values())].sort((a,b)=>b.count-a.count||a.order-b.order).map(item=>item.player).slice(0,11);
  let referenceSide = latestSide && referencePlayers.length >= 8 ? { ...latestSide, starters:referencePlayers } : null;
  if (referencePlayers.length < 11) {
    const afSide = await apiFootballPreviousLineupForTeam(env, team, beforeDate);
    if (afSide) {
      const merged = referencePlayers.slice(), seen = new Set(merged.flatMap(playerTokens));
      for (const player of pitchLineupStarters(afSide)) {
        if (merged.length >= 11) break;
        const keys = playerTokens(player);
        if (keys.some(key=>seen.has(key))) continue;
        merged.push(player);for(const key of keys)seen.add(key);
      }
      if (merged.length > referencePlayers.length) {
        referencePlayers = merged.slice(0,11);
        referenceSide = { ...(referenceSide || afSide), starters:referencePlayers };
      }
    }
  }
  if (referenceSide) {
    const oneMatchComplete = matchCount === 1 && pitchLineupStarters(latestSide).length >= 11;
    return { ...referenceSide, starters:referencePlayers, confirmed:false,
      lineup_type:oneMatchComplete ? "Son oynanan maçın ilk 11'i referans alındı" : "Son maçlardaki ilk 11'lerden oluşturulmuş tahmini referans kadro" };
  }
  return null;
}
async function pitchFillUpcomingLineups(env, bundle, code) {
  const detail = bundle.detail || {}, fixture = bundle.fixture || {};
  if (pitchMatchStatus(detail.status || fixture.status) !== "NS") return;
  const response = bundle.lineups || {};
  const root = response.data || response;
  const raw = root.lineups || root;
  const home = detail.home_team || fixture.home_team || {}, away = detail.away_team || fixture.away_team || {};
  let homeSide = raw.home || raw.home_team_lineup || raw.homeTeam || null;
  let awaySide = raw.away || raw.away_team_lineup || raw.awayTeam || null;
  const complete = side => pitchLineupStarters(side).length >= 11;
  if (complete(homeSide) && complete(awaySide)) return;
  const leagueId = String(detail.league && detail.league.id || fixture.league && fixture.league.id || "");
  const season = String(detail.season || fixture.season || "");
  const date = detail.time_utc || fixture.time_utc || fixture.date || "";
  const id = String(detail.id || fixture.id || "");
  const mergeReference = (current, reference) => {
    if (!reference) return current;
    const currentPlayers = pitchLineupStarters(current);
    const referencePlayers = pitchLineupStarters(reference);
    if (!currentPlayers.length) return { ...reference, confirmed:false, lineup_type:reference.lineup_type || "Son oynanan maçın ilk 11'i referans alındı" };
    const tokens = player => {
      const p = player && (player.player || player) || {};
      const id = String(p.player_id || p.id || "");
      const name = pitchNorm(p.name || p.player_name || p.full_name || "");
      return [id && "id:" + id, name && "name:" + name].filter(Boolean);
    };
    const merged = currentPlayers.slice();
    const seen = new Set(merged.flatMap(tokens));
    for (const player of referencePlayers) {
      if (merged.length >= 11) break;
      const keys = tokens(player);
      if (keys.some(key => seen.has(key))) continue;
      merged.push(player);
      for (const key of keys) seen.add(key);
    }
    return {
      ...reference, ...current,
      starters:merged.slice(0,11), startXI:merged.slice(0,11),
      substitutes:Array.isArray(current.substitutes) ? current.substitutes : (Array.isArray(reference.substitutes) ? reference.substitutes : []),
      confirmed:false,
      lineup_type:currentPlayers.length >= 11 ? (current.lineup_type || "PitchAPI tahmini 11") : "PitchAPI tahmini + son kadro referansı",
    };
  };
  const jobs = [];
  if (!complete(homeSide)) jobs.push(pitchPreviousLineupForTeam(env, leagueId, season, home, date, id, code).then(side => { if (side) { homeSide = mergeReference(homeSide, side); raw.home = homeSide; } }));
  if (!complete(awaySide)) jobs.push(pitchPreviousLineupForTeam(env, leagueId, season, away, date, id, code).then(side => { if (side) { awaySide = mergeReference(awaySide, side); raw.away = awaySide; } }));
  await Promise.allSettled(jobs);
  bundle.lineups = raw;
}

function pitchAppFixture(item, code, leagueName, season) {
  const h = item.home_team || {}, a = item.away_team || {};
  const date = item.time_utc || item.date || "";
  const id = String(item.id || item.match_id || "");
  return {
    fixture: { id: "p:" + id, date, status: { short: pitchMatchStatus(item.status), elapsed: item.minute || null }, venue: item.stadium ? { name: item.stadium } : null, referee: item.referee || "" },
    league: { id: item.league && item.league.id || "", name: item.league && item.league.name || leagueName, code, season: Number(String(season).slice(0,4)) || null, round: item.round_name || item.round || item.matchday || "" },
    teams: {
      home: { id: String(h.id || ""), name: h.name || "Ev Sahibi", raw: h.name || "", logo: h.image_url || h.logo || "" },
      away: { id: String(a.id || ""), name: a.name || "Deplasman", raw: a.name || "", logo: a.image_url || a.logo || "" },
    },
    goals: { home: item.score_home == null ? null : Number(item.score_home), away: item.score_away == null ? null : Number(item.score_away) },
    events: [], lineups: [], statistics: [], referee: item.referee || "", pitchId: id, pitchSource: "PitchAPI",
  };
}
function pitchNormalizeLineupPosition(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const upper = raw.toUpperCase().replace(/[.\s_-]+/g, "");
  const short = { GK:"GK", G:"GK", GOALIE:"GK", KEEPER:"GK", D:"DF", DF:"DF", DEF:"DF", M:"MF", MF:"MF", MID:"MF", F:"FW", FW:"FW", FWD:"FW", RB:"RB", LB:"LB", RWB:"RWB", LWB:"LWB", RCB:"RCB", LCB:"LCB", CB:"CB", SW:"SW", CDM:"CDM", DM:"DM", RDM:"RDM", LDM:"LDM", CM:"CM", RCM:"RCM", LCM:"LCM", CAM:"CAM", AM:"AM", RAM:"RAM", LAM:"LAM", RM:"RM", LM:"LM", RW:"RW", LW:"LW", RWF:"RWF", LWF:"LWF", ST:"ST", CF:"CF", RCF:"RCF", LCF:"LCF", SS:"SS" };
  if (short[upper]) return short[upper];
  // For starters, numeric position_id is a formation slot, never a role code.
  if (/^[-+]?\d+(?:\.\d+)?$/.test(raw)) return "";
  const n = pitchNorm(raw).replace(/\s+/g, " ");
  const aliases = {
    "goalkeeper":"GK", "goal keeper":"GK", "goalie":"GK", "keeper":"GK", "kaleci":"GK", "right back":"RB", "rightback":"RB", "left back":"LB", "leftback":"LB",
    "right wing back":"RWB", "left wing back":"LWB", "right centre back":"RCB", "right center back":"RCB", "left centre back":"LCB", "left center back":"LCB",
    "centre back":"CB", "center back":"CB", "central defender":"CB", "defender":"DF", "sweeper":"SW",
    "defensive midfielder":"DM", "central defensive midfielder":"CDM", "right defensive midfielder":"RDM", "left defensive midfielder":"LDM",
    "central midfielder":"CM", "right central midfielder":"RCM", "left central midfielder":"LCM", "attacking midfielder":"AM",
    "right attacking midfielder":"RAM", "left attacking midfielder":"LAM", "right midfielder":"RM", "left midfielder":"LM", "midfielder":"MF",
    "right winger":"RW", "left winger":"LW", "right wing":"RW", "left wing":"LW", "right forward":"RCF", "left forward":"LCF",
    "centre forward":"CF", "center forward":"CF", "striker":"ST", "second striker":"SS", "forward":"FW", "attacker":"FW"
  };
  return aliases[n] || raw;
}
function pitchLineupSide(side, team) {
  if (!side) return null;
  const convert = (entry, index, isSubstitute) => {
    const p = entry && entry.player && typeof entry.player === "object" ? { ...entry, ...entry.player } : (entry || {});
    const rawPosition = p.position || p.position_name || p.positionName || "";
    const explicitPositionRaw = typeof rawPosition === "object"
      ? (rawPosition.short_name || rawPosition.shortName || rawPosition.name || rawPosition.label || "")
      : rawPosition;
    const explicitPosition = pitchNormalizeLineupPosition(explicitPositionRaw);
    // PitchAPI uses position_id as a formation slot for starters. It is a category only for substitutes.
    const substitutePosition = ({ 0: "GK", 1: "DF", 2: "MF", 3: "FW" })[Number(p.position_id)] || "";
    const rawPitchX = !isSubstitute && p.pitch_x != null && p.pitch_x !== "" && Number.isFinite(Number(p.pitch_x)) ? Number(p.pitch_x) : null;
    const rawPitchY = !isSubstitute && p.pitch_y != null && p.pitch_y !== "" && Number.isFinite(Number(p.pitch_y)) ? Number(p.pitch_y) : null;
    // PitchAPI lineup docs use 0/0 when a coordinate is unavailable (also for subs).
    // Treat a starter's paired 0/0 as missing; otherwise an unlocated player can be
    // mistaken for the goalkeeper and shift every other role one line.
    const missingCoordinatePair = rawPitchX === 0 && rawPitchY === 0;
    const pitchX = missingCoordinatePair ? null : rawPitchX;
    const pitchY = missingCoordinatePair ? null : rawPitchY;
    return { player: {
      id: String(p.player_id || p.id || ""),
      pitchId: String(p.player_id || p.id || ""),
      name: p.name || p.short_name || p.shortName || "",
      logo: /^https:\/\//i.test(String(p.image_url || p.photo || "")) ? String(p.image_url || p.photo) : "",
      photo: /^https:\/\//i.test(String(p.image_url || p.photo || "")) ? String(p.image_url || p.photo) : "",
      image_url: /^https:\/\//i.test(String(p.image_url || p.photo || "")) ? String(p.image_url || p.photo) : "",
      number: p.shirt_number == null ? (p.number == null ? null : p.number) : p.shirt_number,
      pos: String(explicitPosition || (isSubstitute ? substitutePosition : (p.is_goalkeeper === true || p.is_goalkeeper === 1 ? "GK" : ""))),
      posSource: explicitPosition ? "PitchAPI maç kadrosu mevki" : (isSubstitute && substitutePosition ? "PitchAPI yedek mevki kategorisi" : ""),
      place: index + 1,
      pitchX,
      pitchY,
      formationGridId: !isSubstitute && p.position_id != null ? Number(p.position_id) : null,
      captain: !!(p.is_captain || p.captain),
    }};
  };
  const starters = Array.isArray(side.starters) ? side.starters : Array.isArray(side.startXI) ? side.startXI : Array.isArray(side.starting_xi) ? side.starting_xi : Array.isArray(side.startingXI) ? side.startingXI : Array.isArray(side.starting_players) ? side.starting_players : [];
  const substitutes = Array.isArray(side.subs) ? side.subs : Array.isArray(side.substitutes) ? side.substitutes : Array.isArray(side.bench) ? side.bench : [];
  const coach = side.coach && typeof side.coach === "object" ? side.coach : null;
  return {
    team: { id: String(team && team.id || side.team_id || ""), name: team && team.name || side.team && side.team.name || "", logo: team && (team.image_url || team.logo) || side.team && (side.team.image_url || side.team.logo) || "" },
    formation: side.formation || side.formation_name || "",
    coach: coach && (coach.name || coach.full_name) ? { name: coach.name || coach.full_name, id: coach.id || coach.coach_id || null, photo: coach.image_url || coach.photo || coach.image || "" } : null,
    confirmed: side.confirmed === true,
    lineupType: side.lineup_type || "",
    startXI: starters.map((p, i) => convert(p, i, false)),
    substitutes: substitutes.map((p, i) => convert(p, i, true)),
  };
}
function pitchEventToApp(event, teams) {
  const raw = String(event && (event.event_type || event.type) || ""), n = pitchNorm(raw);
  let type = "other", detail = raw;
  if (n.includes("goal") || n.includes("penalty") && n.includes("miss")) { type = "Goal"; detail = event.is_own_goal ? "Own Goal" : event.is_penalty ? "Penalty" : raw; }
  else if (n.includes("yellow") || n.includes("red") || n.includes("card")) { type = "Card"; detail = /second/.test(n) ? "Second Yellow" : n.includes("red") ? "Red Card" : "Yellow Card"; }
  else if (n.includes("substitution") || n.includes("sub")) { type = "subst"; detail = "Substitution"; }
  else if (n.includes("var")) { type = "var"; }
  const teamId = String(event && (event.team_id || event.team && event.team.id) || "");
  const team = teams.find(t => String(t.id) === teamId) || null;
  const p = event && (event.player || event.scorer || event.person) || {};
  const playerName = p && (p.name || p.full_name || p.short_name) || event && (event.player_name || event.scorer_name) || "";
  const playerId = p && (p.id || p.player_id) || event && (event.player_id || event.scorer_id) || "";
  const sub = event && (event.sub_in_player || event.player_in || event.assist_player) || {};
  const incomingName = sub && (sub.name || sub.full_name) || event && (event.sub_in_player_name || event.player_in_name || event.assist_name) || "";
  return {
    eventId: String(event && (event.id || event.event_id || event.uuid) || ""),
    eventSourceType: raw,
    type, detail, team: team ? { id: team.id, name: team.name } : (event && event.team && typeof event.team === "object" ? { id: String(event.team.id || teamId), name: event.team.name || event.team_name || "" } : { id: teamId, name: event && event.team_name || "" }),
    player: playerName ? { id: playerId, name: String(playerName) } : null,
    player_id: String(playerId || ""), player_name: String(playerName || ""),
    assist: incomingName ? { id: sub && (sub.id || sub.player_id) || "", name: String(incomingName) } : event && event.assist && event.assist.name ? event.assist : null,
    time: { elapsed: event.minute == null ? (event.elapsed == null ? null : event.elapsed) : event.minute, extra: event.minute_added || event.added_time || 0 },
    score: { home: event.score_home == null ? null : event.score_home, away: event.score_away == null ? null : event.score_away },
  };
}
function pitchStatsToApp(stats, teams) {
  const periods = Array.isArray(stats && stats.periods) ? stats.periods : [];
  const all = periods.find(p => pitchNorm(p.period) === "all") || periods[0];
  const groups = Array.isArray(all && all.groups) ? all.groups : [];
  const values = [];
  for (const group of groups) for (const item of (Array.isArray(group.items) ? group.items : [])) {
    if (!item || !item.title) continue;
    values.push({ title: item.title, key: item.key || "", home: item.home == null ? null : item.home, away: item.away == null ? null : item.away, format_type: item.format_type || "" });
  }
  return teams.map((team, index) => ({ team: { id: String(team.id || ""), name: team.name || "" }, statistics: values.map(x => ({ type: x.title, key: x.key, value: index ? x.away : x.home, format_type: x.format_type })) }));
}
function pitchRatingTeamKey(value) {
  const aliases = { munich:"munchen", munchen:"munchen", cologne:"koln", koln:"koln", milan:"milano", roma:"roma" };
  const ignored = new Set(["fc","cf","sc","ac","afc","sv","fk","sk","if","bk","cd","club","football","futbol","calcio","the","de","1"]);
  return pitchNorm(value).split(/\s+/).filter(token=>token&&!ignored.has(token)).map(token=>aliases[token]||token).sort().join(" ");
}
function pitchRatingTeamMatches(a,b) {
  const x=pitchRatingTeamKey(a), y=pitchRatingTeamKey(b);
  return !!x&&!!y&&(x===y||x.includes(y)||y.includes(x));
}
async function pitchApiFootballRatingsForMatch(env, detail, fixture) {
  if (!apiFootballKey(env)) return [];
  const home=detail&&detail.home_team||fixture&&fixture.home_team||{}, away=detail&&detail.away_team||fixture&&fixture.away_team||{};
  const homeName=String(home.name||""), awayName=String(away.name||"");
  const date=String(detail&& (detail.time_utc||detail.date) || fixture&& (fixture.time_utc||fixture.date) || "");
  const day=date.slice(0,10);
  if(!homeName||!awayName||!/^\d{4}-\d{2}-\d{2}$/.test(day))return [];
  const status=pitchMatchStatus(detail&&detail.status||fixture&&fixture.status);
  if(!["1H","HT","2H","ET","P","FT","AET","PEN"].includes(status))return [];
  const fixtureList=await cached("af:match-rating-fixtures:v2:"+day,async()=>({body:await apiFootballPaged(env,"/fixtures",{date:day,timezone:"UTC"},8),ttl:3600}));
  const rows=fixtureList.body&&fixtureList.body.response||[];
  const target=Date.parse(date);
  const candidates=rows.map(item=>{
    const h=item&&item.teams&&item.teams.home||{},a=item&&item.teams&&item.teams.away||{};
    const direct=pitchRatingTeamMatches(homeName,h.name)&&pitchRatingTeamMatches(awayName,a.name);
    const reverse=pitchRatingTeamMatches(homeName,a.name)&&pitchRatingTeamMatches(awayName,h.name);
    if(!direct&&!reverse)return null;
    const fixtureDate=Date.parse(item&&item.fixture&&item.fixture.date||"");
    const delta=Number.isFinite(target)&&Number.isFinite(fixtureDate)?Math.abs(target-fixtureDate):Infinity;
    if(delta>18*3600e3)return null;
    return {item,direct,delta};
  }).filter(Boolean).sort((a,b)=>(a.delta-b.delta)||(Number(b.direct)-Number(a.direct)));
  const picked=candidates[0]&&candidates[0].item;
  const afId=String(picked&&picked.fixture&&picked.fixture.id||"");
  if(!/^\d+$/.test(afId))return [];
  const live=["1H","HT","2H","ET","P"].includes(status);
  const result=await cached("af:match-player-ratings:v2:"+afId,async()=>({body:await apiFootballJSON(env,"/fixtures/players",{fixture:afId}),ttl:live?45:21600}));
  const response=result.body&&result.body.response||[];
  const output=[];
  for(const side of response){
    const team=side&&side.team||{};
    for(const row of side&&Array.isArray(side.players)?side.players:[]){
      const player=row&&row.player||{};
      const stats=Array.isArray(row&&row.statistics)?row.statistics:[];
      let rating=null;
      for(const item of stats){
        const games=item&&item.games||{};
        const raw=games.rating??item.rating??row.rating;
        if(raw!=null&&raw!==""){const n=Number(raw);if(Number.isFinite(n)){rating=n;break;}}
      }
      if(rating==null&&!player.photo&&!stats.length)continue;
      output.push({id:String(player.id||""),name:String(player.name||""),teamId:String(team.id||""),teamName:String(team.name||""),photo:String(player.photo||""),rating,statistics:stats,position:stats[0]&&stats[0].games&&stats[0].games.position||""});
    }
  }
  return output;
}
function pitchApiFootballStatsToGroups(statistics) {
  if(!Array.isArray(statistics))return [];
  const aliases={
    games:{minutes:"minutes_played",rating:"rating"},offsides:{total:"offsides"},
    shots:{total:"total_shots",on:"shots_on_target",inside:"shots_inside_box",outside:"shots_outside_box"},
    goals:{total:"goals",assists:"assists",saves:"saves",conceded:"goals_conceded"},
    passes:{total:"total_passes",key:"key_passes",accuracy:"pass_accuracy"},
    tackles:{total:"total_tackles",blocks:"blocks",interceptions:"interceptions"},
    duels:{total:"total_duels",won:"duels_won"},
    dribbles:{attempts:"dribbles_attempted",success:"successful_dribbles",past:"dribbled_past"},
    fouls:{drawn:"fouls_drawn",committed:"fouls_committed"},cards:{yellow:"yellow_cards",red:"red_cards"},
    penalty:{scored:"penalty_goals",missed:"penalties_missed",saved:"penalties_saved",committed:"penalties_committed",won:"penalties_won"}
  };
  const groups=[];
  for(const item of statistics){
    const source=item&&typeof item==="object"?item:{};
    for(const [groupKey,map] of Object.entries(aliases)){
      const sourceGroup=source[groupKey];if(!sourceGroup||typeof sourceGroup!=="object")continue;
      const fields={};
      for(const [field,key] of Object.entries(map)){
        const raw=sourceGroup[field];if(raw==null||raw==="")continue;
        const value=Number(raw);if(!Number.isFinite(value))continue;
        fields[key]={key,stat:{type:Number.isInteger(value)?"integer":"double",value}};
      }
      if(Object.keys(fields).length)groups.push({key:groupKey,stats:fields});
    }
  }
  return groups;
}
function pitchApiFootballPlayerFor(rows, player, team) {
  if(!Array.isArray(rows)||!player||!player.name)return null;
  const playerName=player.name, teamName=team&&team.name||"";
  const candidates=rows.filter(row=>pitchPlayerNameMatches(playerName,row.name)&&(!teamName||!row.teamName||pitchRatingTeamMatches(teamName,row.teamName)));
  if(candidates.length===1)return candidates[0];
  const exact=candidates.filter(row=>pitchNorm(row.name)===pitchNorm(playerName));
  return exact.length===1?exact[0]:null;
}
function pitchApiFootballRatingForPlayer(rows, player, team) {
  const found=pitchApiFootballPlayerFor(rows,player,team);
  return found&&found.rating!=null?found.rating:null;
}
function pitchCalculatedPlayerRating(item, allowSparse = false) {
  if (!item) return null;
  const source = item.raw || item;
  const get = keys => pitchMetricValue(source, keys);
  const stats = {
    minutes: get(["minutes", "minutes_played"]),
    goals: get(["goals", "goal"]),
    assists: get(["assists", "goal_assist"]),
    xg: get(["expected_goals", "xg"]),
    xa: get(["expected_assists", "xa"]),
    xgxa: get(["xg_and_xa", "expected_goals_assists"]),
    totalShots: get(["total_shots", "shots"]),
    shotsOnTarget: get(["shots_on_target", "ontarget_scoring_att"]),
    keyPasses: get(["key_passes", "keypasses"]),
    chances: get(["chances_created", "big_chances_created"]),
    successfulDribbles: get(["successful_dribbles", "dribbles_won"]),
    tackles: get(["tackles", "won_tackle"]),
    interceptions: get(["interceptions", "interception"]),
    clearances: get(["clearances", "total_clearances"]),
    blocks: get(["blocks", "blocked_shots"]),
    recoveries: get(["recoveries", "ball_recoveries"]),
    duelsWon: get(["duels_won", "ground_duels_won"]),
    aerialsWon: get(["aerials_won", "aerial_duels_won"]),
    saves: get(["saves", "goalkeeper_saves"]),
    goalsConceded: get(["goals_conceded", "goals_against"]),
    yellow: get(["yellow_cards", "yellow_card"]),
    red: get(["red_cards", "red_card"]),
    ownGoals: get(["own_goals", "own_goal"]),
    fouls: get(["fouls", "fouls_committed"]),
    errors: get(["errors_lead_to_goal", "errors_leading_to_goal"]),
    accuratePasses: get(["accurate_passes", "passes_completed"]),
    totalPasses: get(["total_passes", "passes"]),
  };
  const available = Object.entries(stats).filter(([key, value]) => value != null && key !== "totalPasses").length;
  // A minimal match line (minutes/goals/assists only) is not enough to justify a rating.
  // Require at least four independent fields so low-data players remain unrated.
  if (stats.minutes != null && stats.minutes <= 0) return null;
  if (!allowSparse && (available < 4 || stats.minutes != null && stats.minutes < 10)) return null;
  let score = 6.0;
  const add = (key, weight, cap = 20) => { if (stats[key] != null) score += Math.max(-cap, Math.min(cap, stats[key])) * weight; };
  add("goals", 1.05, 3);
  add("assists", 0.72, 3);
  add("xg", 0.34, 2.5);
  add("xa", 0.24, 2.5);
  if (stats.xg == null && stats.xa == null) add("xgxa", 0.28, 4);
  add("totalShots", 0.025, 12);
  add("shotsOnTarget", 0.075, 8);
  add("keyPasses", 0.055, 10);
  add("chances", 0.07, 8);
  add("successfulDribbles", 0.035, 12);
  add("tackles", 0.035, 12);
  add("interceptions", 0.035, 12);
  add("clearances", 0.018, 18);
  add("blocks", 0.04, 10);
  add("recoveries", 0.012, 20);
  add("duelsWon", 0.018, 18);
  add("aerialsWon", 0.02, 12);
  add("saves", 0.085, 12);
  add("goalsConceded", -0.22, 5);
  add("yellow", -0.32, 2);
  add("red", -1.15, 1);
  add("ownGoals", -0.85, 2);
  add("fouls", -0.025, 12);
  add("errors", -0.55, 3);
  if (stats.accuratePasses != null && stats.totalPasses != null && stats.totalPasses > 0) {
    const accuracy = Math.max(0, Math.min(100, stats.accuratePasses / stats.totalPasses * 100));
    score += (accuracy - 75) * 0.008;
  }
  if (stats.minutes != null && stats.minutes >= 75) score += 0.12;
  return Math.round(Math.max(4.0, Math.min(10.0, score)) * 10) / 10;
}
function pitchSkorHaneEventRating(player, events) {
  const wanted=String(player&&player.name||"");
  if(!wanted)return 6.0;
  let score=6.0;
  for(const event of pitchUnwrapList(events, ["events"])){
    const type=pitchNorm(event&& (event.event_type||event.type)||"");
    const detail=pitchNorm(event&& (event.detail||event.description)||"");
    const eventPlayer=event&&event.player&&event.player.name||"";
    const assistPlayer=event&&(event.assist_player&&event.assist_player.name||event.assist&&event.assist.name)||"";
    if(eventPlayer&&pitchPlayerNameMatches(wanted,eventPlayer)){
      if(type.includes("goal")&&!/miss|disallow|cancel/.test(detail))score+=event.is_own_goal||detail.includes("own")?-.9:1.0;
      else if(type.includes("red"))score-=1.15;
      else if(type.includes("yellow")||type.includes("card"))score-=.3;
    }
    if((type.includes("goal")||detail.includes("goal"))&&assistPlayer&&pitchPlayerNameMatches(wanted,assistPlayer))score+=.45;
  }
  return Math.round(Math.max(4.0,Math.min(10.0,score))*10)/10;
}
function pitchSubstituteEntered(player, events) {
  const wanted=String(player&&player.name||"");
  if(!wanted)return false;
  return pitchUnwrapList(events,["events"]).some(event=>{
    const type=pitchNorm(event&&(event.event_type||event.type)||"");
    if(!type.includes("sub"))return false;
    const incoming=event&&(event.sub_in_player&&event.sub_in_player.name||event.assist_player&&event.assist_player.name||event.player_in&&event.player_in.name)||"";
    return !!incoming&&pitchPlayerNameMatches(wanted,incoming);
  });
}
function pitchBuildAppMatch(bundle, code, leagueName, season) {
  const d = bundle.detail || {}, f = bundle.fixture || {};
  const h = d.home_team || f.home_team || {}, a = d.away_team || f.away_team || {};
  const teams = [h, a];
  const lineupResponse = bundle.lineups || {};
  const lineupRoot = lineupResponse.data || lineupResponse;
  const lineupsRaw = lineupRoot.lineups || lineupRoot;
  const lineupPlaceholder = team => ({team:{id:String(team && team.id || ""),name:team && team.name || "",logo:team && (team.image_url || team.logo) || ""},formation:"",coach:null,confirmed:false,lineupType:"Kadro verisi bekleniyor",startXI:[],substitutes:[]});
  const lineups = [pitchLineupSide(pitchLineupSideForTeam(lineupsRaw,h), h) || lineupPlaceholder(h), pitchLineupSide(pitchLineupSideForTeam(lineupsRaw,a), a) || lineupPlaceholder(a)];
  const players = pitchUnwrapList(bundle.players, ["players"]);
  const advancedPlayers = pitchUnwrapList(bundle.advancedPlayers, ["players"]);
  const playerMap = new Map(), playerMapByName = new Map();
  for (const row of players) {
    const p = row && row.player || {};
    const id = String(p.id || p.player_id || row.player_id || "");
    const item = { id, name: p.name || p.full_name || p.short_name || "", logo: p.image_url || p.photo || "", teamId: String(row.team_id || row.team && row.team.id || ""), positionId: p.position_id ?? row.position_id ?? null, rating: pitchMetricValue(row, ["rating", "rating_title", "average_rating"]), ratingSource: null, stats: row.stats || [], raw: row };
    if (item.rating != null) item.ratingSource = "PitchAPI";
    if (id) playerMap.set(id, item);
    if (item.name) playerMapByName.set(pitchNorm(item.name), item);
  }
  for (const row of advancedPlayers) {
    const p = row && row.player || {}, id = String(p.id || p.player_id || ""), name = p.name || p.full_name || "";
    const item = (id && playerMap.get(id)) || (name && playerMapByName.get(pitchNorm(name))) || { id, name, stats: [] };
    item.advanced = row;
    if (item.rating == null) {
      item.rating = pitchMetricValue(row, ["rating", "rating_title", "average_rating"]);
      if (item.rating != null) item.ratingSource = "PitchAPI";
    }
    if (id) playerMap.set(id, item);
    if (item.name) playerMapByName.set(pitchNorm(item.name), item);
  }
  const apiRatings=Array.isArray(bundle.apiFootballRatings)?bundle.apiFootballRatings:[];
  for(const item of playerMap.values()){
    if(item.rating!=null)continue;
    const team=teams.find(t=>String(t&&t.id||"")===String(item.teamId||""))||null;
    item.rating=pitchApiFootballRatingForPlayer(apiRatings,item,team);
    if (item.rating != null) item.ratingSource = "API-Football";
  }
  // Some catalogue competitions carry player stat lines but intentionally no provider rating.
  // Give those players a clearly identified SkorHane estimate rather than leaving a blank or
  // presenting a fabricated value as the provider's official rating.
  for (const item of playerMap.values()) {
    if (item.rating != null) continue;
    const raw=item.raw||item;
    const minutes=pitchMetricValue(raw,["minutes","minutes_played"]);
    const positiveStat=["goals","assists","total_shots","shots","shots_on_target","key_passes","chances_created","successful_dribbles","tackles","interceptions","clearances","blocks","recoveries","duels_won","aerials_won","saves"].some(key=>{const value=pitchMetricValue(raw,[key]);return value!=null&&Number(value)>0;});
    const appeared=(minutes!=null&&Number(minutes)>0)||positiveStat;
    const calculated = appeared ? pitchCalculatedPlayerRating(item, true) : null;
    if (calculated != null) { item.rating = calculated; item.ratingSource = "SkorHane"; }
  }
  const eventRows = pitchUnwrapList(bundle.events, ["events"]).map(ev => pitchEventToApp(ev, teams));
  const statistics = pitchStatsToApp(bundle.stats || {}, teams);
  const playerDetailFor = (player, team) => {
    const id=String(player&&(player.pitchId||player.id||player.player_id)||"");
    if(id&&playerMap.has(id))return playerMap.get(id);
    if(!player||!player.name)return null;
    const candidates=[...playerMap.values()].filter(item=>pitchPlayerNameMatches(player.name,item.name));
    if(!candidates.length)return null;
    const sameTeam=candidates.filter(item=>!item.teamId||!team||!team.id||String(item.teamId)===String(team.id));
    if(sameTeam.length===1)return sameTeam[0];
    if(candidates.length===1)return candidates[0];
    const exact=candidates.filter(item=>pitchNorm(item.name)===pitchNorm(player.name));
    return exact.length===1?exact[0]:null;
  };
  const status = pitchMatchStatus(d.status || f.status);
  const elapsedRaw = d.elapsed ?? d.minute ?? d.minutes ?? f.elapsed ?? f.minute ?? (f.status && typeof f.status === "object" ? f.status.elapsed : null);
  const matchHasStarted=["1H","HT","2H","ET","P","FT","AET","PEN","AWD","WO"].includes(status) || (elapsedRaw != null && Number(elapsedRaw) > 0);
  const estimateLineupPlayer=(player,detail,team,isStarter)=>{
    const apiPlayer=pitchApiFootballPlayerFor(apiRatings,player,team);
    const apiRating=apiPlayer&&apiPlayer.rating!=null?apiPlayer.rating:null;
    let rating=detail&&detail.rating!=null?detail.rating:(player.rating!=null?player.rating:apiRating);
    let ratingSource=detail&&detail.ratingSource||(player.ratingSource||null);
    if(rating==null&&matchHasStarted){
      const entered=isStarter||pitchSubstituteEntered(player,bundle.events);
      if(entered){
        const ratingInput=detail||player;
        const ratingData=ratingInput.raw||ratingInput;
        // A live starting-XI player must not remain unrated just because the feed
        // has not emitted a full stat line yet. Sparse calculation starts at 6.0
        // and adjusts only for observed events/stats; unused substitutes stay blank.
        rating=pitchCalculatedPlayerRating(ratingInput,true);
        if(rating==null)rating=pitchSkorHaneEventRating(player,bundle.events);
        if(rating==null&&entered)rating=6.0;
        if(rating!=null)ratingSource="SkorHane";
      }
    }
    // Starter position_id is a formation-grid slot (e.g. 1, 2, 3, 4), not a role code.
    // API-Football's player statistics can provide a broad Goalkeeper/Defender/Midfielder/Attacker label.
    const roleFromStats=!isStarter&&detail?pitchPositionShort(detail.positionId):"";
    const apiPosition=apiPlayer&&apiPlayer.position?pitchNormalizeLineupPosition(apiPlayer.position):"";
    const pos=player.pos||roleFromStats||apiPosition;
    const posSource=player.posSource||(roleFromStats?"PitchAPI yedek mevki kategorisi":apiPosition?"API-Football genel mevki":"");
    return { ...player, logo: player.logo || detail && detail.logo || apiPlayer && apiPlayer.photo || "", pos, posSource, rating, ratingSource: ratingSource || (apiRating!=null?"API-Football":rating!=null?"SkorHane":null) };
  };
  const lineupsWithRatings = lineups.map(side => ({ ...side,
    startXI: side.startXI.map(x => { const player=x.player||{}; const detail=playerDetailFor(player,side.team); return {player:estimateLineupPlayer(player,detail,side.team,true)}; }),
    substitutes: side.substitutes.map(x => { const player=x.player||{}; const detail=playerDetailFor(player,side.team); return {player:estimateLineupPlayer(player,detail,side.team,false)}; })
  }));
  const defenderRolesByCount={2:["CB","CB"],3:["LCB","CB","RCB"],4:["LB","LCB","RCB","RB"],5:["LWB","LCB","CB","RCB","RWB"]};
  const pitchCoordinate=value=>{
    const n=Number(value);
    if(!Number.isFinite(n))return null;
    const normalized=Math.abs(n)>1.5?n/100:n;
    return normalized>=0&&normalized<=1?normalized:null;
  };
  const pitchAssignFormationRoles=(side,sideIndex)=>{
    const xi=(side.startXI||[]).map(entry=>entry.player||entry);
    if(xi.length!==11)return side;
    const coords=xi.map(player=>({player,x:pitchCoordinate(player.pitchX),y:pitchCoordinate(player.pitchY)}));
    const allCoordinates=coords.every(point=>point.x!=null&&point.y!=null);
    const formation=(String(side.formation||"").match(/\d+/g)||[]).map(Number).filter(n=>n>0);
    const formationValid=formation.reduce((a,b)=>a+b,0)===10;
    const valuesFor=axis=>coords.map(point=>axis==='x'?point.x:point.y).filter(value=>value!=null).sort((a,b)=>a-b);
    const axisAnalysis=axis=>{
      const sorted=coords.map(point=>({player:point.player,value:axis==='x'?point.x:point.y})).filter(point=>point.value!=null).sort((a,b)=>a.value-b.value);
      if(sorted.length!==11)return {axis,score:-1,keeper:null,reverse:false,formationMatch:false};
      const clusters=[];
      for(const point of sorted){const last=clusters[clusters.length-1];if(!last||point.value-last[last.length-1].value>.075)clusters.push([point]);else last.push(point);}
      const sizes=clusters.map(row=>row.length);
      const same=(a,b)=>a.length===b.length&&a.every((n,i)=>n===b[i]);
      const lowKeeperMatch=formationValid&&same(sizes.slice(1),formation);
      const highKeeperMatch=formationValid&&same(sizes.slice(0,-1).reverse(),formation);
      let candidate=null;
      if(lowKeeperMatch)candidate={player:sorted[0].player,edge:sorted[0].value,gap:sorted[1].value-sorted[0].value,reverse:false};
      else if(highKeeperMatch)candidate={player:sorted[10].player,edge:1-sorted[10].value,gap:sorted[10].value-sorted[9].value,reverse:true};
      else{
        const low=sorted[0],next=sorted[1],prev=sorted[9],high=sorted[10];
        const lowCandidate=low.value<=.22?{player:low.player,edge:low.value,gap:next.value-low.value,reverse:false}:null;
        const highCandidate=high.value>=.78?{player:high.player,edge:1-high.value,gap:high.value-prev.value,reverse:true}:null;
        if(lowCandidate&&highCandidate)candidate=lowCandidate.gap>=highCandidate.gap?lowCandidate:highCandidate;
        else candidate=lowCandidate||highCandidate;
      }
      const formationMatch=!!(lowKeeperMatch||highKeeperMatch);
      const endpointScore=candidate?Math.max(0,1-candidate.edge*3)*.2+Math.min(.2,candidate.gap):0;
      const clusterScore=sizes.length>=3&&sizes.length<=6?.05:0;
      return {axis,score:(formationMatch?5:0)+endpointScore+clusterScore,keeper:candidate&&candidate.player||null,reverse:!!(candidate&&candidate.reverse),formationMatch,sizes};
    };
    const xAnalysis=axisAnalysis('x'),yAnalysis=axisAnalysis('y');
    const explicitKeepers=xi.filter(player=>/^(GK|G|GOALKEEPER|GOALIE|KEEPER|KALECI)$/i.test(String(player.pos||"")));
    let keeper=explicitKeepers.length===1?explicitKeepers[0]:null;
    let depthAxis='y';
    if(xAnalysis.formationMatch!==yAnalysis.formationMatch){
      const chosen=xAnalysis.formationMatch?xAnalysis:yAnalysis;
      depthAxis=chosen.axis;keeper=keeper||chosen.keeper||null;
    }else if(keeper&&allCoordinates){
      const k=coords.find(point=>point.player===keeper);
      const dx=Math.min(k.x,1-k.x),dy=Math.min(k.y,1-k.y);
      if(Math.abs(dx-dy)>.035)depthAxis=dx<dy?'x':'y';
      else depthAxis=xAnalysis.score>yAnalysis.score?'x':'y';
    }else{
      const chosen=xAnalysis.score>yAnalysis.score?xAnalysis:yAnalysis;
      depthAxis=chosen.axis||'y';keeper=keeper||chosen.keeper||null;
      if(!keeper&&explicitKeepers.length>1){
        const candidates=explicitKeepers.map(player=>coords.find(point=>point.player===player)).filter(Boolean);
        if(candidates.length){
          const candidate=candidates.sort((a,b)=>{
            const da=depthAxis==='x'?Math.min(a.x,1-a.x):Math.min(a.y,1-a.y);
            const db=depthAxis==='x'?Math.min(b.x,1-b.x):Math.min(b.y,1-b.y);
            return da-db;
          })[0];keeper=candidate.player;
        }
      }
    }
    const depthValue=point=>depthAxis==='x'?point.x:point.y;
    const lateralValue=point=>depthAxis==='x'?point.y:point.x;
    const depthValues=coords.map(depthValue).filter(value=>value!=null);
    const hasCoordinates=allCoordinates&&depthValues.length===11&&Math.max(...depthValues)-Math.min(...depthValues)>=.32;
    if(!keeper&&hasCoordinates){
      const sorted=coords.slice().sort((a,b)=>depthValue(a)-depthValue(b));
      const low=sorted[0],next=sorted[1],prev=sorted[9],high=sorted[10];
      const lowGap=depthValue(low)<=.24?depthValue(next)-depthValue(low):-1;
      const highGap=depthValue(high)>=.76?depthValue(high)-depthValue(prev):-1;
      keeper=(lowGap>=highGap&&lowGap>=0)?low.player:(highGap>=0?high.player:null);
    }
    if(!keeper){side.formationLayoutReliable=false;return side;}
    side.pitchDepthAxis=depthAxis;
    side.pitchOrientationSource='PitchAPI coordinates';
    const keeperPoint=coords.find(point=>point.player===keeper);
    const reverse=!!(hasCoordinates&&keeperPoint&&depthValue(keeperPoint)>.5);
    keeper.pos='GK';
    keeper.posSource=keeper.posSource||'PitchAPI kaleci koordinatı';
    if(!hasCoordinates){side.formationLayoutReliable=false;return side;}
    keeper.formationLine=-1;keeper.formationSlot=0;keeper.formationLineSize=1;keeper.formationLayoutReliable=true;
    const outfield=xi.filter(player=>player!==keeper);
    let counts=formationValid?formation:null;
    if(!counts){
      const ordered=outfield.slice().sort((a,b)=>{
        const av=depthAxis==='x'?pitchCoordinate(a.pitchX):pitchCoordinate(a.pitchY);
        const bv=depthAxis==='x'?pitchCoordinate(b.pitchX):pitchCoordinate(b.pitchY);
        return (av-bv)*(reverse?-1:1);
      });
      const clusters=[];
      for(const player of ordered){
        const depth=depthAxis==='x'?pitchCoordinate(player.pitchX):pitchCoordinate(player.pitchY),last=clusters[clusters.length-1];
        if(!last||Math.abs(depth-(depthAxis==='x'?pitchCoordinate(last[last.length-1].pitchX):pitchCoordinate(last[last.length-1].pitchY)))>.085)clusters.push([player]);
        else last.push(player);
      }
      const inferred=clusters.map(row=>row.length);
      counts=inferred.length>=2&&inferred.length<=5&&inferred.reduce((a,b)=>a+b,0)===10?inferred:null;
    }
    if(!counts){side.formationLayoutReliable=false;return side;}
    const depthOrder=outfield.slice().sort((a,b)=>{
      const av=depthAxis==='x'?pitchCoordinate(a.pitchX):pitchCoordinate(a.pitchY);
      const bv=depthAxis==='x'?pitchCoordinate(b.pitchX):pitchCoordinate(b.pitchY);
      return (av-bv)*(reverse?-1:1);
    });
    const formationKey=formation.join('-');
    const roleTemplates={
      "4-2-3-1":[["LB","LCB","RCB","RB"],["LDM","RDM"],["LW","CAM","RW"],["ST"]],
      "4-3-3":[["LB","LCB","RCB","RB"],["LCM","CM","RCM"],["LW","ST","RW"]],
      "4-4-2":[["LB","LCB","RCB","RB"],["LM","LCM","RCM","RM"],["LCF","RCF"]],
      "4-1-4-1":[["LB","LCB","RCB","RB"],["CDM"],["LM","LCM","RCM","RM"],["ST"]],
      "4-4-1-1":[["LB","LCB","RCB","RB"],["LM","LCM","RCM","RM"],["CAM"],["ST"]],
      "4-2-2-2":[["LB","LCB","RCB","RB"],["LDM","RDM"],["LAM","RAM"],["LCF","RCF"]],
      "4-3-1-2":[["LB","LCB","RCB","RB"],["LCM","CM","RCM"],["CAM"],["LCF","RCF"]],
      "4-3-2-1":[["LB","LCB","RCB","RB"],["LCM","CM","RCM"],["LAM","RAM"],["ST"]],
      "4-5-1":[["LB","LCB","RCB","RB"],["LM","LCM","CM","RCM","RM"],["ST"]],
      "4-1-2-1-2":[["LB","LCB","RCB","RB"],["CDM"],["LCM","RCM"],["CAM"],["LCF","RCF"]],
      "5-3-2":[["LWB","LCB","CB","RCB","RWB"],["LCM","CM","RCM"],["LCF","RCF"]],
      "5-4-1":[["LWB","LCB","CB","RCB","RWB"],["LM","LCM","RCM","RM"],["ST"]],
      "5-2-3":[["LWB","LCB","CB","RCB","RWB"],["LDM","RDM"],["LW","ST","RW"]],
      "3-5-2":[["LCB","CB","RCB"],["LM","LCM","CM","RCM","RM"],["LCF","RCF"]],
      "3-4-3":[["LCB","CB","RCB"],["LM","LCM","RCM","RM"],["LW","ST","RW"]],
      "3-4-2-1":[["LCB","CB","RCB"],["LWB","LCM","RCM","RWB"],["LAM","RAM"],["ST"]],
      "3-4-1-2":[["LCB","CB","RCB"],["LM","LCM","RCM","RM"],["CAM"],["LCF","RCF"]],
      "3-2-4-1":[["LCB","CB","RCB"],["LDM","RDM"],["LM","LAM","RAM","RM"],["ST"]],
      "3-1-4-2":[["LCB","CB","RCB"],["CDM"],["LM","LCM","RCM","RM"],["LCF","RCF"]],
      "4-2-1-3":[["LB","LCB","RCB","RB"],["LDM","RDM"],["CAM"],["LW","ST","RW"]]
    };
    const selectedTemplate=roleTemplates[formationKey]||null;
    const roleForRow=(row,count,rowCount)=>{
      const exact=selectedTemplate&&selectedTemplate[row];if(exact&&exact.length===count)return exact;
      if(row===0)return defenderRolesByCount[count]||Array(count).fill('DF');
      if(row===rowCount-1)return count===1?['ST']:count===2?['LCF','RCF']:count===3?['LW','ST','RW']:Array(count).fill('FW');
      if(count===1)return ['CDM'];if(count===2)return ['LDM','RDM'];if(count===3)return ['LCM','CM','RCM'];if(count===4)return ['LM','LCM','RCM','RM'];if(count===5)return ['LM','LCM','CM','RCM','RM'];return Array(count).fill('MF');
    };
    let offset=0;
    for(let row=0;row<counts.length;row++){
      const count=counts[row];let group=depthOrder.slice(offset,offset+count);offset+=count;if(group.length!==count)break;
      // PitchAPI'nin formation koordinatları takımın kendi formasyonunu tarif eder.
      // Bu nedenle her iki kadroda da küçük lateral değer takımın solu, büyük değer sağıdır.
      // Ev sahibi/deplasman için ekran aynalaması worker'da değil, pitchHTML'de bir kez yapılır.
      group.sort((a,b)=>{
        const av=pitchCoordinate(depthAxis==='x'?a.pitchY:a.pitchX),bv=pitchCoordinate(depthAxis==='x'?b.pitchY:b.pitchX);
        return (av-bv)||Number(a.place||0)-Number(b.place||0);
      });
      const roles=roleForRow(row,count,counts.length);
      group.forEach((player,index)=>{
        const current=String(player.pos||'').toUpperCase();
        const source=String(player.posSource||'');
        const explicitMatchRole=lineupPositionSpecificity(current)===2&&(/PitchAPI maç kadrosu mevki|TheSportsDB maç kadrosu|ESPN maç kadrosu \(Opta\)|API-Football maç kadrosu/i.test(source));
        const sideSpecific=/^(LB|RB|LWB|RWB|LW|RW|LWF|RWF|LM|RM|LCM|RCM|LCB|RCB|LCF|RCF|LDM|RDM|LAM|RAM)$/i;
        // Güvenilir, açık sağ/sol mevki (LB/RB, LW/RW vb.) aynen korunur.
        // Sadece mevkii genel olan oyuncular, PitchAPI çizgi/koordinat sırasıyla atanır.
        const preserveExplicitRole=explicitMatchRole&&lineupPositionSpecificity(current)===2;
        const explicitSlot=preserveExplicitRole?roles.indexOf(current):-1;
        const slot=explicitSlot>=0?explicitSlot:index;
        const observedRole=roles[slot]||(row===0?'DF':row===counts.length-1?'FW':'MF');
        if(observedRole&&!preserveExplicitRole){
          if(current&&!player.originalPosition)player.originalPosition=player.pos;
          player.pos=observedRole;player.posSource='PitchAPI koordinat/mevki eşleştirmesi';
        }
        player.formationLine=row;player.formationSlot=slot;player.formationLineSize=count;player.formationLayoutReliable=true;
      });
    }
    side.formationLayoutReliable=offset===10;
    return side;
  };
  // PitchAPI player positions remain in pitchX/pitchY; do not synthesize role rows here.
  const date = d.time_utc || f.time_utc || f.date || "";
  const detail = d;
  const pitch = {
    id: String(d.id || f.id || ""), lineups: lineupsRaw, players: [...playerMap.values()], stats: bundle.stats || null,
    events: bundle.events || null, h2h: bundle.h2h || null, advanced: bundle.advanced || null,
    network: bundle.network || null, advancedPlayers: bundle.advancedPlayers || null,
    heatmaps: bundle.heatmaps || null, momentum: bundle.momentum || null, shots: bundle.shots || null,
    analyticsChecked: bundle.analyticsChecked === true,
    analyticsAvailable: [bundle.advanced,bundle.network,bundle.heatmaps,bundle.momentum,bundle.shots].some(value => value != null && (typeof value !== "object" || Object.keys(value).length > 0)),
    errors: bundle.errors || {},
  };
  return {
    fixture: { id: "p:" + pitch.id, date, status: { short: status, elapsed: detail.elapsed || detail.minute || null }, venue: (detail.stadium || f.stadium) ? { name: detail.stadium || f.stadium } : null, referee: detail.referee || f.referee || "" },
    league: { id: detail.league && detail.league.id || f.league && f.league.id || "", name: detail.league && detail.league.name || leagueName, code, season: Number(String(season).slice(0,4)) || null, round: detail.round_name || detail.round || f.round_name || "" },
    teams: { home: { id: String(h.id || ""), name: h.name || "Ev Sahibi", raw: h.name || "", logo: h.image_url || h.logo || "" }, away: { id: String(a.id || ""), name: a.name || "Deplasman", raw: a.name || "", logo: a.image_url || a.logo || "" } },
    goals: { home: detail.score_home == null ? (f.score_home == null ? null : Number(f.score_home)) : Number(detail.score_home), away: detail.score_away == null ? (f.score_away == null ? null : Number(f.score_away)) : Number(detail.score_away) },
    referee: detail.referee || f.referee || "", stadium: detail.stadium || f.stadium || "", city: detail.city || "",
    events: eventRows, lineups: lineupsWithRatings.map((side,index)=>pitchAssignFormationRoles(side,index)), statistics, statisticsSource: "PitchAPI", lineupsSource: "PitchAPI",
    pitch, pitchSource: "PitchAPI", broadcasts: [],
  };
}
function pitchExtractLivePlayerRows(payload) {
  const rows=[], seen=new Set();
  const visit=(node,depth=0)=>{
    if(!node||depth>9)return;
    if(Array.isArray(node)){for(const item of node)visit(item,depth+1);return;}
    if(typeof node!=='object')return;
    const player=node.player&&typeof node.player==='object'?node.player:node.person&&typeof node.person==='object'?node.person:null;
    const hasStats=!!(node.stats||node.statistics||node.player_stats||node.playerStats);
    if(player&&hasStats){
      const id=String(player.id||player.player_id||node.player_id||'');
      const name=String(player.name||player.short_name||player.full_name||'');
      const teamId=String(node.team_id||node.team&&node.team.id||'');
      const key=id||pitchNorm(name)+'|'+teamId;
      if(name&&!seen.has(key)){seen.add(key);rows.push({...node,player:{...player},team_id:teamId,stats:node.stats||node.statistics||node.player_stats||node.playerStats});}
    } else if((node.player_id||node.id)&& (node.name||node.player_name) && hasStats){
      const id=String(node.player_id||node.id),name=String(node.name||node.player_name),teamId=String(node.team_id||'');
      const key=id||pitchNorm(name)+'|'+teamId;
      if(!seen.has(key)){seen.add(key);rows.push({...node,player:{id,name,image_url:node.image_url||node.photo||''},team_id:teamId,stats:node.stats||node.statistics||node.player_stats||node.playerStats});}
    }
    for(const [key,value] of Object.entries(node))if(value&&typeof value==='object')visit(value,depth+1);
  };
  visit(payload);
  return rows;
}
function pitchMergeLivePlayerRows(baseRows, livePayload) {
  const rows=Array.isArray(baseRows)?baseRows.slice():[];
  for(const live of pitchExtractLivePlayerRows(livePayload)){
    const lp=live.player||{},id=String(lp.id||lp.player_id||live.player_id||''),name=lp.name||lp.short_name||'';
    let at=rows.findIndex(row=>{
      const p=row&&row.player||{};
      const rowTeam=String(row&& (row.team_id||row.team&&row.team.id)||''), liveTeam=String(live&& (live.team_id||live.team&&live.team.id)||'');
      const sameTeam=!rowTeam||!liveTeam||rowTeam===liveTeam;
      return sameTeam&&((id&&String(p.id||p.player_id||row.player_id||'')===id) || (name&&pitchPlayerNameMatches(name,p.name||p.short_name||p.full_name||'')));
    });
    if(at>=0){
      const old=rows[at],op=old.player||{};
      rows[at]={...old,...live,player:{...op,...lp},stats:live.stats||old.stats||old.statistics};
    }else rows.push(live);
  }
  return rows;
}
async function pitchResolveEspnLineupPhoto(name, team, pos='') {
  if(!name)return '';
  const cacheKey='pitch:espn-lineup-photo:v2:'+pitchNorm(name)+':'+pitchNorm(team)+':'+pitchNorm(pos);
  const result=await cached(cacheKey,async()=>{
    try{
      const queries=[...new Set([String(name).trim(),nkp(name)].filter(q=>q&&q.length>=3))];
      const settled=await Promise.allSettled(queries.map(query=>getJSON('https://site.web.api.espn.com/apis/common/v3/search?'+new URLSearchParams({query,limit:'15',type:'player'}))));
      const items=settled.flatMap(x=>x.status==='fulfilled'?(x.value.items||x.value.results||[]):[]);
      const candidates=items.map(x=>({id:String(x.id||(x.athlete&&x.athlete.id)||''),name:x.displayName||x.name||x.fullName||'',team:x.team&&(x.team.displayName||x.team.name)||x.teamName||'',position:x.position&&(x.position.displayName||x.position.name)||'',headshot:(x.headshot&&(x.headshot.href||x.headshot.default))||''})).filter(x=>x.id&&x.headshot);
      const picked=selectPlayerCandidate(candidates,name,team,pos);
      const photo=picked&&/^https:\/\//i.test(picked.headshot)?picked.headshot:'';
      return {body:photo,ttl:photo?604800:21600};
    }catch(_){return {body:'',ttl:3600};}
  });
  return result&&/^https:\/\//i.test(String(result.body||''))?result.body:'';
}
async function pitchEnrichLineupPhotos(env, match, apiRows=[], leagueCode='', seasonYear=0) {
  const sides=match&&match.lineups||[];
  const orderedEntries=[];
  for(const side of sides)for(const entry of side.startXI||[])orderedEntries.push({entry,side,isStarter:true});
  for(const side of sides)for(const entry of side.substitutes||[])orderedEntries.push({entry,side,isStarter:false});
  const targets=[];
  for(const item of orderedEntries){
    const player=item.entry.player||item.entry;
    if(/^https:\/\//i.test(String(player.logo||player.photo||player.image_url||'')))continue;
    const af=pitchApiFootballPlayerFor(apiRows,player,item.side.team||{});
    if(af&&/^https:\/\//i.test(String(af.photo||''))){player.logo=af.photo;player.photo=af.photo;player.image_url=af.photo;player.photoSource='API-Football';continue;}
    if(item.isStarter&&(player.pitchId||player.id||player.name))targets.push({...item,player});
  }
  // First recover the player's own PitchAPI profile image. Keep concurrency bounded to protect quota.
  let cursor=0;
  const profileWorkers=Array.from({length:Math.min(10,targets.length)},async()=>{
    while(cursor<targets.length){
      const item=targets[cursor++],player=item.player;
      const photo=await pitchPlayerPhotoFromProfile(env,player.pitchId||player.id||'');
      if(photo){player.logo=photo;player.photo=photo;player.image_url=photo;player.photoSource='PitchAPI';}
    }
  });
  if(profileWorkers.length)await Promise.allSettled(profileWorkers);

  // Profile photos are absent for some leagues/players. First build one shared photo map
  // per team from recent PitchAPI match-player rows instead of repeating the same season scan
  // for every single starter/substitute.
  const unresolved=targets.filter(item=>!/^https:\/\//i.test(String(item.player.logo||item.player.photo||item.player.image_url||'')));
  const teamEntries=[];
  for(const item of unresolved){
    const team=item.side.team||{},key=String(team.id||team.name||'');
    if(key&&!teamEntries.some(entry=>entry.key===key))teamEntries.push({key,team});
  }
  const rosterMaps=new Map();
  const rosterResults=await Promise.allSettled(teamEntries.map(async entry=>({key:entry.key,map:await pitchTeamRosterPhotoMap(env,entry.team.name||'',leagueCode,seasonYear)})));
  for(const result of rosterResults)if(result.status==='fulfilled'&&result.value)rosterMaps.set(result.value.key,result.value.map||{});
  for(const item of unresolved){
    const team=item.side.team||{},map=rosterMaps.get(String(team.id||team.name||''))||{};
    const wanted=pitchNorm(item.player.name||'');
    let photo=map[wanted]||'';
    if(!photo&&wanted){
      const match=Object.entries(map).find(([name])=>pitchPlayerNameMatches(item.player.name,name));
      if(match)photo=match[1];
    }
    if(/^https:\/\//i.test(String(photo||''))){item.player.logo=photo;item.player.photo=photo;item.player.image_url=photo;item.player.photoSource='PitchAPI geçmiş maçları';}
  }

  // For a remaining starter without a roster portrait, inspect recent lineups to recover
  // a stable PitchAPI player ID; use ESPN only after club/name verification.
  const stillMissing=targets.filter(item=>!/^https:\/\//i.test(String(item.player.logo||item.player.photo||item.player.image_url||'')));
  const starterMissing=stillMissing.filter(item=>item.isStarter);
  cursor=0;
  const resolveWorkers=Array.from({length:Math.min(4,starterMissing.length)},async()=>{
    while(cursor<starterMissing.length){
      const item=starterMissing[cursor++],player=item.player,team=item.side.team||{};
      const photo=await pitchResolvePlayerPhoto(env,player.pitchId||player.id||'',player.name||'',team.name||'',leagueCode,seasonYear);
      if(photo){player.logo=photo;player.photo=photo;player.image_url=photo;player.photoSource='PitchAPI geçmiş kadro';}
    }
  });
  if(resolveWorkers.length)await Promise.race([Promise.allSettled(resolveWorkers),new Promise(resolve=>setTimeout(resolve,6000))]);

  const stillMissingAfterPitch=targets.filter(item=>!/^https:\/\//i.test(String(item.player.logo||item.player.photo||item.player.image_url||'')));
  cursor=0;
  const espnWorkers=Array.from({length:Math.min(4,stillMissingAfterPitch.length)},async()=>{
    while(cursor<stillMissingAfterPitch.length){
      const item=stillMissingAfterPitch[cursor++],player=item.player,team=item.side.team||{};
      const photo=await pitchResolveEspnLineupPhoto(player.name||'',team.name||'',player.pos||'');
      if(photo){player.logo=photo;player.photo=photo;player.image_url=photo;player.photoSource='ESPN';}
    }
  });
  if(espnWorkers.length)await Promise.race([Promise.allSettled(espnWorkers),new Promise(resolve=>setTimeout(resolve,6000))]);
  return match;
}

function pitchMergeLiveSummary(detail, livePayload) {
  if(!livePayload||typeof livePayload!=="object")return detail;
  let live=livePayload;
  for(let i=0;i<4;i++){
    if(live&&live.data&&typeof live.data==="object"){live=live.data;continue;}
    if(live&&live.match&&typeof live.match==="object"){live=live.match;continue;}
    break;
  }
  const score=live.score&&typeof live.score==="object"?live.score:live.scores&&typeof live.scores==="object"?live.scores:{};
  const time=live.time&&typeof live.time==="object"?live.time:live.clock&&typeof live.clock==="object"?live.clock:{};
  const status=live.status||live.match_status||live.state||detail.status;
  const elapsed=live.elapsed??live.minute??live.current_minute??live.currentMinute??time.elapsed??time.minute??time.current_minute??detail.elapsed??detail.minute??null;
  const home=live.score_home??live.home_score??live.homeScore??score.home??score.home_score??score.homeScore??detail.score_home;
  const away=live.score_away??live.away_score??live.awayScore??score.away??score.away_score??score.awayScore??detail.score_away;
  return {...detail,status,elapsed,minute:elapsed,score_home:home,score_away:away};
}
async function pitchMatchFastById(env, matchId, code, forceRefresh=false) {
  if (!/^m_[A-Za-z0-9]{6}$/.test(String(matchId || ""))) throw new Error("Geçersiz PitchAPI maç kimliği.");
  const refreshToken = forceRefresh ? ":refresh:" + Math.floor(Date.now() / 30000) : "";
  // The summary carries the authoritative status/score; keep it short-lived so a cached
  // pre-kickoff NS state cannot survive into the live window.
  const detailResult = await cached("pitch:match-summary:" + PITCH_MATCH_CACHE_VERSION + ":" + matchId + refreshToken, async () => ({ body: await pitchApiJSON(env, "/v1/matches/" + encodeURIComponent(matchId)), ttl: 10 }));
  let detail = detailResult.body || {};
  for (let i=0;i<3;i++) {
    if (detail && detail.data && typeof detail.data === "object") { detail = detail.data; continue; }
    if (detail && detail.match && typeof detail.match === "object") { detail = detail.match; continue; }
    break;
  }
  // The live endpoint is also the source of an up-to-date clock and score. Call it once
  // per ten-second cache window for active or kickoff-near fixtures; outside its live
  // window PitchAPI returns live:false and the stored match, so it is safe at the boundary.
  let events=[];
  const matchStatus=pitchMatchStatus(detail.status);
  const terminal=["FT","AET","PEN","AWD","WO","CANC","ABD"].includes(matchStatus);
  const kickoff=Date.parse(detail.time_utc||detail.kickoff||detail.start_time||detail.date||"");
  const nearLive=!terminal&&Number.isFinite(kickoff)&&Date.now()>=kickoff-60*1000&&Date.now()<=kickoff+5*3600*1000;
  const shouldPollLive=["1H","HT","2H","ET","P","SUSP","INT","BT"].includes(matchStatus)||nearLive;
  if(shouldPollLive){
    const livePromise=cached("pitch:match-live:"+PITCH_MATCH_CACHE_VERSION+":"+matchId,async()=>({body:await pitchApiJSON(env,"/v1/matches/"+encodeURIComponent(matchId)+"/live"),ttl:10})).then(x=>x.body).catch(()=>null);
    const livePayload=await Promise.race([livePromise,new Promise(resolve=>setTimeout(()=>resolve(null),450))]);
    if(livePayload){
      detail=pitchMergeLiveSummary(detail,livePayload);
      let liveRoot=livePayload;
      for(let i=0;i<4;i++){if(liveRoot&&liveRoot.data&&typeof liveRoot.data==="object"){liveRoot=liveRoot.data;continue;}if(liveRoot&&liveRoot.match&&typeof liveRoot.match==="object"){liveRoot=liveRoot.match;continue;}break;}
      const rawEvents=pitchUnwrapList(liveRoot,["events","match_events"]);
      const home=detail.home_team||{},away=detail.away_team||{};
      const teams=[{id:String(home.id||""),name:home.name||"Ev Sahibi"},{id:String(away.id||""),name:away.name||"Deplasman"}];
      events=rawEvents.map(event=>pitchEventToApp(event,teams)).filter(Boolean);
    }
  }
  // Dedicated events continue to load independently from the frontend if not in the snapshot.
  const bundle = { detail, fixture: {}, events, lineups: {}, players: [], stats: {}, h2h: null, analyticsChecked: false, errors: {} };
  const leagueName = detail.league && detail.league.name || "";
  const season = detail.season || "";
  const match = pitchBuildAppMatch(bundle, canonicalPitchLeagueCode(code || "") || "", leagueName, season);
  return { match, pitch: match.pitch, source: "PitchAPI hızlı maç özeti" };
}
async function pitchMatchEventsById(env, matchId, forceRefresh=false) {
  if (!/^m_[A-Za-z0-9]{6}$/.test(String(matchId || ""))) throw new Error("Geçersiz PitchAPI maç kimliği.");
  const token=forceRefresh?":refresh:"+Math.floor(Date.now()/30000):"";
  const [detailResult,eventResult]=await Promise.all([
    cached("pitch:match-summary:"+PITCH_MATCH_CACHE_VERSION+":"+matchId+token,async()=>({body:await pitchApiJSON(env,"/v1/matches/"+encodeURIComponent(matchId)),ttl:forceRefresh?10:90})),
    cached("pitch:match-events-only:"+PITCH_MATCH_CACHE_VERSION+":"+matchId+token,async()=>({body:await pitchApiJSON(env,"/v1/matches/"+encodeURIComponent(matchId)+"/events"),ttl:forceRefresh?8:20}))
  ]);
  let detail=detailResult.body||{};
  for(let i=0;i<3;i++){
    if(detail&&detail.data&&typeof detail.data==="object"){detail=detail.data;continue;}
    if(detail&&detail.match&&typeof detail.match==="object"){detail=detail.match;continue;}
    break;
  }
  const home=detail.home_team||{},away=detail.away_team||{};
  const teams=[{id:String(home.id||""),name:home.name||"Ev Sahibi"},{id:String(away.id||""),name:away.name||"Deplasman"}];
  const raw=pitchUnwrapList(eventResult.body||[],["events"]);
  const events=raw.map(event=>pitchEventToApp(event,teams)).filter(Boolean);
  return {events,source:"PitchAPI maç olayları"};
}

async function pitchMatchBundleById(env, matchId, code, fixture=null, forceRefresh=false) {
  if (!/^m_[A-Za-z0-9]{6}$/.test(String(matchId || ""))) throw new Error("Geçersiz PitchAPI maç kimliği.");
  const refreshToken = forceRefresh ? ":refresh:" + Math.floor(Date.now() / 30000) : "";
  const detailResult = await cached("pitch:match-summary:" + PITCH_MATCH_CACHE_VERSION + ":" + matchId + refreshToken, async () => ({ body: await pitchApiJSON(env, "/v1/matches/" + encodeURIComponent(matchId)), ttl: 10 }));
  const detail = detailResult.body || {};
  const status = pitchMatchStatus(detail.status || fixture && fixture.status);
  const rawStatus = pitchNorm(detail.status || fixture && fixture.status || "");
  const finished = /(^| )(finished|full time|fulltime|ft|aet|after extra time|after penalties|completed)( |$)/.test(rawStatus) || status === "FT" || status === "AET" || status === "PEN" || status === "AWD" || status === "WO";
  const kickoff = Date.parse(detail.time_utc || detail.kickoff || detail.start_time || detail.date || fixture && (fixture.time_utc || fixture.date) || "");
  const nearLive = !finished && Number.isFinite(kickoff) && Date.now() >= kickoff - 60 * 1000 && Date.now() <= kickoff + 5 * 3600 * 1000;
  const live = ["1H","HT","2H","ET","BT","P","SUSP","INT"].includes(status) || nearLive;
  const apiRatingsPromise = live ? Promise.resolve([]) : pitchApiFootballRatingsForMatch(env,detail,fixture).catch(()=>[]);
  const livePromise = live ? cached("pitch:match-live:" + PITCH_MATCH_CACHE_VERSION + ":" + matchId + refreshToken, async () => ({ body: await pitchApiJSON(env, "/v1/matches/" + encodeURIComponent(matchId) + "/live"), ttl: forceRefresh ? 10 : 12 })).then(x=>x.body).catch(()=>null) : Promise.resolve(null);
  // Live snapshot already contains the current XI, events, team stats and player stat lines.
  // Only fetch the dedicated lineup layout in parallel; avoid waiting on redundant /players,
  // /stats and /events requests before showing the first XI.
  const endpoints = live ? [
    ["lineups", "/lineups", 10],
    ["h2h", "/h2h", 86400],
  ] : [
    ["lineups", "/lineups", status === "NS" ? 300 : 86400],
    ["players", "/players", status === "NS" ? 300 : 86400],
    ["stats", "/stats", status === "NS" ? 300 : 86400],
    ["events", "/events", status === "NS" ? 300 : 86400],
    ["h2h", "/h2h", 86400],
  ];
  // Finished-match analytics are bundled here. Live analytics use a separate non-blocking
  // route so slow heatmap/network endpoints can never delay first-XI portraits and ratings.
  if (finished) endpoints.push(
    ["advanced", "/advanced", 2592000],
    ["network", "/advanced/network", 2592000],
    ["advancedPlayers", "/advanced/players", 2592000],
    ["heatmaps", "/heatmaps?frame=home_ltr", 2592000],
    ["momentum", "/momentum", 2592000],
    ["shots", "/shots", 2592000],
  );
  const settled = await Promise.allSettled(endpoints.map(async ([key, path, ttl]) => {
    const result = await cached("pitch:match:" + PITCH_MATCH_CACHE_VERSION + ":" + matchId + ":" + key + refreshToken, async () => {
      try {
        return { body: await pitchApiJSON(env, "/v1/matches/" + encodeURIComponent(matchId) + path), ttl: forceRefresh ? 10 : ttl };
      } catch (error) {
        // The provider marks matches it never rated with a stable 404 code. Cache that
        // expected absence so every app visitor does not repeat six known-empty requests.
        if (error && error.code === "ANALYTICS_UNAVAILABLE") return { body: { __pitchAnalyticsUnavailable: true }, ttl: forceRefresh ? 10 : 2592000 };
        throw error;
      }
    });
    return [key, result.body];
  }));
  const bundle = { detail, fixture: fixture || {}, errors: {}, analyticsChecked: finished };
  for (let i=0;i<settled.length;i++) {
    const key = endpoints[i][0];
    const result = settled[i];
    if (result.status === "fulfilled") {
      if (result.value[1] && result.value[1].__pitchAnalyticsUnavailable) bundle.errors[key] = "Bu maç için gelişmiş analiz verisi yayımlanmamış.";
      else bundle[result.value[0]] = result.value[1];
    } else bundle.errors[key] = result.reason && result.reason.message || String(result.reason);
  }
  const leagueName = detail.league && detail.league.name || fixture && fixture.league && fixture.league.name || "";
  const season = detail.season || fixture && fixture.season || "";
  [bundle.apiFootballRatings,bundle.liveSnapshot]=await Promise.all([
    live ? apiRatingsPromise : Promise.race([apiRatingsPromise,new Promise(resolve=>setTimeout(()=>resolve([]),1100))]),
    livePromise
  ]);
  if(bundle.liveSnapshot){
    const liveRoot=bundle.liveSnapshot.data||bundle.liveSnapshot;
    bundle.detail=pitchMergeLiveSummary(bundle.detail,liveRoot);
    bundle.players=pitchMergeLivePlayerRows(pitchUnwrapList(bundle.players,["players"]),liveRoot);
    if(!bundle.lineups||!Object.keys(bundle.lineups).length){
      const liveLineups=liveRoot.lineups||liveRoot.team_sheets||liveRoot.teamsheets||((liveRoot.home||liveRoot.away)?{home:liveRoot.home,away:liveRoot.away}:null);
      if(liveLineups)bundle.lineups=liveLineups;
    }
    if(!bundle.events||!pitchUnwrapList(bundle.events,["events"]).length)bundle.events=liveRoot.events||liveRoot.match_events||bundle.events||[];
    if(!bundle.stats||!Object.keys(bundle.stats||{}).length)bundle.stats=liveRoot.stats||liveRoot.team_stats||liveRoot.statistics||bundle.stats||{};
  }
  await pitchFillUpcomingLineups(env, bundle, code || "");
  const h2h = pitchH2HExtract(bundle.h2h);
  const h2hRows = pitchH2HRows(h2h);
  const h2hWins = Number(h2h && h2h.home_wins || 0) + Number(h2h && h2h.draws || 0) + Number(h2h && h2h.away_wins || 0);
  const h2hPastRows = h2hRows.filter(row => {
    if (!row || row.finished === false) return false;
    const score = row.score || row.scores || row.result || {};
    const homeScore = row.score_home ?? row.home_score ?? score.home ?? score.home_score;
    const awayScore = row.score_away ?? row.away_score ?? score.away ?? score.away_score;
    return homeScore != null && awayScore != null && homeScore !== "" && awayScore !== "";
  });
  const h2hHas = !!h2h && (Number(h2h.total_matches || 0) > 0 || h2hWins > 0 || h2hPastRows.length > 0);
  if (!h2hHas) {
    const fallback = await pitchH2HFallback(env, bundle, code || "");
    if (fallback) bundle.h2h = fallback;
  }
  const app = pitchBuildAppMatch(bundle, code || "", leagueName, season);
  // Attach portraits before optional third-party enrichment. The first XI response must not
  // wait behind secondary team-stat lookups.
  await pitchEnrichLineupPhotos(env,app,bundle.apiFootballRatings||[],code||"",season);
  // Starter position_id is a grid slot. Coordinates can infer a tactical role, but that
  // inferred role must not count as verified. Always try the match-specific roster provider
  // for those players so a real LB/CDM/CAM/ST label can replace the coordinate estimate.
  const pitchApiCoordinatesComplete=(app.lineups||[]).length>=2&&(app.lineups||[]).slice(0,2).every(side=>{
    const starters=side.startXI||[];
    return starters.length===11&&starters.every(entry=>{
      const player=entry.player||entry,px=Number(player.pitchX),py=Number(player.pitchY);
      return Number.isFinite(px)&&Number.isFinite(py)&&px>=0&&px<=1&&py>=0&&py<=1&&!(px===0&&py===0);
    });
  });
  // Full PitchAPI coordinates are the authoritative match-specific placement. Do not
  // replace these players/positions with name-matched generic role feeds from other APIs.
  const positionEnrichmentNeeded=!pitchApiCoordinatesComplete&&(app.lineups||[]).some(side=>{
    const starters=side.startXI||[];
    return starters.length>=8&&starters.some(entry=>{
      const player=entry.player||entry,pos=String(player.pos||""),source=String(player.posSource||"");
      return lineupPositionSpecificity(pos)<2||/koordinat tahmini|formasyon şablonu|formasyon tahmini/i.test(source);
    });
  });
  if(positionEnrichmentNeeded&&app.teams&&app.teams.home&&app.teams.away){
    // TheSportsDB supplies explicit role names; API-Football supplies the fixture's actual
    // formation plus X=row/Y=column grid. Query both in parallel and apply only a complete,
    // name-matched grid (never infer from shirt/list order).
    const [tsdbResult,espnResult,afResult]=await Promise.all([
      Promise.race([tsdbMatchLineups(app.teams.home.name,app.teams.away.name,app.fixture&&app.fixture.date,true).catch(()=>[]),new Promise(resolve=>setTimeout(()=>resolve([]),2400))]),
      Promise.race([espnMatchSpecificLineups(code||"",app.teams.home.name,app.teams.away.name,app.fixture&&app.fixture.date).catch(()=>[]),new Promise(resolve=>setTimeout(()=>resolve([]),2400))]),
      Promise.race([apiFootballMatchLineups(env,app.teams.home.name,app.teams.away.name,app.fixture&&app.fixture.date).catch(()=>[]),new Promise(resolve=>setTimeout(()=>resolve([]),2400))])
    ]);
    if(tsdbResult.length)app.lineups=mergeDetailedLineupPositions(app.lineups,tsdbResult);
    if(espnResult.length)app.lineups=mergeDetailedLineupPositions(app.lineups,espnResult,"ESPN maç kadrosu (Opta)",true);
    if(afResult.length)app.lineups=applyApiFootballGridRoles(app.lineups,afResult);
  }
  // Some fixtures are present in the catalogue but their /stats response is empty.
  // Keep PitchAPI as the primary source, then use the established match-stat fallback only when needed.
  if(!live&&statRowsQuality(app.statistics)<8){
    const homeName=app.teams&&app.teams.home&&app.teams.home.name,awayName=app.teams&&app.teams.away&&app.teams.away.name;
    const date=app.fixture&&app.fixture.date;
    if(homeName&&awayName&&date){
      const fallback=await tsdbMatchStats(homeName,awayName,date,true,live?15:21600).catch(()=>[]);
      if(statRowsQuality(fallback)>statRowsQuality(app.statistics)){app.statistics=fallback;app.statisticsSource="TheSportsDB (PitchAPI istatistiği bulunmadığı için yedek kaynak)";}
    }
  }
  return { match: app, pitch: app.pitch };
}
async function pitchMatchLookup(env, code, date, home, away, seasonYear, forceRefresh=false) {
  if (!pitchApiKey(env)) throw new Error("PitchAPI için Skor3 Worker ayarlarında PITCH_API_KEY Secret gerekli.");
  code = canonicalPitchLeagueCode(code);
  if (!code) throw new Error("Bu maçın ligi PitchAPI ile eşleştirilemedi.");
  const year = Number(seasonYear) || (new Date(date + "T12:00:00Z").getUTCMonth() >= 6 ? new Date(date + "T12:00:00Z").getUTCFullYear() : new Date(date + "T12:00:00Z").getUTCFullYear()-1);
  // First search the exact match-day endpoint. It avoids the slower league metadata + season fixture walk.
  let dayMatches=[];
  try{
    const dayResult=await cached("pitch:date:"+date+":all",async()=>({body:await pitchApiJSON(env,"/v1/date/"+encodeURIComponent(date)+"?status=all"),ttl:300}));
    dayMatches=pitchUnwrapList(dayResult.body,["matches"]);
  }catch(_){dayMatches=[];}
  let picked=dayMatches.map(m=>({m,score:pitchFixtureScore(m,date,home,away)})).filter(x=>x.score>=0&&(x.m.id||x.m.match_id)).sort((a,b)=>b.score-a.score)[0];
  if(picked)return pitchMatchBundleById(env,String(picked.m.id||picked.m.match_id),code,picked.m,forceRefresh);
  // If the date index did not include the fixture, fall back to the league-season catalogue.
  const league = await pitchLeagueForCode(env, code, year);
  const matches = await pitchLeagueMatches(env, league.id, league.season, "all");
  picked = matches.map(m => ({ m, score: pitchFixtureScore(m, date, home, away) })).filter(x => x.score >= 0).sort((a,b) => b.score-a.score)[0];
  if (!picked) throw new Error("PitchAPI bu tarih ve lig için bu iki takımı eşleştiremedi. Mevcut maç bilgileri korunuyor.");
  return pitchMatchBundleById(env, String(picked.m.id), code, picked.m, forceRefresh);
}
function pitchAdvancedMetricNumber(row, metric) {
  const paths = metric === "keypasses" ? [["passing","key_passes"],["passing","key_passes_completed"],["key_passes"],["key_passes_completed"],["chance_creation","key_passes"]] : [];
  for (const path of paths) {
    let value=row;
    for (const part of path) value=value&&value[part];
    if(value&&typeof value==="object")value=value.value??value.total;
    if(value!=null&&value!==""&&Number.isFinite(Number(value)))return Number(value);
  }
  return null;
}
function pitchExpectedMissingAnalytics(error) {
  const code=String(error&&error.code||"").toUpperCase();
  const message=String(error&&error.message||error||"").toLowerCase();
  return code === "ANALYTICS_UNAVAILABLE" || code === "RESOURCE_NOT_FOUND" || /analytics_unavailable|not rated|no analytics|resource_not_found/.test(message);
}
// PitchAPI maç olaylarından gol ve asist sayımı: sezon toplamı alanlarını maç başına tekrar toplama hatasını önler.
function pitchEventPlayerMetricRows(events, metric) {
  const rows=[],seen=new Set();
  for(const ev of pitchUnwrapList(events,["events"])){
    const type=pitchNorm([ev&&ev.event_type,ev&&ev.type,ev&&ev.detail,ev&&ev.description,ev&&ev.comment].filter(Boolean).join(" "));
    const ownGoal=!!(ev&&(ev.is_own_goal===true||ev.is_own_goal===1||String(ev.is_own_goal).toLowerCase()==="true"))||/own goal|own-goal|own_goal|kendi kalesine/.test(type);
    const failedGoal=/miss|saved|save|failed|disallow|cancel|void|no goal|penalty awarded|awarded penalty|penalty not scored|missed penalty|penalty missed|penalty saved|saved penalty|goal ruled out|ruled out|overturned|committed|conceded|won|goal kick|goalkeeper/.test(type);
    const explicitGoal=!!(ev&&(ev.is_goal===true||ev.is_goal===1||String(ev.is_goal).toLowerCase()==="true"));
    // Do not count text such as "goal kick", "goalkeeper save" or "penalty awarded" as a goal.
    const namedScoredGoal=/(^| )(?:goal|normal goal|goal scored|scored goal|penalty goal|penalty scored|scored penalty)( |$)/.test(type);
    const penaltyFlag=!!(ev&&(ev.is_penalty===true||ev.is_penalty===1||String(ev.is_penalty).toLowerCase()==="true"));
    const goal=!ownGoal&&!failedGoal&&(explicitGoal||namedScoredGoal||(penaltyFlag&&type.includes("penalty")));
    if(metric==="goals"||metric==="assists"){
      if(!goal)continue;
      const actorRaw=metric==="goals"?(ev&&(ev.player||ev.scorer||ev.actor||ev.goal_scorer)||{}):(ev&&(ev.assist_player||ev.assist||ev.assisted_by||ev.assistPlayer)||{});
      const actor=typeof actorRaw==="string"?{name:actorRaw}:actorRaw||{};
      const id=String(actor.id||actor.player_id||(metric==="goals"?(ev&& (ev.player_id||ev.scorer_id||ev.actor_id)):(ev&&(ev.assist_player_id||ev.assist_id)))||"");
      const name=String(actor.name||actor.full_name||actor.short_name||(metric==="goals"?(ev&&(ev.player_name||ev.scorer_name)):(ev&&(ev.assist_player_name||ev.assist_name)))||"");
      if(!id&&!name)continue;
      const teamId=String(ev&& (ev.team_id||ev.team&&ev.team.id||ev.teamId)||"");
      const minuteValue=ev&&(ev.minute!=null?ev.minute:ev.time&&ev.time.elapsed!=null?ev.time.elapsed:ev.time);const minute=String(minuteValue==null?"":minuteValue);
      const eventId=String(ev&&(ev.id||ev.event_id||ev.eventId)||"");
      const detail=pitchNorm([ev&&ev.detail,ev&&ev.description,ev&&ev.comment,ev&&ev.event_type,ev&&ev.type].filter(Boolean).join(" "));
      const assistActor=ev&&(ev.assist_player||ev.assist||ev.assisted_by||ev.assistPlayer);const assistName=typeof assistActor==="string"?assistActor:assistActor&&(assistActor.name||assistActor.full_name)||"";
      const scorerActor=ev&&(ev.player||ev.scorer||ev.actor)||{};const scorerName=typeof scorerActor==="string"?scorerActor:scorerActor&&(scorerActor.name||scorerActor.full_name)||ev&&ev.player_name||"";
      const key=eventId?"event:"+eventId:[id||pitchNorm(name),teamId,minute,detail,metric==="assists"?pitchNorm(scorerName):pitchNorm(assistName),metric].join("|");if(seen.has(key))continue;seen.add(key);
      rows.push({id:id||pitchNorm(name),name,teamId,value:1});
    }else{
      const card=type.includes("yellow")||type.includes("red")||type.includes("card");if(!card)continue;
      const isSecond=type.includes("second yellow")||type.includes("secondyellow")||type.includes("2nd yellow");
      if(metric==="yellow"?!type.includes("yellow"):metric==="red"?!(type.includes("red")||isSecond):true)continue;
      const actorRaw=ev&&(ev.player||ev.actor||ev.card_player||ev.offender)||{};const actor=typeof actorRaw==="string"?{name:actorRaw}:actorRaw||{};
      const id=String(actor.id||actor.player_id||ev.player_id||ev.actor_id||ev.card_player_id||"");
      const name=String(actor.name||actor.full_name||actor.short_name||ev.player_name||"");if(!id&&!name)continue;
      const teamId=String(ev&& (ev.team_id||ev.team&&ev.team.id||ev.teamId)||"");
      const minute=String(ev&&(ev.minute!=null?ev.minute:ev.time&&ev.time.elapsed!=null?ev.time.elapsed:ev.time)||"");
      const eventId=String(ev&&(ev.id||ev.event_id||ev.eventId)||"");
      const key=eventId?"event:"+eventId:[id||pitchNorm(name),teamId,minute,type,metric].join("|");if(seen.has(key))continue;seen.add(key);
      rows.push({id:id||pitchNorm(name),name,teamId,value:1});
    }
  }
  return rows;
}
// Lig oyuncu liderlikleri. Her metrik gerçek maç oyuncu/olay kayıtlarından toplanır.
const PITCH_STAT_METRICS = {
  rating:     { source: "players", keys: ["rating", "rating_title", "average_rating"], average: true, label: "Oyuncu puanları" },
  goals:      { source: "events", label: "Gol krallığı" },
  assists:    { source: "events", label: "Asist krallığı" },
  yellow:     { source: "events", label: "Sarı kartlar" },
  red:        { source: "events", label: "Kırmızı kartlar" },
  keypasses:  { source: "advancedPlayers", label: "Kilit pas" },
  appearances:{ source: "players", keys: ["appearances", "matches_played", "games_played"], appearanceCount: true, label: "En çok maçta oynayanlar" },
  minutes:    { source: "players", keys: ["minutes", "minutes_played"], label: "En çok süre alanlar" },
};

async function pitchStatLeaderBatch(env, code, year, metric, offset, requestedLimit=10) {
  const config = PITCH_STAT_METRICS[metric];
  if (!config) throw new Error("Desteklenmeyen lig istatistiği.");
  const league = await pitchLeagueForCode(env, code, year);
  const matches = await pitchLeagueMatches(env, league.id, league.season, "played");
  // Keep each Worker invocation below Cloudflare's subrequest ceiling.
  const size = Math.max(1, Math.min(10, Number(requestedLimit) || 10)), batch = matches.slice(offset, offset + size);
  const map = new Map(); let failedMatches = 0;
  const settled = await Promise.allSettled(batch.map(async match => {
    const id = String(match && match.id || ""); if (!id) return [];
    let rows = [];
    if (config.source === "advancedPlayers") {
      let body, photoRows=[];
      try {
        const result=await cached("pitch:stat-advanced-players:v9:"+id,async()=>({body:await pitchApiJSON(env,"/v1/matches/"+encodeURIComponent(id)+"/advanced/players"),ttl:300}));
        body=result.body;
      } catch(error) {
        // PitchAPI can hold a fixture without a rated event feed. That is expected absence, not a failed match request.
        if(pitchExpectedMissingAnalytics(error))return [];
        throw error;
      }
      try {
        const standard=await cached("pitch:stat-player-photos:v7:"+id,async()=>({body:await pitchApiJSON(env,"/v1/matches/"+encodeURIComponent(id)+"/players"),ttl:2592000}));
        photoRows=pitchUnwrapList(standard.body,["players"]);
      } catch (_) { photoRows=[]; }
      const photoById=new Map(), photoByName=new Map();
      const rememberPhoto=item=>{
        const p=item&&((item.player&&typeof item.player==="object")?item.player:(item.person&&typeof item.person==="object")?item.person:item)||{};
        const pid=String(p.id||p.player_id||item&&item.player_id||item&&item.playerId||"");
        const name=p.name||p.full_name||p.short_name||item&&item.player_name||"";
        const photo=p.image_url||p.photo||p.photo_url||p.headshot||item&&item.image_url||item&&item.photo||"";
        if(photo&&pid)photoById.set(pid,photo);
        if(photo&&name)photoByName.set(pitchNorm(name),photo);
      };
      for(const item of photoRows)rememberPhoto(item);
      // Bazı maçlarda standart istatistik satırında fotoğraf değil yalnızca oyuncu kimliği gelir;
      // diziliş servisinde bulunan fotoğrafları da aynı kimlik havuzuna ekle.
      try {
        const lineupResult=await cached("pitch:stat-lineup-photos:v3:"+id,async()=>({body:await pitchApiJSON(env,"/v1/matches/"+encodeURIComponent(id)+"/lineups"),ttl:2592000}));
        const lineupBody=lineupResult.body||{};const lineupRoot=lineupBody.data||lineupBody;const lineupRaw=lineupRoot.lineups||lineupRoot;
        for(const side of [lineupRaw.home,lineupRaw.away,lineupRaw.home_team_lineup,lineupRaw.away_team_lineup]){
          for(const entry of pitchLineupStarters(side).concat(side&&(side.subs||side.substitutes||side.bench)||[]))rememberPhoto(entry);
        }
      } catch (_) {}
      rows=pitchUnwrapList(body,["players"]).map(row=>{
        const player=row&&row.player||row&&row.person||{};
        const pid=String(player.id||player.player_id||row&&row.player_id||row&&row.id||"");
        const name=player.name||player.full_name||player.short_name||row&&row.player_name||"";
        if(!pid||!name)return null;
        const value=pitchAdvancedMetricNumber(row,metric);
        if(value==null||!Number.isFinite(value)||value<=0)return null;
        const photo=player.image_url||player.photo||photoById.get(pid)||photoByName.get(pitchNorm(name))||"";
        return {id:pid,name,logo:photo,teamId:String(row.team_id||row.team&&row.team.id||""),value};
      }).filter(Boolean);
    } else if (config.source === "players") {
      const result = await cached("pitch:stat-players:v9:" + id, async () => ({ body: await pitchApiJSON(env, "/v1/matches/" + encodeURIComponent(id) + "/players"), ttl: 300 }));
      const standardStatRows=pitchUnwrapList(result.body,["players"]);
      let metricSourceRows=standardStatRows;
      const startingIds=new Set(),startingNames=new Set();
      if(metric==="appearances"){
        try{
          const lineupResult=await cached("pitch:stat-appearance-lineups:v2:"+id,async()=>({body:await pitchApiJSON(env,"/v1/matches/"+encodeURIComponent(id)+"/lineups"),ttl:300}));
          const root=lineupResult.body&&lineupResult.body.data||lineupResult.body||{},raw=root.lineups||root,starterRows=[];
          for(const side of [raw.home||raw.home_team_lineup||raw.homeTeam,raw.away||raw.away_team_lineup||raw.awayTeam])for(const entry of pitchLineupStarters(side)){
            const player=entry&&(entry.player||entry.person)||entry||{},pid=String(player.id||player.player_id||entry&&entry.player_id||""),name=player.name||player.full_name||player.short_name||entry&&entry.player_name||"",teamId=String(entry&& (entry.team_id||entry.team&&entry.team.id)||side&& (side.team_id||side.team&&side.team.id)||"");
            if(pid)startingIds.add(pid);if(name)startingNames.add(pitchNorm(name));
            if(name){const exists=standardStatRows.some(row=>{const p=row&&(row.player||row.person)||{},rowId=String(p.id||p.player_id||row.player_id||row.playerId||""),rowName=p.name||p.full_name||p.short_name||row.player_name||"",rowTeam=String(row.team_id||row.team&&row.team.id||"");return (pid&&rowId===pid)||(pitchNorm(rowName)===pitchNorm(name)&&(!teamId||!rowTeam||teamId===rowTeam))});if(!exists)starterRows.push({player:{id:pid||pitchNorm(name),name},team_id:teamId,is_starting:true});}
          }
          if(starterRows.length)metricSourceRows=standardStatRows.concat(starterRows);
        }catch(_){}
      }
      const ratingById=new Map(),ratingByName=new Map();let apiRatingRows=[];
      if(metric==="rating"){
        try{
          const advanced=await cached("pitch:stat-rating-advanced:v4:"+id,async()=>({body:await pitchApiJSON(env,"/v1/matches/"+encodeURIComponent(id)+"/advanced/players"),ttl:300}));
          for(const a of pitchUnwrapList(advanced.body,["players","statistics"])){
            const ap=a&&(a.player||a.person)||{},aid=String(ap.id||ap.player_id||a.player_id||a.playerId||""),an=pitchNorm(ap.name||ap.full_name||ap.short_name||a.player_name||""),ar=pitchMetricValue(a,["rating","rating_title","average_rating"]);
            if(ar==null||!Number.isFinite(Number(ar))||Number(ar)<=0)continue;
            const info=Number(ar);if(aid)ratingById.set(aid,info);if(an)ratingByName.set(an,info);
          }
        }catch(_){}
        if(standardStatRows.some(row=>{const v=pitchMetricValue(row,["rating","rating_title","average_rating"]);return v==null||!Number.isFinite(Number(v))||Number(v)<=0;})||!ratingById.size){
          apiRatingRows=await pitchApiFootballRatingsForMatch(env,{...match,status:"FT",time_utc:pitchDateString(match)},match).catch(()=>[]);
        }
      }
      rows = metricSourceRows.map(row => {
        const player = row && (row.player || row.person) || {};
        const playerId = player.id || player.player_id || row && (row.player_id || row.playerId || row.id) || "";
        const playerName = player.name || player.full_name || player.short_name || row && (row.player_name || row.name) || "";
        if (!playerId || !playerName) return null;
        if (config.outfield && pitchIsGoalkeeper(row)) return null;
        if (metric === "saves" && !pitchIsGoalkeeper(row)) return null;
        const minutes = pitchMetricValue(row, ["minutes","minutes_played"]);
        let rating = pitchMetricValue(row, ["rating","rating_title","average_rating"]);
        if(metric==="rating"&&(rating==null||!Number.isFinite(Number(rating))||Number(rating)<=0)){
          const rid=String(player.id||player.player_id||row.player_id||row.playerId||""),rname=pitchNorm(player.name||player.full_name||player.short_name||row.player_name||"");
          rating=ratingById.get(rid)??ratingByName.get(rname)??null;
          if(rating==null&&apiRatingRows.length){
            const tid=String(row.team_id||row.team&&row.team.id||""),team=tid&&String(match.home_team&&match.home_team.id||"")===tid?match.home_team:tid&&String(match.away_team&&match.away_team.id||"")===tid?match.away_team:row.team||{};
            rating=pitchApiFootballRatingForPlayer(apiRatingRows,{name:playerName},{name:team.name||""});
          }
        }
        const goals = pitchMetricValue(row, ["goals","goal","goals_scored","scored"]);
        const assists = pitchMetricValue(row, ["assists","assist","goal_assists","assists_made"]);
        const yellow = pitchMetricValue(row, ["yellow_cards","yellow_card","yellow"]);
        const red = pitchMetricValue(row, ["red_cards","red_card","red"]);
        const appearances = pitchMetricValue(row, ["appearances","matches_played","games_played"]);
        const started = !!(row && (row.is_starting===true || row.is_starter===true || row.starting===true || row.started===true || row.is_starting===1 || row.is_starter===1)) || (metric==="appearances"&&(startingIds.has(String(playerId))||startingNames.has(pitchNorm(playerName))));
        // Oynadığı dakika/puan alanı boş olan ama maçta şut, pas, top kapma vb.
        // aksiyon kaydı bulunan futbolcuları da gerçek katılım olarak say.
        const activityMetrics=["total_shots","shots","shots_on_target","total_passes","passes","accurate_passes","tackles","interceptions","saves","blocks","clearances","duels_won","ground_duels_won","aerials_won","key_passes","fouls_drawn"];
        const hadActivity=activityMetrics.some(key=>{const value=pitchMetricValue(row,[key]);return value!=null&&Number(value)>0});
        const appeared = started || hadActivity || [minutes,rating,goals,assists,yellow,red,appearances].some(v=>v!=null&&Number(v)>0);
        if(config.appearanceCount&&!appeared)return null;
        const value = config.appearanceCount ? 1 : metric==="rating" ? rating : pitchMetricValue(row, config.keys);
        if (value == null || !Number.isFinite(value) || value <= 0) return null;
        return { id:String(playerId), name:playerName, logo:player.image_url || player.photo || player.photo_url || row.image_url || row.photo || "", teamId:String(row.team_id || row.team && row.team.id || ""), value };
      }).filter(Boolean);
    } else if (config.source === "lineups") {
      const result = await cached("pitch:stat-lineups:v2:" + id, async () => ({ body: await pitchApiJSON(env, "/v1/matches/" + encodeURIComponent(id) + "/lineups"), ttl: 2592000 }));
      const lineup = result.body || {};
      for (const [sideIndex, side] of [lineup.home, lineup.away].entries()) for (const p of (side && side.starters || [])) {
        const player = p.player || p;
        const sideTeam = sideIndex === 0 ? lineup.home_team : lineup.away_team;
        if (player.player_id && !player.id) player.id = player.player_id;
        if (player.id && player.name) rows.push({ id:String(player.id), name:player.name, logo:player.image_url || "", teamId:String(side.team_id || side.team && side.team.id || sideTeam && sideTeam.id || ""), value:1 });
      }
    } else {
      const result = await cached("pitch:stat-events:v7:" + id, async () => ({ body: await pitchApiJSON(env, "/v1/matches/" + encodeURIComponent(id) + "/events"), ttl: 300 }));
      rows = pitchEventPlayerMetricRows(result.body,metric).map(item=>({...item,logo:""}));
      if(metric==="goals"||metric==="assists"||metric==="yellow"||metric==="red"){
        try{
          const fallback=await cached("pitch:stat-players-fallback:v8:"+id,async()=>({body:await pitchApiJSON(env,"/v1/matches/"+encodeURIComponent(id)+"/players"),ttl:300}));
          const directKeys=metric==="goals"?["goals","goal","goals_scored","scored"]:metric==="assists"?["assists","assist","goal_assists","assists_made"]:metric==="yellow"?["yellow_cards","yellow_card","yellow"]:["red_cards","red_card","red"];
          const directRows=pitchUnwrapList(fallback.body,["players"]).map(row=>{const p=row&&(row.player||row.person)||{},pid=String(p.id||p.player_id||row.player_id||row.playerId||""),name=p.name||p.full_name||p.short_name||row.player_name||"",value=pitchMetricValue(row,directKeys);return (pid||name)&&value!=null&&value>0?{id:pid||pitchNorm(name),name,logo:p.image_url||p.photo||p.photo_url||row.image_url||"",teamId:String(row.team_id||row.team&&row.team.id||""),value}:null}).filter(Boolean);
          // Olay akışında her gol/asist ayrı satırdır. Önce bunları oyuncu bazında
          // TOPLA; ardından maç istatistik satırı varsa iki kaynaktan büyük olanı
          // seç. Olayları tek tek Math.max ile birleştirmek çok gollü oyuncuyu 1'e düşürüyordu.
          const eventByPlayer=new Map();
          for(const item of rows){
            const nameKey=pitchNorm(item.name||""),teamId=String(item.teamId||""),key=(nameKey?nameKey+"|":"id:"+String(item.id||""))+teamId;
            const old=eventByPlayer.get(key);
            if(!old)eventByPlayer.set(key,{...item});
            else{old.value+=Number(item.value)||0;if(!old.logo&&item.logo)old.logo=item.logo;if(!old.id&&item.id)old.id=item.id;}
          }
          const combined=new Map();
          const mergeMetricRow=(item,preferMax)=>{
            const nameKey=pitchNorm(item.name||""),teamId=String(item.teamId||""),key=(nameKey?nameKey+"|":"id:"+String(item.id||""))+teamId;
            let oldKey=key,old=combined.get(key);
            if(!old&&nameKey){const matches=[...combined.entries()].filter(([,row])=>pitchNorm(row.name||"")===nameKey&&(!teamId||!row.teamId||String(row.teamId)===teamId));if(matches.length===1){oldKey=matches[0][0];old=matches[0][1];}}
            if(!old){combined.set(key,{...item});return;}
            old.value=preferMax?Math.max(Number(old.value)||0,Number(item.value)||0):(Number(old.value)||0)+(Number(item.value)||0);
            if((!old.id||old.id===nameKey)&&item.id)old.id=item.id;
            if(!old.logo&&item.logo)old.logo=item.logo;
            if(!old.teamId&&teamId)old.teamId=teamId;
            const finalKey=(nameKey?nameKey+"|":"id:"+String(old.id||item.id||""))+String(old.teamId||teamId||"");
            if(oldKey!==finalKey)combined.delete(oldKey);
            combined.set(finalKey,old);
          };
          for(const item of eventByPlayer.values())mergeMetricRow(item,false);
          directRows.forEach(item=>mergeMetricRow(item,true));rows=[...combined.values()];
        }catch(_){}
      }
    }
    const oneRowPerPlayer = new Map();
    for (const row of rows) {
      const id=String(row.id||"");if(!id)continue;
      const previous=oneRowPerPlayer.get(id);
      if(!previous){oneRowPerPlayer.set(id,{...row});continue;}
      // If the provider repeats a player line, use the highest same-match metric once;
      // never count duplicate appearances or double a goal/assist tally.
      if(Number(row.value)>Number(previous.value))previous.value=row.value;
      if(!previous.logo&&row.logo)previous.logo=row.logo;
      if(!previous.teamId&&row.teamId)previous.teamId=row.teamId;
    }
    return [...oneRowPerPlayer.values()].map(row => {
      const team = String(match.home_team && match.home_team.id || "") === row.teamId ? match.home_team.name : String(match.away_team && match.away_team.id || "") === row.teamId ? match.away_team.name : "";
      return { ...row, team };
    });
  }));
  for (const result of settled) {
    if (result.status !== "fulfilled") { failedMatches++; continue; }
    for (const p of result.value) {
      let row = map.get(p.id),rowKey=p.id;
      if (!row) {
        const nameKey=pitchNorm(p.name||""),sameName=nameKey?[...map.entries()].filter(([,candidate])=>pitchNorm(candidate.player||"")===nameKey):[];
        if(sameName.length===1){rowKey=sameName[0][0];row=sameName[0][1];}
      }
      if (!row) { row = { playerId:p.id, player:p.name, logo:p.logo, value:0, appearances:0, teams:new Set() }; map.set(p.id,row); }
      else if(rowKey!==p.id&&!map.has(p.id))row.playerId=row.playerId||p.id;
      row.value += p.value; row.appearances++;
      if (!row.logo && p.logo) row.logo = p.logo;
      if (p.team) row.teams.add(p.team);
    }
  }
  const rows = [...map.values()].map(r => ({...r, shownValue:config.average && r.appearances ? r.value/r.appearances : r.value})).sort((a,b)=>b.shownValue-a.shownValue || a.player.localeCompare(b.player,"tr")).map((r,i)=>({ rank:i+1, playerId:r.playerId, player:r.player, logo:r.logo, team:[...r.teams].join(" / "), value:Number(r.shownValue.toFixed(config.average ? 2 : 0)), appearances:r.appearances, source:"PitchAPI" }));
  {
    const needsPhoto=rows.filter(row=>!row.logo&&row.playerId).slice(0,10);
    const photoResults=await Promise.allSettled(needsPhoto.map(async row=>cached("pitch:stat-player-profile-photo:v2:"+row.playerId,async()=>({body:await pitchApiJSON(env,"/v1/players/"+encodeURIComponent(row.playerId)),ttl:2592000}))));
    for(let i=0;i<needsPhoto.length;i++){
      const result=photoResults[i];
      if(result.status!=="fulfilled")continue;
      const profileRoot=result.value&&result.value.body&&result.value.body.data||result.value&&result.value.body||{};
      const profile=profileRoot.player||profileRoot.profile||profileRoot;
      const photo=profile.image_url||profile.photo||profile.photo_url||profile.headshot||profile.avatar||profile.picture||"";
      if(photo)needsPhoto[i].logo=photo;
    }
    // API-Football portrait is a last fallback only when that optional provider key is configured.
    if(metric === "keypasses" && apiFootballKey(env)){
      const noPhoto=rows.filter(row=>!row.logo&&row.player).slice(0,4);
      const fallbacks=await Promise.allSettled(noPhoto.map(row=>apiFootballPlayerSearch(env,row.player)));
      for(let i=0;i<noPhoto.length;i++){
        const result=fallbacks[i];if(result.status!=="fulfilled")continue;
        const matches=(result.value||[]).filter(person=>pitchPlayerNameMatches(noPhoto[i].player,person.name));
        if(matches.length===1)noPhoto[i].logo=matches[0].logo||matches[0].photo||"";
      }
    }
  }
  const nextOffset = offset + batch.length;
  return { code, league:league.name, season:league.season, metric, label:config.label, rows, offset, nextOffset, totalMatches:matches.length, done:nextOffset>=matches.length, failedMatches };
}


// Haftanın takımı: seçilen turdaki tamamlanmış maçların gerçek oyuncu puanlarından 11 seçer.
async function pitchWeekTeamBatch(env, code, year, weekKey) {
  const league = await pitchLeagueForCode(env, code, year);
  const matches = await pitchLeagueMatches(env, league.id, league.season, "played");
  const rawWeek = String(weekKey || "all"),parts=rawWeek.split("|dates:"),week=parts[0];
  const monday = value => { const d = new Date(value || ""); if (Number.isNaN(d.getTime())) return ""; d.setUTCHours(0,0,0,0); d.setUTCDate(d.getUTCDate()-((d.getUTCDay()+6)%7)); return d.toISOString().slice(0,10); };
  const datePart=parts[1]||"";
  const weekDates = week.startsWith("week:") ? new Set(week.slice(5).split(",").filter(x => /^\d{4}-\d{2}-\d{2}$/.test(x))) : datePart ? new Set(datePart.split(",").filter(x=>/^\d{4}-\d{2}-\d{2}$/.test(x))) : null;
  const roundNumber=value=>{const s=String(value||"").trim();const m=s.match(/(?:matchday|gameweek|week|hafta|round)\D*(\d+)|(?:regular season|league stage)\s*[-–:]\s*(\d+)|(\d+)(?:st|nd|rd|th|\.)?\s*(?:matchday|gameweek|week|hafta|round)|^(\d+)$/i);return m?Number(m[1]||m[2]||m[3]||m[4]):null};
  const roundValue=match=>String(match&& (match.round_name||match.round||match.league&&match.league.round||match.fixture&&match.fixture.round||match.matchday)||"").trim();
  const wantedRound=week.startsWith("round:")?roundNumber(week.slice(6)):null;
  const selected = matches.filter(match => {
    // UI sends the exact fixture dates belonging to the selected round. Prefer this
    // authoritative set over inconsistent provider matchday metadata (e.g. final
    // fixture of round 12 incorrectly tagged as round 13 by a feed).
    if (datePart && weekDates && weekDates.size) return weekDates.has(String(pitchDateString(match)||"").slice(0,10));
    if (weekDates && weekDates.size) return weekDates.has(monday(pitchDateString(match)));
    if (week.startsWith("round:") && wantedRound!=null) {const actual=roundNumber(roundValue(match));if(actual!=null)return actual===wantedRound;}
    if (week.startsWith("round:")) return roundValue(match)===week.slice(6);
    return false;
  }).sort((a,b)=>String(pitchDateString(b)).localeCompare(String(pitchDateString(a))));
  if (!selected.length) return { code, league: league.name, season: league.season, week, matchCount: 0, players: [], bestEleven: [], message: "Seçilen haftada tamamlanmış maç/oyuncu kaydı bulunamadı." };
  const settled = await pitchAllSettledLimit(selected, 8, async match => {
    const id = String(match.id || match.match_id || ""); if (!id) return [];
    // Match-player statistics contain ratings and portraits; lineup feed supplies the real
    // position/formation so the XI is not assembled from guessed position_id values.
    const [result, lineupResult, advancedResult] = await Promise.all([
      cached("pitch:week-team-lines:v6:" + id, async()=>({body:await pitchApiJSON(env,"/v1/matches/"+encodeURIComponent(id)+"/players"),ttl:900})),
      cached("pitch:week-team-lineups:v6:" + id, async()=>({body:await pitchApiJSON(env,"/v1/matches/"+encodeURIComponent(id)+"/lineups"),ttl:900})).catch(()=>({body:{}})),
      cached("pitch:week-team-advanced:v3:" + id, async()=>({body:await pitchApiJSON(env,"/v1/matches/"+encodeURIComponent(id)+"/advanced/players"),ttl:900})).catch(()=>({body:{}})),
    ]);
    const home = match.home_team || {}, away = match.away_team || {};
    const root = lineupResult.body && (lineupResult.body.data || lineupResult.body) || {};
    const lineupRoot = root.lineups || root;
    const sideValue = key => lineupRoot[key] || lineupRoot[key + "_team"] || lineupRoot[key + "Team"] || {};
    const startersOf = side => Array.isArray(side) ? side : (side.starters || side.startXI || side.start_xi || side.starting_xi || side.startingXI || side.starting_players || []);
    const roleByPlayer = new Map();
    const broadRole = value => {
      const pos = pitchNormalizeLineupPosition(value);
      if (/^(GK|G|GOALIE|KEEPER)$/.test(pos)) return "GK";
      if (/^(DF|DEF|CB|LB|RB|WB|LWB|RWB|SW|RCB|LCB)$/.test(pos)) return "DF";
      if (/^(MF|MID|DM|CDM|CM|AM|CAM|LM|RM|RDM|LDM|LCM|RCM|RAM|LAM)$/.test(pos)) return "MF";
      if (/^(FW|FWD|ST|CF|SS|LW|RW|LWF|RWF|RCF|LCF)$/.test(pos)) return "FW";
      return "";
    };
    for (const sideKey of ["home", "away"]) {
      const side = sideValue(sideKey), starters = startersOf(side);
      const entries = starters.map(entry => {
        const player = entry && entry.player && typeof entry.player === "object" ? {...entry,...entry.player} : (entry || {});
        return { id:String(player.player_id || player.id || ""), role:broadRole((player.position&&typeof player.position==="object"?(player.position.short_name||player.position.shortName||player.position.abbreviation||player.position.name||player.position.label):player.position) || player.position_name || player.positionName || player.role || ""), x:Number(player.pitch_x), y:Number(player.pitch_y) };
      }).filter(x => x.id);
      for (const x of entries) if (x.role) roleByPlayer.set(x.id,x.role);
      // Mevkiyi yalnızca açık PitchAPI mevki alanından alıyoruz.
      // pitch_x/pitch_y ve position_id diziliş koordinatıdır; mevki gibi yorumlanmaz.
    }
    const standardRows=pitchUnwrapList(result.body,["players"]),advancedRows=pitchUnwrapList(advancedResult.body,["players","statistics"]);
    const advancedById=new Map(),advancedByName=new Map();
    for(const row of advancedRows){const player=row&&(row.player||row.person)||{},pid=String(player.id||player.player_id||row.player_id||row.playerId||""),pname=player.name||player.full_name||player.short_name||row.player_name||"";const rating=pitchMetricValue(row,["rating","rating_title","average_rating"]);if(rating==null||!Number.isFinite(Number(rating))||Number(rating)<=0)continue;const info={rating:Number(rating),row,player};if(pid)advancedById.set(pid,info);if(pname)advancedByName.set(pitchNorm(pname),info)}
    let apiFootballRatings=[];
    if(standardRows.some(row=>{const v=pitchMetricValue(row,["rating","rating_title","average_rating"]);return v==null||!Number.isFinite(Number(v))||Number(v)<=0})||advancedRows.length===0){
      apiFootballRatings=await pitchApiFootballRatingsForMatch(env,{...match,home_team:home,away_team:away,time_utc:pitchDateString(match),status:"FT"},match).catch(()=>[]);
    }
    const standardIds=new Set(standardRows.map(row=>{const player=row&&(row.player||row.person)||{};return String(player.id||player.player_id||row.player_id||row.playerId||"")}));
    const mergedRows=standardRows.slice();
    for(const row of advancedRows){const player=row&&(row.player||row.person)||{},pid=String(player.id||player.player_id||row.player_id||row.playerId||"");if(pid&&!standardIds.has(pid))mergedRows.push(row)}
    return mergedRows.map(row => {
      const player = row && (row.player || row.person) || {};
      const id = String(player.id || player.player_id || row.player_id || ""), name = player.name || player.full_name || player.short_name || row.player_name || "";
      if (!id || !name) return null;
      const advanced=advancedById.get(id)||advancedByName.get(pitchNorm(name));
      const ratingValue=pitchMetricValue(row,["rating","rating_title","average_rating"]);
      const primaryRating=ratingValue!=null&&Number.isFinite(Number(ratingValue))&&Number(ratingValue)>0?Number(ratingValue):advanced&&advanced.rating;
      const teamIdForRating=String(row.team_id||row.team&&row.team.id||advanced&&advanced.row&&(advanced.row.team_id||advanced.row.team&&advanced.row.team.id)||"");
      const teamForRating=teamIdForRating&&String(home.id||"")===teamIdForRating?home:teamIdForRating&&String(away.id||"")===teamIdForRating?away:row.team||{};
      const apiRating=primaryRating==null?pitchApiFootballRatingForPlayer(apiFootballRatings,{name},{name:teamForRating.name||""}):null;
      let rating=primaryRating!=null?primaryRating:apiRating;
      let ratingSource=primaryRating!=null?"PitchAPI":apiRating!=null?"API-Football":"";
      if(rating==null){const calculated=pitchCalculatedPlayerRating(row,false)??(advanced&&pitchCalculatedPlayerRating(advanced.row,false));if(calculated!=null){rating=calculated;ratingSource="SkorHane";}}
      if (rating == null || !Number.isFinite(Number(rating)) || Number(rating) <= 0) return null;
      const teamId = teamIdForRating;
      const team = teamForRating;
      const rawPosition=row.position||row.position_name||row.positionName||player.position||player.position_name||player.positionName||row.role||player.role||"";
      const positionObject=rawPosition&&typeof rawPosition==="object"?(rawPosition.short_name||rawPosition.shortName||rawPosition.abbreviation||rawPosition.name||rawPosition.label||""):rawPosition;
      const position = roleByPlayer.get(id) || pitchNormalizeLineupPosition(positionObject);
      return { id, name, photo: player.image_url || player.photo || player.photo_url || "", team: team.name || "", teamLogo: team.image_url || team.logo || "", position, rating: Number(rating), ratingSource, goals: pitchMetricValue(row,["goals"]) || 0, assists: pitchMetricValue(row,["assists"]) || 0, minutes: pitchMetricValue(row,["minutes","minutes_played"]) || 0 };
    }).filter(Boolean);
  });
  const aggregate = new Map(); let failedMatches = 0;
  for (const item of settled) {
    if (item.status !== "fulfilled") { failedMatches++; continue; }
    for (const p of item.value || []) {
      let old = aggregate.get(p.id);
      if (!old) { old = { ...p, ratingTotal: 0, apps: 0, goals: 0, assists: 0, minutes: 0 }; aggregate.set(p.id, old); }
      old.ratingTotal += p.rating; old.apps++; old.goals += p.goals; old.assists += p.assists; old.minutes += p.minutes;
      if (!old.photo && p.photo) old.photo = p.photo;
      if (!old.position && p.position) old.position = p.position;
      if (!old.team && p.team) { old.team = p.team; old.teamLogo = p.teamLogo; }
    }
  }
  const players = [...aggregate.values()].map(p=>({...p,rating:Number((p.ratingTotal/Math.max(1,p.apps)).toFixed(2)), appearances:p.apps})).sort((a,b)=>b.rating-a.rating || b.appearances-a.appearances);
  const group = p => { const pos=String(p.position||"").toUpperCase(); if (/^(GK|G|GOALIE|KEEPER)$/.test(pos)) return "GK"; if (/^(DF|DEF|CB|LB|RB|WB|LWB|RWB|SW|RCB|LCB)$/.test(pos)) return "DF"; if (/^(MF|MID|DM|CDM|CM|AM|CAM|LM|RM|RDM|LDM|LCM|RCM|RAM|LAM)$/.test(pos)) return "MF"; if (/^(FW|FWD|ST|CF|SS|LW|RW|LWF|RWF|RCF|LCF)$/.test(pos)) return "FW"; return ""; };
  // Mevki kontenjanları sabit 4-3-3'tür. Bir oyuncunun gerçek mevkii bilinmiyorsa
  // puanı yüksek diye başka hatta yerleştirilmez; yanlış mevki yerine eksik XI gösterilir.
  const chosen = [], used = new Set();
  const take = (role, count) => {
    const candidates = players.filter(p => group(p) === role).sort((a,b)=>b.rating-a.rating || b.appearances-a.appearances);
    for (const p of candidates) {
      if (chosen.filter(x=>x.role===role).length >= count) break;
      if (used.has(p.id)) continue;
      used.add(p.id); chosen.push({...p,role});
    }
  };
  take("GK",1); take("DF",4); take("MF",3); take("FW",3);
  // Eksik rol varsa, yalnızca aynı rolün gerçek kayıtlarından tamamla; farklı mevkiyle doldurma.
  const needsPhoto=chosen.filter(p=>!p.photo).slice(0,11);
  const photoResults=await Promise.allSettled(needsPhoto.map(p=>cached("pitch:week-player-photo:v3:"+p.id,async()=>({body:await pitchApiJSON(env,"/v1/players/"+encodeURIComponent(p.id)),ttl:2592000}))));
  for(let i=0;i<needsPhoto.length;i++){const r=photoResults[i];if(r.status!="fulfilled")continue;const root=r.value.body&&r.value.body.data||r.value.body||{};const p=root.player||root.profile||root;needsPhoto[i].photo=p.image_url||p.photo||p.photo_url||p.headshot||"";}
  return { code, league: league.name, season: league.season, week, matchCount: selected.length, failedMatches, bestEleven: chosen.slice(0,11), players: players.slice(0,30), source: "PitchAPI maç oyuncu puanları" };
}

// ---------- Takım sayfası: bu sezonki maçlar, turnuvaya göre ----------
const scN = (c) => { const v = c.score; if (v == null) return null; const n = Number(typeof v === "object" ? (v.displayValue != null ? v.displayValue : v.value) : v); return Number.isFinite(n) ? n : null; };
function teamCodes(code) {
  // Takımın ligi + Avrupa kupaları + o ülkenin kupaları (aynı ESPN takım kimliğiyle sorgulanır; takım katılmıyorsa boş döner).
  if (/^uefa\.|^fifa\./.test(code)) return [code];
  const pre = code.split(".")[0];
  const cups = LEAGUES.filter((l) => l[0].split(".")[0] === pre && l[0] !== code && /kupa|cup|copa|pokal|coppa|coupe|copa del rey|fa cup|dfb/i.test(l[2] + l[0])).map((l) => l[0]).slice(0, 8);
  return [code, "uefa.champions", "uefa.europa", "uefa.europa.conf", ...cups];
}
function teamSeasonBounds(code, year) {
  const calendar = /^(?:usa|bra|arg|jpn|kor|swe|nor|fin|isl)\./i.test(String(code || ""));
  return calendar
    ? [Date.UTC(year, 0, 1), Date.UTC(year + 1, 0, 1)]
    : [Date.UTC(year, 6, 1), Date.UTC(year + 1, 6, 1)];
}
function isInTeamSeason(match, code, year) {
  const time = Date.parse(match && match.fixture && match.fixture.date || "");
  if (!Number.isFinite(time)) return false;
  const [start, end] = teamSeasonBounds(code, year);
  return time >= start && time < end;
}
async function teamEspn(code, id, year = seasonStartYear()) {
  const codes = teamCodes(code);
  const calls = [];
  codes.forEach((cd) => {
    const season = "season=" + encodeURIComponent(String(year));
    calls.push([cd, getJSON(SITE + cd + "/teams/" + id + "/schedule?" + season + "&limit=500")],
      [cd, getJSON(SITE + cd + "/teams/" + id + "/schedule?" + season + "&fixture=true&limit=500")]);
  });
  const res = await Promise.allSettled(calls.map((c) => c[1]));
  if (res.every(result => result.status === "rejected")) throw res[0].reason;
  let team = {};
  const seen = new Set(), groups = new Map();
  res.forEach((r, i) => {
    if (r.status !== "fulfilled") return;
    const cd = calls[i][0], meta = META[cd] || [cd, null, cd, ""];
    if (r.value.team && !team.id) team = r.value.team;
    for (const ev of r.value.events || []) {
      if (seen.has(ev.id)) continue;
      const c = ev.competitions && ev.competitions[0]; if (!c) continue;
      const h = (c.competitors || []).find((x) => x.homeAway === "home"), w = (c.competitors || []).find((x) => x.homeAway === "away");
      if (!h || !w) continue;
      seen.add(ev.id);
      const s = statusOf(c.status || ev.status);
      const gname = cd === code ? ((ev.league && (ev.league.name || ev.league.abbreviation)) || meta[2]) : meta[2];
      const tm = (x) => ({ id: x.team.id, name: x.team.displayName || x.team.name || x.team.shortDisplayName || "", logo: x.team.logo || (x.team.logos && x.team.logos[0] && x.team.logos[0].href) || "" });
      const m = { fixture: { id: "e:" + cd + ":" + ev.id, date: ev.date, status: { short: s.short, elapsed: s.elapsed } }, league: { id: "e:" + cd, code: cd, name: gname, country: "" }, teams: { home: tm(h), away: tm(w) }, goals: { home: s.short === "NS" ? null : scN(h), away: s.short === "NS" ? null : scN(w) } };
      if (!groups.has(gname)) groups.set(gname, []);
      groups.get(gname).push(m);
    }
  });
  const arr = [...groups.entries()].map(([name, matches]) => ({
    name, matches: matches.filter(match => isInTeamSeason(match, code, year)).sort((x, y) => Date.parse(x.fixture.date) - Date.parse(y.fixture.date))
  })).filter(group => group.matches.length);
  return { team: { id, name: team.displayName || team.name || "", logo: team.logo || (team.logos && team.logos[0] && team.logos[0].href) || "" }, code, groups: arr, source: "ESPN" };
}
const FAV_T = [["Trabzonspor", "tur.1"], ["Galatasaray", "tur.1"], ["Besiktas", "tur.1"], ["Fenerbahce", "tur.1"], ["Real Madrid", "esp.1"], ["Bayern Munich", "ger.1"], ["Arsenal", "eng.1"]];
const FAV_P = ["Mohamed Salah", "Victor Osimhen", "Mason Greenwood", "Dušan Vlahović", "Cristiano Ronaldo", "Lionel Messi", "Kylian Mbappé", "Lamine Yamal", "Harry Kane", "Erling Haaland"];
async function favs() {
  const codes = [...new Set(FAV_T.map((x) => x[1]))];
  const lists = {};
  await Promise.all(codes.map(async (c) => { try { const tl = await getJSON(SITE + c + "/teams"); lists[c] = ((tl.sports && tl.sports[0] && tl.sports[0].leagues && tl.sports[0].leagues[0] && tl.sports[0].leagues[0].teams) || []).map((x) => x.team); } catch (_) { lists[c] = []; } }));
  const teams = FAV_T.map(([raw, code]) => {
    const f = (lists[code] || []).find((t) => nameLike(t.displayName || t.name, raw));
    return { raw, code, id: f ? String(f.id) : "", logo: f ? (f.logos && f.logos[0] && f.logos[0].href) || "" : "" };
  });
  const players = await Promise.all(FAV_P.map(async (n) => {
    try { const j = await getJSON("https://en.wikipedia.org/api/rest_v1/page/summary/" + encodeURIComponent(n.replace(/ /g, "_")), 2); return { name: n, wiki: j.title || n, logo: (j.thumbnail && j.thumbnail.source) || (j.originalimage && j.originalimage.source) || "" }; }
    catch (_) { return { name: n, wiki: n, logo: "" }; }
  }));
  return { teams, players };
}
const ROSTER_PHOTO_ALIASES = {
  ederson: "Ederson Santana de Moraes",
  "ederson moraes": "Ederson Santana de Moraes",
  "ismail yuksek": "İsmail Yüksek",
  "levent mercan": "Levent Mercan",
};
// Fenerbahçe oyuncularında doğrulanmış fotoğraf bağlantıları; bunlar ilk tercih edilir.
const ROSTER_KNOWN_PHOTOS = {
  "ederson": "https://thumb.wikimedia.org/wikipedia/commons/thumb/d/d5/Ederson_Moraes_31_Fenerbah%C3%A7e_20260805_%287%29.JPG/500px-Ederson_Moraes_31_Fenerbah%C3%A7e_20260805_%287%29.JPG",
  "ederson santana de moraes": "https://thumb.wikimedia.org/wikipedia/commons/thumb/d/d5/Ederson_Moraes_31_Fenerbah%C3%A7e_20260805_%287%29.JPG/500px-Ederson_Moraes_31_Fenerbah%C3%A7e_20260805_%287%29.JPG",
  "levent mercan": "https://www.fenerbahce.org/getmedia/e062d45c-a621-4e24-b284-72b965767bed/leventportre.png?ext=.png&height=400&width=380",
  "ismail yuksek": "https://media.fenerbahce.org/getmedia/021803d6-c0a4-4a92-8f9b-c3f5c4fa29d3/ismailportre_2.png?ext=.png&height=400&width=380",
};
function rosterPhotoQuery(name) {
  const key = nkw(name);
  return ROSTER_PHOTO_ALIASES[key] || String(name || "").trim();
}
async function tsdbRosterPhoto(name, teamName = "") {
  const query = rosterPhotoQuery(name);
  if (!query) return "";
  try {
    const data = await cached("roster-tsdb-photo:v2:" + nkw(query), async () => ({
      body: await getJSON(TSDB + "searchplayers.php?p=" + encodeURIComponent(query.replace(/\s+/g, "_"))), ttl: 86400,
    }));
    const rows = (data.body.player || []).filter(p => /soccer|football/i.test(p.strSport || "Soccer"));
    const withPhoto = rows.map(p => ({ p, photo: p.strCutout || p.strThumb || p.strRender || "" })).filter(x => x.photo);
    if (!withPhoto.length) return "";
    const target = nkw(query), original = nkw(name);
    const exact = withPhoto.filter(x => [nkw(x.p.strPlayer), nkw(x.p.strPlayerAlternate)].includes(target) || nkw(x.p.strPlayer) === original);
    if (exact.length === 1) return exact[0].photo;
    const clubKey = teamSearchKey(teamName);
    if (clubKey) {
      const byClub = withPhoto.filter(x => {
        const clubs = [x.p.strTeam, x.p.strTeam2, x.p.strTeam3].map(teamSearchKey);
        return clubs.some(c => c && (c === clubKey || c.includes(clubKey) || clubKey.includes(c)));
      });
      if (byClub.length === 1) return byClub[0].photo;
      const namedClub = byClub.filter(x => nkw(x.p.strPlayer).includes(target) || target.includes(nkw(x.p.strPlayer)));
      if (namedClub.length === 1) return namedClub[0].photo;
    }
    const nameMatches = withPhoto.filter(x => {
      const candidate = nkw(x.p.strPlayer);
      return candidate && (candidate === target || candidate.includes(target) || (target.length >= 10 && target.includes(candidate)));
    });
    return nameMatches.length === 1 ? nameMatches[0].photo : "";
  } catch (_) { return ""; }
}
async function wikiPhotos(names) {
  const out = {}, unique = [...new Set((names || []).filter(Boolean))];
  const queries = new Map(unique.map(name => [name, rosterPhotoQuery(name)]));
  for (let i = 0; i < unique.length; i += 50) {
    const chunk = unique.slice(i, i + 50), titles = [...new Set(chunk.map(name => queries.get(name)))];
    try {
      const j = await getJSON(WIKI + new URLSearchParams({ action: "query", prop: "pageimages", piprop: "thumbnail", pithumbsize: "300", redirects: "1", titles: titles.join("|") }), 2);
      const q = j.query || {}, map = {}, red = {}, byTitle = {};
      (q.normalized || []).forEach(n => { map[n.from] = n.to; });
      (q.redirects || []).forEach(r => { red[r.from] = r.to; });
      Object.values(q.pages || {}).forEach(pg => { if (pg.thumbnail && pg.thumbnail.source) byTitle[pg.title] = pg.thumbnail.source; });
      for (const name of chunk) { let title = map[queries.get(name)] || queries.get(name); title = red[title] || title; if (byTitle[title]) out[name] = byTitle[title]; }
    } catch (_) {}
  }
  // Tam ad veya başlık farkı nedeniyle bulunamayanları Wikipedia aramasıyla tamamla.
  const missing = unique.filter(name => !out[name]);
  for (let i = 0; i < missing.length; i += 4) {
    await Promise.all(missing.slice(i, i + 4).map(async name => {
      try {
        const query = queries.get(name), found = await wikiSearch(query, "player");
        const target = nkw(query);
        const exact = found.filter(x => nkw(x.name) === target || nkw(x.wiki) === target);
        const candidate = exact.length === 1 ? exact[0] : (found.length === 1 ? found[0] : null);
        if (candidate && candidate.logo) out[name] = candidate.logo;
      } catch (_) {}
    }));
  }
  return out;
}
function normalizeRosterPos(value) {
  const p = String(value || "").trim().toLowerCase();
  if (/^(gk|goalkeeper|keeper)$/.test(p)) return "GK";
  if (/right back|right-back|right fullback/.test(p)) return "RB";
  if (/left back|left-back|left fullback/.test(p)) return "LB";
  if (/right wing/.test(p)) return "RW";
  if (/left wing/.test(p)) return "LW";
  if (/centre.?back|center.?back|defender/.test(p)) return "CB";
  if (/defensive midfield|holding midfield/.test(p)) return "DM";
  if (/midfield/.test(p)) return "CM";
  if (/forward|striker|attacker/.test(p)) return "ST";
  return String(value || "");
}
async function tsdbTeamRoster(name, knownTeamId = "") {
  let teamId = String(knownTeamId || "").replace(/\D/g, "");
  if (!teamId && name) {
    const searched = await cached("tsdb-team-roster-find:" + teamSearchKey(name), async () => ({ body: await getJSON(TSDB + "searchteams.php?t=" + encodeURIComponent(String(name).trim().replace(/\s+/g, "_"))), ttl: 86400 }));
    const candidates = (searched.body.teams || []).filter(x => /soccer|football/i.test(x.strSport || "Soccer") && teamSearchKey(x.strTeam) === teamSearchKey(name));
    if (candidates.length === 1) teamId = String(candidates[0].idTeam || "");
  }
  if (!teamId) return [];
  const data = await cached("tsdb-team-roster:" + teamId, async () => ({ body: await getJSON(TSDB + "lookup_all_players.php?id=" + encodeURIComponent(teamId)), ttl: 21600 }));
  return (data.body.player || []).filter(p => p.strPlayer).map(p => {
    const photos = [p.strCutout, p.strThumb, p.strRender].filter((x,i,a)=>x&&a.indexOf(x)===i);
    return { name: p.strPlayer, tsdb: String(p.idPlayer || ""), pos: normalizeRosterPos(p.strPosition || ""), nat: p.strNationality || "", photo: photos[0] || "", photos };
  });
}
async function rosterEspn(code, id) {
  const j = await getJSON(SITE + code + "/teams/" + id + "/roster");
  let list = j.athletes || [];
  if (list.length && list[0] && Array.isArray(list[0].items)) list = list.flatMap((g) => g.items || []);
  const names = list.map(a => a.displayName || a.fullName || "").filter(Boolean);
  const ph = await wikiPhotos(names);
  return list.map(a => {
    const name = a.displayName || a.fullName || "", espnPhoto = (a.headshot && a.headshot.href) || (a.id ? "https://a.espncdn.com/i/headshots/soccer/players/full/" + a.id + ".png" : ""), photo = espnPhoto || ph[name] || "";
      return { name, number: a.jersey || "", pos: normalizeRosterPos((a.position && (a.position.abbreviation || a.position.displayName)) || ""), age: a.age || "", nat: a.citizenship || "", espnPlayerId: a.id == null ? "" : String(a.id), photo, photos: [espnPhoto, ph[name]].filter((x,i,a)=>x&&a.indexOf(x)===i) };
  }).filter(x => x.name);
}
async function resolveApiFootballTeam(env, name, knownId = "") {
  const expected = careerTeamLogoLookupName(name);
  const expectedKey = teamSearchKey(expected);
  if (!expectedKey || !apiFootballKey(env)) return null;
  const enrich = async base => {
    if (!base || !base.id) return base;
    try {
      const detail = await cached("af-team-detail:v1:" + String(base.id), async () => ({ body: await apiFootballJSON(env, "/teams", { id: String(base.id) }), ttl: 86400 }));
      const record = (detail.body.response || [])[0] || {}, team = record.team || {}, venue = record.venue || {};
      if (team.name && teamSearchKey(team.name) !== expectedKey) return base;
      return { ...base, name: team.name || base.name, logo: team.logo || base.logo || "", country: team.country || base.country || "", founded: team.founded || base.founded || null, venue: venue.name || "", city: venue.city || "", verified: true };
    } catch (_) { return base; }
  };
  if (knownId && /^\d+$/.test(String(knownId))) {
    try {
      const j = await apiFootballJSON(env, "/teams", { id: String(knownId) });
      const t = ((j.response || [])[0] || {}).team || {};
      // A stale/mismatched provider ID (e.g. a reserve/loan-labelled entry)
      // must never override the visible club name.
      if (t.id && teamSearchKey(t.name || "") === expectedKey) {
        const record = (j.response || [])[0] || {}, venue = record.venue || {};
        return { id: String(t.id), name: t.name || expected, logo: t.logo || "", country: t.country || "", founded: t.founded || null, venue: venue.name || "", city: venue.city || "", verified: true };
      }
    } catch (_) {}
  }
  if (expected.length < 3) return null;
  const found = await apiFootballTeamSearch(env, expected);
  const exact = found.filter(x => teamSearchKey(x.name) === expectedKey);
  if (exact.length === 1) return enrich({ id: exact[0].af, name: exact[0].name, logo: exact[0].logo || exact[0].apiLogo || "", country: exact[0].team || "", verified: true });
  if (!exact.length) {
    const loose = found.filter(x => nameLike(teamSearchKey(x.name), expectedKey) || nameLike(expectedKey, teamSearchKey(x.name)));
    if (loose.length === 1) return enrich({ id: loose[0].af, name: loose[0].name, logo: loose[0].logo || loose[0].apiLogo || "", country: loose[0].team || "", verified: true });
  }
  return null;
}
async function teamTsdb(name, id = "") {
  const cleanName = careerTeamLogoLookupName(name);
  let candidates = [];
  if (id) {
    try {
      const lookup = await getJSON(TSDB + "lookupteam.php?id=" + encodeURIComponent(id));
      candidates = (lookup.teams || []).filter(x => /soccer|football/i.test(x.strSport || "Soccer"));
    } catch (_) {}
  }
  let exact = candidates.filter(x => teamSearchKey(x.strTeam) === teamSearchKey(cleanName));
  // If the supplied TSDB ID points at another club, discard it and resolve by exact name.
  if (!exact.length) {
    const search = await getJSON(TSDB + "searchteams.php?t=" + encodeURIComponent(cleanName.replace(/\s+/g, "_")));
    candidates = (search.teams || []).filter(x => /soccer|football/i.test(x.strSport || "Soccer"));
    exact = candidates.filter(x => teamSearchKey(x.strTeam) === teamSearchKey(cleanName));
  }
  const tm = exact.length === 1 ? exact[0] : null;
  if (!tm) throw new Error("Takım bulunamadı veya takım kimliği eşleşmedi");
  const [l, n] = await Promise.allSettled([getJSON(TSDB + "eventslast.php?id=" + tm.idTeam), getJSON(TSDB + "eventsnext.php?id=" + tm.idTeam)]);
  const evs = [];
  if (l.status === "fulfilled") evs.push(...(l.value.results || []));
  if (n.status === "fulfilled") evs.push(...(n.value.events || []));
  const groups = new Map();
  for (const e of evs) {
    const date = (e.strTimestamp ? e.strTimestamp + "Z" : (e.dateEvent || "") + "T" + (e.strTime || "00:00:00") + "Z").replace("ZZ", "Z");
    const done = e.intHomeScore != null && e.intHomeScore !== "";
    const m = { fixture: { id: "t:" + e.idEvent, date, status: { short: done ? "FT" : "NS", elapsed: null } }, league: { id: "t:" + e.idLeague, code: "", name: e.strLeague || "Diğer", country: "" }, teams: { home: { id: e.idHomeTeam, name: e.strHomeTeam, logo: e.strHomeTeamBadge || "" }, away: { id: e.idAwayTeam, name: e.strAwayTeam, logo: e.strAwayTeamBadge || "" } }, goals: { home: done ? Number(e.intHomeScore) : null, away: done ? Number(e.intAwayScore) : null } };
    const g = e.strLeague || "Diğer"; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(m);
  }
  return { team: { id: tm.idTeam, name: tm.strTeam, logo: tm.strBadge || tm.strLogo || "", founded: tm.intFormedYear || tm.dateFormed || "" }, groups: [...groups.entries()].map(([name, matches]) => ({ name, matches: matches.sort((x, y) => Date.parse(x.fixture.date) - Date.parse(y.fixture.date)) })), source: "TheSportsDB", limited: true };
}

async function apiFootballH2HByNames(env,homeName,awayName){
  if(!apiFootballKey(env))return {source:"API-Football",available:false,total_matches:0,home_wins:0,draws:0,away_wins:0,recent_matches:[],message:"API_FOOTBALL_KEY yapılandırılmadı."};
  const [home,away]=await Promise.all([resolveApiFootballTeam(env,homeName),resolveApiFootballTeam(env,awayName)]);
  if(!home||!away||String(home.id)===String(away.id))return {source:"API-Football",available:false,total_matches:0,home_wins:0,draws:0,away_wins:0,recent_matches:[],message:"Takımlar API-Football kataloğunda güvenli biçimde eşleştirilemedi."};
  const key="match-h2h:api-football:v3:"+String(home.id)+":"+String(away.id);
  const result=await cached(key,async()=>{
    const response=await apiFootballJSON(env,"/fixtures/headtohead",{h2h:String(home.id)+"-"+String(away.id),last:"20"});
    const rows=(response&&response.response||[]).map(item=>{const goals=item.goals||{},full=item.score&&item.score.fulltime||{},status=item.fixture&&item.fixture.status&&item.fixture.status.short||"";return {time_utc:item.fixture&&item.fixture.date||"",home:{id:String(item.teams&&item.teams.home&&item.teams.home.id||""),name:item.teams&&item.teams.home&&item.teams.home.name||""},away:{id:String(item.teams&&item.teams.away&&item.teams.away.id||""),name:item.teams&&item.teams.away&&item.teams.away.name||""},score_home:full.home??goals.home??null,score_away:full.away??goals.away??null,finished:["FT","AET","PEN"].includes(status)};}).filter(x=>x.finished&&x.score_home!=null&&x.score_away!=null);
    return {body:{...pitchH2HSummaryFromRows(rows,home.name,away.name),source:"API-Football",available:rows.length>0,home_name:home.name,away_name:away.name},ttl:21600};
  });
  return result.body;
}

// OddsPapi: maç önü İddaa marketleri ve canlı maçlarda yalnızca maç önü tarihsel market görünümü. Secret adı ODDSPAPI_API_KEY (alternatif: ODDSPAPI_KEY).
async function oddsPapiJSON(env,path,params={}){
  const key=String(env.ODDSPAPI_KEY||env.ODDSPAPI_API_KEY||'').trim();
  if(!key)throw new Error('ODDSPAPI_API_KEY (veya ODDSPAPI_KEY) gizli değişkeni tanımlı değil.');
  const url=new URL('https://api.oddspapi.io/v4/'+String(path||'').replace(/^\/+/,''));
  for(const [k,v] of Object.entries(params||{}))if(v!==undefined&&v!==null&&v!=='')url.searchParams.set(k,String(v));
  url.searchParams.set('apiKey',key);
  const response=await fetch(url.toString(),{headers:{'Accept':'application/json'},signal:AbortSignal.timeout(12000)});
  if(!response.ok){let detail='';try{detail=(await response.text()).slice(0,300)}catch(_){}throw new Error('OddsPapi HTTP '+response.status+(detail?' · '+detail:''));}
  const body=await response.json();
  if(body&&body.error)throw new Error(body.error.message||body.error.code||'OddsPapi veri hatası');
  return body;
}
function oddsPapiArray(body){if(Array.isArray(body))return body;if(body&&Array.isArray(body.data))return body.data;if(body&&Array.isArray(body.response))return body.response;return [];}
function oddsPapiNorm(value){return pitchNorm(String(value||'').replace(/ı/g,'i').replace(/İ/g,'I'));}
function oddsPapiNameScore(wanted,candidate){
  const canon=value=>oddsPapiNorm(value).split(/\s+/).filter(x=>x&&!['fc','cf','afc','sc','club','the'].includes(x)).map(x=>({utd:'united',man:'manchester',ath:'athletic',atletico:'atletico',st:'saint',dep:'deportivo'}[x]||x));
  const aa=canon(wanted),bb=canon(candidate);if(!aa.length||!bb.length)return 0;
  const a=aa.join(' '),b=bb.join(' ');if(a===b)return 1;
  if(Math.min(a.length,b.length)>=5&&(a.includes(b)||b.includes(a)))return .94;
  const aset=new Set(aa),bset=new Set(bb);let common=0;for(const token of aset)if(bset.has(token))common++;
  if(!common)return 0;
  const smaller=Math.min(aset.size,bset.size),larger=Math.max(aset.size,bset.size);
  if(common===smaller)return .90;
  return common/larger;
}
function oddsPapiFixtureSideScore(wanted,fixture,side){
  const prefix=side==='home'?'participant1':'participant2';
  const candidates=[fixture&&fixture[prefix+'Name'],fixture&&fixture[prefix+'ShortName'],fixture&&fixture[prefix+'Abbr']].filter(Boolean);
  return Math.max(0,...candidates.map(name=>oddsPapiNameScore(wanted,name)));
}
async function oddsPapiFixtureForMatch(env,home,away,date,includeLive=false){
  // İstenen gün Türkiye yerel saatine göre alınır; API zamanları UTC'dir.
  const from=new Date(date+'T00:00:00+03:00').toISOString();
  const to=new Date(addDays(date,1)+'T00:00:00+03:00').toISOString();
  const loadFixtures=async(mode)=>{
    const suffix=mode==='iddaa'?'iddaa':mode==='any'?'any-bookmaker':'broad-discovery';
    const key='oddspapi:iddaa:fixtures:v3:'+suffix+':'+date;
    const params={sportId:10,from,to,language:'en'};
    if(mode!=='broad'){params.statusId=0;params.hasOdds=true;}
    if(mode==='iddaa')params.bookmakers='iddaa';
    const result=await cached(key,async()=>({
      body:oddsPapiArray(await oddsPapiJSON(env,'fixtures',params)),ttl:180
    }));
    return result.body||[];
  };
  const rankRows=rows=>rows.map(f=>{
    const h=oddsPapiFixtureSideScore(home,f,'home'),a=oddsPapiFixtureSideScore(away,f,'away');
    const rh=oddsPapiFixtureSideScore(home,f,'away'),ra=oddsPapiFixtureSideScore(away,f,'home');
    const direct=h+a,reverse=rh+ra;
    return {fixture:f,reversed:reverse>direct,score:Math.max(direct,reverse),direct,reverse};
  }).filter(x=>x.fixture&&x.fixture.fixtureId&&x.score>=1.55).sort((a,b)=>b.score-a.score);
  let ranked=includeLive?rankRows(await loadFixtures('broad')):rankRows(await loadFixtures('iddaa'));
  let best=ranked[0],second=ranked[1];
  if(!includeLive&&(!best||(second&&best.score-second.score<.08))){
    // Retry without the bookmaker filter, then verify iddaa on /odds itself.
    ranked=rankRows(await loadFixtures('any'));best=ranked[0];second=ranked[1];
  }
  if(!includeLive&&(!best||(second&&best.score-second.score<.08))){
    // Last discovery fallback: some fixtures are returned without a hasOdds flag
    // even though /odds later exposes bookmaker data. Only a confident fixture
    // match proceeds, and iddaa is still verified on the odds response.
    ranked=rankRows(await loadFixtures('broad'));best=ranked[0];second=ranked[1];
  }
  if(!best||(second&&best.score-second.score<.08))return null;
  return best;
}
async function oddsPapiMarketsCatalog(env){
  const result=await cached('oddspapi:markets:v2:football',async()=>({body:oddsPapiArray(await oddsPapiJSON(env,'markets',{sportId:10,language:'en'})),ttl:86400}));
  return (result.body||[]).filter(m=>Number(m.sportId)===10);
}
function oddsPapiTurkishMarketName(definition){
  const raw=String(definition&&definition.marketName||'').trim();
  const n=oddsPapiNorm(raw).replace(/[_-]+/g,' ');
  const rules=[
    [/^(full time result|match result|1x2|full time 1x2)/,'Maç Sonucu (1-X-2)'],
    [/^(first half result|1st half result|half time result)/,'İlk Yarı Sonucu (1-X-2)'],
    [/^(second half result|2nd half result)/,'İkinci Yarı Sonucu (1-X-2)'],
    [/result.*both teams to score|both teams to score.*result/,'Maç Sonucu + Karşılıklı Gol'],
    [/result.*total goals|total goals.*result/,'Maç Sonucu + Toplam Gol'],
    [/half time.*full time|half time.full time|ht ft/,'İlk Yarı / Maç Sonucu'],
    [/winning margin|win margin|margin of victory/,'Kazanma Farkı'],
    [/goal band|total goals range|goals range/,'Toplam Gol Aralığı'],
    [/both teams.*score in both halves/,'İki Yarıda da Karşılıklı Gol'],
    [/both teams to score|both teams score|btts/,'Karşılıklı Gol'],
    [/double chance/,'Çifte Şans'],
    [/draw no bet/,'Beraberlikte İade'],
    [/correct score/,'Doğru Skor'],
    [/odd.*even|even.*odd/,'Toplam Gol Tek / Çift'],
    [/first goal|team to score first/,'İlk Golü Atan Takım'],
    [/last goal|team to score last/,'Son Golü Atan Takım'],
    [/anytime goalscorer|to score anytime|player to score/,'Oyuncu Gol Atar'],
    [/first goalscorer|first scorer/,'İlk Golü Atan Oyuncu'],
    [/last goalscorer|last scorer/,'Son Golü Atan Oyuncu'],
    [/player.*goal|goals.*player|player goals/,'Oyuncu Gol Sayısı'],
    [/player.*shots on target|shots on target.*player/,'Oyuncu İsabetli Şut'],
    [/player.*shots|shots.*player/,'Oyuncu Şut Sayısı'],
    [/player.*assist|assists.*player/,'Oyuncu Asist Sayısı'],
    [/player.*foul|fouls.*player/,'Oyuncu Faul Sayısı'],
    [/player.*card|cards.*player/,'Oyuncu Kart Görür'],
    [/player.*pass|passes.*player/,'Oyuncu Pas Sayısı'],
    [/player.*tackle|tackles.*player|player.*interception/,'Oyuncu Müdahale Sayısı'],
    [/player.*offside|offsides.*player/,'Oyuncu Ofsayt Sayısı'],
    [/no goal|no goalscorer/,'Gol Olmaz'],
    [/^(first half|1st half).*over under|over under.*(first half|1st half)/,'İlk Yarı Gol Alt / Üst'],
    [/^(second half|2nd half).*over under|over under.*(second half|2nd half)/,'İkinci Yarı Gol Alt / Üst'],
    [/first half.*corner|corner.*first half/,'İlk Yarı Korner Alt / Üst'],
    [/second half.*corner|corner.*second half/,'İkinci Yarı Korner Alt / Üst'],
    [/total corners|corners total|corner total|over under.*corner/,'Toplam Korner Alt / Üst'],
    [/corner handicap|handicap.*corner/,'Korner Handikapı'],
    [/home.*corner|home corners/,'Ev Sahibi Korner Alt / Üst'],
    [/away.*corner|away corners/,'Deplasman Korner Alt / Üst'],
    [/home.*over under|home total|over under.*home/,'Ev Sahibi Golü Alt / Üst'],
    [/away.*over under|away total|over under.*away/,'Deplasman Golü Alt / Üst'],
    [/team total goals|team goals total/,'Takım Golü Alt / Üst'],
    [/^(over under|total goals|total goal)/,'Toplam Gol Alt / Üst'],
    [/asian handicap/,'Asya Handikapı'],
    [/european handicap/,'Avrupa Handikapı'],
    [/handicap/,'Handikap'],
    [/red card/,'Kırmızı Kart'],
    [/yellow card|booking point|card point|total cards?/,'Toplam Kart Alt / Üst'],
    [/first half.*card|card.*first half/,'İlk Yarı Kart Alt / Üst'],
    [/second half.*card|card.*second half/,'İkinci Yarı Kart Alt / Üst'],
    [/penalty/,'Penaltı'],
    [/clean sheet/,'Gol Yemeden Tamamlama'],
    [/win to nil/,'Gol Yemeden Kazanır'],
    [/score in both halves/,'Her İki Yarıda da Gol'],
    [/team to score/,'Gol Atacak Takım'],
  ];
  for(const [pattern,label] of rules)if(pattern.test(n))return label;
  // Unknown catalog entries are retained and lightly localized rather than hidden.
  return raw
    .replace(/\bFull Time\b/gi,'Maç Boyu').replace(/\bHalf Time\b/gi,'İlk Yarı')
    .replace(/\bFirst Half\b|\b1st Half\b/gi,'İlk Yarı').replace(/\bSecond Half\b|\b2nd Half\b/gi,'İkinci Yarı')
    .replace(/\bOver\b/gi,'Üst').replace(/\bUnder\b/gi,'Alt')
    .replace(/\bBoth Teams To Score\b/gi,'Karşılıklı Gol').replace(/\bCorrect Score\b/gi,'Doğru Skor')
    .replace(/\bTotal Goals?\b/gi,'Toplam Gol').replace(/\bGoals?\b/gi,'Gol')
    .replace(/\bCorners?\b/gi,'Korner').replace(/\bCards?\b/gi,'Kart')
    .replace(/\bShots? On Target\b/gi,'İsabetli Şut').replace(/\bShots?\b/gi,'Şut')
    .replace(/\bPlayer\b/gi,'Oyuncu').replace(/\bHome\b/gi,'Ev Sahibi').replace(/\bAway\b/gi,'Deplasman')
    .replace(/\bDraw\b/gi,'Beraberlik').replace(/\bResult\b/gi,'Sonuç')
    .replace(/\bHandicap\b/gi,'Handikap').replace(/\bYes\b/gi,'Evet').replace(/\bNo\b/gi,'Hayır')
    .replace(/\bOdd\b/gi,'Tek').replace(/\bEven\b/gi,'Çift') || 'Diğer İddaa Pazarı';
}
function oddsPapiTurkishOutcome(value){
  const raw=String(value==null?'':value).trim();
  const n=oddsPapiNorm(raw).replace(/\s+/g,' ');
  const map={
    'yes':'Evet','no':'Hayır','over':'Üst','under':'Alt','home':'Ev Sahibi','away':'Deplasman','draw':'Beraberlik',
    'home win':'Ev Sahibi Kazanır','away win':'Deplasman Kazanır','odd':'Tek','even':'Çift',
    'home or draw':'1X','draw or away':'X2','away or draw':'X2','home or away':'12','away or home':'12','home / draw':'1X','draw / away':'X2','away / draw':'X2','home / away':'12','home draw':'1X','draw away':'X2','away draw':'X2','draw home':'1X','home away':'12','away home':'12','draw or home':'1X','1 / x':'1X','x / 2':'X2','1 / 2':'12','team 1':'Ev Sahibi','team 2':'Deplasman',
    '1 or x':'1X','x or 2':'X2','1 or 2':'12','no goal':'Gol Yok','any other score':'Diğer Skor',
    'both teams to score':'Karşılıklı Gol','both teams not to score':'Karşılıklı Gol Yok',
  };
  if(map[n])return map[n];
  return raw
    .replace(/\bHome\b/gi,'Ev Sahibi')
    .replace(/\bAway\b/gi,'Deplasman')
    .replace(/\bDraw\b/gi,'Beraberlik')
    .replace(/\bOver\b/gi,'Üst')
    .replace(/\bUnder\b/gi,'Alt')
    .replace(/\bYes\b/gi,'Evet')
    .replace(/\bNo\b/gi,'Hayır');
}
function oddsPapiReverseTeamSideText(value){
  return String(value==null?'':value).replace(/\bHome\b/gi,'__ODDS_HOME_SIDE__').replace(/\bAway\b/gi,'Home').replace(/__ODDS_HOME_SIDE__/g,'Away');
}
function oddsPapiReverseOutcome(value){
  const raw=String(value==null?'':value).trim();
  const n=oddsPapiNorm(raw).replace(/\s+/g,' ');
  const map={
    '1':'2','2':'1','home':'Away','away':'Home','home win':'Away Win','away win':'Home Win',
    'home or draw':'Away or Draw','away or draw':'Home or Draw','draw or away':'Home or Draw',
    '1 or x':'X or 2','x or 2':'1 or X','1x':'X2','x2':'1X',
    'team 1':'Team 2','team 2':'Team 1','home / draw':'Away / Draw','draw / away':'Draw / Home','away / draw':'Home / Draw','home / away':'Away / Home','home draw':'Away / Draw','draw away':'Draw / Home','away draw':'Home / Draw','home away':'Away / Home','away home':'Home / Away',
  };
  if(map[n])return map[n];
  return oddsPapiReverseTeamSideText(raw);
}
function oddsPapiNormalizeMarkets(oddsBody,marketCatalog,reversed=false){
  const bookmakerOdds=oddsBody&&oddsBody.bookmakerOdds||{};
  const entry=Object.entries(bookmakerOdds).find(([slug])=>String(slug).toLowerCase()==='iddaa');
  if(!entry)return [];
  const bookmaker=entry[1]||{};
  if(bookmaker.bookmakerIsActive===false||bookmaker.suspended===true)return [];
  const marketsObj=bookmaker.markets||{};
  const definitions=new Map((marketCatalog||[]).filter(d=>d&&Number(d.sportId||10)===10).map(d=>[String(d.marketId),d]));
  const output=[];
  for(const [marketId,market] of Object.entries(marketsObj)){
    if(!market||market.marketActive===false)continue;
    const definition=definitions.get(String(marketId));
    if(!definition)continue;
    const outcomesObj=market.outcomes||{};
    const marketType=String(definition.marketType||'').toLowerCase();
    const period=String(definition.period||'').toLowerCase();
    const isPlayerProp=definition.playerProp===true;
    const displayDefinition=reversed?{...definition,marketName:oddsPapiReverseTeamSideText(definition.marketName)}:definition;
    const baseName=oddsPapiTurkishMarketName(displayDefinition);
    const details=[];
    const periodLabels={firsthalf:'İlk Yarı',secondhalf:'İkinci Yarı',fulltime:'Maç Boyu',extratime:'Uzatmalar',penalties:'Penaltılar'};
    if(periodLabels[period]&&!/ilk yari|ikinci yari|mac sonucu|mac boyu|uzatma|penalti/i.test(oddsPapiNorm(baseName)))details.push('Periyot: '+periodLabels[period]);
    const handicap=Number(definition.handicap);
    if(Number.isFinite(handicap)&&handicap!==0&&!/\d+[.,]\d+/.test(baseName))details.push('Çizgi / handikap: '+(handicap>0?'+':'')+String(handicap));
    const detailText=details.join(' · ');

    if(isPlayerProp){
      // Player markets use player IDs as the players-map keys. Collect all active
      // player selections and group their outcome choices under the player's name.
      const byPlayer=new Map();
      for(const [outcomeId,outcome] of Object.entries(outcomesObj)){
        const meta=(definition.outcomes||[]).find(x=>String(x.outcomeId)===String(outcomeId));
        if(!meta)continue;
        const players=outcome&&outcome.players&&typeof outcome.players==='object'?outcome.players:{};
        for(const [playerId,quote] of Object.entries(players)){
          if(!quote||quote.active===false)continue;
          const price=Number(quote.price),playerName=String(quote.playerName||'').trim();
          if(!playerName||!Number.isFinite(price)||price<=1)continue;
          if(!byPlayer.has(playerId))byPlayer.set(playerId,{playerId,playerName,outcomes:[]});
          const group=byPlayer.get(playerId);
          group.outcomes.push({id:String(meta.outcomeName||outcomeId).toUpperCase().replace(/\s+/g,''),label:oddsPapiTurkishOutcome(meta.outcomeName||outcomeId),odd:price,active:true});
        }
      }
      for(const player of byPlayer.values()){
        if(!player.outcomes.length)continue;
        output.push({id:'oddspapi-'+String(marketId)+'-player-'+String(player.playerId),name:baseName+' · '+player.playerName,details:[detailText,'Oyuncu bahsi'].filter(Boolean).join(' · '),type:marketType,period,marketId:String(marketId),playerProp:true,playerId:String(player.playerId),playerName:player.playerName,outcomes:player.outcomes,marketLength:player.outcomes.length});
      }
      continue;
    }

    const outcomes=[];
    for(const [outcomeId,outcome] of Object.entries(outcomesObj)){
      const meta=(definition.outcomes||[]).find(x=>String(x.outcomeId)===String(outcomeId));
      if(!meta)continue;
      const players=outcome&&outcome.players&&typeof outcome.players==='object'?outcome.players:{};
      // OddsPapi keeps standard match markets under players["0"]. Other keys are player props.
      const quote=players['0'];
      if(!quote||quote.active===false)continue;
      const price=Number(quote.price);
      if(!Number.isFinite(price)||price<=1)continue;
      let originalLabel=String(meta.outcomeName||'').trim();
      if(!originalLabel)continue;
      if(reversed)originalLabel=oddsPapiReverseOutcome(originalLabel);
      const selectionNorm=oddsPapiNorm(originalLabel).replace(/\s+/g,' ');
      let id=originalLabel.toUpperCase().replace(/\s+/g,'');
      if(marketType==='1x2'){
        const resultAliases={'1':'1','home':'1','home win':'1','team 1':'1','x':'X','draw':'X','tie':'X','2':'2','away':'2','away win':'2','team 2':'2'};
        if(resultAliases[selectionNorm])id=resultAliases[selectionNorm];
      }
      const label=marketType==='1x2'&&['1','X','2'].includes(id)?id:oddsPapiTurkishOutcome(originalLabel);
      outcomes.push({id,label,odd:price,active:true});
    }
    if(!outcomes.length)continue;
    if(marketType==='1x2')outcomes.sort((a,b)=>['1','X','2'].indexOf(a.id)-['1','X','2'].indexOf(b.id));
    const isFullTimeResult=marketType==='1x2'&&period==='fulltime';
    output.push({
      id:isFullTimeResult?'match-result':'oddspapi-'+String(marketId),
      name:isFullTimeResult?'Maç Sonucu (1-X-2)':baseName,
      details:detailText,type:marketType,period,marketId:String(marketId),outcomes,
      marketLength:Number(definition.marketLength)||outcomes.length,playerProp:false,
    });
  }
  const priority=m=>m.id==='match-result'?0:m.type==='1x2'?1:/total|totals/.test(m.type)?2:m.playerProp?4:3;
  output.sort((a,b)=>priority(a)-priority(b)||String(a.name).localeCompare(String(b.name),'tr'));
  return output;
}
function oddsPapiHistoricalPrematchBody(historyBody,kickoffIso){
  const kickoff=Date.parse(kickoffIso||'');
  if(!Number.isFinite(kickoff))return null;
  const source=historyBody&&historyBody.bookmakers||historyBody&&historyBody.bookmakerOdds||{};
  const entry=Object.entries(source).find(([slug])=>String(slug).toLowerCase()==='iddaa');
  if(!entry)return null;
  const historicMarkets=entry[1]&&entry[1].markets||{};
  const markets={};
  for(const [marketId,market] of Object.entries(historicMarkets)){
    const outcomes={};
    for(const [outcomeId,outcome] of Object.entries(market&&market.outcomes||{})){
      const selectedPlayers={};
      for(const [playerId,history] of Object.entries(outcome&&outcome.players||{})){
        const rows=Array.isArray(history)?history:history&&typeof history==='object'?[history]:[];
        const eligible=rows.filter(row=>{
          const time=Date.parse(row&&row.createdAt||'');
          const price=Number(row&&row.price);
          return Number.isFinite(time)&&time<=kickoff&&Number.isFinite(price)&&price>1;
        }).sort((a,b)=>Date.parse(a.createdAt)-Date.parse(b.createdAt));
        const available=eligible.filter(row=>row.active!==false);
        // Prefer the last active quote. If the book suspended it just before kick-off,
        // keep the last recorded pre-match price as an outcome-label fallback (the UI hides prices).
        const chosen=available[available.length-1]||eligible[eligible.length-1]||null;
        if(chosen)selectedPlayers[playerId]={...chosen,active:true};
      }
      if(Object.keys(selectedPlayers).length)outcomes[outcomeId]={players:selectedPlayers};
    }
    if(Object.keys(outcomes).length)markets[marketId]={marketActive:true,outcomes};
  }
  if(!Object.keys(markets).length)return null;
  return {bookmakerOdds:{iddaa:{bookmakerIsActive:true,suspended:false,markets}},updatedAt:historyBody.updatedAt||new Date().toISOString()};
}
let ODDS_PAPI_HISTORICAL_QUEUE=Promise.resolve();
let ODDS_PAPI_HISTORICAL_LAST_CALL=0;
function oddsPapiHistoricalJSON(env,params={}){
  const task=ODDS_PAPI_HISTORICAL_QUEUE.then(async()=>{
    const wait=Math.max(0,5000-(Date.now()-ODDS_PAPI_HISTORICAL_LAST_CALL));
    if(wait)await sleep(wait);
    ODDS_PAPI_HISTORICAL_LAST_CALL=Date.now();
    return oddsPapiJSON(env,'historical-odds',params);
  });
  ODDS_PAPI_HISTORICAL_QUEUE=task.then(()=>undefined,()=>undefined);
  return task;
}
async function oddsPapiArchivedPrematch(env,home,away,date,status){
  const statusCode=String(status||'NS').toUpperCase();
  const isLive=/^(1H|2H|HT|ET|BT|P|LIVE|INT|SUSP|IN_PLAY|HALFTIME)$/.test(statusCode);
  const isPostponed=/^(CANC|CANCELLED|CANCELED|PST|POSTPONED|ABD|ABANDONED|DELAYED|INTERRUPTED)$/.test(statusCode);
  const isFinished=/^(FT|AET|PEN|FINISHED|FULL_TIME|AWD|WO|WALKOVER)$/.test(statusCode);
  const statusKey=isFinished?'finished':isPostponed?'postponed':isLive?'live':'archive';
  const cacheKey='oddspapi:iddaa:prematch-archive:v3:'+statusKey+':'+oddsPapiNorm(home)+':'+oddsPapiNorm(away)+':'+date;
  return (await cached(cacheKey,async()=>{
    try{
      // broad discovery intentionally omits statusId/hasOdds so finished and cancelled fixtures remain findable.
      const matched=await oddsPapiFixtureForMatch(env,home,away,date,true);
      if(!matched)return {body:{source:'iddaa',provider:'OddsPapi',available:false,isLive,markets:[],updatedAt:new Date().toISOString(),message:'Bu karşılaşma OddsPapi arşivindeki fikstürlerle eşleştirilemedi. Kayıtlı maç önü marketi yok.'},ttl:300};
      const fixture=matched.fixture;
      const [history,catalog]=await Promise.all([
        oddsPapiHistoricalJSON(env,{fixtureId:fixture.fixtureId,bookmakers:'iddaa'}),
        oddsPapiMarketsCatalog(env)
      ]);
      const prematch=oddsPapiHistoricalPrematchBody(history,fixture.startTime||fixture.start_time);
      const markets=prematch?oddsPapiNormalizeMarkets(prematch,catalog,matched.reversed):[];
      return {body:{source:'iddaa',provider:'OddsPapi',available:markets.length>0,isLive,preMatchSnapshot:true,historicalSnapshot:true,fixtureId:String(fixture.fixtureId),home,away,markets,totalMarkets:markets.length,updatedAt:history.updatedAt||new Date().toISOString(),message:markets.length?'':'OddsPapi arşivinde maç başlamadan önceye ait kullanılabilir İddaa marketi bulunamadı.'},ttl:markets.length?86400:300};
    }catch(error){
      return {body:{source:'iddaa',provider:'OddsPapi',available:false,isLive,markets:[],updatedAt:new Date().toISOString(),message:'Maç önü arşivi alınamadı. Bu karşılaşma için tarihsel kayıt bulunmayabilir veya arşiv servisi geçici hata vermiş olabilir; cihazda önceden kaydedilmiş market varsa o gösterilir. ('+String(error&&error.message||error).slice(0,120)+')'},ttl:300};
    }
  })).body;
}
async function oddsPapiIddaaOddsForMatch(env,home,away,date,status){
  const statusCode=String(status||'NS').toUpperCase();
  const live=/^(1H|2H|HT|ET|BT|P|LIVE|INT|SUSP|IN_PLAY|HALFTIME)$/.test(statusCode);
  const historical=/^(FT|AET|PEN|FINISHED|FULL_TIME|AWD|WO|WALKOVER|CANC|CANCELLED|CANCELED|PST|POSTPONED|ABD|ABANDONED|DELAYED|INTERRUPTED)$/.test(statusCode);
  if(live||historical)return oddsPapiArchivedPrematch(env,home,away,date,statusCode);
  const cacheKey='oddspapi:iddaa:match:v3:'+oddsPapiNorm(home)+':'+oddsPapiNorm(away)+':'+date;
  return (await cached(cacheKey,async()=>{
    const matched=await oddsPapiFixtureForMatch(env,home,away,date);
    if(!matched)return {body:{source:'iddaa',provider:'OddsPapi',available:false,isLive:false,markets:[],updatedAt:new Date().toISOString(),message:'OddsPapi fikstürlerinde bu karşılaşma güvenli biçimde eşleştirilemedi. İddaa bu maça oran sağlamıyor olabilir.'},ttl:180};
    const fixture=matched.fixture;
    const [oddsBody,marketCatalog]=await Promise.all([
      oddsPapiJSON(env,'odds',{fixtureId:fixture.fixtureId,bookmakers:'iddaa',language:'en',verbosity:3}),
      oddsPapiMarketsCatalog(env)
    ]);
    const markets=oddsPapiNormalizeMarkets(oddsBody,marketCatalog,matched.reversed);
    if(markets.length)return {body:{source:'iddaa',provider:'OddsPapi',available:true,isLive:false,fixtureId:String(fixture.fixtureId),home,away,markets,totalMarkets:markets.length,updatedAt:oddsBody.updatedAt||new Date().toISOString(),message:''},ttl:1800};
    const archived=await oddsPapiArchivedPrematch(env,home,away,date,statusCode);
    if(archived&&archived.markets&&archived.markets.length)return {body:archived,ttl:archived.historicalSnapshot?86400:180};
    return {body:{source:'iddaa',provider:'OddsPapi',available:false,isLive:false,fixtureId:String(fixture.fixtureId),home,away,markets:[],totalMarkets:0,updatedAt:oddsBody.updatedAt||new Date().toISOString(),message:archived&&archived.message||'Bu karşılaşma için İddaa maç önü marketi bulunamadı.'},ttl:180};
  })).body;
}

async function nosyIddaaFetch(env,path,params={}){
  const key=String(env.NOSYAPI_KEY||env.NOSYAPI_API_KEY||'').trim();if(!key)throw new Error('NOSYAPI_KEY gizli değişkeni tanımlı değil.');
  const url=new URL('https://www.nosyapi.com/apiv2/service/'+path);for(const [k,v] of Object.entries(params))if(v!=null&&v!=='')url.searchParams.set(k,String(v));
  const response=await fetch(url.toString(),{headers:{'X-NSYP':key,'Accept':'application/json'}});if(!response.ok)throw new Error('NosyAPI HTTP '+response.status);
  const body=await response.json();if(body&&body.status&&body.status!=='success')throw new Error(body.messageTR||body.message||'NosyAPI veri hatası');return body;
}
function nosyIddaaNormalize(value){return pitchNorm(String(value||'')).replace(/[^a-z0-9]+/g,' ').trim();}
function nosyIddaaMarkets(match,reverse=false){
  const mapSelection=id=>reverse?(id==='1'?'2':id==='2'?'1':id):id;
  const markets=[];const raw=Array.isArray(match&&match.Bets)?match.Bets:[];
  for(const bet of raw){let marketName=String(bet.gameName||bet.name||'Bahis'),marketDetails=String(bet.gameDetails||'');if(reverse){const swapSides=value=>String(value||'').replace(/__EVSAHIBI__/g,'Deplasman').replace(/__DEPLASMAN__/g,'Ev Sahibi').replace(/ev\s+sahibi/gi,'__EVSAHIBI__').replace(/deplasman/gi,'__DEPLASMAN__').replace(/__EVSAHIBI__/g,'Deplasman').replace(/__DEPLASMAN__/g,'Ev Sahibi');marketName=swapSides(marketName);marketDetails=swapSides(marketDetails)}const outcomes=(Array.isArray(bet.odds)?bet.odds:[]).map((o,i)=>{const odd=Number(o&&o.odd);if(!Number.isFinite(odd)||odd<=1)return null;let label=String(o.value||o.label||o.name||('Seçim '+(i+1)));const n=nosyIddaaNormalize(label);let id=/^(1|ev sahibi|home|ev sahibi kazanir)$/.test(n)?'1':/^(0|x|beraberlik|draw)$/.test(n)?'X':/^(2|deplasman|away|deplasman kazanir)$/.test(n)?'2':String(o.id||o.gameID||label);id=mapSelection(id);if(reverse){if(/^(ev sahibi|home)$/i.test(label))label='Deplasman';else if(/^(deplasman|away)$/i.test(label))label='Ev Sahibi';else if(label==='1')label='2';else if(label==='2')label='1';}return {id,label,odd};}).filter(Boolean);if(outcomes.length)markets.push({id:String(bet.gameID||bet.id||markets.length),name:marketName,details:marketDetails,type:String(bet.type||''),outcomes});}
  const has1x2=markets.some(m=>/maç sonucu|mac sonucu|kim kazanir|maç sonucu 1x2/i.test(m.name));
  if(!has1x2){const values=reverse?[['2','2',match.HomeWin],['X','X',match.Draw],['1','1',match.AwayWin]]:[['1','1',match.HomeWin],['X','X',match.Draw],['2','2',match.AwayWin]];const outcomes=values.map(([id,label,value])=>({id,label,odd:Number(value)})).filter(x=>Number.isFinite(x.odd)&&x.odd>1);if(outcomes.length)markets.unshift({id:'match-result',name:'Maç Sonucu (1-X-2)',details:'İddaa maç sonucu pazarı',type:'Kim Kazanır',outcomes});}
  return markets;
}
async function nosyIddaaOddsForMatch(env,home,away,date,status){
  const key=nosyIddaaNormalize(home)+'|'+nosyIddaaNormalize(away)+'|'+date;
  const live=/^(1H|2H|HT|ET|P|LIVE|INT)$/.test(String(status||'').toUpperCase());
  return (await cached('nosy:iddaa:match:'+key+':'+(live?'live':'pre'),async()=>{
    const scheduleCache=await cached('nosy:iddaa:program:v1:'+date,async()=>({body:await nosyIddaaFetch(env,'bettable-matches',{type:1,date}),ttl:live?8:30}));const schedule=scheduleCache.body;let matches=Array.isArray(schedule&&schedule.data)?schedule.data:[];
    const h=nosyIddaaNormalize(home),a=nosyIddaaNormalize(away);
    const similarity=(left,right)=>{if(left===right)return 1;if(!left||!right)return 0;if(left.includes(right)||right.includes(left))return .91;const x=new Set(left.split(' ')),y=new Set(right.split(' '));let common=0;for(const token of x)if(y.has(token))common++;return common/Math.max(1,new Set([...x,...y]).size);};
    const rankMatches=rows=>rows.map(m=>{const one=nosyIddaaNormalize(m.Team1||''),two=nosyIddaaNormalize(m.Team2||'');const direct=similarity(one,h)+similarity(two,a),reverseScore=similarity(one,a)+similarity(two,h);return {m,reverse:reverseScore>direct,score:Math.max(direct,reverseScore),direct,reverseScore};}).filter(x=>x.score>=1.72).sort((x,y)=>y.score-x.score);
    let scored=rankMatches(matches),best=scored[0],ambiguous=best&&scored[1]&&Math.abs(best.score-scored[1].score)<.08;
    // Kick-off sonrası program listesinden çıkan veya yalnızca canlı listede kalan
    // karşılaşmaları da bulmak için resmî program servisinin popüler/canlı listesine bak.
    if(live&&(!best||ambiguous||!Number(best.m.LiveStatus||0))){
      try{
        const popularCache=await cached('nosy:iddaa:popular:v1:football',async()=>({body:await nosyIddaaFetch(env,'bettable-matches/popular',{type:1}),ttl:8}));
        const popular=Array.isArray(popularCache.body&&popularCache.body.data)?popularCache.body.data:[];
        const popularRanked=rankMatches(popular),popularBest=popularRanked[0],popularAmbiguous=popularBest&&popularRanked[1]&&Math.abs(popularBest.score-popularRanked[1].score)<.08;
        if(popularBest&&!popularAmbiguous&&(!best||ambiguous||Number(popularBest.m.LiveStatus||0)||popularBest.score>best.score)){scored=popularRanked;best=popularBest;ambiguous=false;}
      }catch(_){}
    }
    const match=!ambiguous&&best?best.m:null;if(!match||!match.MatchID)return {body:{source:'iddaa',provider:'NosyAPI',available:false,markets:[],updatedAt:new Date().toISOString(),message:'Bu maç İddaa bülteninde bulunamadı veya takım adı güvenli biçimde eşleştirilemedi.'},ttl:15};
    const reversed=!!best.reverse;
    const detailCache=await cached('nosy:iddaa:details:v1:'+String(match.MatchID)+':'+(live?'live':'pre'),async()=>({body:await nosyIddaaFetch(env,'bettable-matches/details',{matchID:match.MatchID}),ttl:live?8:30}));const details=detailCache.body;const detail=Array.isArray(details&&details.data)?details.data[0]||match:(details&&details.data&&typeof details.data==='object'?details.data:match);
    const markets=nosyIddaaMarkets(detail,reversed);
    return {body:{source:'iddaa',provider:'NosyAPI',available:markets.length>0,matchId:String(match.MatchID),isLive:!!Number(match.LiveStatus||detail.LiveStatus||0),providerReversed:reversed,updatedAt:new Date((Number(details.systemTime||schedule.systemTime)||Date.now()/1000)*1000).toISOString(),home,away,markets,message:markets.length?'':'Bu maç için oran pazarı bulunamadı.'},ttl:live?8:30};
  })).body;
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(request.url), p = url.pathname, q = url.searchParams;
    const todayTR = new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);
    try {
      let res;
      if (p === "/fixtures") {
        const date = q.get("date") || todayTR;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: "Geçersiz tarih" }, 400);
        const ttl = date === todayTR ? 5 : date < todayTR ? 21600 : 3600;
        if (q.get("part") === "s") {
          res = await cached("ss:" + date, async () => {
            const r = await ssDay(env, date, todayTR);
            return { body: { source: "SportScore", parts: PARTS, capped: r.capped, response: r.list }, ttl: date === todayTR ? 5 : ttl };
          });
        } else {
          const part = Number(q.get("part") || 0);
          if (!Number.isInteger(part) || part < 0 || part >= PARTS) return json({ source: "ESPN", parts: PARTS, response: [] });
          res = await cached("f:" + date + ":" + part, async () => ({
            body: { source: "ESPN", parts: PARTS, response: await dayList(date, part) },
            ttl,   // bugün 30 sn: canlı skorlar
          }));
        }
      } else if (p === "/match") {
        const sm = (q.get("id") || "").match(/^s:([a-z0-9-]+):([a-z0-9]+)$/i);
        if (sm) {
          res = await ssDetailC(env, sm[1], sm[2]);
          return json(res.body, 200, { "X-Cache": res.state });
        }
        const tm = (q.get("id") || "").match(/^t:(\d+)$/i);
        if (tm) {
          res = await cached("m:t:" + tm[1], async () => { const body=await tsdbMatchDetail(tm[1]); const s=body.match.fixture.status.short; return { body, ttl:["1H","2H","HT","ET","P"].includes(s)?30:["FT","AET","PEN"].includes(s)?21600:(body.match.lineups||[]).length?300:60 }; });
          return json(res.body, 200, { "X-Cache": res.state });
        }
        const am = (q.get("id") || "").match(/^a:(\d+)$/i);
        if (am) {
          const fast = q.get("fast") === "1";
          res = await cached("m:a:" + am[1] + (fast ? ":fast" : ":full"), async () => {
            const body=await apiFootballMatchDetail(env,am[1]);
            if(!fast)await improveMatchStats(body.match);
            const s=body.match.fixture.status.short;
            return { body, ttl:["1H","2H","HT","ET","P"].includes(s)?(fast?8:20):["FT","AET","PEN"].includes(s)?21600:(body.match.lineups||[]).length?300:60 };
          });
          return json(res.body, 200, { "X-Cache": res.state });
        }
        const fm = (q.get("id") || "").match(/^fd:(\d+)$/i);
        if (fm) {
          res = await cached("m:fd:" + fm[1], async () => {
            const body = await footballDataMatchDetail(env, fm[1]), s = body.match.fixture.status.short;
            return { body, ttl:["1H","2H","HT","ET","P"].includes(s)?20:["FT","AET","PEN"].includes(s)?21600:(body.match.lineups||[]).length?300:60 };
          });
          return json(res.body, 200, { "X-Cache": res.state });
        }
        const m = (q.get("id") || "").match(/^e:([a-z0-9._-]+):(\d+)$/i);
        if (!m) return json({ error: "Geçersiz maç numarası" }, 400);
        const hn0 = q.get("home"), an0 = q.get("away"), dt0 = q.get("date");
        const altP = hn0 && an0 && dt0 ? ssFindByTeams(env, istDay(dt0), hn0, an0, todayTR).catch(() => null) : Promise.resolve(null);
        altP.catch(() => {});
        try {
          const fast = q.get("fast") === "1";
          res = await cached("m:" + m[1] + ":" + m[2] + (fast ? ":fast" : ":full"), async () => {
            const j = await getJSON(SITE + m[1] + "/summary?event=" + m[2]);
            const r = parseSummary(j, m[1], m[2]);
            if(!fast)await Promise.all([improveMatchLineups(env, r.match), improveMatchStats(r.match)]);
            return { body: { match: r.match }, ttl: r.live ? (fast?5:8) : r.done ? 3600 : (r.match.lineups || []).length ? 300 : 60 };
          });
        } catch (e) {
          // ESPN detayı vermezse (403 vb.) aynı maçı SportScore'da takım adı + gün ile bulup onun detayını veririz.
          const alt = await altP;
          if (!alt) throw e;
          const r2 = await ssDetailC(env, alt.slug, alt.id);
          const mt = JSON.parse(JSON.stringify(r2.body.match));
          mt.fallback = "SportScore";
          return json({ match: mt }, 200, { "X-Cache": "FALLBACK" });
        }
      } else if (p === "/search") {
        const term = (q.get("q") || "").trim().slice(0, 60);
        const type = ["coach", "team", "league"].includes(q.get("type")) ? q.get("type") : "player";
        const fast = q.get("fast") === "1";
        if (term.length < 1) return json({ error: "Aramak için en az 1 harf yaz" }, 400);
        res = await cached("q23:" + (fast ? "fast:" : "full:") + type + ":" + term.toLowerCase(), async () => {
          const r = await searchAll(env, term, type, fast);
          return { body: r, ttl: r.items.length ? 900 : r.allFailed ? 5 : 60 };
        });
      } else if (p === "/player") {
        const slug = (q.get("slug") || "").trim(), nm = (q.get("name") || "").trim().slice(0, 80), tmId = (q.get("tm") || "").replace(/\D/g, ""), tsId = (q.get("tsdb") || "").replace(/\D/g, ""), afId = (q.get("af") || "").replace(/\D/g, ""), espnId = (q.get("espn") || "").replace(/\D/g, ""), teamHint = (q.get("team") || "").slice(0, 100), posHint = (q.get("pos") || "").slice(0, 40), wk = (q.get("wiki") || "").slice(0, 120), initialPhoto = (q.get("photo") || "").slice(0, 500), pitchId = (q.get("pitch") || "").trim().slice(0, 80), pitchCode = canonicalPitchLeagueCode(q.get("pitchCode") || ""), pitchYear = String(q.get("pitchYear") || "").slice(0, 4), part = q.get("part") === "info" ? "info" : q.get("part") === "stats" ? "stats" : "all", role = q.get("role") === "coach" ? "coach" : "player";
        if (slug && !/^[A-Za-z0-9._\/-]{2,120}$/.test(slug)) return json({ error: "Geçersiz oyuncu" }, 400);
        if (!slug && !nm && !tmId && !afId && !espnId && !tsId) return json({ error: "Oyuncu belirtilmedi" }, 400);
        res = await cached("pf32:" + role + ":" + part + ":" + (slug || tmId || afId || espnId || tsId || pitchId || nm.toLowerCase()) + ":" + tsId + ":" + afId + ":" + espnId + ":" + pitchId + ":" + pitchCode + ":" + pitchYear + ":" + teamSearchKey(teamHint), async () => {
          const r = await playerFull(env, slug, nm, tmId, tsId, wk, part, role, afId, teamHint, posHint, espnId, initialPhoto, pitchId, pitchCode, pitchYear);
          const hasCareer = !!((r.seasons && r.seasons.length) || (r.coach && r.coach.length));
          const providerErrors = Object.values(r.sources || {}).some(value => /HTTP 429|rate limit|zaman aşımı|HTTP 5\d\d|timeout/i.test(String(value)));
          return { body: r, ttl: part === "info" ? 21600 : hasCareer ? 21600 : providerErrors ? 90 : 1800 };
        });
      } else if (p === "/team") {
        let code = q.get("code") || "";
        const id = (q.get("id") || "").replace(/\D/g, ""), tsId = (q.get("tsdb") || "").replace(/\D/g, ""), nm = (q.get("name") || "").slice(0, 80);
        const afRequested = (q.get("af") || "").replace(/\D/g, ""), fallbackLogo = /^https:\/\//i.test(q.get("logo") || "") ? (q.get("logo") || "").slice(0, 500) : "", year = Number(q.get("season")) || seasonStartYear();
        if (!/^[a-z0-9._-]*$/i.test(code) || !Number.isInteger(year) || year < 1900 || year > seasonStartYear() + 1) return json({ error: "Geçersiz takım veya sezon" }, 400);
        const cleanNm = careerTeamLogoLookupName(nm);
        let id2 = id, afTeam = null;
        // A career row can carry an ID from a different provider/team alias. Verify
        // that it really belongs to the clicked club before using its schedule.
        if (id2 && code && cleanNm) {
          try {
            const check = await getJSON(SITE + code + "/teams/" + id2);
            const foundTeam = check.team || check;
            const foundName = foundTeam.displayName || foundTeam.name || foundTeam.shortDisplayName || "";
            if (!foundName || (teamSearchKey(foundName) !== teamSearchKey(cleanNm) && !nameLike(foundName, cleanNm) && !nameLike(cleanNm, foundName))) id2 = "";
          } catch (_) { id2 = ""; }
        }
        if ((!id2 || !code || !META[code]) && cleanNm) {
          try {
            const found = await espnTeamSearch(cleanNm);
            const exact = found.filter(x => teamSearchKey(x.name) === teamSearchKey(cleanNm));
            if (exact.length === 1) {
              id2 = String(exact[0].id || id2 || "");
              code = exact[0].code || code;
            }
          } catch (_) {}
        }
        if (!id2 && cleanNm) {
          try {
            const directory = await espnCareerTeamDirectory();
            const exact = directory.filter(t => teamSearchKey(t.name) === teamSearchKey(cleanNm));
            if (exact.length === 1) { id2 = String(exact[0].id || ""); code = exact[0].code || code; }
          } catch (_) {}
        }
        if (!id2 && code && cleanNm) {
          try {
            const tl = (await cached("tl:" + code, async () => ({ body: await getJSON(SITE + code + "/teams"), ttl: 86400 }))).body;
            const arr = ((tl.sports && tl.sports[0] && tl.sports[0].leagues && tl.sports[0].leagues[0] && tl.sports[0].leagues[0].teams) || []).map(x => x.team);
            const exact = arr.filter(t => teamSearchKey(t.displayName || t.name) === teamSearchKey(cleanNm));
            const f = exact.length === 1 ? exact[0] : null;
            if (f) id2 = String(f.id);
          } catch (_) {}
        }
        if (!id2 && !code && nm) {
          try {
            const found = await espnTeamSearch(nm), exact = found.filter(x => teamSearchKey(x.name) === teamSearchKey(nm));
            const f = exact.length === 1 ? exact[0] : null;
            if (f) { id2 = String(f.id); code = f.code || ""; }
          } catch (_) {}
        }
        if (apiFootballKey(env) && (afRequested || cleanNm)) {
          try { afTeam = await resolveApiFootballTeam(env, cleanNm, afRequested); } catch (_) {}
        }
        const afTeamId = afTeam && afTeam.id || "";
        const seasonsPromise = afTeamId ? apiFootballTeamSeasons(env, afTeamId).catch(() => []) : code ? apiFootballLeagueSeasons(env, code).catch(() => []) : Promise.resolve([]);
        res = await cached("team:v15:" + [code,id2,afTeamId,tsId,cleanNm.toLowerCase(),year,fallbackLogo].join(":"), async () => {
          let espnBody = null, err = "";
          if (code && META[code] && id2) { try { espnBody = await teamEspn(code, id2, year); } catch (e) { err = e.message || String(e); } }
          let afFixtures = { rows: [], limited: false };
          if (afTeamId && apiFootballKey(env)) {
            try { afFixtures = await apiFootballTeamFixtures(env, afTeamId, year); }
            catch (e) { err = err || (e.message || String(e)); }
          }
          const merged = mergeFixtureRows([espnBody && espnBody.groups ? espnBody.groups.flatMap(g => g.matches || []) : [], afFixtures.rows])
            .filter(match => {
              const apiSeason = Number(match && match.league && match.league.season);
              if (String(match && match.fixture && match.fixture.id || "").startsWith("a:") && apiSeason) return apiSeason === year;
              return isInTeamSeason(match, (match && match.league && match.league.code) || code || "tur.1", year);
            });
          let team = espnBody && espnBody.team || null;
          if (!team || !team.name) team = { id: id2 || afTeamId || tsId || "", name: (afTeam && afTeam.name) || cleanNm, logo: "" };
          if (afTeam) {
            if (!team.logo && afTeam.logo) team.logo = afTeam.logo;
            if (!team.country && afTeam.country) team.country = afTeam.country;
            if (!team.founded && afTeam.founded) team.founded = afTeam.founded;
            if (!team.venue && afTeam.venue) team.venue = afTeam.venue;
            if (!team.city && afTeam.city) team.city = afTeam.city;
          }
          if (!team.logo && afTeamId) team.logo = "https://media.api-sports.io/football/teams/" + afTeamId + ".png";
          if (!team.logo && fallbackLogo) team.logo = fallbackLogo;
          if (year === seasonStartYear() && (merged.length < 8 || !team.founded) && (nm || tsId)) {
            // ESPN/AF bazen yalnızca birkaç fikstür döndürüyor. TheSportsDB'yi
            // tamamlayıcı kaynak olarak da birleştir; maç ID/tarih/takım eşleşmesiyle yinelenenleri temizle.
            try {
              const ts = await teamTsdb(nm, tsId);
              if (ts.team) { if (!team.logo) team.logo = ts.team.logo || ""; if (!team.founded) team.founded = ts.team.founded || ""; } if (ts.groups && ts.groups.length && merged.length < 8) { merged.push(...ts.groups.flatMap(g => g.matches || [])); }
            } catch (e) { err = err || (e.message || String(e)); }
          }
          const groups = groupTeamFixtures(merged);
          if (!groups.length && !team.name) throw new Error("Takım bulunamadı");
          if (!groups.length && year !== seasonStartYear() && !apiFootballKey(env)) err = "Geçmiş sezon maçları için API_FOOTBALL_KEY gerekli; ESPN geçmiş sezonu bu takım için döndürmedi.";
          const years = await seasonsPromise;
          const seasons = years.length ? years : recentSeasonYears(20);
          const primaryCode = code || (afFixtures.rows.map(m => m.league.code).find(Boolean) || "");
          let tables = [];
          if (afTeamId && apiFootballKey(env)) {
            try { tables = await apiFootballStandingsForTeam(env, primaryCode, year, afTeamId); } catch (_) {}
          }
          if (!tables.length && primaryCode && META[primaryCode]) {
            try { tables = parseStandings(await getJSON(SITE_V2 + primaryCode + "/standings?season=" + encodeURIComponent(String(year)))); } catch (_) {}
          }
          return { body: { team: { ...team, id: team.id || id2 || afTeamId || "" }, code: primaryCode, afTeamId: afTeamId || "", groups, tables, seasons, season: year, source: afFixtures.rows.length && espnBody ? "ESPN + API-Football" : afFixtures.rows.length ? "API-Football" : espnBody ? "ESPN" : "ESPN / TheSportsDB", limited: !!afFixtures.limited || merged.some(m => m.league && m.league.fixturesLimited), warning: err }, ttl: year === seasonStartYear() ? 900 : 21600 };
        });
      } else if (p === "/favs") {
        res = await cached("favs", async () => { const r = await favs(); const ok = r.teams.filter((t) => t.logo).length + r.players.filter((x) => x.logo).length; return { body: r, ttl: ok >= 12 ? 86400 : 120 }; });
      } else if (p === "/league-logos") {
        res = await cached("league-logos:v10", async () => ({ body: await leagueLogos(), ttl: 86400 }));
      } else if (p === "/roster") {
        const code = q.get("code") || "", id = (q.get("id") || "").replace(/\D/g, ""), afRequested = (q.get("af") || "").replace(/\D/g, ""), tsdb = (q.get("tsdb") || "").replace(/\D/g, ""), name = (q.get("name") || "").slice(0, 80), year = Number(q.get("season")) || seasonStartYear();
        if (!/^[a-z0-9._-]*$/i.test(code) || !Number.isInteger(year) || year < 1900 || year > seasonStartYear() + 1) return json({ error: "Geçersiz takım sezonu" }, 400);
        let resolvedAf = afRequested;
        if (!resolvedAf && apiFootballKey(env) && name) { try { const found = await resolveApiFootballTeam(env, name); if (found) resolvedAf = found.id; } catch (_) {} }
        res = await cached("roster:v8:" + [code,id,resolvedAf,tsdb,year].join(":"), async () => {
          let afRosterError = "", data = null, players = [];
          if (resolvedAf && apiFootballKey(env)) {
            try { data = year === seasonStartYear() ? await apiFootballCurrentSquad(env, resolvedAf, name) : await apiFootballRoster(env, resolvedAf, year, name); players = data.players || []; }
            catch (e) { afRosterError = e && e.message || String(e); }
          }
          if (year === seasonStartYear()) {
            let tmRosterCount = 0;
            if (code && id) { try { players = mergeRosterPhotoSources(players, await rosterEspn(code, id)); } catch (_) {} }
            if (name || tsdb) { try { players = mergeRosterPhotoSources(players, await tsdbTeamRoster(name, tsdb)); } catch (_) {} }
            if (name) { try { const tmRows = await tmTeamRoster(env, name); tmRosterCount = tmRows.length; players = mergeRosterPhotoSources(players, tmRows); } catch (_) {} }
            if (players.length && name && code) players = await pitchApplyRosterPhotos(env, players, name, code, year);
            if (players.length) return { body: { players, limited: !!(data && data.limited), season: year, source: [resolvedAf ? "API-Football" : "", code && id ? "ESPN" : "", name || tsdb ? "TheSportsDB" : "", tmRosterCount ? "Transfermarkt DB" : ""].filter(Boolean).join(" + "), note: (data && data.note || "") + (afRosterError ? " API-Football: " + afRosterError : "") }, ttl: 21600 };
            if (afRosterError) throw new Error(afRosterError);
            throw new Error("Bu takımın güncel kadrosu kaynaklarda bulunamadı.");
          }
          if (players.length) {
            if (name && code) players = await pitchApplyRosterPhotos(env, players, name, code, year);
            return { body: { players, limited: !!(data && data.limited), season: year, source: "API-Football", note: data && data.note || "" }, ttl: 21600 };
          }
          if (afRosterError) throw new Error(afRosterError);
          throw new Error(apiFootballKey(env) ? "Bu takım ve sezon için sağlayıcı geçmiş kadro verisi sunmuyor." : "Geçmiş sezon kadrosu için Worker'a API_FOOTBALL_KEY secret'ı eklenmeli. Geçmiş sezonun tamamı için sağlayıcı kapsaması gerekir.");
        });
      } else if (p === "/pitch-fixtures") {
        const code = canonicalPitchLeagueCode(q.get("code") || "");
        const rawYear = q.get("season") || String(seasonStartYear());
        const year = Number(String(rawYear).slice(0,4));
        if (!code || !Number.isInteger(year) || year < 1900 || year > seasonStartYear()+1) return json({ error:"Geçersiz PitchAPI ligi veya sezonu." },400);
        res = await cached("pitch:fixtures:" + PITCH_MATCH_CACHE_VERSION + ":" + code + ":" + rawYear, async () => {
          const league = await pitchLeagueForCode(env, code, year);
          const matches = await pitchLeagueMatches(env, league.id, league.season, "all");
          const fixtures = matches.map(m => pitchAppFixture(m, code, league.name, league.season)).filter(m => m.pitchId);
          fixtures.sort((a,b)=>Date.parse(a.fixture.date||0)-Date.parse(b.fixture.date||0));
          // Fikstür tur numarasını yalnızca sağlayıcının gerçek round alanından al.
          // Takvim haftasını lig maç haftası gibi göstermek 1, 10, 2 sıralaması ve hatalı tur üretirdi.
          return { body:{ code, league:league.name, season:league.season, fixtures, source:"PitchAPI", roundFallback:false }, ttl:600 };
        });
      } else if (p === "/pitch-match-data") {
        const code = q.get("code") || "", date = q.get("date") || "", home = q.get("home") || "", away = q.get("away") || "";
        if (!code || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !home || !away) return json({error:"PitchAPI maç eşleştirmesi için lig, tarih ve iki takım gerekli."},400);
        const year = Number(q.get("season") || "0"), forceRefresh = q.get("refresh") === "1";
        const refreshToken = forceRefresh ? ":refresh:" + Math.floor(Date.now()/30000) : "";
        const key = "pitch:match-lookup:" + PITCH_MATCH_CACHE_VERSION + ":" + [code,date,pitchNorm(home),pitchNorm(away),year].join(":") + refreshToken;
        res = await cached(key, async () => {
          const body=await pitchMatchLookup(env,code,date,home,away,year,forceRefresh);
          const status=String(body&&body.match&&body.match.fixture&&body.match.fixture.status&&body.match.fixture.status.short||"");
          const live=["1H","HT","2H","ET","P","SUSP","INT"].includes(status);
          return { body, ttl:forceRefresh?10:live?12:300 };
        });
      } else if (p === "/pitch-match-fast") {
        const id = (q.get("id") || "").trim(), code = canonicalPitchLeagueCode(q.get("code") || ""), forceRefresh = q.get("refresh") === "1";
        if (!/^m_[A-Za-z0-9]{6}$/.test(id)) return json({error:"Geçersiz PitchAPI maç kimliği."},400);
        const refreshToken = forceRefresh ? ":refresh:" + Math.floor(Date.now()/30000) : "";
        res = await cached("pitch:match-fast:" + PITCH_MATCH_CACHE_VERSION + ":" + id + refreshToken, async () => {
          const body = await pitchMatchFastById(env,id,code,forceRefresh);
          return {body,ttl:10};
        });
      } else if (p === "/pitch-match-events") {
        const id=(q.get("id")||"").trim(),forceRefresh=q.get("refresh")==="1";
        if(!/^m_[A-Za-z0-9]{6}$/.test(id))return json({error:"Geçersiz PitchAPI maç kimliği."},400);
        const refreshToken=forceRefresh?":refresh:"+Math.floor(Date.now()/30000):"";
        res=await cached("pitch:match-events-route:"+PITCH_MATCH_CACHE_VERSION+":"+id+refreshToken,async()=>({body:await pitchMatchEventsById(env,id,forceRefresh),ttl:forceRefresh?8:20}));
      } else if (p === "/pitch-match-detail") {
        const id = (q.get("id") || "").trim(), code = canonicalPitchLeagueCode(q.get("code") || ""), forceRefresh = q.get("refresh") === "1";
        if (!/^m_[A-Za-z0-9]{6}$/.test(id)) return json({error:"Geçersiz PitchAPI maç kimliği."},400);
        const refreshToken = forceRefresh ? ":refresh:" + Math.floor(Date.now()/30000) : "";
        res = await cached("pitch:match-direct:" + PITCH_MATCH_CACHE_VERSION + ":" + id + refreshToken, async () => ({ body:await pitchMatchBundleById(env,id,code,null,forceRefresh), ttl:10 }));
       } else if (p === "/pitch-match-photos") {
        const id=(q.get("id")||"").trim();
        if(!/^m_[A-Za-z0-9]{6}$/.test(id))return json({error:"Geçersiz PitchAPI maç kimliği."},400);
        res=await cached("pitch:live-photos:v3:"+id,async()=>{
          const [playersResult,lineupsResult]=await Promise.allSettled([
            cached("pitch:live-photo-rows:v2:"+id,async()=>({body:await pitchApiJSON(env,"/v1/matches/"+encodeURIComponent(id)+"/players"),ttl:10})),
            cached("pitch:live-photo-lineups:v1:"+id,async()=>({body:await pitchApiJSON(env,"/v1/matches/"+encodeURIComponent(id)+"/lineups"),ttl:10}))
          ]);
          const rows=playersResult.status==="fulfilled"?pitchUnwrapList(playersResult.value.body,["players"]):[];
          const photos=rows.map(row=>{const player=row&&row.player||{};return {id:String(player.id||player.player_id||row.player_id||""),name:String(player.name||player.full_name||player.short_name||""),team_id:String(row.team_id||row.team&&row.team.id||""),image_url:String(player.image_url||player.photo||row.image_url||"")};}).filter(row=>/^https:\/\//i.test(row.image_url));
          const root=playersResult.status==="fulfilled"?playersResult.value.body:{};
          const lineupRoot=(lineupsResult.status==="fulfilled"?(lineupsResult.value.body.data||lineupsResult.value.body):{});
          const teams={home:lineupRoot.home_team||lineupRoot.homeTeam||{},away:lineupRoot.away_team||lineupRoot.awayTeam||{}};
          const missing=[];
          for(const sideKey of ["home","away"]){
            const side=lineupRoot[sideKey]||lineupRoot[sideKey+"_team_lineup"]||{};
            const team=side.team||teams[sideKey]||{};
            for(const entry of (side.starters||side.startXI||side.starting_xi||[])){
              const p=entry&&entry.player&&typeof entry.player==="object"?{...entry,...entry.player}:(entry||{});
              const pid=String(p.player_id||p.id||"");
              if(!/^p_[A-Za-z0-9]{6}$/.test(pid)||photos.some(x=>x.id===pid))continue;
              missing.push({id:pid,name:p.name||p.short_name||p.full_name||"",team_id:String(side.team_id||team.id||""),team_name:String(team.name||""),pos:String(p.position||p.position_name||"")});
            }
          }
          const unique=[...new Map(missing.map(x=>[x.id,x])).values()];
          const profileRows=await Promise.allSettled(unique.map(async item=>({ ...item, image_url:await pitchPlayerPhotoFromProfile(env,item.id) })));
          for(const result of profileRows)if(result.status==="fulfilled"&&/^https:\/\//i.test(String(result.value.image_url||"")))photos.push(result.value);
          const photoIds=new Set(photos.map(x=>String(x.id||"")));
          const stillMissing=unique.filter(item=>!photoIds.has(String(item.id)));
          let cursor=0;
          const espnWorkers=Array.from({length:Math.min(4,stillMissing.length)},async()=>{
            while(cursor<stillMissing.length){
              const item=stillMissing[cursor++];
              const image=await pitchResolveEspnLineupPhoto(item.name,item.team_name,item.pos).catch(()=>'');
              if(/^https:\/\//i.test(String(image||'')))photos.push({...item,image_url:image,photo_source:'ESPN'});
            }
          });
          if(espnWorkers.length)await Promise.allSettled(espnWorkers);
          return {body:{photos},ttl:30};
        });
       } else if (p === "/pitch-match-analytics") {
        const id=(q.get("id")||"").trim();
        if(!/^m_[A-Za-z0-9]{6}$/.test(id))return json({error:"Geçersiz PitchAPI maç kimliği."},400);
        res=await cached("pitch:live-analytics:v3:"+id,async()=>{
          // The live snapshot supplies the current event/stat feed; the five analytic resources
          // are fetched independently so a missing network never blocks the shot map, etc.
          const specs=[["live","/live"],["advanced","/advanced"],["network","/advanced/network"],["heatmaps","/heatmaps?frame=home_ltr"],["momentum","/momentum"],["shots","/shots"]];
          const settled=await Promise.allSettled(specs.map(async([key,path])=>{
            try{
              const result=await cached("pitch:live-analytics-endpoint:v3:"+id+":"+key,async()=>({body:await pitchApiJSON(env,"/v1/matches/"+encodeURIComponent(id)+path),ttl:key==="live"?12:10}));
              return [key,result.body];
            }catch(error){
              if(pitchExpectedMissingAnalytics(error))return [key,null];
              throw error;
            }
          }));
          const analytics={errors:{}};
          settled.forEach((item,index)=>{
            const key=specs[index][0];
            if(item.status==="fulfilled")analytics[key]=item.value[1];
            else analytics.errors[key]=item.reason&&item.reason.message||String(item.reason);
          });
          return {body:{analytics},ttl:8};
        });
       } else if (p === "/pitch-match-player") {
        const id = (q.get("id") || "").trim(), player = (q.get("player") || "").trim();
        const playerName = (q.get("name") || "").trim().slice(0,100), teamName = (q.get("team") || "").trim().slice(0,100);
        if (!/^m_[A-Za-z0-9]{6}$/.test(id) || (!/^p_[A-Za-z0-9]+$/.test(player) && !playerName)) return json({error:"Geçersiz maç veya oyuncu bilgisi."},400);
        const identity = (/^p_[A-Za-z0-9]+$/.test(player) ? player : pitchNorm(playerName))+":"+pitchNorm(teamName);
        // v12 invalidates previous player-stat responses and enables direct + API-Football fallback lookup. A live match is refreshed
        // from the dedicated snapshot and player-list endpoints on their live cadence.
        const key = "pitch:match-player:v13:" + id + ":" + identity;
        res = await cached(key, async () => {
          let liveRoot=null, liveRows=[];
          try {
            const liveResult=await cached("pitch:match-player-live:v13:"+id,async()=>({
              body:await pitchApiJSON(env,"/v1/matches/"+encodeURIComponent(id)+"/live"),ttl:10
            }));
            liveRoot=liveResult.body&&(liveResult.body.data||liveResult.body)||null;
            if(liveRoot)liveRows=pitchExtractLivePlayerRows(liveRoot);
          } catch (_) {}
          const rawLiveStatus=liveRoot&&(liveRoot.status||liveRoot.match&&liveRoot.match.status)||"";
          const liveStatus=rawLiveStatus&&typeof rawLiveStatus==="object"?(rawLiveStatus.short||rawLiveStatus.code||rawLiveStatus.status||rawLiveStatus.name||""):rawLiveStatus;
          const isLive=!!(liveRoot&&(liveRoot.live===true||["1H","HT","2H","ET","P","SUSP","INT"].includes(pitchMatchStatus(liveStatus))));
          let rows=[];
          try{
            const listResult = await cached("pitch:match-player-list:v13:"+id, async () => ({
              body: await pitchApiJSON(env,"/v1/matches/"+encodeURIComponent(id)+"/players"),
              ttl: isLive ? 10 : 21600
            }));
            rows=pitchUnwrapList(listResult.body,["players"]);
          }catch(_){rows=[];}
          if(liveRoot&&liveRows.length)rows=pitchMergeLivePlayerRows(rows,liveRoot);
          let line = null;
          const idMatch=row=>String(row&&row.player&&(row.player.id||row.player.player_id)||row&&row.player_id||"")===player;
          if (/^p_[A-Za-z0-9]+$/.test(player)) line = rows.find(idMatch) || null;
          // The match lineups and /players feed can occasionally expose different IDs or name forms.
          // Resolve with the actual team first, then a conservative full/short-name match.
          let expectedTeamId="";
          if(teamName){
            try{
              const summary=await cached("pitch:match-summary:"+PITCH_MATCH_CACHE_VERSION+":"+id,async()=>({body:await pitchApiJSON(env,"/v1/matches/"+encodeURIComponent(id)),ttl:1800}));
              const d=summary.body||{},home=d.home_team||{},away=d.away_team||{};
              if(pitchTeamNameMatches(teamName,home.name))expectedTeamId=String(home.id||"");
              else if(pitchTeamNameMatches(teamName,away.name))expectedTeamId=String(away.id||"");
            }catch(_){}
          }
          const rowMatchesName=row=>{
            const p=row&&row.player||{},names=[p.name,p.full_name,p.short_name].filter(Boolean);
            if(!names.some(n=>pitchPlayerNameMatches(playerName,n)))return false;
            const actualTeamId=String(row&&(row.team_id||row.team&&row.team.id)||"");
            const actualTeamName=String(row&&row.team&&row.team.name||"");
            if(expectedTeamId&&actualTeamId&&expectedTeamId!==actualTeamId)return false;
            if(teamName&&actualTeamName&&!pitchTeamNameMatches(teamName,actualTeamName))return false;
            return true;
          };
          if(!line&&playerName){
            const candidates=rows.filter(rowMatchesName);
            candidates.sort((a,b)=>(pitchNorm(b&&b.player&&b.player.name)===pitchNorm(playerName)?1:0)-(pitchNorm(a&&a.player&&a.player.name)===pitchNorm(playerName)?1:0));
            line=candidates[0]||null;
          }
          let resolvedPlayer=String(line&&(line.player&&(line.player.id||line.player.player_id)||line.player_id)||(/^p_[A-Za-z0-9]+$/.test(player)?player:""));
          let directRoot=null;
          const fetchDirect=async pid=>{
            if(!/^p_[A-Za-z0-9]+$/.test(String(pid||"")))return null;
            try{
              const direct=await cached("pitch:match-player-direct:v13:"+id+":"+pid,async()=>({body:await pitchApiJSON(env,"/v1/matches/"+encodeURIComponent(id)+"/players/"+encodeURIComponent(pid)),ttl:isLive?10:21600}));
              const root=direct.body&&(direct.body.data||direct.body)||{};
              const stats=root.stats||root.statistics||[];
              if(pitchHasPlayerStatValues(stats)){
                directRoot=root;
                line={...(line||{}),...root,player:{...(line&&line.player||{}),...(root.player||{})},stats};
                resolvedPlayer=String(line.player&&line.player.id||pid);
                return line;
              }
              return null;
            }catch(error){
              // A bad/stale player ID should not abort the name-based fallback.
              if(error&&error.code==="PLAN_UPGRADE_REQUIRED")throw error;
              return null;
            }
          };
          if(resolvedPlayer)await fetchDirect(resolvedPlayer);
          if((!line||!pitchHasPlayerStatValues(line.stats))&&playerName){
            // As a last identity source, resolve the player's provider ID from the confirmed match lineup.
            try{
              const lineupResult=await cached("pitch:match-lineups-for-player:v4:"+id,async()=>({body:await pitchApiJSON(env,"/v1/matches/"+encodeURIComponent(id)+"/lineups"),ttl:isLive?10:21600}));
              const root=lineupResult.body&&(lineupResult.body.data||lineupResult.body)||{};
              const sides=[root.home,root.away,root.home_team_lineup,root.away_team_lineup].filter(Boolean);
              let found=null;
              const walk=(node,depth=0)=>{
                if(!node||depth>7||found)return;
                if(Array.isArray(node)){for(const item of node)walk(item,depth+1);return;}
                if(typeof node!=="object")return;
                const p=node.player&&typeof node.player==="object"?node.player:node;
                const nm=p.name||p.full_name||p.short_name||"";
                const pid=p.player_id||p.id||node.player_id||"";
                const sideTeam=String(node.team&&node.team.name||node.team_name||"");
                if(nm&&pid&&pitchPlayerNameMatches(playerName,nm)&&(!teamName||!sideTeam||pitchTeamNameMatches(teamName,sideTeam))){found=String(pid);return;}
                for(const [key,value] of Object.entries(node))if(value&&typeof value==="object")walk(value,depth+1);
              };
              sides.forEach(side=>walk(side));
              if(found&&/^p_[A-Za-z0-9]+$/.test(found)){resolvedPlayer=found;await fetchDirect(found);}
            }catch(_){}
          }
          let fallbackSource="PitchAPI";
          if((!line||!pitchHasPlayerStatValues(line.stats))&&playerName){
            // PitchAPI can omit a player line while API-Football still publishes the live line.
            try{
              const summary=await cached("pitch:match-summary:"+PITCH_MATCH_CACHE_VERSION+":"+id,async()=>({body:await pitchApiJSON(env,"/v1/matches/"+encodeURIComponent(id)),ttl:1800}));
              const afRows=await pitchApiFootballRatingsForMatch(env,summary.body||{},null);
              const candidates=afRows.filter(row=>pitchPlayerNameMatches(playerName,row.name)&&(!teamName||!row.teamName||pitchRatingTeamMatches(teamName,row.teamName)));
              const exact=candidates.filter(row=>pitchNorm(row.name)===pitchNorm(playerName));
              const afPlayer=exact.length===1?exact[0]:candidates.length===1?candidates[0]:null;
              if(afPlayer){
                const afStats=pitchApiFootballStatsToGroups(afPlayer.statistics);
                if(afStats.length){
                  line={...(line||{}),player:{...(line&&line.player||{}),id:line&&line.player&&line.player.id||afPlayer.id||"",name:afPlayer.name||playerName,image_url:afPlayer.photo||line&&line.player&&line.player.image_url||""},team_id:line&&line.team_id||afPlayer.teamId||"",stats:afStats};
                  if(afPlayer.rating!=null)line.rating=afPlayer.rating;
                  fallbackSource="API-Football";
                }
              }
            }catch(_){}
          }
          if(!line) return { body:{ player:{name:playerName},stats:[],rating:null,advanced:null,source:"PitchAPI",matched:false }, ttl:isLive?8:60 };
          let advanced = null;
          if (!isLive && /^p_[A-Za-z0-9]+$/.test(resolvedPlayer)) {
            try {
              const response = await pitchApiJSON(env,"/v1/matches/"+encodeURIComponent(id)+"/advanced/players/"+encodeURIComponent(resolvedPlayer));
              advanced = response && (response.player || response) || null;
            } catch (error) {
              if (!pitchExpectedMissingAnalytics(error)) throw error;
            }
          }
          let rating = pitchMetricValue(line,["rating","rating_title","average_rating"]) ?? (advanced ? pitchMetricValue(advanced,["rating","rating_title","average_rating"]) : null);
          if(rating==null){
            try{
              const detailResult=await cached("pitch:match-summary:"+PITCH_MATCH_CACHE_VERSION+":"+id,async()=>({body:await pitchApiJSON(env,"/v1/matches/"+encodeURIComponent(id)),ttl:1800}));
              const fallbackRows=await pitchApiFootballRatingsForMatch(env,detailResult.body||{},null);
              rating=pitchApiFootballRatingForPlayer(fallbackRows,line.player||{name:playerName},{name:line.team&&line.team.name||teamName});
            }catch(_){}
          }
          const playerData=line.player||{name:playerName};
          const playerPhoto=playerData.image_url||playerData.photo||"";
          const lineStats=line.stats||line.statistics||line.player_stats||[];
          return { body:{
            player:{...playerData,logo:/^https:\/\//i.test(playerPhoto)?playerPhoto:"",photo:/^https:\/\//i.test(playerPhoto)?playerPhoto:""},
            team_id:line.team_id||line.team&&line.team.id||"",
            position_id:line.position_id||playerData.position_id||null,
            stats:lineStats,rating:line.rating??rating,advanced,source:fallbackSource,matched:true,
            live:isLive
          }, ttl:isLive?8:300 };
        });
      } else if (p === "/pitch-stat-leaders") {
        const code = canonicalPitchLeagueCode(q.get("code") || ""), year = Number(q.get("season") || seasonStartYear());
        const metric = (q.get("metric") || "goals").trim();
        const rawOffset = Number(q.get("offset") || 0), offset = Number.isInteger(rawOffset) && rawOffset >= 0 ? rawOffset : -1;
        const rawLimit = Number(q.get("limit") || 10), limit = Number.isInteger(rawLimit) && rawLimit >= 1 && rawLimit <= 10 ? rawLimit : -1;
        if (!code || !Number.isInteger(year) || year < 1900 || year > seasonStartYear()+1 || offset < 0 || limit < 0 || !PITCH_STAT_METRICS[metric]) return json({error:"Geçersiz lig istatistiği, sezon, sayfa veya sayfa boyutu."},400);
        res = await cached("pitch:stat-leaders:v2:" + PITCH_MATCH_CACHE_VERSION + ":" + code + ":" + year + ":" + metric + ":" + offset + ":" + limit, async () => ({body:await pitchStatLeaderBatch(env,code,year,metric,offset,limit),ttl:300}));
      } else if (p === "/pitch-week-team") {
        const code=canonicalPitchLeagueCode(q.get("code")||""),year=Number(q.get("season")||seasonStartYear()),week=(q.get("week")||"").trim().slice(0,200);
        if(!code||!Number.isInteger(year)||year<1900||year>seasonStartYear()+1||!(/^(?:round:[^|]+(?:\|dates:\d{4}-\d{2}-\d{2}(?:,\d{4}-\d{2}-\d{2})*)?|week:\d{4}-\d{2}-\d{2}(?:,\d{4}-\d{2}-\d{2})*)$/.test(week)))return json({error:"Geçersiz lig, sezon veya hafta."},400);
        res=await cached("pitch:week-team:v10:"+code+":"+year+":"+pitchNorm(week),async()=>({body:await pitchWeekTeamBatch(env,code,year,week),ttl:900}));
      } else if (p === "/pitch-team-standings") {
        const code=canonicalPitchLeagueCode(q.get("code")||""),year=Number(q.get("season")||seasonStartYear());
        if(!code||!Number.isInteger(year)||year<1900||year>seasonStartYear()+1)return json({error:"Geçersiz lig veya sezon."},400);
        res=await cached("pitch:team-standings:v3:"+code+":"+year,async()=>({body:await pitchTeamStandingsForCode(env,code,year),ttl:1800}));
      } else if (p === "/match-h2h") {
        const home=(q.get("home")||"").trim().slice(0,100),away=(q.get("away")||"").trim().slice(0,100),code=(q.get("code")||"").trim(),season=(q.get("season")||"").trim();
        if(!home||!away)return json({error:"İkili rekabet için iki takım adı gerekli."},400);
        const cacheKey="match-h2h:v2:"+pitchNorm(code)+":"+season+":"+pitchNorm(home)+":"+pitchNorm(away);
        res=await cached(cacheKey,async()=>{
          let h2h=null,source="";
          if(code){try{const candidate=await pitchH2HByNamesInLeague(env,code,season,home,away);if(pitchH2HHasRecords(candidate)){h2h=candidate;source="PitchAPI lig geçmişi";}}catch(_){}}
          if(!pitchH2HHasRecords(h2h)){try{const candidate=await apiFootballH2HByNames(env,home,away);if(pitchH2HHasRecords(candidate)){h2h=candidate;source="API-Football";}}catch(_){}}
          return {body:{h2h,source},ttl:h2h?21600:600};
        });
      } else if (p === "/iddaa-odds") {
        const home=(q.get("home")||"").trim().slice(0,100),away=(q.get("away")||"").trim().slice(0,100),date=(q.get("date")||"").trim(),status=(q.get("status")||"NS").trim().toUpperCase();
        if(!home||!away||!/^\d{4}-\d{2}-\d{2}$/.test(date))return json({error:"İddaa maçı için ev/deplasman adı veya tarih geçersiz."},400);
        if(!env.ODDSPAPI_KEY&&!env.ODDSPAPI_API_KEY)return json({source:"iddaa",provider:"OddsPapi",available:false,sourceConfigured:false,markets:[],message:"OddsPapi erişimi için Cloudflare Worker Secrets bölümüne ODDSPAPI_API_KEY (veya ODDSPAPI_KEY) eklenmeli.",officialUrl:"https://www.iddaa.com/program/futbol"});
        const odds=await oddsPapiIddaaOddsForMatch(env,home,away,date,status);res={body:{...odds,sourceConfigured:true,officialUrl:"https://www.iddaa.com/program/futbol"},state:"MISS"};
      } else if (p === "/pitch-team-stats") {
        const code=canonicalPitchLeagueCode(q.get("code")||""),year=Number(q.get("season")||seasonStartYear()),team=(q.get("team")||"").trim().slice(0,100);
        const rawOffset=Number(q.get("offset")||0),offset=Number.isInteger(rawOffset)&&rawOffset>=0?rawOffset:-1,rawLimit=Number(q.get("limit")||20),limit=Number.isInteger(rawLimit)&&rawLimit>=1&&rawLimit<=20?rawLimit:-1;
        if(!code||!team||!Number.isInteger(year)||year<1900||year>seasonStartYear()+1||offset<0||limit<0)return json({error:"Geçersiz takım istatistiği isteği."},400);
        res=await cached("pitch:team-stats:v15:"+code+":"+year+":"+pitchNorm(team)+":"+offset+":"+limit,async()=>({body:await pitchTeamStatsBatch(env,code,year,team,offset,limit),ttl:300}));
      } else if (p === "/pitch-player-photo") {
        const name=(q.get("name")||"").trim().slice(0,100),team=(q.get("team")||"").trim().slice(0,100),player=(q.get("player")||"").trim(),pos=(q.get("pos")||"").trim().slice(0,40),code=canonicalPitchLeagueCode(q.get("code")||""),season=Number(q.get("season")||seasonStartYear());
        if(!name||!team||!code)return json({photo:"",message:"Fotoğraf eşleştirmesi için oyuncu, takım ve lig gerekli."},400);
        if(!pitchApiKey(env))return json({photo:"",message:"PitchAPI anahtarı tanımlı değil."},400);
        const cacheKey="pitch:photo-recovery:v1:"+[player,pitchNorm(name),pitchNorm(team),code,season].join(":");
        res=await cached(cacheKey,async()=>{
          let photo=await pitchResolvePlayerPhoto(env,player,name,team,code,season).catch(()=>"");
          if(!photo)photo=await pitchResolveEspnLineupPhoto(name,team,pos).catch(()=>"");
          return {body:{photo:photo||"",source:photo?"Oyuncu profil/yedek görsel kaynağı":""},ttl:photo?604800:21600};
        });
      } else if (p === "/pitch-team-player-photos") {
        const teamName = (q.get("team") || "").trim().slice(0, 100);
        const code = canonicalPitchLeagueCode(q.get("code") || "");
        const year = Number(q.get("season") || seasonStartYear());
        if (!teamName || !code || !Number.isInteger(year) || year < 1900 || year > seasonStartYear() + 1) return json({ error: "Geçersiz PitchAPI takım fotoğrafı isteği." }, 400);
        if (!pitchApiKey(env)) return json({ error: "PitchAPI entegrasyonu için PITCH_API_KEY gizli değişkeni gerekli." }, 400);
        const cacheKey = "pitch:team-player-photos:v1:" + [pitchNorm(teamName), code, year].join(":");
        res = await cached(cacheKey, async () => ({ body: { photos: await pitchTeamRosterPhotoMap(env, teamName, code, year), source: "PitchAPI" }, ttl: 86400 }));
      } else if (p === "/pitch-player-recent") {
        const playerId = (q.get("player") || "").trim();
        const playerName = (q.get("name") || "").trim().slice(0, 100);
        const teamName = (q.get("team") || "").trim().slice(0, 100);
        const code = canonicalPitchLeagueCode(q.get("code") || "");
        const year = Number(q.get("season") || seasonStartYear());
        if ((!/^p_[A-Za-z0-9]+$/.test(playerId) && !playerName) || !code || !Number.isInteger(year) || year < 1900 || year > seasonStartYear() + 1) return json({ error: "Geçersiz PitchAPI oyuncusu, takım, lig veya sezon." }, 400);
        if (!pitchApiKey(env)) return json({ error: "PitchAPI entegrasyonu için PITCH_API_KEY gizli değişkeni gerekli." }, 400);
        const rawLimit=Number(q.get("limit")||60),scanLimit=rawLimit===13?13:60;
        const cacheKey = "pitch:player-recent:v8:" + [playerId, pitchNorm(playerName), pitchNorm(teamName), code, year, scanLimit].join(":");
        res = await cached(cacheKey, async () => ({ body: await pitchPlayerRecentBatch(env, playerId, playerName, teamName, code, year, scanLimit), ttl: 300 }));
      } else if (p === "/pitch-player-resolve") {
        const name = (q.get("name") || "").trim().slice(0, 100);
        const team = (q.get("team") || "").trim().slice(0, 100);
        const code = canonicalPitchLeagueCode(q.get("code") || "");
        const season = (q.get("season") || "").trim();
        const rawOffset = Number(q.get("offset") || 0);
        const offset = Number.isInteger(rawOffset) && rawOffset >= 0 ? rawOffset : -1;
        if (!name || !code || offset < 0) return json({ error: "PitchAPI oyuncu adı, lig kodu veya sayfa numarası geçersiz." }, 400);
        if (!pitchApiKey(env)) return json({ error: "PitchAPI için PITCH_API_KEY gizli değişkeni gerekli." }, 400);
        if (!season) {
          res = await cached("pitch-player-resolve-seasons:v4:" + code, async () => {
            const league = await pitchLeagueInfoForCode(env, code);
            return { body: { code, league: league.name, seasons: league.seasons }, ttl: 43200 };
          });
        } else {
          if (season.length > 12 || !/^(?:19|20)\d{2}(?:\/\d{4})?$/.test(season)) return json({ error: "Geçersiz sezon biçimi." }, 400);
          const cacheKey = "pitch-player-resolve:v4:" + code + ":" + season + ":" + pitchNorm(name) + ":" + pitchNorm(team) + ":" + offset;
          res = await cached(cacheKey, async () => ({ body: await pitchPlayerResolveBatch(env, name, team, code, season, offset), ttl: 86400 }));
        }
      } else if (p === "/pitch-player-career") {
        const playerId = (q.get("player") || "").trim(), code = canonicalPitchLeagueCode(q.get("code") || "");
        const playerName = (q.get("name") || "").trim().slice(0,100);
        const season = (q.get("season") || "").trim(), rawOffset = Number(q.get("offset") || 0);
        const offset = Number.isInteger(rawOffset) && rawOffset >= 0 ? rawOffset : -1;
        if (!/^p_[A-Za-z0-9]+$/.test(playerId) || !code || offset < 0) return json({ error: "Geçersiz PitchAPI oyuncusu, lig veya sayfa numarası." }, 400);
        if (!pitchApiKey(env)) return json({ error: "PitchAPI entegrasyonu için Skor3 Worker ayarlarına PITCH_API_KEY gizli değişkeni eklenmeli." }, 400);
        if (!season) {
          res = await cached("pitch-player-seasons:v6:" + code, async () => {
            const league = await pitchLeagueInfoForCode(env, code);
            return { body: { league: league.name, seasons: league.seasons }, ttl: 43200 };
          });
        } else {
          if (season.length > 12 || !/^(?:19|20)\d{2}(?:\/\d{4})?$/.test(season)) return json({ error: "Geçersiz sezon biçimi." }, 400);
          res = await cached("pitch-player-career:v16:" + playerId + ":" + pitchNorm(playerName) + ":" + code + ":" + season + ":" + offset, async () => {
            const body = await pitchPlayerSeasonBatch(env, playerId, code, season, offset, playerName);
            const incomplete = Number(body.failedMatches || 0) + Number(body.failedEvents || 0) + Number(body.failedLineups || 0) + Number(body.missingEvents || 0) + Number(body.missingLineups || 0) > 0;
            return { body, ttl: incomplete ? 180 : 900 };
          });
        }
      } else if (p === "/pitch-leaders") {
        const code = q.get("code") || "", year = Number(q.get("season")) || seasonStartYear(), rawOffset = Number(q.get("offset") || 0);
        const offset = Number.isInteger(rawOffset) && rawOffset >= 0 ? rawOffset : -1;
        if (!META[code] || !Number.isInteger(year) || year < 1900 || year > seasonStartYear() + 1 || offset < 0) return json({ error: "Geçersiz lig, sezon veya parça numarası." }, 400);
        res = await cached("pitch-leaders:v4:" + code + ":" + year + ":" + offset, async () => ({ body: await pitchLeaderBatch(env, code, year, offset), ttl: 900 }));
      } else if (p === "/league") {
        const code = q.get("code") || "", year = Number(q.get("season")) || seasonStartYear();
        const dynamicLeague = code.match(/^af-(\d+)$/i);
        if (!/^[a-z0-9._-]+$/i.test(code) || (!META[code] && !dynamicLeague) || !Number.isInteger(year) || year < 1900 || year > seasonStartYear() + 1) return json({ error: "Geçersiz lig veya sezon" }, 400);
        res = await cached("league:v6:" + code + ":" + year, async () => {
          const body = dynamicLeague ? await apiFootballLeagueDataById(env, dynamicLeague[1], year) : await leagueData(env, code, year);
          const leaderFailed = !!(body.errors && (body.errors.goals || body.errors.assists));
          return { body, ttl: leaderFailed ? 60 : 900 };
        });
      } else if (p === "/standings") {
        const code = q.get("league") || "", teamId = (q.get("team") || "").replace(/\D/g, ""), year = Number(q.get("season")) || seasonStartYear();
        if ((!code && !teamId) || (code && !/^[a-z0-9._-]+$/i.test(code)) || !Number.isInteger(year) || year < 1900 || year > seasonStartYear() + 1) return json({ error: "Geçersiz lig veya sezon" }, 400);
        res = await cached("standings:v6:" + [code,teamId,year].join(":"), async () => {
          let tables = [];
          try { tables = teamId ? await apiFootballStandingsForTeam(env, code, year, teamId) : await apiFootballStandings(env, code, year); } catch (_) {}
          if (!tables.length && code && META[code]) { try { tables = parseStandings(await getJSON(SITE_V2 + code + "/standings?season=" + encodeURIComponent(String(year)))); } catch (_) {} }
          return { body: { tables, season: year }, ttl: tables.length ? 1800 : 300 };
        });
      } else {
        return json({ error: "Bilinmeyen adres" }, 404);
      }
      return json(res.body, 200, { "X-Cache": res.state });
    } catch (e) {
      return json({ error: e.message }, 502);
    }
  },
};