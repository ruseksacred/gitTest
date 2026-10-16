# Race Focus

Gra przeglądarkowa do treningu koncentracji: klikaj losowo rozmieszczone liczby w kolejności od 1 do końca. Polski interfejs na komputer i telefon, inspirowany motorsportem.

## Uruchomienie

Wymagany **Node.js 24 lub nowszy**. Lokalnie aplikacja używa SQLite i nie potrzebuje usług zewnętrznych. Darmowe wdrożenie korzysta z Render i PostgreSQL w Neon — pełna instrukcja w [DEPLOY.md](DEPLOY.md), konfiguracja w [render.yaml](render.yaml).

```bash
cd /workspace/gitTest
npm ci --cache /tmp/race-focus-npm-cache
npm start
```

Serwer nasłuchuje na porcie **3000**, na wszystkich interfejsach. `npm run dev` uruchamia go z automatycznym restartem po zmianie plików. Endpoint `GET /api/health` sprawdza proces bez wybudzania bazy, a `GET /api/ready` sprawdza połączenie z bazą. Aby zagrać, otwórz adres tego serwera w przeglądarce i załóż konto. Dwie osoby muszą mieć dostęp do tego samego serwera; lokalny proces w środowisku Codex nie jest publicznym hostingiem.

## Pierwszy sprint

- Konta: login 3–20 znaków (litery ASCII, cyfry, podkreślenie), hasło 8–128 znaków, logowanie i wylogowanie.
- Trening solo na planszy 3×3, 4×4 lub 5×5.
- Pojedynki online: pokój z kodem, dołączenie drugiej osoby, gotowość, wspólne odliczanie i identyczna plansza.
- Plansza jest ujawniana dopiero po odliczaniu; trafione liczby przygasają.
- Każdy błędny wybór aktywnej liczby dodaje 1 sekundę. Kliknięcia ukończonych pól są blokowane w interfejsie.
- Wynik = czas na serwerze + kary, zaokrąglony do 0,01 sekundy. Równe wyniki oznaczają remis.
- Wyniki pojedynku pojawiają się po ukończeniu przez obu graczy. Limit rozgrywki: 3 minuty. Ukończona plansza wygrywa z nieukończoną; dwie nieukończone oznaczają remis. Nieukończona plansza nie tworzy rekordu.
- Wyjście przed odliczaniem jest bez kary. Wyjście, odświeżenie strony, wylogowanie lub utrata połączenia od rozpoczęcia odliczania oznaczają walkower. Zerwane połączenia są wykrywane przez heartbeat w ciągu około 30 sekund. Przerwany trening solo nie jest zapisywany.
- Osobne rekordy i średnie solo dla każdego rozmiaru; bilans wygranych, przegranych i remisów; ostatnie wyniki z karami. Interfejs pokazuje 6 ostatnich, API zwraca 20.
- Jedna aktywna karta gry na konto. Druga karta pokazuje komunikat i pozwala ponownie połączyć się po zamknięciu pierwszej.

## Testy

```bash
npm test
npm run test:browser
```

Testy serwera sprawdzają autoryzację, walidację, wszystkie rozmiary plansz, kary, wspólny start, remis, wyniki, walkower, limit czasu, granice pokoi, ponawianie zapisu po awarii bazy, HTTPS za reverse proxy oraz odtworzenie danych po restarcie. Korzystają z oddzielnych baz testowych. Zmienna `TEST_DATABASE_URL` pozwala uruchomić ten sam zestaw oraz test przeglądarkowy na PostgreSQL; instrukcja w [DEPLOY.md](DEPLOY.md).

Test przeglądarkowy używa Playwright i systemowego Chromium pod `/usr/bin/chromium`. Na innym systemie ustaw `CHROMIUM_PATH` na plik wykonywalny przeglądarki. Uruchamia dwa oddzielne konteksty, w tym dotykowy widok telefonu, i przechodzi przez rejestrację, trening, pojedynek i ponowne logowanie. Zrzuty ekranu zapisuje w ignorowanym katalogu `test-results/`. Test używa `--no-sandbox` wyłącznie dla przeglądarki testowej w kontenerze.

## Dane i konfiguracja

| Zmienna | Domyślnie | Zastosowanie |
| --- | --- | --- |
| `PORT` | `3000` | Port HTTP i WebSocket |
| `DATABASE_URL` | brak — SQLite | Connection string PostgreSQL; wymagany na Render, ustawiany bezpiecznie w panelu hostingu |
| `DB_PATH` | `data/race-focus.sqlite` przy projekcie | Trwały plik SQLite; ścieżka bezwzględna zalecana |
| `PUBLIC_ORIGIN` | `RENDER_EXTERNAL_URL` na Render; poza nim origin żądania | Publiczny origin, np. `https://gra.example.com`; ustaw dla własnej domeny lub innego reverse proxy |
| `COOKIE_SECURE` | włączone na Render, poza nim wyłączone | `1` dla hostingu z HTTPS |

Baza i pliki SQLite WAL są ignorowane przez Git. Nie usuwaj `data/`, jeśli chcesz zachować konta i wyniki. Backup wykonuj narzędziem obsługującym SQLite albo po zatrzymaniu procesu. Hasła są haszowane `scrypt` z indywidualną solą. Sesja trwa 7 dni; losowy token jest w ciasteczku `HttpOnly`, `SameSite=Strict`, w bazie znajduje się wyłącznie jego hash. Logowanie i rejestracja mają limit prób na adres połączenia. Za reverse proxy ten limit jest wspólny dla klientów proxy — konfigurację limitów dla większego ruchu należy dopasować przy wdrożeniu.

## Hosting i granice pierwszej wersji

To aplikacja dla **jednego procesu Node.js**. Publiczne wdrożenie wymaga HTTPS, obsługi WebSocket, poprawnego originu i bezpiecznych ciasteczek. Dostępna konfiguracja Render Free + Neon Free używa zewnętrznego PostgreSQL, więc nie potrzebuje płatnego dysku. Alternatywny hosting z SQLite wymaga trwałego wolumenu dla `data/`. Statyczny hosting (np. GitHub Pages) nie uruchomi serwera gry. `render.yaml` i instrukcja nie oznaczają, że usługa została już utworzona — publiczny adres nada Render po wdrożeniu na koncie użytkownika.

Konta i ukończone wyniki przetrwają restart. Pokoje i trwające gry są w pamięci: restart zrywa sesje gry, a wymuszone zatrzymanie może utracić niedokończony mecz. Graceful shutdown kończy aktywne pojedynki walkowerem. Pierwsza wersja nie obejmuje odzyskiwania hasła, rankingu globalnego ani wznowienia meczu po rozłączeniu.

Na darmowym hostingu serwer i baza mogą usypiać się po bezczynności. Health check i heartbeat nie wykonują zapytań do bazy. W razie błędu zapisu wynik nie jest oznaczany jako zapisany: gracz może ponowić zapis. Powtórzenie nie tworzy podwójnego meczu. Nowa baza Neon zaczyna pusta; dotychczasowe dane SQLite nie są automatycznie migrowane.

Serwer kontroluje planszę, kolejność, start, kary i wyniki. Pomiar uwzględnia opóźnienie sieci; telefon i komputer mogą też dawać inne warunki sterowania. To gra towarzyska, bez zaawansowanego wykrywania botów lub gwarancji pomiaru sportowego. Nie jest to zwalidowane narzędzie oceny zdolności kierowcy.

## Struktura

- `server.js` — HTTP, konta, WebSocket i reguły rozgrywki.
- `database.js` — SQLite lokalnie, PostgreSQL na hostingu, transakcje i weryfikacja TLS.
- `public/` — interfejs bez etapu kompilacji i bez zewnętrznych fontów.
- `test/game.test.js` — testy integracyjne API i protokołu gry.
- `test/browser.js` — test dwóch użytkowników w Chromium.
- `render.yaml`, `DEPLOY.md` — konfiguracja i instrukcja bezpłatnego wdrożenia.
- `scripts/smoke.mjs` — sprawdzenie strony i bazy po wdrożeniu (`npm run smoke -- ADRES`).

Poprzednie cztery pliki demonstracyjne zastąpiono aplikacją; pozostają w historii Git. Nie wykonano resetu historii.
