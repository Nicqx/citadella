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
| Speciális kerületek | aktív Labor, Kovácsműhely, Múzeum; több passzív hatás és védelem | HTTP + unit |
| Titkos kéz és jogosultságok | másik játékos kezét nem mutatja, 401/403, lobby zárolása | HTTP |
| Mobil UI | létrehozás, bot, véletlen 14, tiltott karakter, 27-es súgó, 2/2, utolsó forduló | Chromium |
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

### Ismert, még hiányzó öt egyedi kerülethatás

Az 54 alap + 14 kiválasztott kerületből álló pakli és a teljes 30 lapos
egyedi katalógus rendben van. Ettől azonban egy kártya képessége
még nem feltétlenül működik. A következő hatásokhoz nem található
teljes szerveroldali végrehajtás, ezért a tesztcsomag **5 látható TODO
esetet** tartalmaz:

| Kártya | Hiányzó művelet |
|---|---|
| Fegyvertár | Fegyvertár feláldozása egy másik kerület elpusztításáért |
| Állványzat | kerület felépítése az Állványzat feláldozásával az arany helyett |
| Temető | építés egy saját kerület feláldozásával az arany helyett |
| Színház | karakterek titkos cseréje a draft végén (2–3 főnél is) |
| Tolvajtanya | kerület építési költségének kifizetése kézlapokból |

Ezek **nem PASS-ok** és nem a szabályok szerint működőnek tekintendők.
Minden egyedi kerülethatást külön pozitív tesztnek kell majd védenie,
amikor az implementáció elkészül.

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
teljes UI minden karaktergombja ellenőrzött. A hiányzó öt kerülethatás
mellett később külön mély E2E szükséges a komplikált
kerület- és karakterkölcsönhatásokra, például Színház 2–3 fővel,
Boszorkány + Magisztrátus + Zsaroló és speciális építési módok.

**A jelenlegi QA tehát erős regressziós alap, nem 100%-os
szabályhűségi tanúsítvány.**
