# HANDOFF.md — Reys Hisoboti v2 AI & Developer Handoff Guide

> **DIQQAT / QOIDA**: Har qanday AI agent yoki dasturchi loyihaga o'zgartirish kiritganda, ushbu faylni (`HANDOFF.md`), shuningdek `AGENTS.md` va `CLAUDE.md` fayllarini yangilashi **shart**. Ushbu hujjatlar har doim codebase ning joriy holatini 100% to'g'ri aks ettirishi lozim.

---

## 1. Loyihaning Maqsadi va Umumiy Ko'rinishi

Bu loyiha yuk tashuvchilar va omborlar uchun xizmat qiladigan **"Reys hisoboti" (Trip Reports)** tizimidir. U:
1. **Telegram Bot (aiogram 3)** — faqat ruxsat berilgan adminlar (`ADMIN_IDS`) uchun ishlaydi, Mini App ochish tugmasini beradi.
2. **Telegram Mini App (WebApp)** — vanilla JavaScript (build-step yo'q), mobil qurilmalarga moslangan, kutilmagan uzilishlarda oflayn ishlash uchun `IndexedDB` ga asoslangan outbox mexanizmiga ega.
3. **Brauzer kirish** — username va 4 xonali PIN yoki WebAuthn (Passkeys) orqali Telegramsiz ham kompyuter/brauzerdan foydalanish imkoniyati.
4. **Cloudflare R2 / S3 Storage** — yuk rasmlarini server diskiga emas, bulutli obyektlar omboriga (R2) xavfsiz va tejamkor saqlaydi (lokal fallback bilan).
5. **Durable Telegram Forwarding (Outbox)** — kiritilgan yuklarni tegishli Telegram kanallariga rasmlari va hisob-kitob matni bilan jo'natadi.
6. **Excel Eksport** — Kargolarga tarqatish (`shablon.xlsx`), Obshiy ves (`obshiy_ves_shablon.xlsx`) va Umumiy hisobot (`umumiy_hisobot_shabloni.xlsx`) larni jonli formulalar bilan generatsiya qiladi.

---

## 2. Loyiha Tuzilishi (Directory Map)

```text
reys_hisoboti_v2/
├── app/
│   ├── __init__.py
│   ├── __main__.py          # Yagona jarayon: FastAPI + aiogram bot + outbox worker
│   ├── bot.py               # aiogram 3 bot (IsAdmin filtri, WebAppInfo tugmasi)
│   ├── config.py            # .env o'qish, sozlamalar va kanallar xaritasi
│   ├── db.py                # Asinxron SQLite (aiosqlite) orqali hisobotlar va balans
│   ├── excel_export.py      # openpyxl asosidagi 3 xil Excel eksport generatori
│   ├── outbox.py            # Telegram kanallariga jo'natuvchi navbat va worker
│   ├── passkeys.py          # WebAuthn passkeys (data/passkeys.json)
│   ├── passwords.py         # PBKDF2-HMAC-SHA256 parol xeshlash
│   ├── queue.py             # arq / Redis asinxron navbat boshqaruvi
│   ├── security.py          # Telegram initData validatsiya, sessiya tokenlari, CSRF
│   ├── server.py            # FastAPI API endpointlari va statik fayllar
│   ├── storage.py           # Cloudflare R2 / S3 asinxron fayl ombori (lokal fallback bilan)
│   └── storage_migrate.py   # Lokal rasmlarni R2 ga xavfsiz ko'chirish vositasi (Zero Data Loss)
├── tests/                   # Pytest avtomatlashtirilgan testlar to'plami
│   ├── test_db_and_storage.py
│   ├── test_migrate.py
│   └── test_server_api.py
├── assets/                  # Excel shablonlari (.xlsx)
├── webapp/                  # Mini App frontend (Vanilla HTML, CSS, JS)
│   ├── css/styles.css       # Dizayn va mavzular (Light/Dark/Auto)
│   ├── js/app.js            # Frontend holat mashinasi, kamera, IndexedDB outbox
│   └── index.html           # Yagona sahifali Mini App interfeysi
├── data/                    # Baza (reys.db), passkeys va lokal rasmlar (gitignored)
├── AGENTS.md                # Agentlar uchun yo'riqnoma
├── CLAUDE.md                # Claude Code yo'riqnomasi (AGENTS.md nusxasi)
├── HANDOFF.md               # Ushbu kontekst topshirish hujjati
└── requirements.txt         # Python paketlar
```

---

## 3. Asosiy Modullar va Arxitektura Tafsilotlari

### A. Yagona Process va Event Loop (`app/__main__.py`)
- FastAPI serveri (`uvicorn`) va aiogram bot (`dp.start_polling(handle_signals=False)`) yagona `asyncio` event loop ichida birgalikda ishlaydi.
- Server ishga tushganda `outbox.ensure_started()` chaqiriladi.

### B. Rasmlar Ombori (`app/storage.py`, `app/storage_migrate.py` & Cloudflare R2)
- Rasmlar Cloudflare R2 bucket-ga yuklanadi.
- **Tartibli Papkalar Ierarxiyasi (Clean Folder Structure)**:
  - Format: `{action}/report_{report_id}/{entry_id}/{idx}.webp`
  - Masalan:
    - `top/report_44/5915/0.webp`
    - `reys/report_44/5916/0.webp`
    - `bizda/report_44/5917/0.webp`
    - `chiqgan/report_44/5918/0.webp`
    - `adjust/report_44/5919/0.webp`
  - Bu orqali Cloudflare Dashboardda har bir bo'lim va hisobot bo'yicha rasmlar alohida papkalarda toza va tartibli saqlanadi.
- **R2 CORS Siyosati (Cross-Origin Resource Sharing)**:
  - Agar rasmlar to'g'ridan-to'g'ri R2 CDN public domenidan (`R2_PUBLIC_URL`) brauzer va Telegram Mini Appga yuklansa, brauzer `fetch()` yoki canvas xatosi bermasligi uchun Cloudflare R2 da quyidagi CORS sozlanishi tavsiya etiladi:
    ```json
    [
      {
        "AllowedOrigins": ["*"],
        "AllowedMethods": ["GET", "HEAD"],
        "AllowedHeaders": ["*"],
        "MaxAgeSeconds": 3600
      }
    ]
    ```
  - Agar `R2_PUBLIC_URL` bo'sh qolsa, FastAPI serveri rasmlarni o'zidan `/api/entry/{id}/photo/{idx}` orqali stream qilib beradi (CORS talab etilmaydi).
- **Graceful Local Fallback**: Agar R2 sozlamalari (`.env`) kiritilmagan bo'lsa yoki R2 vaqtincha uzilsa, tizim avtomatik ravishda lokal diskka (`data/photos/<entry_id>/<idx>`) yozadi.
- **Xavfsiz R2 ga ko'chirish (`python -m app.storage_migrate`)**:
  - **Zero Data Loss Kafolati**: Sukut bo'yicha lokal fayllar va bazadagi BLOB hech qachon o'chirilmaydi.
  - Har bir rasm R2 ga yuklangach, `head_object` orqali baytma-bayt to'liq tekshiriladi; faqat 100% muvaffaqiyatli tekshiruvdan keyingina SQLite da `r2_key`/`r2_url` yoziladi.
  - Jarayon to'xtab qolsa yoki internet uzilsa, qayta ishga tushirish qolgan rasmlardan davom etadi (idempotent).
  - `--dry-run`: hech narsani o'zgartirmasdan holatni ko'rsatish; `--purge-local`: faqat R2 ga yuklangani tasdiqlangach disk nusxasini tozalash.


### C. Ma'lumotlar Modeli va Balans Qoidalari (`app/db.py`)
- **`reports`**: Maksimal 25 ta hisobot (`MAX_REPORTS = 25`). Yangi hisobot 25 tadan oshsa, eng eskisi qattiq tozalanadi (`_prune`).
- **`inventory`**: `(report_id, tovar_turi) -> weight`.
- **`activity`**: Yozuvlar logi (`reys`, `adjust`, `top`, `topchiqgan`, `bizda`, `chiqgan`).
- **Balans qoidasi**:
  - `reys`: Sof vazn $\text{net} = \text{weight} - \text{coefficient}$. Faqat `net` inventarga qo'shiladi.
  - `adjust`: Bir tovar turidan boshqasiga vazn ko'chiradi. Agar qoldiq yetmasa `InsufficientStock` (409) beradi.
  - **Obshiy ves harakatlari inventarga ta'sir qilmaydi**: `coefficient = 0`, `net = weight` bo'ladi, koeffitsient esa `box_weight` ustunida saqlanadi.

### D. Outbox va Kanallar (`app/outbox.py`)
- Harakatlar bo'yicha Telegram kanallari:
  - `top` $\rightarrow$ `BOT_TOP_TYPE_CHANNEL_ID`
  - `topchiqgan` $\rightarrow$ `BOT_TOPDAN_CHIQGAN_CHANNEL_ID`
  - `bizda` $\rightarrow$ `BOT_BIZDA_QOLADIGAN_CHANNEL_ID`
  - `chiqgan` $\rightarrow$ `BOT_BIZDAN_CHIQGAN_CHANNEL_ID`
  - `reys` va `adjust` $\rightarrow$ `BOT_KARGOLARGA_TARQATISH_CHANNEL_ID`
- Xatolik yuz berganda qayta urinish zinapoyasi: `[5, 15, 30, 60, 120, 300, 600, 900]` soniya.

### E. Avtomatlashtirilgan Testlar (`tests/`)
- Loyihada to'liq regressiya va integratsiya testlari mavjud (`python -m pytest`).
- `test_db_and_storage.py` — Baza yaratilishi, balans hisoblash, tovarlararo ko'chirish (`adjust`), R2 storage va lokal fallback sinovlari.
- `test_migrate.py` — R2 xavfsiz migratsiyasi, ma'lumotlar saqlanishi va unmigrated rasmlar tekshiruvi.
- `test_server_api.py` — FastAPI marshrutlari, rasmli multipart yuborish, Excel eksporti va xavfsizlik (CSRF/Origin) sinovlari.

### F. Ishlash Unumdorligi (Performance Tuning)
- SQLite PRAGMAlari: `journal_mode=WAL`, `synchronous=NORMAL`, `busy_timeout=5000`, `cache_size=-64000`, `temp_store=MEMORY`.
- `list_entries` dagi N+1 so'rovlar muammosi bartaraf qilindi: `LEFT JOIN` va `IN (...)` orqali 1000 ta so'rov atigi 2 ta tezkor so'rovga qisqartirildi.
### G. WebP Rasmlar Konvertatsiyasi (Client & Server)
- **Klient tomoni (`webapp/js/app.js`)**:
  - `convertFileToWebP`: Galereyadan tanlangan rasmlarni brauzer canvas orqali avtomatik WebP ga (95% sifat) o'tkazadi (maksimal o'lcham 2560px).
  - Jonli kameradan (`capturePhoto`): to'g'ridan-to'g'ri `image/webp` formatida olinadi.
  - Qurilma xotirasi (IndexedDB) va mobil internet trafigi 70-85% tejaladi.
- **Server tomoni (`app/images.py`)**:
  - `Pillow` va `pillow_heif` kutubxonalari orqali istalgan format (HEIC, HEIF, JPEG, PNG, WEBP) qabul qilinadi.
  - EXIF orientation avtomatik to'g'rilanadi (`ImageOps.exif_transpose`), o'lcham 2560px gacha Lanczos orqali optimal masshtablanadi.
  - Server diskiga va Cloudflare R2 ga doimo `.webp` saqlanadi.
- **Migratsiya (`app/storage_migrate.py`)**:
  - Eskidan diskda qolgan JPEG/PNG rasmlarni R2 ga ko'chirishda avtomatik WebP ga aylantiradi va `head_object` orqali tekshirib, Zero Data Loss tamoyili bilan saqlaydi.

### H. Oflayn Rejim, Floating Status Bar va Outbox Diagnostikasi
- **Outbox oynasi (iOS va Android xatosi tuzatildi)**:
  - Ilgari `#outboxSheet` z-index (50) to'liq ekranli `.screen` (90) ortida qolib ketgani uchun mobil qurilmalarda ko'rinmas edi.
  - Endi `#outboxSheet` (100) va `#outboxBackdrop` (99) barcha ekranlar ustida ko'rinadi.
  - `.sheet--tall` da `touch-action: pan-y;` va `-webkit-overflow-scrolling: touch;` orqali sensorli ekranda ravon aylantirish ta'minlandi.
- **Floating Status Bar (`#outboxPillWrap`, `.outbox-pill`)**:
  - Adminlarning "yukim tushdimi, internet bormi, bazaga yuklash boshlandimi?" degan xavotirlarini yo'qotish uchun ekranning yuqori qismida ixcham holat indikatori ishlaydi.
  - Konteynerda `pointer-events: none` o'rnatilgan — forma to'ldirishga, tugmalarni bosishga va skrollga **aslo xalaqit bermaydi**.
  - Tugmaning o'zini bosganda esa darhol batafsil diagnostika oynasi ochiladi.
  - Jonli holatlar: `⚡ 3 ta kutilmoqda (Oflayn)`, `🔄 Yuklanmoqda…`, `⏳ 3 ta yozuv navbatda`.
- **Batafsil Diagnostika Kartalari (`.outbox-card`)**:
  - Har bir yozuv bo'yicha: Reys nomi, Bo'lim (`Top`, `Bizda`, `Chiqgan`, `Kargo`), Kod, Og'irlik, Koeffitsient ko'rsatiladi.
  - **Rasmlarning haqiqiy miniatyurasi (Thumbnails)**: Blob lardan `<img>` miniatyuralar chiziladi, admin aynan qaysi rasm kutayotganini ko'z bilan ko'rib xotirjam bo'ladi.
  - Alohida yuborish va o'chirish tugmalari mavjud.

### I. "Yuklanganlar" Oynasida Qidiruv, Saralash va Filtr Tizimi
- **Barcha 6 ta bo'lim uchun umumiy (`#entriesScreen`)**:
  - Kargolarga tarqatish (`reys`), Adashgan yuklar (`adjust`), Top yuklangan (`top`), Bizda qoladigan (`bizda`), Bizdan chiqgan (`chiqgan`), Topdan chiqgan (`topchiqgan`).
- **Tezkor qidiruv (Instant Search)**:
  - Karobka kodi (`code`), tovar/kargo nomi (`type`), o'tkazish yo'nalishi (`from -> to`), og'irlik bo'yicha 0ms kechikish bilan real-time izlash + tozalash (×) tugmasi.
- **Sana bo'yicha saralash va oraliq**:
  - Tezkor chiplar: `Barchasi`, `Bugun`, `Kecha`, `7 kun`.
  - Maxsus sana oralig'i: `Dan` va `Gacha` taqvimi orqali ixtiyoriy oraliqni filtrlash.
- **Saralash tartibi (Sort Order)**:
  - `⏳ Yangilari oldin` (yangidan eskiga)
  - `⌛ Eskilari oldin` (eskidan yangiga)
  - `⚖️ Og'irlari oldin` (katta vazndan kichikka)
  - `🪶 Yengillari oldin` (kichik vazndan kattaga)
  - `🔤 Kod / Tovar (A-Z)` (alifbo / son tartibi)
- **Kanal va Tovar filtrlari**:
  - Telegram kanali holati: `Barchasi`, `📤 Yuborilmaganlar`, `✅ Yuborilganlar`, `🖼️ Faqat rasmlilar`.
  - Tovar turi bo'yicha filtrlash (mavjud tovarlar bo'yicha dinamik dropdown).
- **Statistika va Xulosa Bar (`#entriesSummaryBar`)**:
  - `N ta yozuv (jami M tadan)` va `Jami: X.XX kg` doimiy ko'rinib turadi.
  - Filtr aktiv bo'lganda filtr tugmasida ko'k nuqta (`#entriesFilterDot`) yonadi va bitta bosish bilan tozalash (`Tozalash`) tugmasi paydo bo'ladi.

### J. Mobil-Birinchi Dizayn Tizimi (Mobile-First Design System)
- **Zamonaviy Palitra**:
  - Asosiy harakat rangi: Electric Blue (`#2457ff`).
  - Faol indikator va urg'u: Neon Volt (`#c8ff3d`).
  - Chuqur OLED Obsidian qora mavzu (`#090b10` / `#050608` / `#11141d`) va ko'zni toliqtirmaydigan tiniq oq mavzu (`#f8fafc` / `#090d16`).
- **Mobil Ergonomika va Sensor Qulaylik**:
  - Barcha asosiy tugmalar (`.btn--primary`, `.work-save`, `#saveBtn`) va elementlar uchun 48-52px minimal sensor nishoni (touch target).
  - iPhone Dynamic Island / notch va Android navigatsiya paneli uchun to'liq xavfsiz maydon (`env(safe-area-inset-top)`, `env(safe-area-inset-bottom)`).
  - Taktil sensor bosish animatsiyasi: `:active { transform: scale(0.97); }`.
- **Ombor Operatsiyalari uchun Hero Og'irlik Maydoni**:
  - `#weight`, `#adjWeight`, `#topWeight` maydonlari 28px qalin tabulyar raqamlar (`tabular-nums`) bilan jihozlandi.
  - Suffix maydonida aniq ko'rinadigan `kg` yorlig'i va tezkor saqlash tabletkasi (`.suffix-save`).
- **Tezkor Rejim Yorug' Banneri (`.fast-mode-banner`)**:
  - `#panel-report` va `#topScreen` formalarida tezkor rejim faollashganda Neon Volt (`#c8ff3d`) yorug'lik taratuvchi banner paydo bo'ladi.
  - Banner saqlashdan so'ng keyingi yuk uchun kamera avtomatik ochilishini doimo eslatib turadi va bosilganda tezkor rejimni to'g'ridan-to'g'ri o'chiradi/yoqadi.

### K. Server Deploy va Cloudflare R2 / CORS Arxitekturasi
- **Ishlab chiqarish serveri holati (`89.167.37.232`)**:
  - Supervisor dasturi: `report` (`127.0.0.1:5555`), Nginx reverse-proxy (`https://report.xckep.uz`).
  - Ma'lumotlar to'liq zaxirasi: `/root/mandarin_foto_hisobot/data_backup_20260930_pre_pull/` (422MB SQLite `data/reys.db` va 3,998 ta rasm papkalari saqlangan).
  - Maxsus Redis porti: `127.0.0.1:6385`, parol `Mandarin2026!`. Alohida xavfsiz instansiya, boshqa loyihalarga tegmaydi.
- **Cloudflare R2 Folder Tuzilishi**:
  - `{action}/report_{report_id}/{entry_id}/{idx}.webp`
  - Bo'limlar bo'yicha toza kataloglash:
    - Obshiy ves: `top/report_44/5915/0.webp`, `bizda/report_44/5916/0.webp`, `chiqgan/report_44/5917/0.webp`, `topchiqgan/report_44/5918/0.webp`
    - Kargolarga tarqatish: `reys/report_44/5919/0.webp`
    - Adashgan yuklar (razves): `adjust/report_44/5920/0.webp`
- **R2 CORS (Cross-Origin Resource Sharing) Qoidalari**:
  - **Server orqali proksi (standart holat)**: `R2_PUBLIC_DOMAIN` belgilanmaganda rasmlar `/api/entry/{id}/photo/{idx}` orqali server tomonidan uzatiladi. Bu holatda **CORS umuman shart emas**, R2 bucketni public qilish ham kerak emas.
  - **Direct Public CDN / Custom Domain qo'llanilganda**: Agar R2 ga ommaviy havola (masalan, `pub-xxx.r2.dev` yoki `cdn.xckep.uz`) ulanib `.env` ga berilsa, Mini App brauzerida rasm yuklanishi va canvas tahlilida bloklanmasligi uchun Cloudflare R2 bucket settingsda CORS policy (`GET`, `HEAD`, `*`) yoqilishi shart.

### L. iOS (WebKit) va Oflayn Rejimda Rasmlar Barqarorligi (Oktyabr 2026)
- **Xatoliklarni formatlash (`formatApiError`)**:
  - FastAPI 422 xatolari va ichki xato massivlari inson tushunadigan o'zbekcha matnga aylantiriladi.
  - Ekranda tushunarsiz `[object Object]` ko'rinishi butunlay bartaraf etildi.
- **IndexedDB xavfsiz Blob saqlash**:
  - iOS Safari (WebKit / Telegram in-app brauzeri) da `File` obyektlarini IndexedDB ga yozishda yuz beradigan `DataCloneError` muammosi bartaraf etildi: rasmlar sof `Blob` (`file.slice`) va `{ name, type, blob }` formatida xavfsiz saqlanadi.
  - `uploadCreateRaw` da `b instanceof Blob` qat'iy tekshiriladi, bu serverga tasodifan `photos = "[object Object]"` matni ketishini 100% oldini oladi.
- **iPhone Kamera WebP/JPEG Fallback**:
  - `capturePhoto` da `canvas.toBlob("image/webp")` xotira yoki format cheklovi sababli `null` qaytarganda, avtomatik `image/jpeg` (0.92) ga o'tish zanjiri joriy etildi. Kamera hech qachon bo'sh rasm qoldirmaydi.
- **Onlayn Tezkor Saqlash (Optimistic Dual Strategy)**:
  - Qurilma onlayn bo'lganda, yozuv to'g'ridan-to'g'ri serverga yuklanadi (IndexedDB ga ortiqcha yozish/o'chirish tsikli aylanmaydi, tezlik 2x oshadi).
  - Faqat tarmoq uzilsa yoki telefon oflayn bo'lsagina yozuv IndexedDB navbatiga qo'yiladi va aloqa tiklanganda fonda yuklanadi.
- **Backend 422 Handler (`app/server.py`)**:
  - `RequestValidationError` uchun maxsus handler qo'shilib, xom Pydantic JSON massivlari o'rniga doim standart `{"ok": false, "detail": "..."}` qaytariladi.

### M. 200 Reyslar Limiti, Reys Nomini Tahrirlash (Rename) va Tezkor Qidiruv (Oktyabr 2026)
- **Maksimal Hisobotlar Limiti 200 taga ko'tarildi**:
  - `app/config.py` va `app/db.py` da `MAX_REPORTS = int(os.getenv("MAX_REPORTS", "200"))` qilib sozlandi.
  - `.env.example` ga `MAX_REPORTS=200` kiritildi.
  - Mini App interfeysi `homeReportsMax = 200` bilan ishlaydi va serverdan olingan limitni aks ettiradi.
- **Reys Nomini O'zgartirish (Rename Report)**:
  - Backend: `app/db.py` da `rename_report(report_id, new_name)` qo'shildi (takroriy nom, bo'sh nom va uzunlik cheklovlari tekshiriladi). Barcha yozuvlar `report_id` ga bog'langanligi sababli nom o'zgartirish mutlaqo xavfsiz.
  - API: `PATCH /api/reports/{report_id}` endpointi yaratildi (admin auth, rate limiting, xatoliklar tekshiruvi bilan).
  - Frontend: Har bir reys kartasida **✏️ Nom** tugmasi va reys menyusida sarlavha yonida `#menuRenameBtn` qalamchasi qo'shildi. Bosilganda ochiluvchi modal orqali nom bir zumda o'zgartiriladi va toast bildirishnomasi chiqadi.
- **Hisobotlar Bo'yicha Jonli Qidiruv (Live Search)**:
  - Bosh ekranda `#homeSearchInput` qidiruv paneli joylashtirildi.
  - Foydalanuvchi nom yozishi bilan reyslar ro'yxati jonli ravishda filtrlanadi va topilganlar soni (`N ta hisobot topildi`) ko'rsatiladi. Tozalash tugmasi (`&times;`) mavjud.

### N. Hisobotlar Oynasida Ko'p Reysli Filtr va Excel Eksport (Oktyabr 2026)
- **Bosh ekrandagi Filtr interfeysi (`#/reports`)**:
  - `#homeScreen` da "Yangi hisobot qo'shish" yonida zamonaviy `#homeFilterBtn` filtr tugmasi joylashtirildi.
  - Bosilganda qulay pastki panel (`#reportsFilterSheet`) ochiladi:
    1. **Tovar turi tanlash** (`<select id="filterTovarSelect">`): Standart va maxsus qo'shilgan barcha tovar turlari ro'yxati.
    2. **Reyslar ro'yxati (Multi-select checkbox list)**: Mavjud hisobotlar ro'yxati, har bir reys nomi va undagi yozuvlar soni ko'rsatiladi. Barcha reyslarni bir bosishda belgilash ("Barchasi") yoki tozalash ("Tozalash") havolalari mavjud.
    3. **"Rasmlarni ham tortish" toggle**: Yoqilganda tanlangan reyslardagi ushbu tovar turiga tegishli rasmlar avtomatik yuklanadi.
    4. **"Excel yuklab olish" tugmasi**: Jarayon davomida yuklanish holatini ko'rsatadi va tayyor faylni yuklab beradi.
- **Excel Hisobot Tuzilishi (`app/excel_export.py`)**:
  - **1-ustun (Col A)**: Reys nomi (`FilterRep1`, `Reys 10` va h.k.).
  - **2-ustun (Col B)**: Og'irligi (Umumiy hisobot formulasidagi ushbu tovar turining baza og'irligi).
  - **3-ustun (Col C)**: Qo'shiladigan karobka og'irligi (Umumiy hisobot formulasidagi taqsimlangan karobka og'irligi).
  - **4-ustun (Col D)**: Jami og'irlik (Jonli Excel formulasi: `=B{row}+C{row}`).
  - **5-ustun va keyingilar (Col E+)**: Agar rasmlar tanlansa, har bir reysdagi o'sha tovar turiga yuklangan fotosuratlar 110x110 px o'lchamdagi miniatyura (thumbnail) sifatida katakchalarga (`1-rasm`, `2-rasm`...) chiroyli joylashtiriladi.
  - **Pastki qatordagi JAMI**: Yakuniy umumiy yig'indi satri jonli Excel formulalari (`=SUM(B2:B{N})`, `=SUM(C2:C{N})`, `=SUM(D2:D{N})`) bilan hisoblanadi.
- **Backend API & Baza (`app/server.py`, `app/db.py`)**:
  - `POST /api/export/filtered` (JSON body) va `GET /api/export/filtered` endpointlari.
  - `db.get_report_type_photos(report_id, tovar_turi)`: Ushbu hisobot va tovar turiga tegishli barcha rasmlarni tartib bilan olib beradi.
  - `excel_export.calculate_report_metrics(report_id)`: Umumiy hisobotdagi mandarin, taqsimlanuvchi va taqsimlanmaydigan tovar turlari bo'yicha og'irlik va karobka og'irliklarini hisoblab beruvchi yagona mantiqiy markaz.
- **Avtomatlashtirilgan Testlar**:
  - `tests/test_server_api.py` da `test_cross_report_filtered_export` testi qo'shildi (openpyxl orqali formulalar, qatorlar, JAMI va rasmlar to'liq tekshirildi). Barcha 15 ta test muvaffaqiyatli o'tadi.

### O. Desktop & Tablet UI/UX Moslashuvi va Sheet Z-Index / Kesh Tuzatishlari (2026-10-07)
- **Sheet Z-Index & Ko'rinish Tuzatishi**:
  - `.screen` qatlami `z-index: 90` ga ega bo'lganligi sababli, ilgari `.sheet` (`z-index: 50`) va `.sheet-backdrop` (`z-index: 40`) bosh ekranning orqasida qolib ketgan edi.
  - Barcha `.sheet` va modal elementlar (`#reportsFilterSheet`, `#nameSheet`, `#setSheet`, `#entryActSheet`, `#outboxSheet`) qat'iy `z-index: 100 !important`, ularning fonlari esa `z-index: 99 !important` ga ko'tarildi.
  - Brauzer keshini yangilash uchun `index.html` da CSS va JS versiyalari `?v=desktopux2` ga oshirildi.
- **Desktop & Tablet Responsiv Dizayn**:
  - `.home-container` va `.screen__top-inner` uchun `max-width: 1000px; margin: 0 auto;` o'rnatildi, bu keng monitorlarda (1920px+) elementlarning xunuk cho'zilib ketishining oldini oladi.
  - Bosh ekran boshqaruv paneli (`.home-toolbar`):
    - Mobilda: yuqorida `Filtr` (ixcham) + `Yangi hisobot qo'shish` (asosiy) yonma-yon, pastda to'liq kenglikdagi qidiruv satri.
    - Planshet va kompyuterda (`min-width: 640px`): bir chiziqli zamonaviy panel — chapda moslashuvchan qidiruv satri, o'rtada `Filtr` tugmasi, o'ngda `Yangi hisobot qo'shish` tugmasi.
  - Reyslar ro'yxati: Planshet va kompyuterda 2 ustunli chiroyli grid (`grid-template-columns: repeat(2, minmax(0, 1fr))`), hover effektlari, interaktiv soyalar va harakatlar.
  - Modallar: Keng ekranlarda pastki tortma (drawer) o'rniga markazlashtirilgan macOS/iPadOS modal dialogi (`width: min(540px, 92vw)`, markazda suzuvchi, 24px yumaloqlangan burchaklar, nozik hoshiya va chuqur soya).
  - Tovar tanlash `<select id="filterTovarSelect">`: `.input--select` maxsus o'ng tomondagi ko'rsatkich burchak (chevron arrow) belgisi bilan to'liq stilizatsiya qilindi.

### P. Filtrlangan Rasmlarni Telegram Kanalga Yuborish va Kanalni Eslab Qolish (2026-10-07)
- **Talab & Konseptual O'zgarish**:
  - Foydalanuvchi talabi bilan Excel fayl ichiga og'ir rasmlarni yuklash to'xtatildi ("rasmlar exelda kerak emas"). Buning o'rniga Excel toza va yengil 4 ta ustun (Reys nomi, Og'irligi, Qo'shiladigan karobka, Jami) va pastki `JAMI` yig'indi formulasi bilan lahzada shakllanadi.
  - Tanlangan reyslardagi belgilangan tovar turiga tegishli fotosuratlar va yozuvlar "Kargolarga tarqatish" xabarlari formatida (`{report_name} - {tovar_turi}\n\n{weight} - {coef} = {net} kg`) foydalanuvchi kiritgan Telegram kanalga yuboriladi.
- **Kanalni Eslab Qolish (Memory across devices & sessions)**:
  - Baza: `app/db.py` da `app_settings` jadvali (`key TEXT PRIMARY KEY, value TEXT NOT NULL`) va `get_setting` / `set_setting` yordamchilari joriy qilindi.
  - API: `GET /api/reports` endopointi `last_filter_channel` parametrini ham qaytaradi.
  - Frontend: `#filterChannelInput` maydoni avval `localStorage.getItem("last_filter_channel")`, agar u bo'sh bo'lsa serverdan kelgan `state.lastFilterChannel` bilan avtomatik to'ldiriladi. Har safar yuborilganda kiritilgan kanal `localStorage` da yangilanadi.
- **Kanalga Yuborish API & Xavfsizlik (`app/server.py`, `app/outbox.py`)**:
  - `POST /api/send-filtered`:
    - Parametrlar: `{ init_data, report_ids, tovar_turi, channel_id }`.
    - Erta tekshiruv: `_bot.get_chat(chat)` orqali bot ushbu kanalga a'zoligi va ruxsati bor-yo'qligi darhol tekshiriladi. Agar bot kanalda admin bo'lmasa, tushunarli o'zbekcha xatolik beriladi (`"Bot ushbu kanalga ulanmagan yoki admin huquqi yo'q..."`).
    - Fon jarayoni: `outbox.send_filtered_to_channel(chat, entries)` orqali har bir yozuv 1 ta rasm bo'lsa `send_photo`, ko'p rasm bo'lsa `send_media_group`, rasm bo'lmasa `send_message` orqali yuboriladi. Telegram flood control (`retry_after`) va xabarlar orasida 0.4s pauza bilan himoyalangan.
- **Interfeys**:
  - `#reportsFilterSheet` da eski rasmlar checkboxi o'rniga `#filterChannelInput` kiritish maydoni.
  - Pastda ikkita alohida boshqaruv tugmasi: `#filterDownloadBtn` ("Excel yuklab olish") va `#filterSendBtn` (Telegram ko'k rangida "Telegramga yuborish").
  - Kesh yangilanishi: `?v=tgchannel1`.
- **Top Tovar Turi Maxsus Mantiqi ("Bizda qoladigan"dan olish)**:
  - Tovar turi `top` tanlanganda og'irlik `inventory` dan emas (u yerda doim 0), balki Obshiy ves ichidagi "bizda qoladigan" sheetining yakuniy jami og'irligi (`bizda_total`) dan olinadi (`metrics["top"]`).
  - Telegramga yuborishda `tovar_turi == 'top'` bo'lganda `action in ('bizda', 'top')` bo'lgan barcha Obshiy ves yozuvlari avtomatik tanlanadi va fotosuratlari bilan kanalga yuboriladi.

### Q. Tovar Turlarini To'g'ri Ajratish (x637 vs xabib) va Reys Kartasi 3-Talik Nuqta Menyusi (2026-10-07)
- **Tovar Turlari Normalizatsiyasi (`normalize_type_key` & `normalize_telegram_type_key`)**:
  - Umumiy hisobotlar, inventar va Excel jadvallarida (`normalize_type_key`) `x637`, `x517`, `x657` kabi barcha `x`+raqamli turlar avvalgidek `xabib` hisobiga jamlanadi.
  - **Faqat Telegramga yuborishda (`normalize_telegram_type_key`)**: Har bir `x`+raqamli tur (`x637`, `x517`, `x657`) `xabib` dan to'liq alohida mustaqil tur sifatida ajratiladi, natijada kanalga `x637` yuborilganda faqat `x637` yozuvlari va rasmlari yuboriladi, `xabib` qo'shilib ketmaydi.
- **Reys Kartasida 3 Talik Nuqtacha Menyusi (Kebab menu ⋮)**:
  - Bosh ekrandagi har bir reys kartasiga qulay 3-talik nuqtacha tugmasi (`.report-item__more`) qo'shildi.
  - Bosilganda zamonaviy `#reportMoreSheet` menyusi ochiladi va 2 ta asosiy amaliyotni taklif etadi:
    1. **"Maxsus reys nomi (Card Badge & Umumiy hisobot Excel)" (`#specialReysSheet`, `POST /api/reports/{id}/special-name`)**:
       - Alohida yangi hisobot/karta ochmaydi. Tanlangan reysga maxsus nom biriktiradi (`special_name` ustuni).
       - Shu reys kartasining ichida o'ziga xos yuqori kontrastli, o'qish juda oson bo'lgan issiq oltin/amber rangli VIP belgi (`.report-item__special-badge`) bo'lib ko'rinadi (yorug' rejimda quyuq bronza matn `#78350f` va yumshoq fon `#fef3c7`, qorong'u rejimda yorqin oltin `#fde68a`).
       - Agar mavjud badge bo'lsa, uni tahrirlash yoki "Badgeni o'chirish" tugmasi orqali tozalash mumkin.
       - **Umumiy hisobot Excel (`build_umumiy_excel`)**: Shablonning `B2` katakchasidagi eski statik `M174` matni o'rniga dinamik ravishda shu reysning maxsus nomi (`special_name`) yoziladi.
    2. **"Kg to'g'rilash" (`#kgFixSheet`)**:
       - Tanlangan reysdagi istalgan tovar turiga to'g'ridan-to'g'ri `+` yoki `-` kg (masalan `+6` yoki `-2.5`) qo'shish yoki ayirish imkonini beradi.
       - Sababi/izoh kiritish maydoni (`note`).
       - Baza darajasida (`db.fix_report_kg`): `inventory` jadvalidagi qoldiq hisob-kitob qilinadi, `activity` jadvaliga `action = 'kg_fix'`, `weight = delta`, `net = delta`, `actor = identity`, `note = note` ko'rinishida audit qaydi yoziladi.
       - Foydalanuvchi kim qilganini aniq ko'rishi uchun: Faoliyat (Activity) tarixida `Kg to'g'rilash: {tovar} ({+6/-2.5} kg) | Admin: {actor} · {izoh}` ko'rinishida aniq audit ko'rsatiladi.
- **Backend API**:
  - `POST /api/reports/{report_id}/special-name` (JSON: `{ special_name }`).
  - `POST /api/reports/{report_id}/adjust-kg` (JSON: `{ tovar_turi, weight, note }`).
- **Kesh yangilanishi**:
  - `index.html` da CSS va JS fayllar versiyasi `?v=badgecolor1` ga yangilandi.

### R. Word DOCX Hisoboti va Maxsus Reys Filtr Tizimi (2026-10-07)
- **Talab & Maqsad**:
  - Maxsus reysi (`special_name`) mavjud bo'lgan reyslarda Umumiy hisobot Excel yuklab olinganda unga qo'shimcha ravishda avtomatik ravishda Word (`.docx`) hisobot hujjati ham birga yuklab beriladi.
  - Qidiruv va ko'p reysli filtrda maxsus reys nomi bo'yicha ham tezkor qidirish va saralash imkoniyati yaratildi.
- **DOCX Hujjat Strukturasi & Hisob-kitob Qoidalari (`app/excel_export.py:build_special_docx`)**:
  - **Sana**: Reys bo'yicha birinchi yozuv kiritilgan vaqt (`db.get_report_start_ts` -> `SELECT MIN(ts) FROM activity WHERE report_id = ? AND deleted_at IS NULL`, `DD.MM.YYYY` formatida).
  - **1-qator**: `AVIA {special_name} ({report_name}) UCHUN OPSHI VES: {total_ves:.2f} KG. {date}` (`total_ves` = Obshiy ves `top` worksheet D ustun jami + `bizda qoladigan` worksheet D ustun jami).
  - **2-qator**: `TOP CARGO {special_name} ({report_name}) - {top_total:.2f} KG. {date}` (Obshiy ves `top` worksheet D ustun jami).
  - **3-qator**: `Avia {special_name} ({report_name})  - {bizda_total:.2f} KG. {date}` (Obshiy ves `bizda qoladigan` worksheet D ustun jami).
  - **4-qator**: `(O'zimizga qolgan.)`.
  - **5-qator va keyingilari**: Umumiy hisobot E ustunidagi og'irliklar ("To'lashi kerak bo'lgan summa:"): `{CARGO_NOMI} ({special_name}) - {total:.2f} KG` (`mandarin`, `akb`, `jet`, `xabib` va barcha kargolar bo'yicha karobka taqsimoti va kg_fix qo'shilgan yakuniy to'lov og'irligi).
  - Toza va ixcham Calibri 11.5pt shrifti, qalin sarlavhalar va 1.15 qatorlar oralig'i bilan `python-docx` orqali hosil qilinadi.
- **Backend API & Bog'liqliklar**:
  - `requirements.txt`: `python-docx>=1.1.0`.
  - `GET /api/export/docx?report_id=`: DOCX faylini `application/vnd.openxmlformats-officedocument.wordprocessingml.document` ko'rinishida yuklab beradi.
- **Frontend Imkoniyatlari (`webapp/js/app.js`, `webapp/index.html`, `webapp/css/styles.css`)**:
  - **Avtomatik yuklash**: Reys kartasidagi `Excel` tugmasi bosilganda (`downloadSummaryExcel`), agar reysda `special_name` mavjud bo'lsa, 350ms kechikish bilan `downloadDocx(rep)` ham avtomatik ishga tushib, foydalanuvchiga Word hujjatini yuklab beradi.
  - **Kebab menyuda alohida tugma**: `#reportMoreSheet` da reysda maxsus nom bo'lsa `#reportMoreDocxBtn` ("Word (DOCX) yuklab olish") tugmasi ko'rinadi va faqat DOCX faylni alohida yuklash imkonini beradi.
  - **Asosiy qidiruv (`#homeSearchInput`)**: Reys nomi bilan bir qatorda maxsus reys nomi bo'yicha ham real vaqtda filtrlaydi.
  - **Ko'p reysli filtr oynasida (`#reportsFilterSheet`)**:
    - Har bir reys checkbox satrida maxsus reys nomi oltin rangli VIP badge bilan ko'rsatiladi.
    - `#filterReportsSearch` orqali ro'yxatni nom yoki maxsus reys bo'yicha lahzada qidirish.
    - `#filterSpecialOnlyReports` ("Maxsus reyslar") tugmasi orqali birgina bosishda faqat maxsus reyslarni belgilash.
  - Kesh yangilanishi: `?v=specialdocx1`.

### S. Dinamik Koeffitsient va Karobka Og'irligi Presets ('+' tugmasi va boshqaruv) (2026-10-08)
- **Talab & Maqsad**:
  - Kargolarga tarqatish (`#workScreen`) va Obshiy ves (`#topScreen`) oynalarida koeffitsient va karobka og'irliklarini tezkor tanlash imkonini kengaytirish.
  - Foydalanuvchilar har safar "O'zim kiritaman" orqali yangi sonlarni qayta-qayta yozib o'tirmasligi uchun dinamik `+` tugmasi orqali yangi qiymatlarni kiritish, ularni qurilma xotirasida (`localStorage`) saqlab qolish va istalgan payt o'chirish/boshqarish imkoniyatini ta'minlash.
- **Foydalanuvchi Interfeysi & Amallar**:
  - **Kargolarga tarqatish (`#coefChips`)**: Boshlang'ich `0.94`, `1.22`, `1.4`, `1.05` chiplari yonida interaktiv `+` tugmasi (`.chip--add`) joylashtirildi. Bosilganda koeffitsient qo'shish paneli ochiladi.
  - **Obshiy ves (`#topCoefChips`)**: Boshlang'ich `1`, `1.22`, `1.4`, `1.05` chiplari yonida interaktiv `+` tugmasi (`.chip--add`) joylashtirildi.
  - **"Ayirilmasin" menyusi (`#coefBoxMenu`)**: Kargolarga tarqatishdagi ochiluvchi menyu pastida `+ Yangi karobka og'irligi` elementi qo'shildi. Kiritilgan yangi og'irlik ham Obshiy ves, ham Ayirilmasin menyusida bir zumda paydo bo'ladi.
  - **Yangi Bottom Sheet (`#presetSheet`)**:
    - Zamonaviy va ixcham modal: sarlavha, o'nlik klaviatura (`inputmode="decimal"`), "Saqlash va tanlash" tugmasi.
    - **Mavjud qiymatlarni boshqarish / o'chirish**: Sheet pastida barcha mavjud qiymatlar ko'rinadi va foydalanuvchi qo'shgan shaxsiy qiymatlar yonidagi `×` tugmasi orqali tasodifiy xato kiritilgan qiymatlarni bir zumda o'chirib tashlash mumkin.
- **Saqlash va Barqarorlik**:
  - Qiymatlar `localStorage` dagi `reys_coef_presets` va `reys_box_presets` kalitlarida saqlanadi.
  - Xatoliklardan himoyalangan (`try/catch` va musbat son tekshiruvi).
  - Yangi qiymat kiritilganda chiplar avtomatik qayta chiziladi va yangi kiritilgan qiymat darhol tanlanadi (`setCoefUI` / `setTopCoefUI`).
- **Kesh yangilanishi**:
### T. Barcha Tovar Turlarini Uppercase Qilish (2026-10-09)
- **Talab & Maqsad**:
  - Ma'lumotlar bazasida (`data/reys.db`) barcha tovar turlari (`tovar_turi`, `from_type`, `to_type`, `custom_types.name`) bosh harflarga (UPPERCASE: `AKB`, `TRITON`, `IZI`, `NAVO`, `XABIB`, `JET`, `JON`, `TOP`, `UZTEZ`, `MANDARIN`, `ONEWAY`, `X637`, `X517`, `REDWING`, `MEBEL`, `XON CAROGO`, `MUSR`) o'tkazildi.
  - Tizimda aralash holat (masalan bir joyda `x637` va `X637`, `oneway` va `ONEWAY`) to'liq bartaraf qilindi va yagona bosh harf standartiga keltirildi.
- **Baza Migratsiyasi (`schema_migrations: uppercase_all_tovar_turi_20261009`)**:
  - `init()` funksiyasida idempotent xavfsiz migratsiya qo'shildi:
    1. `inventory` jadvalidagi mumkin bo'lgan duplikatlar tekshirilib birlashtiriladi.
    2. `custom_types` dagi duplikatlar birlashtiriladi.
    3. `UPDATE custom_types SET name = UPPER(name)`
    4. `UPDATE inventory SET tovar_turi = UPPER(tovar_turi)`
    5. `UPDATE activity SET tovar_turi = UPPER(tovar_turi) WHERE tovar_turi IS NOT NULL`
    6. `UPDATE activity SET from_type = UPPER(from_type) WHERE from_type IS NOT NULL`
    7. `UPDATE activity SET to_type = UPPER(to_type) WHERE to_type IS NOT NULL`
  - Hech qanday og'irlik, audit yozuvi yoki rasm yo'qotilmadi (to'liq zero data loss).
- **Backend & Frontend Sinxronizatsiyasi**:
  - `app/db.py`: `DEFAULT_TYPES = ["AKB", "TRITON", "IZI", "NAVO", "XABIB", "JET", "JON", "TOP", "UZTEZ", "MANDARIN", "ONEWAY", "X637", "X517", "REDWING"]`, `DEFAULT_TYPE_SET = {t.upper() for t in DEFAULT_TYPES}`.
  - `_clean_type(name: str)` endi har doim `.strip().upper()` qaytaradi, shuningdek `add_reys`, `adjust`, `fix_report_kg`, `edit_reys`, `edit_adjust` amallarida barcha kiritilgan turlar avtomatik ravishda bosh harflarga normallashtiriladi.
  - `webapp/js/app.js`: `DEFAULT_TYPES` massivi va boshlang'ich tanlovlar `AKB` ga yangilandi, yangi tovar turi kiritilganda `addType` uni avtomatik `.toUpperCase()` qiladi.
  - `webapp/index.html`: Boshlang'ich tovar turi ko'rinishi `#typeValue` `AKB` ga yangilandi.
  - Avtomatlashtirilgan testlar: `tests/test_db_and_storage.py:test_uppercase_tovar_turi` qo'shildi va 20 ta test to'liq muvaffaqiyatli o'tishi tekshirildi.

### U. XON CARGO To'g'rilash va Umumiy Hisobot Excel Custom Kargolari (2026-10-09)
- **Talab & Maqsad**:
  - `M296 UMUMIY HISOBOT.xlsx` standarti asosida foydalanuvchi "Kargolarga tarqatish" bo'limidan yangi tovar turi (`XON CARGO`, `MEBEL`, `X213` va h.k.) qo'shganda, Umumiy hisobot Excelida to'liq taqsimlanuvchi kargo sifatida D ustunida `=C{row}*$H$3`, E ustunida `=C{row}+D{row}` formulalari hosil bo'lishi, Mandarin (C4) formulasidan ayrilishi, va Toza yuk (G3) formulasidan ayrilmasligini ta'minlash.
  - Serverdagi ma'lumotlar bazasida `XON CAROGO` nomidagi xatolik barcha jadvallarda (`custom_types`, `inventory`, `activity`) to'liq **`XON CARGO`** deb to'g'rilanishi.
- **Baza Migratsiyasi (`schema_migrations: rename_xon_carogo_and_clean_types_20261009`)**:
  - `activity` jadvalida: `tovar_turi`, `from_type`, `to_type` ustunlaridagi `XON CAROGO` qiymatlari `XON CARGO` ga o'zgartirildi.
  - `custom_types` jadvalida: `XON CAROGO` to'liq `XON CARGO` ga o'zgartirildi, `DEFAULT_TYPES` da mavjud bo'lgan takroriy standart turlar olib tashlandi.
  - `inventory` jadvalida: har bir `report_id` uchun `XON CAROGO` qiymati `XON CARGO` ga o'tkazildi, agar reysda ikkala yozuv ham bo'lsa og'irliklari birlashtirildi (`SUM(weight)`).
  - `_clean_type(name)` va `normalize_type_key` funksiyalarida `xon carogo` -> `XON CARGO` / `xon cargo` avtomatik xavfsiz moslash kodi kiritildi.
- **Umumiy hisobot Excel Formulalari (`app/excel_export.py:build_umumiy_excel`)**:
  - `NON_DISTRIBUTED_LABELS = {"izi", "triton", "top"}` qilib belgilandi.
  - `distributable_rows`: `NON_DISTRIBUTED_LABELS` va `karobka`/`mandarin` dan tashqari BARCHA standart va yangi custom kargolar.
  - Har bir taqsimlanuvchi yangi qator uchun D ustuniga `=C{row}*$H$3`, E ustuniga `=C{row}+D{row}` formulalari yoziladi.
  - Mandarin `C4` formulasiga barcha taqsimlanuvchi qatorlar `-C{row}` sifatida ulanadi.
  - `G3` sof yukdan faqat `izi`, `triton`, `top` va `C3` (karobka) ayriladi.
  - `calculate_report_metrics` va Word DOCX (`build_special_docx`) funksiyalarida yangi kargolar avtomatik taqsimlangan karobka og'irligi bilan qo'shildi.
  - `assets/umumiy_hisobot_shabloni.xlsx` da B11 katakchasi `oneway` ga keltirildi.
- **Avtomatlashtirilgan Testlar**:
  - Jami 22 ta avtomatlashtirilgan test 100% muvaffaqiyatli o'tdi.

### V. Kg to'g'rilashni Umumiy Hisobot E ustuniga ("To'lanishi kerak bo'lgan summa") bog'lash (2026-10-09)
- **Talab & Muammo**:
  - Ilgari `fix_report_kg` amali to'g'ridan-to'g'ri `inventory` jadvalini (C ustuni - sof yuk) o'zgartirar edi. Natijada D ustunidagi karobka taqsimoti, Mandarin (C4) formulasi va boshqa hisoblar asossiz qayta hisoblanib ketar edi. Mandarin kabi formulali kargolarda esa C ustuniga umuman ta'sir qilmas edi.
  - Foydalanuvchi talabi: Kg to'g'rilash (`+` / `-` kg) sof yukka (C ustuni) emas, aynan **E ustuni ("To'lashi kerak bo'lgan summa:")** ga qo'llanilishi kerak.
- **Yechim & Arxitektura**:
  - `fix_report_kg`: `inventory` jadvaliga tegmaydi (sof ombor qoldig'i 100% buzilmaydi). Faqat `activity` jadvaliga `action = 'kg_fix'` deb audit yozuvini kiritadi.
  - `db.get_report_kg_fixes(report_id)` va `db.get_report_kg_fix_totals(report_id)`: Reys bo'yicha har bir tovar turining `kg_fix` deltalari ro'yxatini qaytaradi.
  - `app/excel_export.py:build_umumiy_excel`:
    - Har bir kargo uchun (Mandarin, standart kargolar va barcha custom kargolar) E ustuniga jonli formula yoziladi:
      - Agar to'g'rilash bo'lsa: `=C{row}+D{row}+{delta}` (masalan, `=C5+D5+6` yoki `=C5+D5-2.5` yoki `=C4+D4+0.01`).
      - Agar to'g'rilash bo'lmasa: standart `=C{row}+D{row}`.
    - C ustuni (sof yuk), D ustuni (karobka taqsimoti), Mandarin (C4) va Toza yuk (G3) formulalari toza va o'zgarishsiz qoladi.
  - `calculate_report_metrics` va Ko'p reysli filtr (`build_filtered_cross_report_excel`): Jami og'irlik E ustuniga to'liq mos keladi.
  - `build_special_docx`: Word (.docx) hisobotidagi kargo qatorlari ham C ustunidan emas, aynan E ustunidan (`m["total"]`) olinadigan qilindi (karobka taqsimoti va kg_fix hisobga olingan holda).
  - `schema_migrations: unlink_kg_fix_from_inventory_20261009`: Eskidan qolgan `kg_fix` tufayli `inventory` ga qo'shilib qolgan deltalarni to'liq qaytarib, inventarni asl holiga keltirdi.
  - `#kgFixSheet` modalidagi tushuntirish hinti yangilandi.

---

## 4. Yangilanishlar Bo'yicha Qat'iy Qoidalar

1. Har qanday yangi endpoint yoki xususiyat qo'shilganda `HANDOFF.md`, `AGENTS.md` va `CLAUDE.md` birgalikda yangilanadi.
2. Har bir o'zgarishdan so'ng `python -m pytest` orqali barcha testlar muvaffaqiyatli o'tishi tekshiriladi.
3. Hech qachon foydalanuvchi ma'lumotlari yoki eski migratsiyalar o'chirilmasligi lozim (har doim additiv o'zgarishlar).
4. Yangi parametrlar kiritilganda `.env.example` da namunasi ko'rsatilishi va lokal fallback ta'minlanishi shart.

