# SkorHane — Transfermarkt veri katmanı

Bu depo, Transfermarkt oyuncu detaylarını `felipeall/transfermarkt-api` v5.0.0 üzerinden alır; GitHub Actions içinde çalışan Python işçisi verileri Supabase PostgreSQL'e yazar. Cloudflare Worker yalnızca Supabase'ten okur, eksik/eski oyuncu alanlarını algıladığında tek oyuncu yenileme iş akışını tetikler. Tarayıcı Transfermarkt'a doğrudan bağlanmaz.

## Mimari

```text
SkorHane HTML
    │
    ▼
Cloudflare Worker (skor3)
    ├─ Supabase'ten oyuncu detaylarını okur
    ├─ eksik/eski alanları kontrol eder
    ├─ oyuncu başına kalıcı kuyruk kilidi tutar
    └─ GITHUB_ACTIONS_TOKEN ile tek oyuncu workflow_dispatch
             │
             ▼
        GitHub Actions
             ├─ felipeall/transfermarkt-api v5.0.0 (127.0.0.1:8000)
             └─ sync/sync_transfermarkt.py
                    │
                    ▼
                Supabase
```

## Aktarılan alanlar

| Alan | Felipe API endpoint | Supabase hedefi |
|---|---|---|
| Oyuncu profili ve mevcut piyasa değeri | `/players/{id}/profile` | `tm_players.profile_payload`, `current_market_value_*` |
| Piyasa değeri geçmişi | `/players/{id}/market_value` | `tm_players.market_value_payload`, `tm_market_values` |
| Transfer geçmişi ve ücretler | `/players/{id}/transfers` | `tm_players.transfers_payload`, `tm_transfers` |
| Sezon istatistikleri | `/players/{id}/stats` | `tm_players.stats_payload`, `tm_player_season_stats` |
| Sakatlık geçmişi | `/players/{id}/injuries?page_number=` | `tm_players.injuries_payload` |
| Tam sezon maç verisi (tam test/normal mod) | `/players/{id}/matches` | `current_season_payload`, sezon toplamları |
| Eksik maç/diğer yokluklar (tam test/normal mod) | `/players/{id}/absences?page_number=` | `absences_payload` |

`seasonId` ve `clubId` alanları normalize edilir. `clubFrom` / `clubTo` nesneleri kulüp adına ve gerekiyorsa şeffaf `Kulüp #ID` etiketine dönüştürülür. Transfer ücreti ve piyasa değeri için EUR sayısal değerleri ile kaynağın metin gösterimi ayrı tutulur. Kaleci sezon kayıtlarında `goals_conceded` ve `clean_sheets` alanları da saklanır.

## 1. Supabase kurulumu

1. Supabase projesinin SQL Editor bölümünü aç.
2. `database/001_transfermarkt_schema.sql` dosyasının tamamını çalıştır. Dosya tabloları, güvenli UPSERT fonksiyonlarını ve RLS ayarlarını oluşturur.
3. `database/002_team_seasons_and_leaderboards.sql` dosyasını çalıştır. Bu migration lig/sezon kadro bağlantılarını, takım/oyuncu sezon toplamlarını, gol krallığı ve asist lideri görünümlerini oluşturur.
4. `database/003_player_profile_bundle.sql` dosyasını çalıştır. Oyuncu profilinin geçmiş verilerini tek sorguda getiren RPC'yi oluşturur.
5. `database/004_league_sync_dashboard_detail.sql` dosyasını çalıştır. Bu dosya `tm_league_sync_dashboard` görünümünü ayrıntılı veri kapsamı raporuyla yeniler ve sezon bazında `tm_league_sync_dashboard_seasons` görünümünü oluşturur. Yalnızca raporlama görünümleri/fonksiyonu oluşturulur; oyuncu, kadro, transfer, değer veya istatistik kayıtları silinmez.
6. Tabloların oluştuğunu doğrula: `tm_players`, `tm_player_season_stats`, `tm_transfers`, `tm_market_values`, `tm_appearances`, `tm_source_records`, `tm_sync_runs`, `tm_team_season_squads`.
7. İki dashboard görünümünü kontrol et:

```sql
select *
from public.tm_league_sync_dashboard
order by competition_id;

select *
from public.tm_league_sync_dashboard_seasons
order by competition_id, season_id desc;
```

İlk görünüm liglerin genel veri kapsamını; ikinci görünüm her lig/sezonun takım, oyuncu, piyasa değeri, sakatlık/transfer kapsamı, performans istatistikleri, gol/asist liderleri, puan tablosu ve kadro aktarım durumunu ayrı ayrı gösterir. Ayrıca `raw_stat_metric_coverage` JSON alanı, standartlaştırılmış alanların dışındaki kaynak istatistik metriklerini de dinamik olarak listeler; her metrik için kaç oyuncuda bulunduğunu, kaç kayıt içerdiğini ve sayısal toplamını verir.

Şema RLS'i etkinleştirir; tablolar `anon` ve `authenticated` rollerine kapalıdır. Yazma/okuma işlemlerinde yalnızca sunucu tarafı `service_role` anahtarı kullanılır. Bu anahtarı HTML'e veya tarayıcı JavaScript'ine asla koyma.

## 2. GitHub Secrets

GitHub deposunda **Settings → Secrets and variables → Actions → Secrets** bölümüne ekle:

| Secret | İçerik |
|---|---|
| `SUPABASE_URL` | Supabase Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service-role / secret anahtarı |

Bu iki secret GitHub Actions işçisi içindir. Workflow dosyalarında gerçek anahtar bulunmamalıdır.

## 3. Cloudflare Worker (skor3)

Cloudflare Worker → Settings → Variables and Secrets bölümünde şu secret/binding değerleri bulunmalı:

| Secret / değişken | Kullanım |
|---|---|
| `SUPABASE_URL` | Aynı Supabase Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Worker'ın sunucu tarafı Supabase erişimi |
| `GITHUB_ACTIONS_TOKEN` | Tek oyuncu workflow'unu tetikleyen fine-grained GitHub PAT |

`GITHUB_ACTIONS_TOKEN` için yalnızca bu depoya erişim ver. Fine-grained PAT için yalnızca bu depoda `Actions: Read and write` izni ver; workflow dispatch endpoint'i için gereken izin budur. Token'ı `SkorHane-HTML-kodu-kopyalanabilir.txt` içine koyma; yalnızca Cloudflare secret olarak sakla. Token sızdıysa GitHub'dan iptal edip yenisini üret.

`SkorHane-Worker.js` dosyasının tamamını Cloudflare `skor3` Worker koduyla değiştir ve Deploy et. `SkorHane-Worker-kodu-kopyalanabilir.txt` aynı içeriğin kopyasıdır.

## 4. GitHub Actions çalışma biçimi

Ana iş akışı **SkorHane Transfermarkt Tek Oyuncu Yenileme** adını taşır ve yalnızca `workflow_dispatch` ile çalışır. `push` veya cron tetikleri yoktur. Aynı oyuncu ID'si için paralel iki iş çalıştırılmaz; farklı oyuncular birbirinden bağımsız işlenebilir.

İki mod bulunur:

- `refresh-player-missing`: Yalnızca eksik veya eski profil, piyasa değeri, transfer, sezon istatistiği ve sakatlık endpoint'lerini çağırır. Güncel ve doğrulanmış boş listeyi tekrar tekrar çekmez.
- `one-player-test`: Belirtilen tek oyuncunun tüm detay endpoint'lerini ve güncel sezon maç/absans verisini tam entegrasyon testi olarak çeker.

Her iki mod da Felipe API v5.0.0 sunucusunu aynı runner üzerinde `127.0.0.1:8000` adresinde başlatır. Upstream eşzamanlılığı 1'dir; istekler gecikmeli ve sınırlı tekrar denemelidir. Toplu tarama ana iş akışından çıkarılmıştır.

Diğer lig/kadro aktarım iş akışları otomatik başlamaz. `SkorHane Eksik Ligler — Paralel Takım ve Kadro Aktarımı` yalnızca Actions ekranından manuel tetiklenir. Yeni kadro tarih aralığı için kullanılan kurtarma iş akışı da yalnızca elle verilecek iki UTC sınırıyla çalışır.

## 5. Tek seferlik canlıya alma ve test

1. Supabase SQL Editor'da `database/001_transfermarkt_schema.sql` dosyasının tamamını çalıştır.
2. GitHub Secrets içine `SUPABASE_URL` ve `SUPABASE_SERVICE_ROLE_KEY` ekle.
3. Cloudflare `skor3` Worker secret'larına `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` ve `GITHUB_ACTIONS_TOKEN` ekle. Fine-grained PAT'yi bu depoyla sınırla.
4. `SkorHane-Worker.js` dosyasını Worker'a yapıştırıp Deploy et.
5. SkorHane HTML kaynağını `SkorHane-HTML-kodu-kopyalanabilir.txt` içeriğiyle değiştir.
6. GitHub → Actions → **SkorHane Transfermarkt Tek Oyuncu Yenileme** → Run workflow.
7. İlk doğrulama için `refresh-player-missing` seç ve `player_id` alanına `401923` (Victor Osimhen) yaz. Sadece eksik/eski alanlar çağrılır.
8. Workflow tamamlandığında Actions logundaki Supabase doğrulama bölümünde güncel değer, sezon satırı, değer geçmişi, transfer ve sakatlık sayısını kontrol et.
9. SkorHane'de aynı oyuncu profilini aç. Eksik veri varsa Worker kuyruğa alır; oyuncu ekranı profili ve tüm Transfermarkt bölümlerini 6 saniye sonra, ardından 12 saniyelik aralıklarla aynı ekranda otomatik yeniler. Kuyruk uyarısı göstermez ve profili yeniden açtırmaz.
10. Bir endpoint'in tam cevabını ayrıca denemek gerektiğinde aynı workflow'da `one-player-test` modunu seç.

Supabase'te elle kontrol için:

```sql
select
  tm_id, name, current_market_value_text, current_market_value_eur,
  last_felipe_synced_at,
  jsonb_array_length(coalesce(stats_payload->'stats', '[]'::jsonb)) as raw_stats
from public.tm_players
where tm_id = '401923';

select season_id, competition_name, club_name, appearances, goals, assists,
       goals_conceded, clean_sheets
from public.tm_player_season_stats
where tm_id = '401923'
order by season_id desc;

select transfer_date, from_club, to_club, transfer_type, fee_text, fee_eur
from public.tm_transfers
where tm_id = '401923'
order by transfer_date desc;

select valuation_date, display_value, value_eur, club_name
from public.tm_market_values
where tm_id = '401923'
order by valuation_date desc;
```

## 6. Boş yanıt, 404/429 ve veri koruma kuralları

- `404`, `429`, timeout, HTTP 5xx, geçersiz JSON veya beklenmeyen response şeması oyuncuyu tamamlandı olarak işaretlemez.
- Geçici hatalarda oyuncu başına `retry_at` ve artan bekleme süresi tutulur. Kalıcı 404/410/422 veya çok sayıda başarısız deneme `blocked` durumuna geçer; profil açıldıkça aynı oyuncu için yeni workflow spam'i oluşmaz.
- Boş `stats`, `transfers` veya `marketValueHistory` cevabı eski dolu kayıtların üzerine yazılmaz. Kaynak kontrol zamanı yine güncellenerek sağlayıcının gerçekten boş döndüğü kaydedilir.
- Boş sakatlık listesi yalnızca taze ve doğrulanmış provider cevabıysa boş kabul edilir. Önceden alınmış, eski `[]` değeri doğrulanmış sayılmaz.
- Güncel piyasa değeri `NULL` veya boş string ile ezilmez; yeni bir değer yoksa mevcut değer korunur.
- Gerçekten transferi/sakatlığı olmayan oyuncuya sahte satır üretilmez. Boş sonuç, boş olarak gösterilir.
- Worker kuyruğundaki `queued`, `running`, `retry`, `blocked`, `dispatch-failed` ve `completed` durumları Python işçisi tarafından aynı Supabase kaydında güncellenir.

## 7. Güvenlik ve veri kaynağı notu

Depo Public olsa bile Supabase service-role anahtarı, GitHub PAT veya başka bir özel token kod dosyalarında tutulmamalıdır. Yalnızca GitHub Secrets ve Cloudflare Worker Secrets kullan. Depoda açıkça yazılmış token veya özel anahtar bulunursa derhal iptal et/yenile.

`felipeall/transfermarkt-api`, Transfermarkt'ın dahili ve belgelenmemiş JSON arayüzünü kullanır; upstream değişiklikleri servisi etkileyebilir. Kütüphanenin lisansı Transfermarkt verisi için ayrıca kullanım hakkı vermez. Ticari/yayın ortamında kullanımdan önce Transfermarkt'ın geçerli koşullarını ve veri kullanım izinlerini kontrol et.

## 8. Dosya özeti

| Dosya | Rol |
|---|---|
| `sync/sync_transfermarkt.py` | Felipe API çağrıları, dönüşümler, tek oyuncu yenileme kuyruğu, güvenli UPSERT |
| `sync/sync_squads_and_clubs.py` | Lig/kulüp/kadro aktarımı (ayrı manuel workflow) |
| `.github/workflows/transfermarkt-sync.yml` | Tek oyuncu / eksik alan odaklı manuel yenileme ve doğrulama |
| `.github/workflows/refresh-imported-player-details.yml` | Elle verilen UTC aralığı için isteğe bağlı toplu kurtarma |
| `.github/workflows/import-missing-leagues.yml` | Manuel eksik lig/kadro aktarımı |
| `.github/workflows/validate-detail-queues.yml` / `test-sync-workers.yml` | Manuel test ve kuyruk kontrolü |
| `database/001_transfermarkt_schema.sql` | Tablolar, güvenli merge RPC'leri, RLS ve ek sezon kolonları |
| `database/002_team_seasons_and_leaderboards.sql` | Lig/sezon kadroları, takım sezon özetleri, gol ve asist liderleri |
| `database/003_player_profile_bundle.sql` | Oyuncu profili için birleşik geçmiş veri RPC'si |
| `database/004_league_sync_dashboard_detail.sql` | Lig ve sezon bazında ayrıntılı veri kapsamı dashboard görünümleri |
| `SkorHane-Worker.js` | Canlı Cloudflare Worker |
| `SkorHane-Worker-kodu-kopyalanabilir.txt` | Worker ile birebir kopya |
| `SkorHane-HTML-kodu-kopyalanabilir.txt` | Oyuncu profil ekranı ve yenileme durumu UI'si |
| `tests/` | Ağ gerektirmeyen Python regresyon testleri |

