# Darmowe wdrożenie: Render + Neon

Konfiguracja `render.yaml` wybiera wyłącznie **Render Free Web Service**. Nie tworzy płatnej bazy, dysku ani innych usług Render. Bazę PostgreSQL utwórz osobno w **Neon Free**. W obu panelach przed zatwierdzeniem sprawdź, że wybrany jest plan Free; ta konfiguracja nie wymaga włączania płatnego planu.

## 1. Kod na GitHub

Render musi widzieć pliki aplikacji na GitHub, a nie tylko cztery stare pliki testowe. Wybierz gałąź **`race-focus-free-hosting`**, zawierającą `package.json`, `server.js`, `database.js`, `public/` i `render.yaml`. Ta sama gałąź jest ustawiona w konfiguracji usługi. Dostęp Render do repozytorium przyznaj przez integrację GitHub podczas tworzenia usługi. Nie wklejaj tokenów do kodu.

## 2. Bezpłatna baza Neon

1. Otwórz <https://console.neon.tech> i zaloguj się, np. przez GitHub.
2. Utwórz projekt `race-focus` w planie **Free**, najlepiej w regionie Frankfurt, jeśli jest dostępny.
3. W oknie **Connect** wybierz adres do PostgreSQL. Adres z poolingiem (`-pooler` w nazwie hosta) jest obsługiwany i zalecany. Baza może być domyślna, np. `neondb`.
4. Skopiuj connection string. Wkleisz go **wyłącznie** do pola `DATABASE_URL` w Render. Nie wysyłaj go na czacie i nie zapisuj w repozytorium.

Aplikacja sama tworzy tabele i indeksy podczas pierwszego uruchomienia. Połączenie do Neon weryfikuje certyfikat TLS. Standardowy adres z `sslmode=require` jest obsługiwany z pełną weryfikacją certyfikatu i nazwy hosta.

## 3. Darmowy serwer Render

Otwórz <https://dashboard.render.com> i połącz swoje konto GitHub.

**Blueprint:** wybierz **New → Blueprint**, repozytorium `ruseksacred/gitTest` i gałąź z aplikacją. Render odczyta `render.yaml`. Wprowadź `DATABASE_URL` z Neon i upewnij się, że plan to **Free**. Jeśli panel nie pozwala wybrać właściwej gałęzi, użyj ręcznego sposobu poniżej.

**Ręcznie:** wybierz **New → Web Service**, to samo repozytorium i właściwą gałąź. Ustaw:

| Pole | Wartość |
| --- | --- |
| Name | `race-focus` lub inna dostępna nazwa |
| Region | Frankfurt, jeśli dostępny |
| Runtime | Node |
| Root Directory | puste — projekt jest w katalogu głównym repozytorium |
| Build Command | `npm ci --omit=dev --no-audit --no-fund` |
| Start Command | `npm start` |
| Instance Type | **Free** |
| Health Check Path | `/api/health` |

W **Environment** dodaj:

| Nazwa | Wartość |
| --- | --- |
| `DATABASE_URL` | connection string skopiowany z Neon |
| `NODE_VERSION` | `24` |
| `NODE_ENV` | `production` |
| `COOKIE_SECURE` | `1` |

Nie ustawiaj `PORT` — Render podaje go automatycznie. `PUBLIC_ORIGIN` również nie jest potrzebny dla domyślnej domeny: aplikacja korzysta z `RENDER_EXTERNAL_URL` dostarczonego przez Render. Przy własnej domenie ustaw `PUBLIC_ORIGIN` na jej adres HTTPS.

Kliknij **Create Web Service / Deploy**. Po poprawnym wdrożeniu panel pokaże rzeczywisty adres HTTPS kończący się `.onrender.com`. To ten link przekazujesz drugiemu graczowi. Nazwy usług są przydzielane przez Render; żaden adres nie jest z góry zarezerwowany.

## 4. Sprawdzenie działającej gry

```bash
npm run smoke -- https://ADRES-Z-PANELU.onrender.com
```

Polecenie sprawdza stronę, gotowość PostgreSQL i anonimową sesję. Nie tworzy użytkowników. Następnie:

1. Otwórz ten sam adres na dwóch urządzeniach i załóż dwa konta.
2. Utwórz pokój, dołącz drugim kontem i rozegraj pojedynek.
3. Sprawdź zwycięzcę, wyloguj się i zaloguj ponownie — statystyki powinny zostać.
4. Po restarcie usługi ponownie sprawdź logowanie i statystyki. Trwające pokoje nie są przywracane.

## 5. Dodanie gry do telefonów

Użyj rzeczywistego adresu **HTTPS z Render**; instalacja nie wymaga dodatkowej konfiguracji hostingu.

- **Na iPhonie żony:** otwórz link w Safari → Udostępnij → Dodaj do ekranu początkowego → Dodaj. Jeśli jest dostępne „Otwórz jako aplikację”, pozostaw włączone. Następnie uruchom Race Focus z ikony.
- **Na Androidzie:** otwórz link w Chrome i wybierz Zainstaluj aplikację; opcja może też być w menu pod nazwą Dodaj do ekranu głównego.
- Załóżcie dwa oddzielne konta. Jeżeli po instalacji aplikacja ponownie prosi o logowanie, użyj tego samego loginu i hasła co na stronie.
- Jedno z Was tworzy pokój, drugie wpisuje kod. Możecie korzystać z różnych sieci, np. Wi‑Fi i internetu komórkowego.

Przed pierwszą wspólną grą sprawdźcie na obu telefonach: uruchomienie z ikony bez paska przeglądarki, logowanie, wybór liczb i widoczność całej planszy. Zmiana aplikacji na iOS może uśpić połączenie, dlatego pozostańcie w grze do zakończenia pojedynku. Podczas aktualizacji nie trwa mecz — aplikacja nie przeładowuje rozgrywki automatycznie.

Bez internetu dostępny jest wyłącznie ekran informacyjny, nie trening ani pojedynki. Automatyczne testy obejmują Chromium z emulacją telefonu; instalację w systemowym Safari trzeba jeszcze potwierdzić na fizycznym iPhonie pod opublikowanym adresem.

### Aktualizacja aplikacji

Nowe commity na `race-focus-free-hosting` powinny uruchamiać wdrożenie Render, jeśli włączono Auto-Deploy. Sprawdź status **Live** dla najnowszego commita. Jeśli automatyczne wdrożenie jest wyłączone, wybierz **Manual Deploy → Deploy latest commit**. Następnie odśwież stronę na obu telefonach albo wybierz **Zaktualizuj**, jeżeli aplikacja pokazuje komunikat o nowej wersji.

Przy komunikacie o utracie połączenia aplikacja automatycznie próbuje je odtworzyć. Ukończony mecz nie jest liczony ponownie. Rozpoczęty mecz pozostaje przerwany zgodnie z regułą walkowera. Aby rozegrać kolejną rundę, jedna osoba tworzy nowy pokój i przekazuje **nowy** kod drugiej osobie.

Jeżeli sieć lub przeglądarka nie pozwala otworzyć WebSocket, aplikacja automatycznie używa zwykłego HTTPS. Nie trzeba zmieniać konfiguracji Render ani Neon. Wersję serwera można sprawdzić pod `/api/version`: wersja z planszami 4×4–7×7 zwraca `release: "boards-4-to-7"`. Pole `commit` pozwala porównać wdrożenie z ostatnim commitem w Render; endpoint nie ujawnia danych kont ani połączenia z bazą.

Ranking „Twoje przejazdy” korzysta z dotychczasowych wyników dla dostępnych rozmiarów planszy (4×4–7×7). Nie wymaga migracji danych ani zmiany ustawień Render czy Neon. Po wdrożeniu wybierz tryb i rozmiar planszy w sekcji statystyk; po nowym ukończonym przejeździe gra pokaże jego miejsce automatycznie. Wycofanie planszy 3×3 nie usuwa jej wyników z bazy.

## Ograniczenia darmowej wersji

Render Free może usypiać serwer po bezczynności, a Neon może usypiać bazę. Pierwsze otwarcie po przerwie może potrwać dłużej. Bieżące limity godzin, transferu i bazy sprawdzisz w panelach dostawców. Nie dodawaj automatycznego pingowania w celu obchodzenia usypiania.

Gra nie odpytuje bazy przy każdym kliknięciu ani podczas heartbeat WebSocket. Health check Render sprawdza proces bez wybudzania Neon; `/api/ready` sprawdza bazę na żądanie. Zakończony mecz zapisuje obie strony w jednej transakcji. W razie błędu bazy gracz widzi możliwość ponowienia zapisu, a identyfikator meczu chroni przed podwójnym wynikiem.

Wymagana jest **jedna instancja serwera** — pokoje są w pamięci procesu. Konta i ukończone wyniki pozostają w Neon po uśpieniu, przebudowie i restarcie Render. Dotychczasowa lokalna baza SQLite pozostaje zachowana; jej dane nie są automatycznie kopiowane do nowej bazy Neon. Nowe wdrożenie zaczyna z pustą bazą.

## Testy PostgreSQL przed wdrożeniem

Zwykłe `npm test` korzysta z SQLite. Można uruchomić ten sam zestaw na testowym PostgreSQL:

```bash
docker run --detach --rm --name race-focus-pg-test \
  -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=race_focus_test \
  -p 127.0.0.1:55432:5432 postgres:17-alpine

TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55432/race_focus_test npm test
TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55432/race_focus_test npm run test:browser

docker stop race-focus-pg-test
```

Poczekaj na gotowość bazy przed testami (`docker exec race-focus-pg-test pg_isready -U postgres`). Brak hasła dotyczy wyłącznie tego jednorazowego, lokalnego kontenera testowego nasłuchującego na loopback. Nie używaj takiej konfiguracji na publicznym serwerze. Testy tworzą osobne schematy `rf_test_*` i usuwają je po zakończeniu.
