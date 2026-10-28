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
2. Bu fonksiyon sayfaya `postMessage({type:'inputRequest', prompt})` gönderir, sonra `__input__` adresine **senkron** `XMLHttpRequest` (`open(..., false)`) yapar → Python cevap gelene kadar bekler.
3. `sw.js` (Service Worker) bu isteği yakalar, `respondWith(new Promise(...))` ile askıda tutar.
4. Öğrenci konsolda yazıp Enter'a basınca sayfa `navigator.serviceWorker.controller.postMessage({type:'inputResult', value})` gönderir; SW bekleyen isteği bu değerle cevaplar, Python devam eder.
- SW ilk ziyarette sayfayı hemen kontrol etmeyebilir: `skipWaiting()` + `clients.claim()` kullan; worker'ı ancak `navigator.serviceWorker.controller` hazır olunca başlat.
- Stop'a basıldığında bekleyen input boş değerle cevaplanır, ardından worker sonlandırılır.

# TEMEL ÖZELLİKLER & GEREKSİNİMLER
- **Arayüz:** Dil İngilizce. Koyu/açık tema; varsayılan sistem ayarı, elle değiştirilebilir ve seçim hatırlanır. Masaüstü öncelikli, mobilde kullanılabilir.

- **Dosya Yöneticisi (Multi-file Support):**
  - Yeni dosya ekleme, silme, yeniden adlandırma (Örn: `main.py`, `fonksiyonlar.py`, `hesaplar.csv`). Klasör desteği YOK (düz liste).
  - Bilgisayardan dosya yükleme: "Upload" butonu ve dosya yöneticisine sürükle-bırak. Yalnızca metin dosyaları (`.py`, `.txt`, `.csv` vb.). Zip indirme YOK.
  - `main.py` her zaman vardır, silinemez/yeniden adlandırılamaz. İlk açılışta **boş**tur. Örnek kod veya "projeyi sıfırla" butonu yok.
  - Geçersiz modül adı (`fonksiyon-lar.py`) veya tekrar eden isim için uyarı verilir. Aynı isimde dosya yüklenirse üzerine yazmadan önce sorulur.
  - Çalıştırmadan önce tüm dosyalar Pyodide FS'e (`/home/pyodide`) yazılır; `main.py` içinden `import fonksiyonlar` çalışır.
  - Çalıştırmadan sonra FS'teki metin dosyaları geri okunur: `open("sonuc.txt", "w")` ile oluşan/değişen dosyalar dosya yöneticisinde görünür ve kaydedilir.

- **Kod Editörü:**
  - CodeMirror 6 (jsDelivr `+esm`). Sentaks vurgulama, satır numaraları, Tab girintileme, temaya uyum. Kod tamamlama/AI önerileri YOK.
  - Editöre sürükle-bırak ile dosya açılabilir: önce dosya yöneticisi dosyayı alır, sonra editör onu açar.

- **Çalıştırma:**
  - "Run" her zaman `main.py`'yi çalıştırır.
  - Her çalıştırma temiz başlar: global değişkenler sıfırlanır, kullanıcı modülleri `sys.modules`'tan silinir.
  - "Stop" butonu: worker sonlandırılır ve arka planda yeniden başlatılır.
  - Kütüphaneler: yalnızca standart kütüphane (`random`, `math` vb.). Ek paket yükleme yok.

- **Konsol (Stdout/Stderr & Stdin):**
  - `print()` çıktıları ve hatalar canlı olarak konsola akar.
  - `input()` istemi konsolda görünür; öğrenci doğrudan konsola yazar ve Enter'a basar (ayrı modal yok).

- **Hata Ayıklama & Traceback:**
  - Traceback'ten Pyodide iç satırları gizlenir; yalnızca kullanıcı dosyalarına ait satırlar ve hata mesajı kırmızı renkte gösterilir.
  - Dosya/satır bilgisine tıklanınca o dosya editörde açılır ve satır vurgulanır.

# DOSYA YAPISI
- `index.html`, `style.css`
- `app.js` (arayüz, dosya yöneticisi, konsol) + gerekirse ES modülleri (`editor.js`, `storage.js`)
- `worker.js` (Pyodide, input override, FS senkronizasyonu)
- `sw.js` (input kanalı)

# KODLAMA ADIMLARI
1. Dosya yapısını oluştur.
2. Pyodide (jsDelivr, sabit sürüm) ve CodeMirror 6'yı CDN'den dahil et.
3. Pyodide yüklenirken yükleme göstergesi (loader) göster.
4. Worker ↔ sayfa mesajlaşması; FS senkronizasyonu (yazma ve çalıştırma sonrası geri okuma).
5. Service Worker input kanalı.
6. Run/Stop, traceback işleme, tema.

Lütfen doğrudan çalışan, eksiksiz ve modüler bir kod taslağı ile başla.
