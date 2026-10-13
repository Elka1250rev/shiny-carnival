# CSV ricaricabile, versione 1

Il CSV conserva i dati sorgente del calcolo. Importazione ed esportazione usano lo stesso formato; il prospetto dei risultati ha un formato diverso e non può essere ricaricato come dataset.

## Convenzioni

- Codifica UTF-8 e separatore `;`.
- Intestazione obbligatoria con tutte le colonne indicate qui sotto. L'esportazione usa questo ordine; l'importazione accetta anche colonne riordinate.
- Campo `versione` uguale a `1` in ogni riga.
- Date nel formato `AAAA-MM-GG`.
- Numeri senza separatori delle migliaia; punto decimale nel formato esportato. Sono ammessi fino a 18 decimali nei dati numerici.
- Campi non applicabili lasciati vuoti; commissioni pari a zero scritte `0` nelle transazioni.
- Identificativi `id` stabili e univoci per lotti, transazioni e minusvalenze pregresse.
- `ordine` intero non negativo, per ricostruire la sequenza delle operazioni della stessa data. Le transazioni nella stessa data devono avere ordini distinti; i lotti iniziali devono avere ordini distinti per asset e data originaria.
- Prezzi e commissioni sempre in euro. Il prezzo delle transazioni è **unitario**, non il controvalore totale.

Il parser gestisce campi CSV tra virgolette doppie; una virgoletta interna si scrive due volte. Il formato canonico esportato usa il punto decimale; l'importatore accetta anche una virgola decimale semplice, senza separatori delle migliaia.

```csv
versione;tipo;id;data;ordine;cripto;quantita;prezzo_unitario_eur;commissioni_eur;data_acquisto_originale;anno_minusvalenza;importo_eur
```

## Tipi di riga

| Tipo | Campi richiesti | Significato |
| --- | --- | --- |
| `configurazione` | `versione`, `tipo`, `data` | Una sola riga: `data` è la data della situazione iniziale. Tutti gli altri campi sono vuoti. |
| `iniziale` | `versione`, `tipo`, `id`, `data`, `ordine`, `cripto`, `quantita`, `prezzo_unitario_eur`, `data_acquisto_originale` | Lotto residuo alla data iniziale. `data` coincide con la configurazione; il prezzo è il costo unitario storico, con commissioni già incluse. |
| `acquisto` | `versione`, `tipo`, `id`, `data`, `ordine`, `cripto`, `quantita`, `prezzo_unitario_eur`, `commissioni_eur` | Acquisto contro euro. |
| `vendita` | Gli stessi campi di `acquisto` | Vendita contro euro; non può eccedere la disponibilità cronologica. |
| `minusvalenza_pregressa` | `versione`, `tipo`, `id`, `anno_minusvalenza`, `importo_eur` | Residuo già dichiarato e ancora disponibile all'apertura, con anno di origine. Tutti gli altri campi sono vuoti. |

Le quantità devono essere positive; prezzi e commissioni devono essere non negativi. Un costo unitario nullo non dimostra da solo che quel costo sia fiscalmente riconosciuto. L'importo di una minusvalenza pregressa deve essere positivo.

Sono supportate date di apertura e transazioni del 2025 e del 2026. La data originaria di acquisto di un lotto deve essere precedente o coincidente con l'apertura. Le transazioni non possono precedere l'apertura. L'anno di una minusvalenza pregressa deve precedere l'anno di apertura: si inserisce il residuo disponibile, non l'importo originario già utilizzato in parte.

Il dataset può contenere al massimo 5.000 righe complessive fra lotti, transazioni e minusvalenze pregresse, oltre alla configurazione. Per le perdite pregresse è prevista una sola riga con il residuo complessivo per anno di origine, dal 2021 al 2025. La scadenza viene valutata nel calcolo. Nel dataset i nomi delle crypto devono essere maiuscoli: l'interfaccia normalizza l'inserimento manuale, mentre un CSV con nomi non canonici viene segnalato dalla validazione prima dell'importazione.

## Esempio

Questo è il contenuto di [examples/esempio.csv](../examples/esempio.csv):

```csv
versione;tipo;id;data;ordine;cripto;quantita;prezzo_unitario_eur;commissioni_eur;data_acquisto_originale;anno_minusvalenza;importo_eur
1;configurazione;;2026-01-01;;;;;;;;
1;iniziale;lotto-btc-1;2026-01-01;1;BTC;0.2;40000;;2025-03-01;;
1;acquisto;tx-btc-1;2026-01-10;2;BTC;0.1;50000;10;;;
1;vendita;tx-btc-2;2026-02-10;3;BTC;0.05;60000;5;;;
```

Il lotto iniziale contiene 0,2 BTC acquistati originariamente il 1° marzo 2025. L'acquisto successivo aggiunge 0,1 BTC; la vendita consuma fiscalmente 0,05 BTC da questo lotto più recente. Le commissioni storiche del lotto iniziale sono già comprese nel costo unitario di 40.000 euro.

Il ricavo netto della vendita è 2.995 euro e il costo fiscale LIFO è 2.505 euro: la plusvalenza fiscale è 490 euro. Senza altre operazioni o perdite disponibili, l'imposta stimata per il 2026 è 161,70 euro.

Una riga aggiuntiva per 500 euro di minusvalenza residua originata nel 2024 sarebbe:

```csv
1;minusvalenza_pregressa;perdita-2024;;;;;;;;2024;500
```

Inserirla solo se il residuo risulta già dichiarato e disponibile al 1° gennaio 2026.

## Importazione ed esportazione

L'importazione mostra un'anteprima e segnala gli errori prima di applicare il dataset. Un file non valido non modifica i dati in uso. L'importazione confermata sostituisce il dataset corrente: il CSV deve quindi contenere tutti i dati che si vogliono conservare.

I risultati vengono ricalcolati ordinando le operazioni per data e ordine. Non dipendono dall'ordine fisico delle righe nel file. Identificativi duplicati, date non valide, dati mancanti e vendite superiori alla disponibilità impediscono un calcolo valido.

Esportare il CSV ricaricabile prima di chiudere o ricaricare la pagina. Il download viene avviato dal browser e non invia il file al server. Conservare il file su un dispositivo a propria scelta: l'applicazione non mantiene copie.

## Futuri formati

Gli importatori sono registrati separatamente e restituiscono lo stesso dataset normalizzato. Un adattatore Excel potrà convertire fogli e colonne in configurazione, lotti, transazioni e perdite pregresse; validazione e calcoli resteranno condivisi. Questa versione non legge file `.xlsx` o `.xls` e non stabilisce ancora una struttura di foglio Excel.
