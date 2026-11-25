# SkorHane – PostgreSQL / Transfermarkt Veri Katmanı

Bu depo, SkorHane'nin oyuncu, kadro, transfer, piyasa değeri ve sezon istatistiklerini Supabase PostgreSQL üzerinde tutar. Transfermarkt'a ait kaynak istekleri tarayıcıdan değil, GitHub Actions içinde başlatılan yerel Felipe API sunucusu ve Python senkronizasyon işçileri üzerinden yapılır.

## 1. Mimari

```text
Transfermarkt veri kaynağı
          │
          ▼
felipeall/transfermarkt-api (v5.0.0)
          │
          ▼
GitHub Actions
  ├─ sync/sync_squads_and_clubs.py
  │    ├─ lig → kulüpler
  │    ├─ kulüp → güncel kadro
  │    ├─ 1.5–3.0 sn istek aralığı
  │    └─ lig/kulüp checkpoint + tekrar çalıştırma
  └─ sync/sync_transfermarkt.py
       ├─ oyuncu profili
       ├─ piyasa değeri geçmişi
       ├─ transfer geçmişi
       ├─ sezon istatistikleri
       ├─ sakatlıklar / eksik maçlar
       └─ güncel sezon maçları
          │
          ▼
Supabase PostgreSQL
  ├─ tm_players
  ├─ tm_player_season_stats
  ├─ tm_transfers
  ├─ tm_market_values
  ├─ tm_appearances
  ├─ tm_source_records
  └─ tm_sync_runs
          ▲
          │ yalnızca DB okuma
Cloudflare Worker → SkorHane HTML
```

- GitHub Actions, Felipe API'yi aynı runner üzerinde `127.0.0.1:8000` adresinde başlatır. Harici bir API token'ı gerekmez.
- Supabase'e yazma işlemleri `SUPABASE_SERVICE_ROLE_KEY` ile sunucu tarafında yapılır. Bu anahtar HTML dosyasına veya istemci JavaScript'ine konulmamalıdır.
- Kadro işçisi yalnızca normalize edilmiş alanları yazar; ham HTML ve tam upstream yanıtları Supabase'e kopyalanmaz.
- UPSERT fonksiyonları dolu alanları korur. Hata, boş yanıt veya eksik alan mevcut dolu oyuncu verisini silmek için kullanılmaz.

## 2. Veri kaynağı ve endpoint eşleştirmesi

### A. felipeall/transfermarkt-api

Depo: https://github.com/felipeall/transfermarkt-api

**Güncel lig ve kadro aktarımı** `sync/sync_squads_and_clubs.py` tarafından yapılır:

| Aktarım | Felipe API endpoint'i | Supabase hedefi |
|---|---|---|
| Lig → kulüpler | `GET /competitions/{competition_id}/clubs?season_id=` | Lig/kulüp ilerleme bilgisi `tm_source_records` |
| Kulüp → takım profili | `GET /clubs/{club_id}/profile` | Logo, resmi ad, lig, teknik direktör ve stadyum alanları `tm_source_records` |
| Kulüp → güncel kadro | `GET /clubs/{club_id}/players?season_id=` | `tm_players` |
| Oyuncu fotoğrafı | Kadro yanıtındaki `image_url` | `tm_players.photo_url` |
| Güncel piyasa değeri | Kadro yanıtındaki `market_value` | `tm_players.current_market_value_*` |
| Mevcut takım / mevki | Kadro yanıtındaki `current_club`, `position` | `tm_players.team_name`, `position` |
| Katılım / geldiği kulüp | `joined_on`, `signed_from` | `tm_transfers` içinde tekil gözlem |

Kadro endpoint'i oyuncu ID'si, adı, fotoğrafı, pozisyonu, forma numarası, kaptanlık, uyruk, boy, ayak, katılım tarihi, geldiği kulüp, sözleşme tarihi ve piyasa değeri alanlarını tanımlar. Mevcut veritabanı şemasında ayrı bir kulüp/lig tablosu bulunmadığı için takım adı oyuncu kaydında tutulur; küçük senkronizasyon checkpoint'leri `tm_source_records` tablosuna yazılır.

**Oyuncu detayları** aynı API'nin aşağıdaki endpoint'leriyle `sync/sync_transfermarkt.py` tarafından güncellenir:

| Veri | Endpoint |
|---|---|
| Profil ve fotoğraf | `GET /players/{player_id}/profile` |
| Piyasa değeri ve geçmişi | `GET /players/{player_id}/market_value` |
| Transfer geçmişi | `GET /players/{player_id}/transfers` |
| Sezon istatistikleri | `GET /players/{player_id}/stats` |
| Oynanan maçlar | `GET /players/{player_id}/matches?season_id=&page_number=` |
| Sakatlık geçmişi | `GET /players/{player_id}/injuries?page_number=` |
| Diğer eksiklikler | `GET /players/{player_id}/absences?page_number=` |

Yeni kadrodan eklenen oyuncular `tm_players` tablosuna UPSERT edilir; mevcut oyuncu detay kuyruğu bunları sonraki çalışmalarda tamamlar.

**Önemli kaynak notu:** Felipe API'nin kendi README'si, Transfermarkt'ın kullandığı JSON arayüzünün dahili ve belgelenmemiş olduğunu; upstream'in değişebileceğini ve projenin MIT lisansının Transfermarkt verisine kullanım hakkı vermediğini belirtir. Üretimde veya ticari yayında kullanmadan önce Transfermarkt'ın güncel koşullarını ve veri kullanım izinlerini kontrol et. Bu worker engel aşma, proxy döndürme veya WAF atlatma yapmaz.

### B. dcaribou/transfermarkt-scraper

Depo: https://github.com/dcaribou/transfermarkt-scraper

- Yalnızca `seed-history` manuel göreviyle çalışır; normal kadro cron'u bu aracı çağırmaz.
- Varsayılan ligler `TR1,GB1,ES1,L1,IT1,FR1`; tarihsel sezonlar `2022,2023,2024,2025` (sezon başlangıç yılı) olarak tanımlıdır.
- Tarihsel oyuncu ve maç performansları tekilleştirilir; tekrar çalıştırmalarda checkpoint kullanılır.
- Crawler eşzamanlılığı 1'dir; tamamlanan kulüp ve oyuncu batch'leri tekrar taranmaz.
- Tarihsel seed uzun sürebilir; yalnızca ihtiyaç varsa manuel çalıştır.

## 3. Supabase kurulumu

1. Supabase'te PostgreSQL projesi oluştur.
2. **SQL Editor** bölümünde `database/001_transfermarkt_schema.sql` dosyasının tamamını çalıştır.
3. `tm_players`, `tm_player_season_stats`, `tm_transfers`, `tm_market_values`, `tm_appearances`, `tm_source_records` ve `tm_sync_runs` tablolarının oluştuğunu kontrol et.
4. Project URL ve sunucu tarafı service-role/secret anahtarını al. Anahtarı gizli tut.

SQL şeması RLS'i açar ve tabloları `anon` / `authenticated` rollerine kapatır. Arka plan görevleri ve Worker yalnızca sunucu tarafındaki erişim anahtarını kullanır.

## 4. GitHub Actions kurulumu

GitHub deposunda **Settings → Secrets and variables → Actions → Secrets** bölümüne şu iki secret'ı ekle:

| Secret | Değer |
|---|---|
| `SUPABASE_URL` | Supabase Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase servis/secret anahtarı |

Felipe API, workflow içinde klonlanıp runner üzerinde başlatılır. Kadro işçisi için ayrıca API token gerekmez. Zamanlanmış ana kadro/detay senkronizasyonu başlangıçta kapalıdır; testlerden sonra repository variable olarak `ENABLE_TRANSFERMARKT_CRON=true` tanımlanır.

## 5. Önerilen test sırası

1. **Eksik ligleri içe aktar:** Actions → `SkorHane Eksik Ligler — Paralel Takım ve Kadro Aktarımı`. Bu ayrı iş akışı 2. Lig grupları `TR3A, TR3B`, 3. Lig grupları `TR4A–TR4D` ile Bundesliga `L1`, Serie A `IT1` ve Ligue 1 `FR1` kadrolarını ana oyuncu detay aktarımından bağımsız içe aktarır. Dosya güncellendiğinde otomatik başlar; Actions ekranından elle de başlatılabilir.
2. **Tüm kadroları elle aktar:** Actions → `SkorHane Transfermarkt Sync` → Run workflow → `import-squads`.
3. **Supabase'i kontrol et:**

```sql
select tm_id, name, team_name, position, photo_url, current_market_value_text
from public.tm_players
where is_active = true
order by name
limit 30;
```

4. **Tek oyuncu testi:** Actions'ta `one-player-test` seçip `player_id` alanına mevcut bir `tm_id` yaz.
5. **Normal senkronizasyon:** `sync` modunu çalıştır. Önce güncel kadrolar, ardından oyuncu detayları işlenir.
6. **Tarihsel seed:** Yalnızca tarihsel maç istatistikleri gerekiyorsa `seed-history` modunu manuel başlat.

## 6. Otomatik zamanlama ve güvenli devam

- Kadro cron'u ana `transfermarkt-sync.yml` içinde pazartesi ve perşembe 03:20 UTC'de tanımlıdır. Türkiye saatiyle 06:20'dir. Başlatmak için `ENABLE_TRANSFERMARKT_CRON=true` repository variable'ını ekle.
- Kadro istekleri sırayla yapılır; her dış API çağrısından önce 1.5–3.0 saniye rastgele bekleme uygulanır. Yerel API'nin upstream eşzamanlılığı 1'dir.
- Her lig için tamamlanan kulüp ID'leri `tm_source_records` içine checkpoint olarak yazılır. Çalışma gece yarısını geçse bile `running` durumundaki checkpoint silinmez; tekrar başladığında tamamlanan kulüpleri atlayıp sıradaki kulüpten devam eder. Tamamlanan ligler aynı sezon içinde gereksiz yere yeniden içe aktarılmaz.
- Bir kulübün kadrosu boş veya geçersiz gelirse o kulüp tamamlandı sayılmaz; tekrar denenecek şekilde bırakılır.
- Bir kulübün oyuncuları yazılırken hata olursa kulüp checkpoint'i tamamlanmaz. Sonraki çalıştırma aynı kulübü yeniden işler; RPC UPSERT'leri aynı oyuncuyu çoğaltmaz.
- Dolu `photo_url`, piyasa değeri, takım adı ve diğer mevcut alanlar null/boş veriyle silinmez.
- Her çalışma `tm_sync_runs` tablosuna durum ve süre kaydı bırakır.

## 7. Cloudflare Worker

1. `SkorHane-Worker.js` dosyasını mevcut Cloudflare Worker koduyla değiştir.
2. Worker → Settings → Variables and Secrets bölümünde `SUPABASE_URL` ve `SUPABASE_SERVICE_ROLE_KEY` değerlerini tanımla.
3. Mevcut diğer futbol sağlayıcı anahtarlarını silme veya yeniden adlandırma.
4. Worker'ı Deploy et. Arayüz HTML'sinde değişiklik gerekmez.

## 8. Dosyalar

- `sync/sync_squads_and_clubs.py` – Felipe API'den lig/kulüp/kadro aktarımı.
- `sync/sync_transfermarkt.py` – oyuncu detayları, transferler, değer geçmişi, istatistik ve tarihsel seed işleri.
- `.github/workflows/transfermarkt-sync.yml` – ana manuel/zamanlanmış görevler.
- `.github/workflows/import-missing-leagues.yml` – eksik ligler için ana oyuncu yenilemesinden ayrı, paralel ve süre sınırında checkpoint’ten otomatik devam eden görev.
- `.github/workflows/resume-long-sync.yml` – 6 saatlik sert zaman aşımı durumunda yedek otomatik devam mekanizması.
- `database/001_transfermarkt_schema.sql` – tablolar, RLS ve UPSERT RPC'leri.
- `tests/` – ağ gerektirmeyen senkronizasyon testleri.
