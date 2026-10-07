# Citadella – telefonos asztal

Mobilbarát, Redis-alapú Citadella segédalkalmazás a játékszobához. A cél nem a kerületkártyák teljes digitalizálása: a fizikai lapok maradhatnak a játékosoknál, a webapp pedig kezeli a titkos karakterválasztást, a nyílt aranykészletet, a megépített kerületek összesített állapotát, a körsorrendet és az eredményszámítás alapját.

## Jelenlegi játékmód

- 4–8 játékos.
- 4–7 főnél a klasszikus 1–8. rangú karakterek szerepelnek.
- 8 főnél kilencedik karakterként a Királynő kerül be.
- A kiválasztási fázisban az app kezeli a képpel felfelé/lefelé félretett karaktereket és a 7–8 játékosra vonatkozó utolsó választó szabályát.
- A karaktered és a képességed a saját telefonodon végig látszik.
- A `?` gomb a játékban lévő összes karakter képességét mutatja.
- A közös asztal minden játékos aranyát és megépített kerületeit mutatja.
- Kerület építésekor csak név, típus és költség kell; a kártya különleges hatása a fizikai kártyán marad.
- A pontozás automatikusan számolja a kerületek költségét, az öt típusért járó +3 pontot és a befejezési bónuszt. Az egyedi kerületek további pontja kézzel adható meg.

A karakterképességeket az alkalmazás nem erőlteti rá automatikusan a játékosokra. Ez tudatos: több képesség a fizikai kézben tartott kerületlapokkal, választással vagy blöffel dolgozik. Az aktív játékos és a host a nyílt aranyállapotot korrigálhatja, így a képességek eredménye lekövethető.

## Indítás fejlesztői gépen

Redis szükséges a `redis://localhost:6379` címen.

```bash
npm install
npm test
npm start
```

Alap URL: `http://localhost:8106/citadella/`.

## K3s frissítés

A repo ugyanazt a frissítési mintát követi, mint a többi játékszoba-app:

```bash
./update.sh --target nuc --dry-run
./update.sh --target nuc
```

Pi 5 esetén `--target pi5`. A script ellenőrzi a node nevét és architektúráját, lokális image-et épít, importálja a k3s containerd-be, majd frissíti a Deploymentet és Service-t.

Az ingress útvonal a központi `Nicqx/ingress` repóban legyen: `/citadella -> citadella-game-service:8106`.

## Session és biztonság

- Ötjegyű sessionkód.
- 6 órás Redis TTL, aktív lekérdezésnél meghosszabbítva.
- Minden játékos külön, véletlen kliens-token kap; a token nem kerül a publikus játékállapotba.
- A konténer nem rootként fut, read-only root filesystemmel, letiltott service-account tokennel és eldobott Linux capabilitykkel.
