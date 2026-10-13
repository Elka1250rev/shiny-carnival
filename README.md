# Shiny Carnival

Calcolatore locale di plusvalenze, minusvalenze e imposta sulle compravendite di cripto-attività contro euro, per persone fisiche residenti in Italia, fuori dall'attività d'impresa, in **regime dichiarativo**.

L'applicazione è statica: i dati inseriti rimangono nella memoria della pagina. Non utilizza account, database, cookie, `localStorage`, `IndexedDB` o analitiche; non invia transazioni al server. Chiudere o ricaricare la pagina elimina i dati non esportati.

## Funzioni

- Situazione iniziale composta da lotti residui, con data originaria di acquisto, quantità e costo unitario documentato.
- Inserimento di acquisti e vendite, con data, ordine, crypto, quantità, prezzo unitario in euro e commissioni in euro.
- Per ogni operazione: quantità e prezzo medio prima e dopo, costo fiscale attribuito alla vendita e plusvalenza o minusvalenza fiscale.
- Riepilogo per il 2025 e il 2026, con compensazione delle minusvalenze pregresse dichiarate e ancora disponibili.
- Importazione CSV con anteprima e validazione, esportazione dei dati ricaricabili e CSV separato del prospetto dei risultati.
- Importatori separati dal modello e dal calcolo, per aggiungere in seguito altri formati. Excel non è implementato.

Il **prezzo medio ponderato gestionale** e il **costo fiscale LIFO** sono due valori distinti. Una vendita lascia invariato il prezzo medio gestionale finché rimangono unità; il calcolo fiscale consuma invece i lotti più recenti. Il dettaglio delle regole e dei limiti è in [docs/FISCALITA.md](docs/FISCALITA.md).

## Avvio locale

Serve Node.js 24. Non sono necessarie dipendenze da installare.

```sh
npm run serve
```

Aprire l'indirizzo stampato dal comando. I file dell'applicazione sono in `dist/` e possono essere serviti da qualunque server HTTP statico.

```sh
npm test
npm run check
```

I test verificano il motore di calcolo e il formato CSV; il controllo aggiuntivo verifica i file del progetto. GitHub Actions esegue entrambi i comandi con Node.js 24, senza pubblicare il sito.

## Dati ed esportazione

L'esportazione dei dati salva la configurazione, i lotti iniziali, le transazioni e le minusvalenze pregresse. Importando quel file si ricostruiscono i risultati con le regole dell'applicazione. Il CSV del prospetto è invece destinato alla consultazione e non è un file ricaricabile.

Il formato usa UTF-8, separatore `;`, date `AAAA-MM-GG` e punto decimale senza separatori delle migliaia. La specifica è in [docs/CSV.md](docs/CSV.md); [examples/esempio.csv](examples/esempio.csv) contiene un portafoglio minimo da importare.

L'applicazione usa aritmetica decimale esatta per i calcoli interni. L'imposta stimata viene arrotondata ai centesimi; le quantità e gli importi visualizzati possono essere abbreviati senza modificare i dati sorgente esportati.

## Pubblicazione su GitHub Pages

Il sito può essere ospitato su GitHub Pages perché tutti i calcoli avvengono nel browser. Questo repository contiene un workflow di controllo, **senza deployment automatico**.

Per pubblicarlo manualmente:

1. Pubblicare il contenuto di `dist/` nella radice di un ramo dedicato, per esempio `gh-pages`.
2. In GitHub, aprire **Settings → Pages → Build and deployment**.
3. Selezionare **Deploy from a branch**, il ramo dedicato e la cartella **/(root)**.

In alternativa, un futuro workflow Pages può caricare `dist/` come artefatto del sito. Non serve alcun servizio applicativo o database. Il server di hosting riceve le normali richieste per i file statici; i dati finanziari restano nella pagina.

## Struttura e ampliamenti

- `dist/`: interfaccia e moduli JavaScript del sito.
- `tests/`: verifiche con il test runner integrato di Node.js.
- `docs/`: regole fiscali supportate e contratto del CSV.
- `examples/`: dati dimostrativi privi di informazioni personali.

Ogni importatore converte il proprio formato nello stesso dataset. Validazione, ordinamento cronologico e motore fiscale sono condivisi: un futuro adattatore Excel dovrà occuparsi solo della conversione. Le regole fiscali sono selezionate per anno; nuovi anni o nuovi tipi di operazione richiedono una verifica normativa e test dedicati.

Il perimetro attuale copre le compravendite di cripto-attività ordinarie contro euro nel 2025 e nel 2026. Permute, staking, DeFi, NFT, token di moneta elettronica denominati in euro, imposte sul possesso e obblighi di monitoraggio non sono calcolati. I nomi degli asset non ne certificano la categoria fiscale.
