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

- Osobne ekrany: Centrum, Solo, Mistrzostwa, Statystyki i Historia. Na komputerze menu jest po lewej, na telefonie u dołu. Nawigacja i przyciski wstecz/dalej nie przeładowują strony ani połączenia. Linki `/#/solo`, `/#/championship`, `/#/stats` i `/#/history` otwierają wybraną sekcję.
- W trakcie sesji ekran skupia się na planszy i kompaktowym pomiarze czasu, kar, delty oraz straty do rywala. Szczegóły okrążeń są rozwijane pod planszą na telefonie i widoczne obok na komputerze. Zmiana ekranu w trakcie jazdy wymaga potwierdzenia opuszczenia sesji; podczas zapisywania lub błędu zapisu trzeba najpierw dokończyć zapis. Po zakończeniu mistrzostw można przeglądać statystyki i historię, a następnie wrócić do pokoju przez „Twoja ostatnia sesja” i zagrać rewanż. Odświeżenie lub zamknięcie strony nadal przerywa aktywną sesję.
- Konta: login 3–20 znaków (litery ASCII, cyfry, podkreślenie), hasło 8–128 znaków, logowanie i wylogowanie.
- Trening solo: wybór toru 4×4, 5×5, 6×6 lub 7×7 i 1–10 okrążeń. Jeden start i płynne przejście między planszami; każda plansza jest nowym kółkiem. W czasie jazdy widać czas całego treningu i aktualnego okrążenia z karami, najlepsze kółko i deltę do własnego najlepszego kółka w tym treningu oraz tabelę ukończonych kółek. Podsumowanie pokazuje czasy jazdy, kary, wyniki, delty na mecie, sumę, najlepsze i średnie kółko. Powtórzenie zachowuje wybrany tor i liczbę okrążeń. Każde ukończone kółko jest osobnym wynikiem w rankingu solo; suma treningu nie konkuruje z pojedynczymi okrążeniami.
- Mistrzostwa 1 vs 1: twórca wybiera tory 4×4–7×7 i po 1–10 okrążeń. Jeden tor jest jednym wyścigiem, a ukończenie planszy jednym okrążeniem. Obaj gracze widzą plan i potwierdzają gotowość przed wyścigiem.
- Na danym torze kolejne plansze pojawiają się natychmiast, niezależnie dla każdego zawodnika. Rywal może być na innym okrążeniu; obaj otrzymują taki sam układ liczb dla tego samego numeru okrążenia. Gotowość obu osób jest wymagana dopiero przed kolejnym torem. Rewanż rozpoczyna nowe mistrzostwa z tym samym planem i zerową punktacją.
- Suma czasów wszystkich okrążeń z karami rozstrzyga wyścig. Punkty przyznawane są raz po całym wyścigu: ostatnie miejsce w pełnej stawce daje 1 pkt, poprzednie 2 itd. Przy obecnych dwóch graczach zwycięzca otrzymuje 2 pkt, drugi 1 pkt; identyczne czasy oznaczają po 1,5 pkt. DNF daje 0 pkt. Suma punktów z wyścigów tworzy klasyfikację mistrzostw; remis punktowy pozostaje remisem.
- Podczas jazdy widoczne są czas wyścigu, czas aktualnego kółka, kary, najlepsze kółko bieżącego wyścigu, tabela kółek obu osób, łączna strata do rywala i delta do własnego najlepszego kółka tego wyścigu. Strata porównuje czas z karami w ostatnim wspólnym punkcie (numer okrążenia + liczba). Delta porównuje tę samą liczbę z własnym najlepszym ukończonym kółkiem w bieżącym wyścigu; ujemna oznacza przewagę, dodatnia stratę. Pomiar aktualizuje się przy trafieniach, bez pozornej interpolacji między nimi. Nowa kara natychmiast zwiększa deltę.
- Pierwsze ukończone kółko sesji staje się referencją delty. Kolejne szybsze kółko zastępuje referencję. Nowy trening, nowy tor mistrzostw i rewanż zaczynają pomiar od nowa; rekordy historyczne i czasy rywala nie są używane jako odniesienie. Delta uwzględnia kary i porównuje te same punkty planszy. Delta na mecie w tabeli dotyczy najlepszego wcześniejszego kółka tej sesji; przy pierwszym jest pusta.
- Raport mistrzostw zawiera klasyfikację punktową, wynik każdego wyścigu, czasy wszystkich kółek obu osób, kary, rekordy, średnie i skumulowane straty. Punkty są wyłącznie przy wyścigach, nigdy przy kółkach. Tabela okrążeń pokazuje jednego wybranego zawodnika, domyślnie zalogowanego gracza; wybór dotyczy wszystkich torów raportu i jest zachowany podczas jego aktualizacji. Klasyfikacja i wyniki całych wyścigów nadal pokazują obu graczy. Historia zachowuje ostatnich 20 raportów na liście, w tym starsze mecze w ich pierwotnym formacie. Każde ukończone kółko nadal trafia osobno do rankingu przejazdów.
- Plansza jest ujawniana dopiero po odliczaniu; trafione liczby przygasają.
- Każdy błędny wybór aktywnej liczby dodaje 1 sekundę. Kliknięcia ukończonych pól są blokowane w interfejsie.
- Wynik = czas na serwerze + kary, zaokrąglony do 0,01 sekundy. Równe wyniki oznaczają remis.
- Wynik wyścigu jest zapisywany po ukończeniu wszystkich okrążeń przez obu graczy lub upływie limitu: 3 minuty × liczba okrążeń. Nieukończony wyścig ma status DNF; ukończone w nim kółka pozostają w raporcie i rankingu. Trening solo ma limit 3 minuty × wybrana liczba okrążeń.
- Wyjście przed pierwszym odliczaniem jest bez kary. Wyjście, odświeżenie strony, wylogowanie lub utrata połączenia po starcie, także między wyścigami, oznaczają walkower w całych mistrzostwach. Dotychczasowe czasy i punkty pozostają zapisane; nieodbyte okrążenia nie są dopisywane. Wyjście po zakończeniu całego meczu nie zmienia wyniku. Zerwane połączenia są wykrywane przez heartbeat w ciągu około 30 sekund. Po przerwaniu treningu solo lub upływie limitu zapisują się ukończone okrążenia; bieżąca nieukończona plansza nie daje wyniku. Pomiar punktów ukończonych kółek pozostaje zapisany w telemetrii, ale nowa sesja nie korzysta z niego jako odniesienia. Przed pierwszym ukończonym kółkiem bieżącej sesji delta pozostaje pusta.
- Osobne rekordy i średnie solo dla każdego rozmiaru oraz bilans wygranych, przegranych i remisów.
- „Twoje przejazdy”: osobisty ranking całej historii ukończonych przejazdów, filtry solo / pojedynki / oba tryby i rozmiar 4×4, 5×5, 6×6 lub 7×7. Wyniki rosnąco według czasu z karami; remisy dzielą miejsce. Tabela pokazuje rywala, datę, rezultat pojedynku, czas jazdy, liczbę błędów, kary i wynik końcowy. Podsumowanie obejmuje liczbę przejazdów, najlepszy i średni wynik, sumę kar oraz przejazdy bez błędów.
- Nowy zapisany wynik automatycznie wybiera właściwą kategorię, otwiera stronę ze swoim miejscem i zostaje podświetlony. Historia jest stronicowana po 20 wyników, bez ograniczania do ostatnich przejazdów. Nieukończone plansze nie wchodzą do rankingu; nadal uwzględniane są w bilansie pojedynków. Na telefonie tabelę można przesuwać poziomo.

- Jedna aktywna karta gry na konto. Druga karta pokazuje komunikat i pozwala ponownie połączyć się po zamknięciu pierwszej.

Dostępne plansze mają 16, 25, 36 lub 49 liczb. Rozmiar 3×3 został wycofany z gry i filtrów rankingu; jego wcześniej zapisane wyniki pozostają w bazie. Każdy dostępny rozmiar działa w treningu solo i pojedynku, z karą +1 s za błąd.

Po utracie połączenia aplikacja próbuje automatycznie połączyć się ponownie. Sprawdza odpowiedź serwera po powrocie na ekran gry oraz przed rozpoczęciem treningu, utworzeniem pokoju i dołączeniem kodem. Nawet po uśpieniu połączenia przez telefon można rozpocząć kolejny pojedynek bez odświeżania i ponownego logowania. Ukończony, zapisany wynik pozostaje na ekranie; statystyki są ponownie pobierane z serwera.

Jeśli przeglądarka lub sieć blokuje WebSocket, aplikacja automatycznie przechodzi na połączenie przez HTTPS: zdarzenia płyną przez EventSource, a polecenia przez POST. Kolejność kliknięć jest zachowana, a weryfikacja konta nie odpytuje bazy przy każdym kliknięciu. Oba sposoby korzystają z tych samych pokoi, zasad i statystyk. Serwer jawnie dopuszcza własny adres WSS w polityce CSP, także dla Safari. Nieudane próby są ograniczone; błąd przy tworzeniu WebSocket nie pozostawia aplikacji z wiecznym napisem „Łączenie…”.

Przerwanego meczu nie wznawiamy: nadal obowiązuje walkower, a kliknięcia i gotowość nie są wysyłane ponownie. Gdy zawiedzie kilka automatycznych prób, pozostaje przycisk „Połącz ponownie”. Inna karta tego samego konta nadal nie może przejąć gry. Rewanż działa, dopóki obie osoby pozostają w pokoju. Wymiana pozornie otwartego połączenia z tej samej karty po zakończonej rundzie zachowuje pokój i wymaga ponownego potwierdzenia gotowości. Po utracie miejsca w pokoju, odświeżeniu strony albo restarcie serwera jedna osoba tworzy nowy pokój, a druga dołącza jego kodem.

## Instalacja na telefonie (PWA)

Po opublikowaniu pod adresem **HTTPS** gra może mieć własną ikonę i otwierać się w osobnym oknie, bez paska przeglądarki. Te same konta, pokoje i wyniki działają na Androidzie, iPhonie i komputerze. Każdy gracz używa własnego konta i tego samego adresu serwera.

- **iPhone / iPad:** otwórz link w Safari → Udostępnij → Dodaj do ekranu początkowego → Dodaj. Jeśli Safari pokazuje opcję „Otwórz jako aplikację”, pozostaw ją włączoną. Otwórz grę z nowej ikony.
- **Android:** otwórz link w Chrome → Zainstaluj aplikację. Jeżeli przeglądarka nie pokazuje przycisku automatycznie, użyj menu → Dodaj do ekranu głównego / Zainstaluj aplikację.
- Przycisk **Dodaj do ekranu** w grze pokazuje instrukcję odpowiednią dla urządzenia; w obsługiwanej przeglądarce uruchamia systemowy proces instalacji.

Po instalacji na iOS może być potrzebne ponowne logowanie, ponieważ system może używać oddzielnej sesji dla aplikacji. Samo zamknięcie Safari lub instalacja podczas meczu może przerwać połączenie — instaluj z ekranu głównego gry.

**Internet jest wymagany także do treningu solo.** Po pierwszym poprawnym otwarciu aplikacja zapisuje wyłącznie publiczny ekran informujący o braku połączenia i jego zasoby. Nie zapisuje w cache kont, haseł, odpowiedzi API, wyników ani plansz. Nie kolejkuje kliknięć ani wyników do późniejszej synchronizacji. Przerwane pojedynki nadal podlegają regule walkowera.

Nowa wersja pojawia się jako komunikat z przyciskiem **Zaktualizuj**. Komunikat jest ukryty, a aktualizacja zablokowana podczas gry, w pokoju oraz przy niezapisanym wyniku. Aktualizacja nigdy sama nie odświeża meczu, również gdy uruchomiono ją w innej karcie. Przy każdej publikacji nowej wersji zwiększ wersję cache w `public/sw.js`, aby aplikacja pokazała komunikat także przy zmianach samego kodu gry.

To wersja instalowana ze strony. Publikacja w App Store i Google Play jest odrębnym etapem.

## Testy

```bash
npm test
npm run test:browser
npm run test:pwa
npm run test:reconnect
npm run test:http
npm run test:ranking
npm run test:match
npm run test:solo
npm run test:navigation
```

Testy serwera sprawdzają autoryzację, walidację, wszystkie rozmiary plansz, kary, wspólny start, remis, wyniki, walkower, limit czasu, granice pokoi, ponawianie zapisu po awarii bazy, HTTPS za reverse proxy oraz odtworzenie danych po restarcie. Korzystają z oddzielnych baz testowych. Zmienna `TEST_DATABASE_URL` pozwala uruchomić ten sam zestaw oraz test przeglądarkowy na PostgreSQL; instrukcja w [DEPLOY.md](DEPLOY.md).

Test przeglądarkowy używa Playwright i systemowego Chromium pod `/usr/bin/chromium`. Na innym systemie ustaw `CHROMIUM_PATH` na plik wykonywalny przeglądarki. Uruchamia dwa oddzielne konteksty, w tym dotykowy widok telefonu, i przechodzi przez rejestrację, trening, pojedynek i ponowne logowanie. Zrzuty ekranu zapisuje w ignorowanym katalogu `test-results/`. Test używa `--no-sandbox` wyłącznie dla przeglądarki testowej w kontenerze.

`npm run test:pwa` sprawdza manifest i rozmiary ikon, instrukcję iPhone’a, rzeczywisty cykl aktualizacji service workera podczas treningu, nawigację offline oraz brak danych konta w cache. Używa Chromium z emulacją telefonu; wywołanie systemowego okna instalacji jest symulowane. Nie zastępuje sprawdzenia instalacji na fizycznym iPhonie w Safari po wdrożeniu HTTPS.

`npm run test:reconnect` rozgrywa trzy pojedynki z tymi samymi kontami: po pierwszym symuluje utratę internetu, a po drugim połączenie, które pozornie jest otwarte, ale nie odpowiada. Sprawdza kolejną rozgrywkę bez przeładowania strony, brak podwójnych wyników oraz ochronę przed drugą kartą.

`npm run test:http` blokuje WebSocket dla obu graczy: jednemu odrzuca połączenie serwer, drugiemu przeglądarka zgłasza synchroniczny `SecurityError`. Sprawdza automatyczne przejście na HTTPS, rewanż w tym samym pokoju przez HTTPS oraz pojedynek mieszany WebSocket/HTTPS, kolejność szybkich kliknięć, brak zapytań do bazy przy trafieniach, powrót po utracie internetu i skończoną liczbę nieudanych prób. `TEST_DATABASE_URL` pozwala sprawdzić ten sam scenariusz na PostgreSQL.

`npm run test:ranking` sprawdza filtry, kary, stronicowanie, odporność na spóźnioną odpowiedź dla poprzedniego filtra, automatyczne umieszczenie rzeczywiście rozegranego treningu na drugiej stronie rankingu, widok telefonu oraz usunięcie historii z widoku po wylogowaniu. Testy API w `npm test` dodatkowo sprawdzają remisy, całą historię, prywatność wyników i walidację filtrów. Oba zestawy obsługują `TEST_DATABASE_URL`.

`npm run test:match` rozgrywa cztery wyścigi i pięć płynnych okrążeń między komputerem przez WebSocket i telefonem przez HTTPS. Sprawdza niezależny postęp, wspólne układy dla tych samych kółek, żywe straty i delty bieżącego wyścigu, gotowość wyłącznie przed torami, wynik mistrzostw 7 : 5, raport i odczyt po przeładowaniu. Testy serwera sprawdzają również dokładne punkty pomiarowe, kary w delcie, reset odniesienia przy nowym wyścigu i rewanżu, prywatność, walkower, rollback i ponawianie zapisu bez powielania kółek ani punktów. Obsługują `TEST_DATABASE_URL`.

`npm run test:solo` sprawdza wybór toru i liczby okrążeń, trzy płynne kółka z karą i deltą do najlepszego kółka treningu, osobne wyniki w rankingu, powtórzenie konfiguracji, reset odniesienia po powtórzeniu treningu oraz planszę 7×7 na telefonie o szerokości 320 px przez HTTPS. Testy serwera dodatkowo sprawdzają przerwanie treningu, limit czasu, pomijanie spóźnionych kliknięć i ponawianie zapisu bez duplikatów. Oba zestawy obsługują `TEST_DATABASE_URL`.

`npm run test:navigation` sprawdza osobne widoki, linki do sekcji, nawigację wstecz/dalej bez przeładowania, zachowanie ustawień, ochronę przed przypadkowym opuszczeniem wyścigu, widoczność całej planszy 7×7 przy 320×740 px, zapis ukończonego kółka po potwierdzonym wyjściu, przeglądanie raportów i rewanż w zachowanym pokoju.

`GET /api/runs` wymaga zalogowania. Parametry: `mode=all|solo|duel` (domyślnie `all`), `size=4|5|6|7` (domyślnie `4`), `page` (od 1), `limit` (1–50, domyślnie 20), opcjonalnie `highlight` (identyfikator meczu). Odpowiedź zawiera podsumowanie całej wybranej kategorii i jedną stronę wyników. `highlight` otwiera stronę z danym przejazdem, jeżeli należy do użytkownika i pasuje do filtrów. Starszy `/api/stats` zachowuje dotychczasowy format.

`GET /api/duels` zwraca ostatnich 20 meczów zalogowanego gracza, a `GET /api/duels/:id` pełny raport wyłącznie uczestnikom danego meczu. Polecenie `create` z `championship: true` i `tracks: [{size: 4, laps: 2}, {size: 6, laps: 1}]` ustala mistrzostwa; `rematch` z identyfikatorem zapisanego wyścigu potwierdza gotowość do następnego toru lub rewanżu. Każde `hit` w mistrzostwach zawiera `raceId` i `lap`; opóźnione trafienia z innego kółka są ignorowane. Samo `tracks` pozostaje zgodne ze starszym protokołem meczów. Serwer wyznacza punktację, kolejność i wyniki. Starsze polecenie `create` z samym `size` pozostaje zgodne z dotychczasowym protokołem pojedynczych rund.

Polecenie gry `solo` z `{size: 4, laps: 3}` rozpoczyna trening z pomiarem okrążeń. Każde `hit` zawiera `raceId`, numer `lap` i `number`. Pomiar i zapis korzystają z tych samych reguł co mistrzostwa, bez punktów ani rywala. Starsze `solo` z samym `size` pozostaje zgodne z dotychczasowym protokołem pojedynczej planszy.

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
- `runs.js`, `public/ranking.js`, `public/ranking.css` — osobisty ranking przejazdów, filtry i tabela statystyk.
- `lap-timing.js`, `training.js`, `public/training.js` — wspólny pomiar kółek i delty sesji i wielookrążeniowy trening solo.
- `championship.js`, `public/championship.js`, `public/championship.css` — niezależne okrążenia, telemetria, punkty za wyścig i raport mistrzostw.
- `duels.js`, `public/duels.js`, `public/duels.css` — konfiguracja i historia, z zachowaniem starszych raportów meczów.
- `public/` — interfejs bez etapu kompilacji i bez zewnętrznych fontów.
- `public/manifest.webmanifest`, `public/pwa.js`, `public/sw.js`, `public/icons/` — instalacja PWA i publiczny ekran offline.
- `http-channel.js`, `public/http-channel.js` — zapasowy kanał gry przez HTTPS.
- `test/game.test.js` — testy integracyjne API i protokołu gry.
- `test/browser.js` — test dwóch użytkowników w Chromium.
- `render.yaml`, `DEPLOY.md` — konfiguracja i instrukcja bezpłatnego wdrożenia.
- `scripts/smoke.mjs` — sprawdzenie strony i bazy po wdrożeniu (`npm run smoke -- ADRES`).

Poprzednie cztery pliki demonstracyjne zastąpiono aplikacją; pozostają w historii Git. Nie wykonano resetu historii.
