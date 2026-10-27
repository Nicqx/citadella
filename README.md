# Citadella – telefonos asztal

Mobilbarát, Redis-alapú Citadella játékszoba. Az alkalmazás kezeli a titkos karakterválasztást, a kerületpaklit és a játékosok privát kezét, az aranyat, az építést, a körsorrendet és a legfontosabb karakterképességeket.

## Jelenlegi játékmód

- 4–8 résztvevő; a valós játékosok mellé a lobbyban szimulált játékosok adhatók.
- Minden játékos 2 arannyal és 4 titkos kerületlappal indul.
- A kerületpakli mindig 54 alap + 14 egyedi kerületből áll. Az egyedi kerületek a teljes, 30 lapos készletből választhatók ki indulás előtt; alapból az első játék 14 lapos készlete van kijelölve.
- A saját kéz csak a saját telefonon látható; más játékosok csak a kézlapok számát látják.
- A kör elején az aktív játékos 2 aranyat választ, vagy 2 kerületlapból 1-et tart meg.
- Építeni közvetlenül a saját kézben látható lapra kattintva lehet; az app levonja az aranyat és az asztalra teszi a kerületet.
- Normál karakter körönként legfeljebb 1, az Építész legfeljebb 3 kerületet építhet.
- 4–7 főnél a klasszikus 1–8. rangú karakterek szerepelnek.
- 8 főnél kilencedik karakterként a Királynő kerül be.
- A kiválasztási fázis kezeli a nyílt/rejtett félretett karaktereket és a 7–8 játékosra vonatkozó utolsó választó szabályát.
- A karaktered és a képességed a saját telefonodon végig látszik.
- A `?` gomb teljes játékmeneti segédletet mutat: cél, előkészítés, karakterválasztás, kör menete, pontozás, karakterek és az egyedi kerületek hatásai.
- A közös asztal minden játékos aranyát, kézlapjainak számát és megépített kerületeit mutatja.
- A pontozás teljesen automatikus: az app számolja a kerületek alapértékét, az öt típusért járó +3 pontot, a befejezési bónuszt és az egyedi kerületek játékvégi pontjait. A Kísértetvárosnál a legtöbb pontot adó szabályos típust választja.

## Interaktív karakterképességek

- **Orgyilkos:** karakterre kattintva kijelöli az áldozatot; az érintett karakter köre automatikusan kimarad és nem fedődik fel.
- **Tolvaj:** karakterre kattintva kijelöli a célpontot; amikor az a karakter sorra kerül, az aranya automatikusan a Tolvajhoz kerül.
- **Mágus:** egy másik játékossal teljes kézcsere, vagy kijelölt saját lapok eldobása és ugyanannyi új húzása.
- **Király / Püspök / Kereskedő / Hadúr:** kattintható színbevétel.
- **Király:** a korona automatikusan átkerül hozzá.
- **Kereskedő:** a plusz 1 arany automatikus.
- **Építész:** a plusz 2 kerületlap automatikus, és az építési limit 3.
- **Hadúr:** a nyílt asztalról kattintással választhat elpusztítandó kerületet; az app kezeli a költséget és az alapvető védelmeket.
- **Királynő:** a Király melletti ülésért járó bónuszt az app automatikusan kezeli.

Az egyedi kerületek egyre nagyobb része automatizált. Többek közt a Gyár, Könyvtár, Kőfejtő, Laboratórium, Kovácsműhely, Aranybánya, Csillagvizsgáló, Park, Szegényház, Istálló, Emlékmű, Nagy fal és a játékvégi pontbónuszok be vannak kötve. A Múzeum alá körönként egy kézlap tehető, az app nyilvántartja ezeket és automatikusan pontozza őket.

## Szimulált játékosok

- A házigazda a lobbyban 0–7 szimulált játékost állíthat be, úgy hogy a teljes létszám legfeljebb 8 legyen.
- A botok titokban karaktert választanak, nyersanyagot gyűjtenek, egyszerű karakterképességeket használnak és szabályosan építkeznek.
- A botstratégia szándékosan egyszerű: játékképes ellenfelet/pótlást ad, nem tökéletes mesterséges intelligenciát.

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

Az ingress útvonal a központi `Nicqx/ingress` repóban: `/citadella -> citadella-game-service:8106`.

## Session és biztonság

- Ötjegyű sessionkód.
- 6 órás Redis TTL, aktív lekérdezésnél meghosszabbítva.
- Minden játékos külön, véletlen kliens-token kap; a token nem kerül a publikus játékállapotba.
- A kézben lévő kerületlapokat a szerver csak a saját hitelesített játékos válaszában adja vissza.
- A konténer nem rootként fut, read-only root filesystemmel, letiltott service-account tokennel és eldobott Linux capabilitykkel.
