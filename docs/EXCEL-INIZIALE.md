# Situazione iniziale da Excel

**Importa situazione iniziale da Excel** è disponibile nella sezione **Situazione iniziale** e nella verifica del CSV della piattaforma. Legge file `.xlsx` sul dispositivo, senza invii in rete, cookie, archiviazione persistente o dipendenze esterne. Non importa operazioni da Excel. Non supporta `.xls`, `.xlsm`, file cifrati o macro.

## Tabella riconosciuta

| Colonna | Uso |
| --- | --- |
| `CRIPTOVALUTA` | Identificatore dell'asset, normalizzato in maiuscolo. Non ne certifica la natura fiscale. |
| `TOTALE CRIPTO` | Quantità residua riportata nel file, da verificare esplicitamente. |
| `CRIPTO/EURO` | Valore unitario di significato da confermare: prezzo di mercato, costo medio o costo unitario di un singolo lotto. Non diventa automaticamente costo fiscale. |
| `EURO` | Totale informativo salvato nel file, anche se risultato di una formula. Non ricostruisce il costo fiscale. |

Le intestazioni possono essere precedute da note e righe vuote; sono cercate nei primi 100 record non vuoti, anche in ordine diverso. Viene cercata prima una riga contenente tutte e quattro le intestazioni: un titolo con la sola parola `CRIPTOVALUTA` non nasconde l'intestazione completa sottostante. Colonne mancanti, duplicate o sconosciute bloccano la lettura. Le righe sono ordinate secondo il loro numero Excel, anche se gli elementi XML del file sono fuori ordine. Ogni riga successiva deve essere una posizione; sono riconosciute separatamente le righe con asset vuoto e dicitura `TOTALE VALORE CRIPTO IN EURO:`. Righe ambigue non vengono scartate. La scelta fra più fogli è esplicita, inclusi eventuali fogli nascosti. Cambiare foglio ricomincia la verifica delle date e dei lotti; deselezionarlo disabilita la conferma.

## Data richiesta esplicitamente

La **Data della situazione** parte vuota. Il nome del file e le note del foglio non la impostano. Occorre scegliere anche il **Momento della giornata**:

- saldi all'inizio della giornata: apertura nella stessa data;
- saldi alla fine della giornata: apertura all'inizio del giorno successivo.

Esempio: saldi alla fine del **31 dicembre 2024** diventano disponibilità all'apertura del **1° gennaio 2025**. Il sito continua a calcolare soltanto il 2025 e il 2026; l'apertura risultante deve essere in questi anni. Non viene aggiunta una disciplina fiscale per il 2024.

La data dei saldi non è la data originaria di acquisto. Per i lotti documentati la data originaria va inserita; nella modalità a prezzo medio stimato rimane non disponibile. Nessun acquisto viene datato automaticamente al 31 dicembre o al giorno di apertura.

## Prezzo medio storico stimato e modifica successiva

Per il tracciato è preimpostata l’ipotesi autorizzata **prezzo medio storico stimato**: `CRIPTO/EURO` precompila il costo unitario di un saldo aggregato per crypto, sempre modificabile nell’anteprima. La conferma deve indicare consapevolmente l’uso della stima. La riga EUR è prequalificata come liquidità informativa e viene mostrata separatamente.

Il saldo stimato viene registrato senza inventare una data originaria: `acquiredOn` è vuoto e `basisMethod` vale `estimated_average`. Non può coesistere con altri lotti iniziali della stessa crypto; per suddividerlo occorre ricostruire i lotti documentati. Gli acquisti successivi sono considerati più recenti del saldo iniziale. Per le porzioni iniziali si usa il prezzo medio confermato: i singoli lotti LIFO storici non sono ricostruiti e risultati e imposta sono indicativi. L’avvertenza compare nella pagina e nel PDF, anche dopo un ripristino CSV.

Dopo l’importazione, aprire **Situazione iniziale → Modifica** sulla crypto per cambiare il prezzo medio stimato o la quantità. La modifica ricalcola le operazioni e l’imposta e resta segnalata come stima. Se si ottiene la documentazione, è possibile scegliere **Lotto documentato**, inserire una data originaria effettiva e il costo riconosciuto; per più acquisti vanno inseriti i singoli lotti con i dati reali. Non viene scelta una data di comodo.

Il CSV ricaricabile versione 2 conserva anche la natura stimata: nelle righe `iniziale`, `dati_estesi` contiene `{"basisMethod":"estimated_average"}` e `data_acquisto_originale` resta vuota. La versione 1 non ammette questo caso. La modifica successiva e il ripristino non perdono la segnalazione della stima.

## Costi e lotti documentati

Un saldo aggregato e un valore di mercato non ricostruiscono i lotti LIFO. Per ogni posizione inserire i singoli acquisti originari ancora disponibili, con quantità residua, data e costo unitario fiscale documentato, esclusi commissioni e oneri accessori. La somma dei lotti deve coincidere esattamente con la quantità totale confermata per quella riga.

Se `CRIPTO/EURO` è stato esplicitamente qualificato come **costo unitario storico di un unico lotto per riga**, un pulsante permette di copiarlo nel costo di quel lotto. La copia non è automatica. Se si torna a un'altra interpretazione o si suddivide la riga in più lotti, i costi copiati da quella colonna vengono rimossi e vanno documentati singolarmente. I costi inseriti manualmente restano disponibili. Un costo pari a zero deve essere esplicitamente inserito e confermato.

Le formule non vengono eseguite. Le quantità devono essere numeri espliciti o testo numerico: valori logici VERO/FALSO, errori Excel, celle di tipo data e formule non vengono convertiti in quantità, neppure se il valore interno è `1` o `0`. Per precompilare o copiare `CRIPTO/EURO` valgono gli stessi controlli: una cella non utilizzabile lascia il costo vuoto e richiede un inserimento manuale verificato. I valori salvati delle formule della colonna `EURO` e dei totali restano informativi e potrebbero essere obsoleti.

La riga `EUR` richiede una conferma esplicita che rappresenti liquidità in euro. Viene mostrata nell'anteprima, esclusa dai lotti crypto e dal calcolo e non viene conservata nel CSV della sessione. Se rappresenta altro, correggere il tracciato prima di confermare. Un prospetto composto solo da liquidità o posizioni nulle può impostare lotti vuoti, con le conferme richieste e la convalida delle operazioni esistenti.

## Precisione e limiti

I valori numerici XML vengono mantenuti come stringhe. La notazione scientifica è espansa senza passare per numeri JavaScript; la formattazione visiva delle celle non arrotonda i dati. Excel può conservare cifre diverse da quelle mostrate: verificare quantità e costi. Per correggere una quantità, modificare esplicitamente il totale confermato e i lotti; il dato originale viene mostrato nell'anteprima. I valori di calcolo ammettono 30 cifre intere e 18 decimali: ulteriori cifre richiedono una correzione documentata, senza tagli automatici.

Limiti del lettore: 5 MiB compressi, 20 MiB decompressi, 256 elementi ZIP, 20 fogli, 10.000 righe XML per foglio incluse quelle vuote, 30.000 celle per foglio, 64 colonne. Numeri di riga duplicati o oltre il limite Excel di 1.048.576 e tipi di cella sconosciuti sono respinti. Il modello consente sempre al massimo 5.000 record complessivi fra lotti, operazioni e minusvalenze; anche il CSV completo deve restare entro 5 MiB. La decompressione usa `DecompressionStream` locale: il browser deve supportare `deflate-raw`.

## Conferma, annullamento ed esportazione

Il pulsante finale si abilita solo dopo le scelte esplicite, la riconciliazione dei lotti e la validazione del motore. La conferma **sostituisce tutti i lotti iniziali e aggiorna la data di apertura**, conservando operazioni e minusvalenze della sessione. Se i nuovi saldi non rendono valide queste operazioni, il file non viene applicato. Annullare la verifica, selezionare un file non valido o chiudere durante la lettura non applica dati alla sessione. Solo l'ultimo file selezionato nell'anteprima corrente può diventare importabile: una lettura precedente completata in ritardo viene ignorata anche dopo la chiusura e riapertura della finestra.

Se l'Excel viene aperto dalla verifica del CSV della piattaforma, quella verifica resta aperta e conserva classificazioni e rettifiche già salvate. Dopo la conferma dell'Excel, la sessione contiene subito i nuovi lotti; le operazioni del CSV richiedono ancora la propria conferma separata. Una rettifica CSV aperta deve essere salvata o annullata prima di aprire l'Excel.

Dopo la conferma usare **Esporta dati**: il CSV ricaricabile conserva apertura e lotti importati con le date, quantità e costi confermati e l’eventuale segnalazione di costo medio stimato. Note, valori informativi, formule, prezzi di mercato e liquidità EUR dell'Excel non fanno parte del dataset fiscale esportato: conservare anche il prospetto originale. Le rettifiche dell'anteprima annullata non vengono conservate.
