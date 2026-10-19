# CSV con quantità inviate e ricevute

L'importazione riconosce il tracciato a 17 colonne e mostra una verifica prima di applicare le operazioni al calcolatore. Il formato non contiene i costi storici della situazione iniziale: occorre prepararli nel sito. Il file della piattaforma e il CSV ricaricabile CriptoConti sono formati distinti.

## Struttura

UTF-8, separatore virgola, con tutte queste colonne obbligatorie, anche riordinate:

```csv
id,datetime_tz_CET,type,label,market_model_type,order_type,sent_amount,sent_currency,sent_value_EUR,sent_address,received_amount,received_currency,received_value_EUR,received_address,fee_amount,fee_currency,fee_value_EUR
```

Il lettore conserva le stringhe originali, i decimali e tutti i metadati. Le colonne duplicate o mancanti, gli ID duplicati e le righe non valide sono segnalati con la posizione nel file. Nessuna riga viene eliminata silenziosamente. Il contenuto dell'allegato personale non fa parte del repository o dei test: sono usati soltanto esempi sintetici.

## Quantità effettive e controvalori

L'utente ha confermato che `sent_amount` e `received_amount` sono **quantità nette effettivamente addebitate o accreditate**, con commissioni già considerate. Per esempio, `received_amount=1` e `fee_amount=0.001` indicano un accredito di 1 unità: non di 0.999 e non di 1.001. La commissione non deve essere applicata una seconda volta alle quantità.

I campi `sent_value_EUR` e `received_value_EUR` rappresentano controvalori effettivi al momento dell'operazione; restano distinti e non vengono sostituiti con quotazioni attuali. Un controvalore effettivo già netto non dimostra, da solo, il **corrispettivo lordo fiscale**: quest'ultimo deve essere verificato nella documentazione ed eventualmente rettificato per singola riga. Le quantità restano i movimenti reali del portafoglio.

La circolare AdE 30/E, § 3.1, pp. 50–51, esclude la deduzione dei costi di acquisto/cessione e richiede i proventi da detenzione al lordo delle trattenute. Il sito conserva `fee_amount`, `fee_currency`, `fee_value_EUR` e non ricostruisce importi fiscali incerti sommando automaticamente una commissione. Se un valore è ambiguo, la verifica rimane a carico dell'utente: non vengono inventati prezzi, lotti o costi.

## Operazioni rappresentate

| Riga della piattaforma | Operazione del calcolatore |
| --- | --- |
| `Buy`, EUR inviati e crypto ricevuta | Acquisto: quantità ricevuta effettiva; costo fiscale totale EUR verificato, inizialmente proposto da `sent_value_EUR`. |
| `Sell`, crypto inviata ed EUR ricevuti | Vendita: quantità ceduta effettiva; corrispettivo lordo EUR verificato, inizialmente proposto da `received_value_EUR`. |
| `Trade`, due crypto diverse | Permuta neutrale o imponibile dopo classificazione esplicita della coppia. |
| `Receive`, `label=Reward`, `market_model_type=EARN` | Premio da qualificare e verificare; EARN può comprendere proventi da detenzione e premi promozionali. |
| `Deposit`, EUR ricevuti | Movimento informativo EUR; nessun reddito e nessuna ricostruzione di un saldo di liquidità utilizzabile. |

Gli altri tipi o strutture incoerenti bloccano l'importazione senza escludere automaticamente le righe. Le categorie fiscali non sono dedotte dal ticker, dall'etichetta EARN o dal solo nome della piattaforma.

## Verifica prima dell'importazione

1. **Destinazione:** sostituire soltanto le operazioni conservando apertura, lotti iniziali e minusvalenze, oppure aggiungere operazioni di altre date. In aggiunta, una data già presente viene bloccata: il sito non può ricostruire la sequenza relativa fra gli orari exchange e le operazioni esistenti prive di orario.
2. **Data e ora:** confermare i valori testuali `AAAA-MM-GG-HH:mm:ss`, senza conversione automatica di `CET`. Le righe sono ordinate per timestamp; a parità di secondo è mantenuto l'ordine nel file. La sequenza giornaliera è assegnata da 1. La conferma non stabilisce un offset legale o una conversione dell'ora estiva.
3. **Importi fiscali:** verificare i controvalori lordi richiesti, mantenendo le quantità nette effettive. L'anteprima conserva entrambe le valorizzazioni EUR e permette rettifiche senza modificare le 17 stringhe di origine.
4. **Permute:** classificare ogni coppia come neutrale solo se sussistono eguali caratteristiche e funzioni; altrimenti verificare la rilevanza fiscale e il valore normale della crypto ricevuta. Una scelta collettiva richiede la stessa verifica per tutte le coppie. Non ogni stablecoin è omogenea a bitcoin: EMT, ART, NFT e strumenti finanziari richiedono una qualificazione specifica; i regimi speciali esclusi non diventano supportati per effetto della scelta.
5. **Date dei lotti neutrali:** scegliere esplicitamente data storica o data dello scambio. Il costo storico viene trasferito in entrambi i casi; la data incide sul LIFO futuro. Il sito non presenta uno dei criteri come una prescrizione espressa della legge.
6. **Premi:** verificare la natura per ogni riga. Un provento da detenzione è imponibile lordo alla ricezione e richiede separatamente il costo fiscale documentato del token per le vendite successive. Un premio promozionale non viene dichiarato esente dal sito: può richiedere una diversa qualificazione e obblighi esterni al perimetro. La sua eventuale registrazione come ingresso con costo documentato non equivale a una certificazione della tassazione del premio. Il costo zero richiede una conferma esplicita, non viene inferito dall'assenza di pagamento.
7. **Commissione in una terza crypto:** verificare se è già compresa senza ulteriore movimento oppure se costituisce un pagamento aggiuntivo di un servizio. Nel secondo caso viene generata una cessione separata della crypto usata per il servizio, al valore EUR documentato della commissione. La scelta non va fatta dal solo fatto che la valuta sia diversa.

L'anteprima è paginata e consente di rettificare i dati della singola riga. I totali EUR esatti sono conservati direttamente: nessun totale è ricostruito da un prezzo unitario arrotondato. Per una permuta neutrale non si inserisce un nuovo costo al valore di mercato: viene trasferito quello storico dei lotti ceduti.

## Situazione iniziale ed errori

Il CSV non prova un saldo iniziale nullo né un costo fiscale zero. Inserire nella situazione iniziale i lotti residui documentati prima della prima operazione, con costo fiscale esclusi gli oneri. I vecchi dati in cui le commissioni erano incorporate nei lotti iniziali richiedono una revisione manuale.

L'anteprima distingue la lettura corretta del file dalle verifiche ancora da completare: il pulsante finale rimane disabilitato finché mancano scelte fiscali o dati necessari. Uno scarto di quantità può dipendere da lotti iniziali mancanti, movimenti omessi o dati errati; non certifica quanto fosse realmente posseduto all'apertura.

Accanto a ogni crypto con saldo insufficiente, **Aggiungi un lotto di…** apre il modulo dei lotti conservando file, pagina, classificazioni e rettifiche già salvate. È precompilato soltanto l'asset: quantità, data originaria e costo devono essere inseriti dalla documentazione, con un lotto distinto per ogni acquisto originario. Una rettifica di riga ancora aperta va prima salvata o annullata.

**Salva e ricalcola** nel modulo del lotto aggiorna subito la sessione e il controllo dei saldi. Il lotto resta nella sessione anche annullando poi l'importazione; **Annulla** nel modulo del lotto non aggiunge nulla. L'importazione delle operazioni rimane un'azione separata, applicata soltanto con **Importa e ricalcola**. Chiudere la finestra di importazione elimina le scelte non ancora applicate della revisione.

La validazione del motore resta obbligatoria: date fuori dal 2025–2026, operazioni precedenti all'apertura, cessioni superiori alle quantità disponibili, duplicati e dati fiscali mancanti impediscono l'applicazione del CSV. Un errore non sostituisce le operazioni della sessione; gli errori del motore riferiti a operazioni importate riportano la riga della fonte originale, comprese le eventuali cessioni separate per commissioni.

## Export e privacy

Dopo l'importazione, **Esporta dati** produce il CSV CriptoConti versione 2. Il campo `dati_estesi` conserva il controvalore totale esatto, i dati della permuta o del provento, tutte le 17 colonne originali e le decisioni di conversione. Le rettifiche normalizzate restano distinte dalla fonte; non è necessario ricaricare l'originale exchange a ogni sessione se si dispone di questo export completo.

I file e le scelte restano nella memoria della pagina: non sono trasmessi a un servizio fiscale, non vengono usati cookie e non esiste salvataggio automatico. Chiudendo o ricaricando la pagina si perde ciò che non è stato esportato. Il CSV v2 contiene anche gli eventuali indirizzi e metadati originali: conservarlo sul proprio dispositivo.

Le regole fiscali, i limiti e le fonti sono descritti in [FISCALITA.md](FISCALITA.md); il contratto ricaricabile è in [CSV.md](CSV.md). La situazione iniziale può essere importata anche dal tracciato Excel descritto in [EXCEL-INIZIALE.md](EXCEL-INIZIALE.md), mantenendo aperta la verifica del CSV. Dopo la conferma dell'Excel, i lotti sono già aggiornati nella sessione; il CSV delle operazioni richiede ancora la propria conferma.
