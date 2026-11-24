# SkorHane – PostgreSQL / Transfermarkt Veri Katmanı

Bu paket, SkorHane'nin **24 Kasım 2026 tarihli son HTML + Cloudflare Worker** dosyaları üzerine hazırlanmıştır. Transfermarkt verisi için istemci tarafına doğrudan kaynak isteği eklenmez. Arayüz ve Worker'ın Transfermarkt arama, oyuncu profili, kadro, transfer ve piyasa değeri okumaları yalnızca PostgreSQL (Supabase REST) üzerinden yapılır.

> **Durum:** Kod paketi ve veritabanı şeması hazırlandı. Kullanıcının henüz bir PostgreSQL projesi, Supabase anahtarı, GitHub deposu veya Apify token'ı olmadığı için canlı veritabanı oluşturulmadı, dış kaynaklar çalıştırılmadı ve gerçek oyuncu senkronizasyonu doğrulanmadı. Kurulum adımları tamamlandıktan sonra gerçek test yapılabilir.

## 1. Mimari

```text
Transfermarkt kaynakları
   ├─ felipeall/transfermarkt-api
   ├─ kamerozkan/transfermarkt-scraper (Apify)
   └─ dcaribou/transfermarkt-scraper (tek seferlik geçmiş seed)
                 │
                 ▼
       GitHub Actions arka plan görevleri
       ├─ jitter / düşük eşzamanlılık
       ├─ 403 / 429 / timeout tekrar denemesi
       ├─ log + devam etme
       └─ idempotent UPSERT
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
        Cloudflare Worker
                 ▲
                 │
           SkorHane HTML
```

- **Kullanıcı tıklaması Transfermarkt'a gitmez.** Arama, oyuncu sayfası ve güncel takım kadrosu Worker tarafından PostgreSQL'den okunur.
- Kaynaklara istek yalnızca GitHub Actions'ın arka plan görevleri tarafından yapılır.
- PostgreSQL erişimi `SUPABASE_SERVICE_ROLE_KEY` ile sunucu tarafında yapılır. Bu anahtar HTML dosyasına veya istemci JavaScript'ine konulmamalıdır.

## 2. Kaynakların görevleri

### A. felipeall/transfermarkt-api

Depo: https://github.com/felipeall/transfermarkt-api

- Oyuncu profili düzenli aralıklarla güncellenir.
- Aktif sezon maç endpoint'i `season_id` parametresiyle çekilir; sayfa başına 50 maç sınırı dikkate alınır.
- Oyuncu profil bilgisi ve aktif sezonun maç/performans verileri düzenli aralıklarla güncellenir.
- Normal cron eski sezon, tam kariyer istatistiği, transfer geçmişi veya piyasa değeri geçmişi endpoint'lerini çağırmaz. Tarihsel maç kayıtları dcaribou seed'inden; güncel kadro, transfer gözlemi ve piyasa değeri kamerozkan'dan gelir.
- Bu kaynak gelecek fikstür/live skor sağlayıcısı değildir.
- Varsayılan adres `https://transfermarkt-api.fly.dev` test amacıyla yayımlanmış ve hız sınırına sahip sunucudur. Kalıcı kullanımda API'yi kendi altyapında barındırıp GitHub workflow içindeki `FELIPE_API_BASE` değerini kendi adresinle değiştirmen önerilir. Public servis için güvenli aralık 3.1–4.0 saniye olarak ayarlanmıştır.

### B. kamerozkan/transfermarkt-scraper (Apify)

Actor: https://apify.com/kamerozkan/transfermarkt-scraper

- Varsayılan lig `TR1` (Türkiye Süper Lig).
- Oyuncu adı, kulüp, mevki, fotoğraf, uyruk, boy, ayak, forma numarası, sözleşme, katılım tarihi, nereden geldiği, transfer ücreti ve güncel piyasa değeri alanlarını günceller.
- Güncel kadro üyesi olarak görülen oyuncular `is_active=true` olur; son görülme zamanı da kaydedilir.
- `joinedDate` + `signedFrom` + mevcut kulüp varsa son transfer kaydı UPSERT edilir.
- Actor'ın `checkedAt` zamanı `tm_players.current_market_value_observed_at` alanına yazılır. Bu, Transfermarkt'ın resmî değerleme tarihi değil SkorHane'nin güncel değeri gördüğü zamandır. Kaynak gerçek `marketValueDate` vermedikçe bu gözlem, `tm_market_values` tarihsel değerleme satırı gibi kaydedilmez.
- Apify actor'ı oyuncu kayıt adedine göre ücretlendirme yapabilir. Çalıştırmadan önce actor'ın güncel fiyatını ve hesabındaki kullanım limitini kontrol et.
- Bu kaynak için `APIFY_TOKEN` gerekir.

Daha fazla lig eklemek için `.github/workflows/transfermarkt-sync.yml` dosyasında `TM_LEAGUES: TR1` değerini örneğin `TR1,GB1,ES1,IT1,L1,FR1` olarak değiştir. Bu, Apify tüketimini artırır.

### C. dcaribou/transfermarkt-scraper

Depo: https://github.com/dcaribou/transfermarkt-scraper

- Yalnızca `seed-history` manuel göreviyle çalışır; normal cron bu scraper'ı çağırmaz.
- Varsayılan ligler `TR1,GB1,ES1,L1,IT1,FR1`; tarihsel sezonlar `2022,2023,2024,2025` (sezon başlangıç yılı) olarak tanımlıdır. 2026/27 aktif sezonu bu tarihsel seed'den ayrı tutulur.
- Seçilen sezonların kadrolarındaki oyuncular birleştirilir; her oyuncunun maç performansları tek sefer taranıp `tm_appearances` tablosuna yazılır.
- Oyuncu ve maç kayıtları kaynak anahtarıyla tekilleştirilir; aynı seed yeniden çalıştırılırsa aynı kayıt ikinci kez çoğalmaz.
- Crawler ayarı `max_concurrency=1`, en fazla 18 istek/dakika ve 1.5–3.5 saniye rastgele beklemedir. Engelleme/erişim kısıtlamalarını aşmak için proxy kullanımı veya başka bir yöntem eklenmemiştir. Kaynak erişimi reddederse görev bunu loglar.
- Kulüp listeleri, her lig/sezon içindeki kulüp oyuncu taramaları ve tarihsel maç performansları ayrı checkpoint ile tutulur. Maç performansları varsayılan 25 oyunculuk batch'ler hâlinde çekilir; tamamlanan kulüp/batch/oyuncular yeniden taranmaz. Yarım kalan batch'in kısmi kayıtları UPSERT edilir ve yalnız o batch tekrar denenir.
- Tarihsel seed uzun sürebilir. İlk oyuncu testi tamamlanmadan çalıştırma.

Daha eski sezonları dahil etmek istersen workflow içindeki `DCARIBOU_SEASONS` listesine sezon başlangıç yıllarını ekleyebilirsin. Bu işlem daha fazla sayfa tarayacağı için daha uzun sürecektir.

## 3. PostgreSQL projesi oluşturma

Paket, Cloudflare Worker ile kolay ve güvenli REST erişimi için **Supabase üzerinde barındırılan PostgreSQL** kullanır. Supabase hesabını ve projesini kullanıcının oluşturması gerekir.

1. Supabase'te yeni bir PostgreSQL projesi oluştur.
2. Proje açıldıktan sonra **SQL Editor** bölümüne gir.
3. Bu paketteki `database/001_transfermarkt_schema.sql` dosyasının tamamını çalıştır.
4. SQL tamamlandıktan sonra `public` şemasında `tm_players`, `tm_player_season_stats`, `tm_transfers`, `tm_market_values`, `tm_appearances`, `tm_source_records` ve `tm_sync_runs` tablolarının oluştuğunu kontrol et.
5. **Project URL** ile sunucu tarafı `service_role`/secret anahtarını al. Anahtar gizli tutulmalıdır.

SQL şeması RLS'i açar ve tabloları `anon` / `authenticated` rollerine kapatır. Yazma/okuma servis anahtarına sahip arka plan görevi ve Worker üzerinden yapılır.

## 4. GitHub Actions kurulumu

1. GitHub'da özel (private) bir depo oluştur.
2. Paketteki `.github/workflows/transfermarkt-sync.yml`, `sync/`, `database/`, `requirements.txt` ve README dosyalarını deponun köküne yükle.
3. Depoda **Settings → Secrets and variables → Actions → Secrets** bölümüne şu secrets değerlerini ekle:

| Secret | Değer |
|---|---|
| `SUPABASE_URL` | Supabase Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase servis/secret anahtarı |
| `APIFY_TOKEN` | Apify API token |

`APIFY_TOKEN` olmadan kamerozkan kaynağından kadro içe aktarılamaz. `FELIPE_API_BASE` workflow dosyasında varsayılan olarak public test API adresidir; kendi API kurulumuna geçince değiştir.

4. Dosyaları deponun varsayılan dalına (ör. `main`) gönder.
5. **Actions** sekmesinde workflow'un göründüğünü kontrol et.

Zamanlanmış görev başlangıçta kapalıdır. Test başarılı olana kadar otomatik cron çalışmaz.

## 5. Cloudflare Worker kurulumu

1. Paketteki `SkorHane-Worker.js` (veya aynı içeriğin metin kopyası) dosyasını mevcut SkorHane Cloudflare Worker kodunun tamamıyla değiştir.
2. Cloudflare Worker → **Settings → Variables and Secrets** alanına şu secrets'ları ekle:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
3. Mevcut `API_FOOTBALL_KEY`, `PITCH_API_KEY` ve diğer mevcut secret değerlerini silme veya yeniden adlandırma.
4. Worker'ı Deploy et.
5. Uygulamanın HTML dosyasını değiştirmek gerekmiyor; paketteki HTML, en son sürümle aynı tutulmuştur.

## 6. Önerilen ilk test sırası

**Aşama 1 — Kadro içe aktarımı**

GitHub → Actions → `SkorHane Transfermarkt Sync` → Run workflow → `import-squads` seç. Bu adım kamerozkan kaynağından varsayılan olarak TR1 kadrolarını DB'ye aktarır.

**Aşama 2 — Tek oyuncu testi**

Supabase SQL Editor'de şu sorguyu çalıştır:

```sql
select tm_id, name, team_name, current_market_value_text
from public.tm_players
where is_active = true
order by name
limit 30;
```

Bir oyuncunun `tm_id` değerini al. GitHub Actions'ta workflow'u tekrar çalıştır, `one-player-test` seç ve `player_id` alanına bu ID'yi yaz. Bu işlem yalnızca o oyuncunun profilini ve aktif sezon maçlarını test eder; tarihsel sezon taraması yapmaz.

**Aşama 3 — Tarihsel seed**

Tek oyuncu testi başarılı olduktan sonra workflow'u `seed-history` ile manuel başlat. Bu görev dcaribou ile varsayılan 2022–2025 tarihsel sezonlarını bir defa tarar. Tamamlanmasını Actions loglarından takip et.

**Aşama 4 — Normal senkronizasyon**

`sync` modunu manuel çalıştır. Bu mod önce kamerozkan güncel kadro/piyasa değeri verisini, sonra felipeall profil + aktif sezon maçlarını işler. felipeall her çalıştırmada `last_felipe_synced_at` alanı en eski/boş olan 80 aktif oyuncudan başlar; kamerozkan'ın genel senkronizasyon zamanı bu sırayı sıfırlamaz ve tüm aktif kadro küçük partiler hâlinde döner.

**Aşama 5 — Otomatik cron'u açma**

Tek oyuncu testi ve ilk normal senkronizasyon sorunsuz tamamlandıktan sonra GitHub deposunda **Settings → Secrets and variables → Actions → Variables** altında şu repository variable'ı oluştur:

- `ENABLE_TRANSFERMARKT_CRON` = `true`

Bundan sonra workflow pazartesi ve perşembe 03:20 UTC'de (Türkiye saatiyle 06:20) çalışır. GitHub zamanlanmış görevlerinde kısa gecikmeler olabilir.

## 7. Kayıt ve hata toleransı

- felipeall istekleri sırayla yapılır; aynı anda tek istek vardır. İki istek arası 3.1–4.0 saniye rastgele gecikme vardır.
- Diğer kaynak istekleri için varsayılan gecikme 1.5–3.5 saniyedir.
- 403, 408, 425, 429, 5xx, timeout ve bozuk JSON durumları loglanır; kademeli bekleme ile tekrar denenir. Bir oyuncunun verisi alınamazsa sonraki oyuncuya geçilir.
- Boş/null/boş obje/boş dizi ile mevcut dolu değerler silinmez.
- Yazmalar RPC tabanlı UPSERT ile yapılır. `tm_sync_runs` tablosunda her kaynak çalışmasının durumu ve süresi tutulur.
- Normal felipeall cron'u yalnızca oyuncu profili ve aktif sezon maçlarını ister. Eski sezonlar rutin güncelleme sırasında tekrar taranmaz. Kamerozkan'ın güncel piyasa değeri `tm_players` üzerine UPSERT edilir; `checkedAt` gözlem zamanı ayrı tutulur. `tm_market_values` tablosuna yalnızca kaynak gerçek bir değerleme tarihi verdiğinde tarihsel nokta eklenir.
- Kamerozkan kadrosunda son 14 günde görülmeyen oyuncular Transfermarkt DB kadro eklemesinden çıkarılır; felipeall güncelleme kuyruğu da son 14 günde kadroda doğrulanmış oyuncularla sınırlıdır. Diğer veri kaynaklarının kadro sonuçları ayrıca korunur.

## 8. Bilinen sınırlar

- Bu paket veritabanını veya GitHub/Apify/Cloudflare hesaplarını senin yerine oluşturmaz. İlk gerçek veri için yukarıdaki hesap/secret/deploy adımları zorunludur.
- felipeall'ın public Fly sunucusu test içindir; kalıcı ve yüksek hacimli kullanımda kendi sunucunda çalıştırılması önerilir.
- dcaribou seed'i ve Transfermarkt kaynaklarının verileri, upstream erişim/engel/kapsam durumuna bağlıdır. Scraper kodunun çalışması, her oyuncu için eksiksiz veri geleceği garantisi değildir.
- felipeall oyuncu maç endpoint'i geçmişte oynanmış maçları sunar; gelecek fikstür veya canlı skor servisi değildir. Geçmiş maçların dcaribou üzerinden ne kadar geriye gidebildiği, Transfermarkt'ın tarama yanıtlarına bağlıdır.
- Apify actor kullanımı ücret doğurabilir. Ücret ve limitleri başlamadan önce kontrol et.
- Açık kaynak kod lisansları, Transfermarkt içeriğinin ticari yeniden dağıtım izni anlamına gelmez. SkorHane'de yayınlamadan önce Transfermarkt koşullarını ve veri kullanım haklarını ayrıca değerlendir.

## 9. Dosya listesi

- `SkorHane-Worker.js` – PostgreSQL'den okuyan güncel Worker.
- `SkorHane-Worker-kodu-kopyalanabilir.txt` – aynı Worker'ın kopyalanabilir hâli.
- `SkorHane-HTML-kodu-kopyalanabilir.txt` – mevcut HTML dosyasının aynısı; arayüz değişikliği yapılmadı.
- `database/001_transfermarkt_schema.sql` – PostgreSQL tabloları, indeksler, RLS, UPSERT RPC'leri ve tarihsel maç görünümü.
- `sync/sync_transfermarkt.py` – kamerozkan, felipeall ve dcaribou senkronizasyon işçisi.
- `.github/workflows/transfermarkt-sync.yml` – manuel ve zamanlanmış görevler.
- `tests/test_sync_helpers.py` – ağ kullanmadan çalışan veri normalizasyon testleri.
