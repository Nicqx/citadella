# Citadella: szabálykönyv-alapú E2E és regressziós QA

## Mire használható?

Ez a tesztkörnyezet az alkalmazás valódi Express HTTP végpontjait és – a
böngészős rétegben – valódi Chromiumot használ. **Minden teszt külön,
véletlen porton indított helyi kiszolgálót és memóriaalapú teszt-Redis
helyettesítőt használ. Nem csatlakozik a NUC Rediséhez és nem módosít
futó játékszobákat.**

Alapul vett szabályok: a projektben korábban rendelkezésre bocsátott magyar
Citadella-szabálykönyv (különösen: 2–3 játékos mód, karakterképességek,
egyedi kerületek részletes magyarázatai, város befejezése). A tesztek a
szabályokat önálló várható eredményként rögzítik, nem a forráskód
eredményét másolják vissza.

## Futtatás

Node.js 20+ szükséges. A repo gyökeréből:

```bash
npm install
npm run test:e2e       # HTTP E2E: teljes lobby/draft, szerepek, építés, lezárás, jogok
npm test               # minden unit- és HTTP-regressziós teszt
npm run check          # szintaktikai ellenőrzés
```

A külön Chromium-réteg lokálisan (tesztelésre használt gépen):

```bash
npm install --no-save playwright
npx playwright install chromium
npm run test:e2e:browser
```

CI: a meglévő **checks** workflow a `npm test` miatt minden változáskor
futtatja a HTTP E2E-t is. A külön **browser-e2e** workflow mobil (390px)
és asztali (1280px) Chromiumot futtat az érintett PR-eknél, vagy
manuálisan elindítható.

## Lefedettségi mátrix

| Terület | Vizsgálat | Lefedettség |
|---|---|---|
| 2 játékos, 1 ember + 1 bot | valódi HTTP szoba/draft, mindkét játékos 2 karaktere, 4 karakterkör | automatizált |
| 3 játékos, 1 ember + 2 bot | valódi HTTP szoba/draft, 2 karakter/fő, 6 karakterkör | automatizált |
| 2–3 fős normál draft | kétszeri titkos választás, dobások, karakterek titkossága | unit + HTTP |
| 2 játékosnál Császár tiltása | konfigurációs elutasítás | HTTP |
| 3 játékosnál Királynő tiltása | konfigurációs elutasítás | HTTP |
| 2–3 fő: 8 kerület | 7. kerület még nem zár le, 8. elindítja az utolsó fordulót | HTTP |
| 4, 5, 7, 8 fő: 7 kerület | 6. még nem zár le, 7. elindítja az utolsó fordulót | HTTP |
| Forduló lezárása | minden hátralévő karakterkör lefut, nem indul új draft, pontozás automatikus | HTTP |
| Emlékmű | 2 kerületnek számít a befejezéshez | HTTP |
| 30 egyedi kerületből 14 | 13 / 15 / duplikált: elutasítva; 14: elfogadva | HTTP |
| 27 karakter | karakterenként legalább egy valódi HTTP képesség-/bevétel-/tiltás teszt | HTTP |
| Speciális kerületek | Labor, Kovácsműhely, Múzeum, Fegyvertár, Állványzat, Temető, Tolvajtanya, Színház; passzív hatások és védelem | HTTP + unit |
| Titkos kéz és jogosultságok | másik játékos kezét nem mutatja, 401/403, lobby zárolása | HTTP |
| Mobil UI | létrehozás, bot, véletlen 14, súgó, 2/2, Színház, speciális építések, Fegyvertár, utolsó forduló | Chromium |
| Asztali UI | háromfős 9. rang, két karakter és botdraft | Chromium |

### Az összes karakter (27/27: legalább egy HTTP szcenárió)

| Rang | Karakterek |
|---|---|
| 1 | Orgyilkos, Boszorkány, Magisztrátus |
| 2 | Tolvaj, Kém, Zsaroló |
| 3 | Mágus, Varázsló, Látnok |
| 4 | Király, Császár, Patrícius |
| 5 | Püspök, Apát, Bíboros |
| 6 | Kereskedő, Alkimista, Szatócs |
| 7 | Építész, Navigátor, Tudós |
| 8 | Hadúr, Diplomata, Marsall |
| 9 | Királynő, Művész, Adószedő |

A szereptesztek a tényleges karakterképességek közül például célpontot
választanak, kézlapot cserélnek vagy húznak, elpusztítanak vagy
elkoboznak kerületeket, a bevételt és körsorrendet ellenőrzik,
valamint a megfelelő esetekben visszautasított második akciót is.
**Ez legalább egy releváns forgatókönyv minden karakterhez, nem az
összes lehetséges karakterpár, kártya- és játékosszám-kombináció
kimerítő bizonyítása.**

### Mind az öt korábban hiányzó kerülethatás – E2E-vel

A `test/unique-district-complete.http.e2e.test.js` a korábbi 5 TODO helyett
valódi HTTP-hívásokkal ellenőrzi a műveleteket, költségeket és tiltásokat.

| Kerület | Megvalósított, ellenőrzött szabály |
|---|---|
| Fegyvertár | Az aktív játékos feláldozza a Fegyvertárat, és elpusztít egy másik kerületet; befejezett városból nem pusztíthat |
| Állványzat | Az Állványzat feláldozásával 0 aranyért építhet; Magisztrátus nem kobozhatja el az így felépített kerületet |
| Temető | A megépítéshez saját kerületet lehet feláldozni arany helyett; Múzeum áldozásakor az alatta lévő lapok is visszakerülnek a pakliba |
| Színház | A teljes draft után, a kör kezdete előtt dönthető el a titkos, opcionális karaktercsere; 2–3 főnél a saját átadott karakter választható, a célpont két karaktere közül véletlenül kerül kiválasztásra; 4+ főnél egy karakter cserél gazdát |
| Tolvajtanya | Minden eldobott kézlap 1 aranynyi építési költséget fedez; a többit aranyban kell kifizetni; Magisztrátus-elkobzás esetén csak az elköltött arany jár vissza |

A Színház cseréje **nem** mutatja meg a célpont rejtett lapjait a
cserét végrehajtó játékosnak, és a többi játékoshoz csak a saját
aktuális titkos karakterük jut el. A bot számára a csere opcionális:
jelenleg automatikusan **kihagyja** a vak Színház-cserét.

A Chromium mobilos E2E a Színház választófelületét, az Állványzat
feláldozásával történő építést és a Fegyvertár képességét is tényleges
gombnyomásokon keresztül ellenőrzi.

### Konkrét szabályhibák, amelyeket a tesztkörnyezet felfedezett

- **Alkimista + Szegényház:** a Szegényház hatása megelőzi az
  Alkimista kör végi építésiköltség-visszatérítését.
- **Erődítmény:** sem a Diplomata, sem a Marsall képessége nem
  célozhatja; ez szerveroldalon is tiltott.
- **Nagy fal:** a Hadúr mellett a Diplomata és a Marsall
  érintett kerületeknél fizetendő költsége is a szabály szerint
  1 arannyal nő; a Marsall bot ugyanezt figyelembe veszi.

Ezek először **piros HTTP regressziós tesztként** jelentkeztek,
majd a javítás után zöldre váltottak.

## Korlátok, további QA

A tesztjátékok között vannak teljes, API-n végigjátszott draftok,
és vannak mesterségesen előkészített, de valódi HTTP hívásokkal
végrehajtott karakter-/végjátékhelyzetek. Nem szükséges ehhez minden
partit tíz-húsz valódi fordulón át lejátszani.

A teszt nem jelenti azt, hogy az egész szabálykönyv minden
kerület-kombinációja, a 27 karakter minden szélső esete vagy a
teljes UI minden karaktergombja ellenőrzött. A jelenlegi tesztek mellett később is szükség van mélyebb E2E-re a
komplikált karakter- és kerületkombinációkra, például Boszorkány +
Magisztrátus + Zsaroló együttes hatásaira. Egyetlen tesztcsomag sem
fedi le az összes lehetséges játéksorrendet.

**A jelenlegi QA tehát erős regressziós alap, nem 100%-os
szabályhűségi tanúsítvány.**
