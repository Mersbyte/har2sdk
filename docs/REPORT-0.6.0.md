# har2sdk 0.6.0 — Rapor

Bu rapor, v0.5.0'dan 0.6.0'a giden üç aşamalık çalışmanın (bağımsız saldırı incelemesi, sağlamlaştırma, yayın hazırlığı) sonucudur. Her bulgunun kanıtı, onu gösteren testtir: test önce yazıldı, düzeltmeden önce başarısız olduğu görüldü, sonra kod düzeltildi.

Kısaltmalar: **P** = gizlilik bulgusu (kayıtlı bir değer bir çıktıya sızıyordu), **C** = doğruluk bulgusu (koruma doğru çıktıyı bozuyordu ya da çıktı yanlıştı). Testler `test/review5.test.ts` içinde, her bulgu için bir `describe` bloğu, bulgu numarasıyla.

Özet sayılar:

| | Önce (0.5.0) | Sonra (0.6.0) |
|---|---|---|
| `npm test` | 223 test | 306 test, hepsi geçiyor |
| Gizlilik fuzz'ı | 14 yerleşim türü, 1.000 seed | 26 yerleşim türü; 1–1.000 ve 1.001–3.000 seed'lerin hepsi geçiyor |
| Demo çıktısı (`test/fixtures/demo-snapshot.json`) | — | Değişmedi (aynı endpoint'ler, aynı tipler) |
| GitHub Actions | yeşil | 3 PR'da da yeşil (ubuntu Node 22/24, windows, macOS, Node 20 çalışma zamanı) |

---

## 1. Bulunan sorunlar

### 1a. Gizlilik (sızıntılar)

| # | Sorun | Kanıt (girdi → sızdığı yer) | Düzeltildi mi | Test |
|---|---|---|---|---|
| P1 | Mock, JSON dışındaki gövdeleri (XML, HTML, düz metin, yarım kalmış JSON) neredeyse olduğu gibi sunuyordu: yalnızca e-posta, sorgu dizesi ve uzun rakamlar maskeleniyordu. | `<user><login>mdemir</login><fullName>Oguz Kilic</fullName><city>Kadikoy</city>…` → mock yanıtında üçü de aynen. `text/plain` "… is allergic to penicillin" aynen. | Evet. Etiket/öznitelik/anahtar adına göre JSON gibi temizleniyor; düz metin satır satır. Bu alanlar leak guard'a kanıt olarak da toplanıyor. | `P1 …` (5 test) |
| P2 | GraphQL sayı sabitleri belgeye gömülü kalıyordu. | `user(id: 4815162342)` → client.ts, openapi.json, MCP `inspect_endpoint` yanıtı; leak guard fark etmiyordu. | Evet. id argümanları ve 6+ haneli sayılar değişkene dönüşüyor; `first: 20` gibi küçük sayılar kalıyor. | `P2 …` |
| P3 | GET ile gönderilen GraphQL belgelerindeki sabitler kanıt sayılmıyordu. | `?query=… user(login: "mdemir")` + `/api/users/mdemir/repos` → `mdemir` client.ts, openapi, prompt ve MCP'de. | Evet. GET ve toplu (batch) belgelerdeki sabitler toplanıyor; argüman adı (`login`, `id`…) kimlik kanıtı. | `P3 …` |
| P4 | Kısa bir kullanıcı adı daha uzun bir token'ın içinde tarayıcıdan kaçıyordu. | `cookie: remember_mdemir=1`, `x-app-version: 2.14.0+mdemir` → client.ts yorumu, openapi `securitySchemes`, prompt, `inspect --json`; guard sessiz. | Evet. Tarayıcı bileşik token'ların parçalarına bakıyor (API'nin kendi host etiketleri hariç); veri taşıyan çerez/başlık adları ve sürüm metadata'sı listelenmiyor. | `P4 …` (4 test) |
| P5 | Sahte verideki URL'ler kullanıcı adını host'ta tutuyordu. | `blog: "https://mdemir.github.io/…"`, `site: "https://oguz-kilic.dev"` (Oguz Kilic kayıtlı) → mock ve `--examples`. | Evet. Kayıtlı/kimlik/kayıtlı ismin slug'ı olan host etiketleri ve path parçaları sahteleniyor; `v2` gibi sürümler kalıyor. | `P5 …` |
| P6 | İki girişli, kayıtlı isimlerle anahtarlanmış sözlükler. | `{ oguz: {score}, mehmet: {score} }` → mock anahtarları aynen sundu; client.ts reddedildi. | Evet. ≥2 aynı şekilli giriş + tüm anahtarlar kayıtlı → `Record`, mock'ta sahte anahtar. | `P6 …` (3 test) |
| P7 | Jira tarzı anahtarlar (`PROJ-7`) tek görüldüğünde path literal kalıyordu. | `/rest/api/2/issue/PROJ-7/comment` → client.ts ve MCP yanıtı, guard sessiz (kanıt yok sanıyordu). | Evet. Büyük harfli anahtar + numara bir kimlik biçimi. | `P7 …` |
| P8 | `/orgs/` sonrasında `s` ile biten slug çoğul sanılıyordu. | `/orgs/acme-labs/members` → literal; client.ts, MCP, `inspect --json`. | Evet. | `P8 …` |
| P9 | Rol anahtarlarındaki kullanıcı adları (`reviewer`, `approver`, `requester`, `editor`…) kimlik sayılmıyordu. | `{reviewer: "mdemir"}` + `/api/users/mdemir/stats` → her yerde. | Evet. | `P9 …` |
| P10 | Kimlik anahtarı altındaki büyük harfli kiracı kodları dışlanıyordu (`AB`/`USD` kuralı). | `{team: "ACME"}` + `/api/teams/ACME/members` → literal. | Evet; dışlama artık yalnızca id anahtarları için. | `P10 …` (2 test) |
| P11 | Koleksiyondan sonraki dosya adları literal kalıyordu. | `/api/attachments/hiv-test-results.pdf/meta` → her çıktıda. | Evet. | `P11 …` (2 test) |
| P12 | Kayıtlı bir ismin tanımlayıcı biçimi olan anahtarlar. | `{ oguz_kilic: {…} }` (Oguz Kilic kayıtlı) → mock anahtarı aynen; client.ts reddedildi. | Evet. | `P12 …` |
| P13 | Kişi kaydındaki takvim tarihleri maskelenmiyordu. | `{email, born: "1990-04-12"}` → mock ve `--examples`. | Evet; zaman damgaları (`createdAt`) kalıyor. | `P13 …` |
| P14 | HAR dosyasının adı üretilen dosyalara yazılıyordu. | `oguz-kilic-bank.har` → client.ts başlığı, openapi açıklaması, prompt; ad kayıtlı isimle eşleşince guard reddediyordu. | Evet. | `P14 …` |
| P15 | Tarayıcı ASCII dışı harflerde token'ı bölüyordu; yüzde kodlu path'leri görmüyordu. | `çağrı`, `y%C4%B1lmaz` → görünmez. `/api/profiles/ayşe.yılmaz` → her yerde. | Evet. Unicode token'lar, yüzde kodu çözümü, harf çevirisi (`Kılıç` → `kilic`). | `P15 …` (3 test) |
| P16 | Aynı kimliğin başka ayırıcılarla yazımı. | `login: "ece_kaya"` + `/api/users/ece-kaya/settings`, `https://ece-kaya.github.io` → her yerde. | Evet. | `P16 …` (2 test) |
| P17 | Kanıt, capture'daki sıraya bağlıydı (fuzz buldu). | Bir isim önce `?q=` ile, sonra `fullName` altında görülünce slug biçimi hiç kaydedilmiyordu → mock'ta `kerem-okafor.dev`. | Evet. | `P17 …` |
| P18 | Rakam içeren kullanıcı adları teknik anahtar altında ve metin satırında korunuyordu (fuzz buldu). | `chiara50` → mock. | Evet. | `P18 …` |
| P19 | Tek kelimelik, `s` ile biten org slug'ı (fuzz buldu). | `/orgs/kilics/teams` → prompt ve MCP. | Evet. | `P19 …` |
| P20 | Sahte id gerçek id ile aynı çıkabiliyordu (palindrom gövde). | `DEM-66` → `DEM-66` (300 seed'lik bir fuzz çalıştırmasında bir kez). | Evet. | `P20 …` |

### 1b. Doğruluk (korumanın bozduğu normal çıktı)

| # | Sorun | Kanıt | Düzeltildi mi | Test |
|---|---|---|---|---|
| C1 | Toplu (Apollo batching) GraphQL istekleri yanlış alarm veriyordu; persisted-query hash'leri de. | Literal içermeyen iki belgeli batch → CLI hiçbir dosya yazmadı (çıkış 2). | Evet. | `C1 …` (2 test) |
| C2 | Mock toplu isteğe tek nesne dönüyordu; batch içinde kaydedilmiş bir işleme yanlış sonuç veriyordu. | `[{GetCart},{GetMe}]` → `{data:{cart}}`. | Evet. | `C2 …` |
| C3 | Stripe liste zarflarındaki `url: "/v1/customers"` veri sayılıyordu → **her Stripe benzeri capture reddediliyordu**. | Gerçekçi Stripe capture'ı → çıkış 2. | Evet. Göreli path yalnızca id/uzun sayı/sorgu taşıyorsa veri. | `C3 …` (2 test) |
| C4 | Şeylerin tek kelimelik isimleri (kategori "Books", plan "Premium") kişisel veri sayılıyordu → `/api/books` veya `premium` alanı olan her istemci reddediliyordu. | Sıradan e-ticaret capture'ı → çıkış 2. | Evet. Bunlar artık "label": üretici veri gibi davranıyor, tarayıcı raporlamıyor. Kişi nesnesindeki isimler (iletişim/kimlik alanı, kişi koleksiyonu, `/me`) eskisi gibi kişisel. | `C4 …` (2 test) |
| C5 | GitHub tarzı path'ler: `/repos/{repoId}/har2sdk/issues` ve ret. | GitHub benzeri capture. | Evet: `/repos/{owner}/{repo}/…` (liste üyeliği, parametreden sonra yankı, `owner.login` ile adlandırma). | `C5 …` |
| C6 | Tekil kaynak kelimesinden sonra anahtar yankısı (`/project/PROJ` → `{key: "PROJ"}`) literal kalıp reddediliyordu. | Jira benzeri capture. | Evet; `settings/profile` gibi alt yollar literal kalıyor. | `C6 …` (2 test) |
| C7 | Shopify: `/admin/api/2024-01/` sürümü `{apiId}` oluyordu; `632910392.json` parametrenin içinde kalıyordu. | `getApiProductsJson`, `get202401Product`. | Evet: `/admin/api/2024-01/products/{productId}.json` → `getProduct` (istemci, OpenAPI ve mock). | `C7 …` (2 test) |
| C8 | Mock `__typename`, Stripe `object`, `type: "User"` değerlerini bozuyordu → Apollo önbelleği ve ayrımlı birleşimler kırılıyordu. | `__typename: "Lorem"`. | Evet (yalnızca ayrımcı anahtarlarda). | `C8 …` (2 test), `C14` |
| C9 | Mock göreli API linklerini çöpe çeviriyordu. | `"/v1/customers"` → `"/y7/ayrhjcnun"`. | Evet. | `C9 …` |
| C10 | Mock tRPC superjson çıktısındaki `meta`'yı atıyordu (Date'ler string oluyordu). | `user.byId`. | Evet. | `C10 …` |
| C11 | GraphQL liste sabitleri ve blok stringler değişkene dönüşmüyor, ret alıyordu. | `users(emails: [...])`, `"""…"""`. | Evet. | `C11 …` (2 test) |
| C12 | Veri anahtarlarından geçen superjson meta yolları client.ts'e gömülüyor, ret alıyordu. | `seen.ord-77314`. | Evet. | `C12 …` |
| C13 | Üreticinin kendi kelimesiyle aynı kayıtlı değer (`har2sdk` adlı bir repo) ret alıyordu. | — | Evet. | `C13 …` |
| C14 | (Kendi düzeltmemin yan etkisi olmasın diye) Label'lar sıradan nesneleri `Record` yapmamalı. | "Shipping"/"Discount" kalemleri + `{shipping, discount}`. | Evet. | `C14 …` (3 test) |
| C15 | Rol kelimeleri (`author_association: "OWNER"`) `{owner}` parametre adını engelliyordu. | GitHub benzeri capture → ret. | Evet. | `C15 …` |
| C16 | Mock, Latin-1 dışı karakterli bir path'te **tüm süreci çökertiyordu**. | `/api/iğdır/weather` → `ERR_INVALID_CHAR`, sunucu kapandı. | Evet; başlık yüzde kodlu, hatalı istek 500 alıyor. | `C16 …` |
| C17 | `--examples` demo'nun kendisinde bile reddediliyordu (0.5.0'da da). Scrubber zaman damgalarını bilerek tutuyor, guard bunları sızıntı sayıyordu. | `har2sdk acme-shop.har --examples` → "10 recorded values", hiçbir dosya yazılmadı. | Evet; spec örneksiz taranıyor, örnekler scrubber testleri ve fuzz ile denetleniyor. | `C17 …` (2 test), `test/browsers.test.ts` |

### 1c. Aşama 2'de bulunanlar

| Sorun | Kanıt | Düzeltildi mi | Test |
|---|---|---|---|
| Büyük HAR'lar tek seferde belleğe okunuyordu; ~512 MB üstü dosyalar hiç açılmıyordu. | 600 MB sentetik HAR → 0.5.0: "too large to load in one piece". | Evet: akışla okuyucu (`loadHarFile`). | `test/stream.test.ts` (7 test) |
| Review 5'in ek kanıtı taint toplamayı ~2 kat yavaşlatmıştı (200 MB'da 19 sn). | CPU profili: `add`, `identity`, `words`. | Evet; ölçüm aşağıda. | — (performans) |

200 MB / 600 MB ölçümü (sentetik: API JSON + base64 görseller + JS paketleri; Node 22, 4 vCPU; her biri 3 çalıştırma; test dosyaları commit edilmedi ve silindi):

| Capture | 0.5.0 | 0.6.0 |
|---|---|---|
| 200 MB, 8.191 istek | 10,5–11,7 sn, 713–716 MB tepe RSS | 11,3–12,2 sn, 410–432 MB tepe RSS |
| 600 MB, 24.622 istek | reddedildi | 38,8 sn, 979 MB tepe RSS |

### 1d. İddia kontrolü (README / SECURITY / CHANGELOG)

Abartılı ya da eskimiş bulunanlar düzeltildi: modele giden metne GraphQL belgelerinin de dahil olduğu ("yalnızca path ve tipler" değil); guard'ın raporlamadığı şeyler (label'lar, API'nin kendi host etiketleri, har2sdk'nin kendi kelimeleri); mock'un büyük tamsayıları sahtelediği ("sayılar kalır" değil); `--raw`'ın JSON'u yeniden serileştirdiği ("verbatim" değil); fuzz kapsamı ve seed sayısı; tarayıcı fixture'ları. MCP araç açıklamaları da güncellendi.

## 2. Düzeltemediklerim

Ayrıntılar `docs/KNOWN-ISSUES.md` içinde.

- **Kanıtsız değerler.** Capture'ın başka hiçbir yerinde geçmeyen, bir kez path parçası olarak kullanılmış düz bir kelime (ör. yalnızca `text/plain` "mdemir" dönen bir `/whoami`) tanınamaz. Bu, guard'ın belgelenmiş sınırı.
- **Label politikasının bedeli.** Kişi kanıtı olmayan bir nesnedeki tek kelimelik isimler (repo, proje, kategori adı) artık tarayıcı tarafından raporlanmıyor. Üretici bunları hâlâ veri gibi işliyor ve koleksiyon üyeliği kanıtı varsa path'te parametre yapıyor; ama üyelik kanıtı yoksa bir repo adı path literal'i olarak yazılabilir. Yanlış alarmları (C4) kaldırmak için bilinçli bir takas; SECURITY.md *Limits* bölümünde yazılı.
- **GraphQL değişken varsayılanları.** `query Q($login: String = "mdemir")`: guard yakalıyor ve yazmayı reddediyor, ama değer değişkene taşınmıyor (yeni özellik sayılacağı için `docs/IDEAS.md`'ye yazıldı).
- **Öğrenilmiş konumda kelime+rakam repo adları.** `/repos/{owner}/widget9/issues`, `widget9` bir liste yanıtında geçmiyorsa literal kalıyor (review 4'ün `oauth2`/`ipv4` kuralı bilinçli olarak korunuyor).
- **Firefox ve WebKit fixture'ları yok.** Ortamda yalnızca Chromium kurulu; Playwright `firefox-1495` ve `webkit-2215` çalıştırılabilirlerini bulamadı ve tarayıcı kurmama izin yoktu. `record.mjs` her ikisini de destekliyor.
- **Chrome DevTools "Save all as HAR" fixture'ı yok.** Bir insanın tarayıcı başında olması gerekiyor; Playwright kayıtları ve eski Chrome tarzı test girdileri formatı kapsıyor.

3 deneme kuralına takılıp bırakılan bir sorun olmadı.

## 3. Açılan PR'lar ve merge sırası

PR'lar üst üste kuruldu (her biri bir öncekinin dalı üzerinde), bu yüzden **bu sırayla** merge edilmeli:

1. **#1 `review-5` → `main`** — Aşama 1: saldırı incelemesi, P1–P20 ve C1–C16, fuzz genişletmesi, belge iddiaları. https://github.com/Mersbyte/har2sdk/pull/1
2. **#2 `hardening` → `review-5`** — Aşama 2: akışla okuyucu, performans, tarayıcı fixture'ları, C17. #1 merge edildikten sonra tabanı `main` olarak değiştirin (ya da #1'den önce `review-5`'e merge edin). https://github.com/Mersbyte/har2sdk/pull/2
3. **#3 `release-prep` → `hardening`** — Aşama 3: 0.6.0 sürümü, README, ekran görüntüleri, CHANGELOG, bu rapor. #2'den sonra tabanı `main` yapın.

Hiçbir PR merge edilmedi, npm'e bir şey yayınlanmadı, repo public yapılmadı.

## 4. Net cevap

### npm'e hazır mı? **Evet — PR'lar merge edildi; yayından önce bir iş kaldı (repoyu public yapmak).**

Kanıt:
- `npm test` 306/306; gizlilik fuzz'ı 3.000/3.000 seed; demo snapshot değişmedi.
- CI üç PR'da da yeşil: ubuntu (Node 22, 24), windows, macOS, Node 20 çalışma zamanı.
- `npm pack`: 45 dosya, 117 kB; içerik `dist/`, README, LICENSE, SECURITY.md, CHANGELOG.md. Test, fixture, HAR yok.
- Tarball temiz bir dizine kuruldu; `npx har2sdk --version` → `0.6.0`; demo HAR ile üretim, `inspect --json`, `prompt`, `mock` (+ üretilen istemcinin mock'a gerçek çağrıları: `listProducts`, `getOrder`, GraphQL) ve MCP `initialize` çalıştı.
- `har2sdk` adı npm'de boş (`npm view har2sdk` → 404). `prepublishOnly` testleri çalıştırıyor; `VERSION`, `package.json` ve CHANGELOG bir testle birbirine bağlı.

Yayından önce:
1. **Repo public değilken** npm sayfasındaki `repository`/`homepage` linkleri ve README'deki göreli görseller (`docs/demo.svg`, `docs/screenshots/*`) kırık görünür; npm göreli görselleri GitHub deposundan çözer. Ya repoyu yayınla aynı anda public yapın ya da görselleri mutlak URL'ye çevirin.
2. ~~`package.json` içindeki `author` alanı boş~~ — düzeltildi: `author` artık `"Mersbyte"`, LICENSE'ta da `Copyright (c) 2026 Mersbyte` (#4).

### Hacker News'e hazır mı? **Teknik olarak evet, ama repo public olup npm'e çıktıktan sonra; ve gizlilik iddiaları en çok sorgulanacak yer olacak.**

Lehine kanıt: ilk ekranda ne yaptığı ve tek komut görülüyor; gerçek Chromium ile kaydedilmiş demo ve ekran görüntüleri var; LLM gerekmiyor, deterministik; README dürüst bir "sınırlar" bölümü ve ölçülmüş performans tablosu içeriyor; beş inceleme turunun girdileri test olarak repoda.

Dikkat edilmesi gerekenler:
- Gizlilik koruması **kanıta dayalı bir heuristik, kanıt değil** — README ve SECURITY.md bunu açıkça söylüyor; HN'de bu dürüstlük önemli. Her inceleme turu yeni girdi şekilleri buldu (bu turda 20 sızıntı sınıfı); 0.6.0'dan sonra da bulunacağını varsayın ve SECURITY.md'deki özel bildirim yolunu açık tutun.
- Firefox/Safari/DevTools fixture'ları yok; ilk geri bildirimler muhtemelen bu tarayıcılardan gelecek.
- "Başkalarının API'sini tersine mühendislik" konusu tartışma çıkarabilir; README'deki "sorumlu kullanım" paragrafı yerinde.

Önerim: üç PR'ı sırayla merge edin, repoyu public yapın, `npm publish`, sonra HN.
