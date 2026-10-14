# Shiny Carnival

Calcolatore locale di plusvalenze, minusvalenze e imposta sulle compravendite di cripto-attività contro euro, per persone fisiche residenti in Italia, fuori dall'attività d'impresa, in **regime dichiarativo**.

L'applicazione è statica: i dati inseriti rimangono nella memoria della pagina. Non utilizza account, database, cookie, `localStorage`, `IndexedDB` o analitiche; non invia transazioni al server. Chiudere o ricaricare la pagina elimina i dati non esportati.

## Funzioni

- Situazione iniziale composta da lotti residui, con data originaria di acquisto, quantità e costo unitario documentato.
- Inserimento di acquisti e vendite, con data, ordine, crypto, quantità, prezzo unitario in euro e commissioni in euro.
- Per ogni operazione: quantità e prezzo medio prima e dopo, costo fiscale attribuito alla vendita e plusvalenza o minusvalenza fiscale.
- Riepilogo per il 2025 e il 2026, con compensazione delle minusvalenze pregresse dichiarate e ancora disponibili.
- Importazione CSV con anteprima e validazione, esportazione dei dati ricaricabili e CSV separato del prospetto dei risultati.
- Riepilogo PDF con plusvalenza o minusvalenza per ogni operazione e riepilogo fiscale dell'anno selezionato.
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

I test verificano aritmetica, motore di calcolo, formato CSV, importazione asincrona, sequenza delle operazioni e riepilogo PDF; il controllo aggiuntivo verifica i file del progetto. Il workflow **Controlli** esegue entrambi i comandi con Node.js 24 sui push e sulle pull request.

Il job **PDF in Chrome** genera PDF con dati sintetici usando il sito nel browser e ne controlla testo, dimensioni delle pagine, impaginazione su più pagine e ripristino della sessione. I PDF e le anteprime sono disponibili come artefatto della verifica per sette giorni. Questi test usano Playwright 1.58.2, Chrome, Poppler e i font Noto CJK, installati soltanto nell'ambiente di test; il sito non richiede queste dipendenze. Con tali strumenti disponibili, la verifica si avvia con `npm run test:pdf-browser`.

## Modifiche al progetto

Usare un branch dedicato per ogni modifica e aprire una pull request verso `main`. Non pubblicare modifiche direttamente su `main`. Verificare i test e i controlli prima di proporre l'unione della pull request; l'unione in `main` avvia la pubblicazione del sito.

## Dati ed esportazione

L'esportazione dei dati salva la configurazione, i lotti iniziali, le transazioni e le minusvalenze pregresse. Importando quel file si ricostruiscono i risultati con le regole dell'applicazione. Il CSV del prospetto è invece destinato alla consultazione e non è un file ricaricabile.

Nella sezione **Operazioni**, il pulsante **Esporta PDF** apre la finestra di stampa del browser: selezionare **Salva come PDF** come destinazione. Il prospetto è predisposto in A4 orizzontale e contiene tutte le operazioni della sessione, anche con un filtro di ricerca attivo. Per ciascuna riga mostra quantità, commissioni, ricavo netto, costo di acquisto o costo fiscale LIFO e plusvalenza/minusvalenza; gli acquisti sono indicati come **Nessun realizzo**. Il riepilogo fiscale riguarda soltanto l'anno selezionato e conserva le avvertenze del calcolo.

Gli importi del PDF sono arrotondati direttamente dai valori esatti del calcolo. Una plusvalenza o minusvalenza non nulla che si arrotonda a zero è indicata come **inferiore a 0,005 €**, senza confonderla con un pareggio. Le avvertenze relative al calcolo sono riportate prima della tabella, accanto al riepilogo fiscale. Le pagine sono numerate nei browser che supportano i contatori di pagina in stampa.

Il PDF è creato tramite la stampa locale del browser e serve alla consultazione. Per riprendere il lavoro usare il CSV ottenuto con **Esporta dati**. Chiudere o annullare la finestra di stampa lascia intatti i dati della sessione.

Il formato usa UTF-8, separatore `;`, date `AAAA-MM-GG` e punto decimale senza separatori delle migliaia. La specifica è in [docs/CSV.md](docs/CSV.md); [examples/esempio.csv](examples/esempio.csv) contiene un portafoglio minimo da importare.

L'applicazione usa aritmetica decimale esatta per i calcoli interni. L'imposta stimata viene arrotondata ai centesimi; le quantità e gli importi visualizzati possono essere abbreviati senza modificare i dati sorgente esportati.

Storici molto lunghi con numerose vendite parziali e quantità a 18 decimali possono ancora richiedere diversi secondi di calcolo: l'aritmetica esatta conserva frazioni via via più complesse.

## Pubblicazione su GitHub Pages

Il sito è pubblicato su [GitHub Pages](https://elka1250rev.github.io/shiny-carnival/): tutti i calcoli avvengono nel browser.

In **Settings → Pages → Build and deployment**, la sorgente deve essere **GitHub Actions**. Il workflow `.github/workflows/pages.yml` pubblica il contenuto di `dist/` quando una modifica arriva su `main`; i branch e le pull request eseguono i controlli senza aggiornare il sito pubblico. È disponibile anche l'avvio manuale del workflow Pages.

Non serve alcun servizio applicativo o database. Il server di hosting riceve le normali richieste per i file statici; i dati finanziari restano nella pagina.

## Struttura e ampliamenti

- `dist/`: interfaccia e moduli JavaScript del sito.
- `tests/`: verifiche con il test runner integrato di Node.js.
- `docs/`: regole fiscali supportate e contratto del CSV.
- `examples/`: dati dimostrativi privi di informazioni personali.

Ogni importatore converte il proprio formato nello stesso dataset. Validazione, ordinamento cronologico e motore fiscale sono condivisi: un futuro adattatore Excel dovrà occuparsi solo della conversione. Le regole fiscali sono selezionate per anno; nuovi anni o nuovi tipi di operazione richiedono una verifica normativa e test dedicati.

Il perimetro attuale copre le compravendite di cripto-attività ordinarie contro euro nel 2025 e nel 2026. Permute, staking, DeFi, NFT, token di moneta elettronica denominati in euro, imposte sul possesso e obblighi di monitoraggio non sono calcolati. I nomi degli asset non ne certificano la categoria fiscale.
