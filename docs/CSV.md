# CSV ricaricabile: versioni 1 e 2

Il CSV ricaricabile conserva la situazione iniziale, le operazioni e le minusvalenze pregresse. Il **Prospetto CSV** esporta invece i risultati e non può ripristinare una sessione. Il CSV originale a 17 colonne della piattaforma ha un adattatore separato, descritto in [CSV-EXCHANGE.md](CSV-EXCHANGE.md).

## Convenzioni comuni

- UTF-8, separatore `;`, intestazione obbligatoria; le colonne possono essere riordinate ma non duplicate.
- Date `AAAA-MM-GG`; numeri senza separatori delle migliaia, fino a 30 cifre intere e 18 decimali. L'esportazione usa il punto; il parser accetta anche una virgola decimale semplice.
- `id` stabile e univoco fra lotti, transazioni e perdite; massimo 64 caratteri, senza controlli o prefissi di formula `=`, `+`, `-`, `@`.
- `ordine` intero non negativo e distinto fra tutte le operazioni della stessa data. Per i lotti iniziali l'unicità riguarda asset e data originaria; la loro sequenza è distinta.
- Nomi degli asset maiuscoli, coerenti fra tutte le righe della stessa attività. Il nome non certifica la categoria fiscale.
- Quantità positive; prezzi, commissioni e costi non negativi. Campi non applicabili vuoti; commissioni zero scritte `0` nelle transazioni.
- Massimo 5.000 righe di dati, oltre alla configurazione, e 5 MiB per file. L'eventuale operazione derivata per una commissione in una terza crypto concorre al limite di righe.

Il lettore gestisce virgolette doppie, separatori e ritorni a capo nei campi quotati. Una virgoletta interna è raddoppiata. La versione è uniforme in tutte le righe.

## Versione 1 e compatibilità

```csv
versione;tipo;id;data;ordine;cripto;quantita;prezzo_unitario_eur;commissioni_eur;data_acquisto_originale;anno_minusvalenza;importo_eur
```

Con `versione=1` sono ammessi configurazione, lotti iniziali, acquisti, vendite e minusvalenze pregresse. I file esistenti rimangono leggibili. Il loro ricalcolo usa le regole fiscali attuali: **le commissioni non sono deducibili fiscalmente**. I vecchi lotti iniziali in cui erano stati incorporati oneri devono essere verificati e corretti manualmente; il file non permette di ricostruire automaticamente la quota di commissione.

## Versione 2

La versione 2 aggiunge una colonna e nuovi tipi di transazione:

```csv
versione;tipo;id;data;ordine;cripto;quantita;prezzo_unitario_eur;commissioni_eur;data_acquisto_originale;anno_minusvalenza;importo_eur;dati_estesi
```

`dati_estesi` contiene JSON quotato secondo le regole CSV. Le stringhe decimali restano esatte; i campi sconosciuti o non compatibili con il tipo vengono respinti. L'esportazione conserva la versione del dataset: le operazioni exchange richiedono la 2, senza conversione al formato 1 che ne perderebbe i dati.

## Tipi di riga

| Tipo | Campi oltre a `versione` e `tipo` | Significato |
| --- | --- | --- |
| `configurazione` | `data` | Una sola riga, data della situazione iniziale. Gli altri campi sono vuoti. |
| `iniziale` | `id`, `data`, `ordine`, `cripto`, `quantita`, `prezzo_unitario_eur`, `data_acquisto_originale` | Lotto residuo: `data` coincide con l'apertura e il prezzo è il costo unitario fiscale storico documentato, esclusi gli oneri. |
| `acquisto` | `id`, `data`, `ordine`, `cripto`, `quantita`, `prezzo_unitario_eur`, `commissioni_eur` | Acquisto contro euro; il prezzo è unitario, non il totale. Le commissioni incidono sul costo gestionale. |
| `vendita` | Come `acquisto` | Cessione contro euro; il prezzo è lordo fiscale. Le commissioni incidono soltanto sul risultato gestionale. |
| `minusvalenza_pregressa` | `id`, `anno_minusvalenza`, `importo_eur` | Residuo complessivo per anno, già dichiarato e disponibile all'apertura. |
| `permuta_neutrale` (v2) | Campi delle transazioni; prezzo `0`, commissioni `0`, dati estesi obbligatori | Cessione e ricezione di asset diversi, senza realizzo; trasferimento del costo storico. |
| `permuta_imponibile` (v2) | Come sopra | Realizzo al valore normale documentato dell'asset ricevuto, nuovo lotto allo stesso costo. |
| `provento` (v2) | Campi delle transazioni; prezzo `0`, commissioni `0`, dati estesi obbligatori | Provento da detenzione imponibile lordo alla percezione e ingresso delle unità ricevute. |
| `deposito_eur` (v2) | Campi delle transazioni; `cripto=EUR`, prezzo `1`, commissioni `0` | Movimento informativo, privo di risultato fiscale. Non ricostruisce un conto EUR. |

Apertura e operazioni devono ricadere nel 2025 o 2026; nessuna operazione può precedere l'apertura. Le date originarie dei lotti non possono essere successive all'apertura. Le minusvalenze pregresse hanno anno dal 2021 al 2025, precedente all'anno di apertura; massimo una riga per anno. La scadenza è verificata nel calcolo.

## Contenuto di `dati_estesi`

| Campo JSON | Impiego |
| --- | --- |
| `totalEur` | Controvalore totale EUR esatto. Se presente su acquisto/vendita, prevale su quantità × prezzo unitario. Obbligatorio per provento e permuta imponibile; non ammesso per permuta neutrale. |
| `receivedAsset` | Asset ricevuto nelle due permute, diverso da `cripto`. |
| `receivedQuantity` | Quantità positiva ricevuta nelle due permute. |
| `lotDatePolicy` | Solo permuta neutrale: `historical` mantiene le date storiche; `exchange` usa la data dello scambio. Scelta esplicita che influisce sul LIFO, non una regola fiscale attestata dal sito. |
| `rewardCostEur` | Solo provento: costo fiscale totale documentato dei token ricevuti per le future cessioni; obbligatorio anche quando la scelta documentata è zero. È distinto dal provento lordo imponibile `totalEur`. |
| `source` | Facoltativo, conserva provenienza, tutte le 17 stringhe originali dell'exchange e decisioni esplicite di conversione. |

`source` ha `line` (numero di riga originale), `values` (tutte e sole le 17 colonne indicate in [CSV-EXCHANGE.md](CSV-EXCHANGE.md)), eventuale `decisions` e booleano `derived` per una commissione convertita in cessione separata. In `decisions` sono ammessi:

- `swapTaxTreatment`: `neutral`, `taxable`, `not_applicable`;
- `rewardTreatment`: `holding_income`, `documented_acquisition`, `not_applicable`;
- `rewardCostPolicy`: `zero_confirmed`, `received_value_confirmed`, `manual`, `not_applicable`;
- `amountsPolicy`: `as_reported_confirmed`, `manual`;
- `feePolicy`: `already_included`, `separate_taxable_disposal`, `not_applicable`;
- `lotDatePolicy`: `historical`, `exchange`, `not_applicable`;
- `grossValuesConfirmed`: booleano.

Un premio verificato come ingresso di diversa natura (`documented_acquisition`) è normalizzato come `acquisto`, con `totalEur` pari al costo esplicitamente documentato; non genera automaticamente provento da detenzione. Ciò non attesta l'esenzione del premio né assolve obblighi di altre categorie fiscali. Il costo zero richiede conferma esplicita.

Le rettifiche sono nei campi normalizzati: non sovrascrivono `source.values`. Quantità e controvalori originali, entrambe le parti dello scambio, commissioni e metadati rimangono disponibili nell'export ricaricabile. Il prospetto dei risultati aggiunge i dati delle nuove operazioni quando presenti, ma resta un formato di sola consultazione.

Esempio del solo oggetto esteso di una permuta neutrale, prima della quotatura CSV:

```json
{"receivedAsset":"ETH","receivedQuantity":"2.5","lotDatePolicy":"historical"}
```

## Esempio semplice compatibile con la versione 1

[examples/esempio.csv](../examples/esempio.csv) contiene:

```csv
versione;tipo;id;data;ordine;cripto;quantita;prezzo_unitario_eur;commissioni_eur;data_acquisto_originale;anno_minusvalenza;importo_eur
1;configurazione;;2026-01-01;;;;;;;;
1;iniziale;lotto-btc-1;2026-01-01;1;BTC;0.2;40000;;2025-03-01;;
1;acquisto;tx-btc-1;2026-01-10;2;BTC;0.1;50000;10;;;
1;vendita;tx-btc-2;2026-02-10;3;BTC;0.05;60000;5;;;
```

Il lotto iniziale è residuo e il costo unitario fiscale di 40.000 euro deve escludere gli oneri. L'acquisto aggiunge 0,1 BTC; la vendita consuma 0,05 BTC dal nuovo lotto. Il corrispettivo lordo è 3.000 euro e il costo fiscale LIFO 2.500: **plusvalenza fiscale 500 euro**, imposta ordinaria 2026 di **165 euro**, in assenza di altre operazioni o perdite utilizzabili. Il ricavo gestionale netto della vendita è invece 2.995 euro.

Una perdita residua 2024 di 500 euro, solo se già dichiarata e disponibile al 1° gennaio 2026, si rappresenta in versione 1 come:

```csv
1;minusvalenza_pregressa;perdita-2024;;;;;;;;2024;500
```

## Importazione, esportazione e riservatezza

L'importazione del CSV CriptoConti mostra un'anteprima e, dopo la conferma, sostituisce l'intero dataset. Quella exchange propone invece se sostituire soltanto le operazioni o aggiungerle, conservando lotti e perdite. Un file non valido non modifica la sessione. Quantità non disponibili, ID duplicati, campi mancanti e sequenze incoerenti impediscono un calcolo valido.

Esportare **Esporta dati** prima di chiudere o ricaricare la pagina e ricaricarlo nella sessione successiva. Il file viene creato nel browser, senza invii al server e senza copie conservate dall'applicazione. Il CSV v2 può contenere anche indirizzi e metadati originali dell'exchange: conservarlo come documentazione personale.

## Futuri formati

Gli adattatori producono lo stesso dataset normalizzato e condividono validazione e motore. Per la situazione iniziale è disponibile un lettore `.xlsx` separato, descritto in [EXCEL-INIZIALE.md](EXCEL-INIZIALE.md). Le operazioni restano importabili in CSV; `.xls` e altri tracciati Excel non sono supportati.
