# GÖREV
Öğrencilerin tarayıcı üzerinde Python kodları yazabileceği, çalıştırabileceği, dosyalar (`.py`, `.txt`, `.csv` gibi) oluşturup `import` edebileceği veya okuyabileceği son derece sade ve hızlı bir online Python editörü oluşturacaksın.

Kullanım amacı: derste gösterilen temel düzeyde programları çalıştırmak. İndirme boyutu/performans optimizasyonuna takılma.

# TEKNİK MİMARİ & KISITLAMALAR
1. **Çalışma Ortamı:** Kodlar tamamen client-side (tarayıcıda) Pyodide / WebAssembly (WASM) kullanılarak çalışacaktır. Sunucu/backend veya dış AI servisi kesinlikle KULLANILMAYACAKTIR.
2. **Hosting:** GitHub Pages üzerinde statik olarak yayınlanacak biçimde saf HTML5, CSS3 ve Vanilla JavaScript kullanılacaktır. Build adımı olmayacak.
3. **Veri Depolama:** Tek proje; dosyalar `IndexedDB`'de tutulur. Tema tercihi `localStorage`'da.
4. **Pyodide bir Web Worker içinde çalışır** (sayfa donmaz, Stop butonu mümkün olur).

# input() ÇÖZÜMÜ (Service Worker + senkron XHR)
online-python.com'un kullandığı yöntem; COOP/COEP başlığı gerektirmez, GitHub Pages'te çalışır.
1. Worker içinde `builtins.input` kendi fonksiyonumuzla değiştirilir.
2. Bu fonksiyon istemi (prompt) stdout'a yazar, sayfaya `postMessage({type:'inputRequest', id})` gönderir, sonra `__pyinput__?id=...` adresine **senkron** `XMLHttpRequest` (`open(..., false)`) yapar → Python cevap gelene kadar bekler.
3. `sw.js` (Service Worker) bu isteği yakalar, `respondWith(new Promise(...))` ile askıda tutar.
4. Öğrenci konsolda yazıp Enter'a basınca sayfa `navigator.serviceWorker.controller.postMessage({type:'inputResult', id, value})` gönderir; SW bekleyen isteği bu değerle cevaplar, Python devam eder.
- Her istek kendi `id`'sini taşır; birden fazla sekme birbirine karışmaz. Değer istekten önce gelirse SW onu saklar.
- SW istekleri en fazla 60 sn bekletir, sonra `{retry: true}` döner ve worker yeniden sorar (tarayıcı uzun bekleyen isteği öldürmesin diye).
- SW ilk ziyarette sayfayı hemen kontrol etmeyebilir: `skipWaiting()` + `clients.claim()` kullanılır; worker ancak `navigator.serviceWorker.controller` hazır olunca başlatılır.
- Stop'a basıldığında bekleyen input boş değerle cevaplanır, ardından worker sonlandırılır.
- `file://` ile açılırsa SW çalışmaz; konsolda uyarı çıkar ve `input()` anlaşılır bir hata verir.

# TEMEL ÖZELLİKLER & GEREKSİNİMLER
- **Arayüz:** Dil İngilizce. Koyu/açık tema; varsayılan sistem ayarı, elle değiştirilebilir ve seçim hatırlanır. Masaüstü öncelikli, mobilde kullanılabilir (paneller alt alta).
  - Yerleşim: dosya yöneticisi (sabit 210 px) | editör | konsol.
  - Editör ile konsol arasında sürüklenebilir ayırıcı: ok tuşlarıyla da ayarlanır, çift tıklama varsayılana döndürür, genişlik `localStorage`'da hatırlanır. Editör en az 280 px, konsol en az 220 px.
  - İlk açılışta Pyodide yüklenirken lightbox: animasyonlu Python simgesi, aşama yazısı, ilerleme çubuğu. Yükleme başarısız olursa hata mesajı ve "Reload page" butonu. Stop sonrası yeniden başlatmada gösterilmez.

- **Dosya Yöneticisi (Multi-file Support):**
  - Yeni dosya ekleme, silme, yeniden adlandırma (Örn: `main.py`, `fonksiyonlar.py`, `hesaplar.csv`). Klasör desteği YOK (düz liste).
  - Bilgisayardan dosya yükleme: "Upload" butonu ve dosya yöneticisine sürükle-bırak. Yalnızca metin dosyaları (`.py`, `.txt`, `.csv` vb.). Zip indirme YOK.
  - `main.py` her zaman vardır, silinemez/yeniden adlandırılamaz. İlk açılışta **boş**tur. Örnek kod veya "projeyi sıfırla" butonu yok.
  - Geçersiz modül adı (`fonksiyon-lar.py`) veya tekrar eden isim kabul edilmez. Geçersiz isimli yüklemede düzeltilmiş isim önerilir (`Ödev 1.py` → `Ödev_1.py`). Aynı isimde dosya yüklenirse üzerine yazmadan önce sorulur.
  - Standart modülle aynı isim (`random.py`, `math.py` vb.) için uyarı verilir (gerçek modülün yerine geçer).
  - Yükleme sınırı: dosya başına 1 MB, yalnızca UTF-8 metin.
  - Çalıştırmadan önce tüm dosyalar Pyodide FS'e (`/home/pyodide`) yazılır; `main.py` içinden `import fonksiyonlar` çalışır.
  - Çalıştırmadan sonra FS'teki metin dosyaları geri okunur: `open("sonuc.txt", "w")` ile oluşan/değişen dosyalar dosya yöneticisinde görünür ve kaydedilir.

- **Kod Editörü:**
  - CodeMirror 6, jsDelivr'den **import map** ile yüklenir (her paket tek ve sabit sürüm; `+esm` kullanılmadı çünkü paketlerin farklı kopyaları karışabiliyor). Sentaks vurgulama, satır numaraları, Tab girintileme (4 boşluk), temaya uyum (renkler CSS değişkenlerinden). Kod tamamlama/AI önerileri YOK.
  - Her dosyanın kendi geri alma (undo) geçmişi vardır. `Ctrl+Enter` çalıştırır. Değişiklikler otomatik kaydedilir.
  - Editöre sürükle-bırak ile dosya açılabilir: önce dosya yöneticisi dosyayı alır, sonra editör onu açar.

- **Çalıştırma:**
  - "Run" her zaman `main.py`'yi çalıştırır.
  - Her çalıştırma temiz başlar: global değişkenler sıfırlanır, kullanıcı modülleri `sys.modules`'tan silinir.
  - "Stop" butonu: worker sonlandırılır ve arka planda yeniden başlatılır.
  - Kütüphaneler: yalnızca standart kütüphane (`random`, `math` vb.). Ek paket yükleme yok. `turtle`/`tkinter` çalışmaz.
  - Pyodide **0.29.5** (Python 3.13), jsDelivr'den.

- **Konsol (Stdout/Stderr & Stdin):**
  - `print()` çıktıları ve hatalar canlı olarak konsola akar.
  - `input()` istemi konsolda görünür; öğrenci doğrudan konsola yazar ve Enter'a basar (ayrı modal yok).

- **Hata Ayıklama & Traceback:**
  - Traceback'ten Pyodide iç satırları gizlenir; yalnızca kullanıcı dosyalarına ait satırlar ve hata mesajı kırmızı renkte gösterilir.
  - Dosya/satır bilgisine tıklanınca o dosya editörde açılır ve satır vurgulanır.
  - Hata sonrası en derindeki kullanıcı satırı otomatik açılır ve vurgulanır.

# DOSYA YAPISI
- `index.html`: sayfa iskeleti, CodeMirror import map'i, lightbox
- `style.css`: tema değişkenleri, yerleşim, animasyonlar
- `app.js`: dosya yöneticisi, konsol, Run/Stop, ayırıcı, tema, sürükle-bırak
- `editor.js`: CodeMirror 6 kurulumu
- `storage.js`: IndexedDB
- `worker.js`: Pyodide, `input()` override, FS senkronizasyonu, traceback filtreleme
- `sw.js`: input kanalı
- `.nojekyll`, `.gitignore`, `.gitattributes`

# DURUM (2026-10-28)
Tüm özellikler tamamlandı ve Chrome'da otomatik testlerle doğrulandı.

- Depo: https://github.com/volkanoger/csc2201 (`main` dalı)
- Yayın: https://volkanoger.github.io/csc2201/ (Settings → Pages → `main` / root)
- Yerel test: proje klasöründe `python -m http.server 8000` → http://localhost:8000 (`file://` ile açılmamalı)

## İleride düşünülebilecekler
- Konsol / editör yazı boyutu ayarı (projeksiyon için A-/A+).
- Projeyi sıfırlama veya tek tek dosya indirme.
- Firefox ve Safari'de elle test.
