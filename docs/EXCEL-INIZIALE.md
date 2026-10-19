# Situazione iniziale da Excel

**Importa situazione iniziale da Excel** è disponibile nella sezione **Situazione iniziale** e nella verifica del CSV della piattaforma. Legge file `.xlsx` sul dispositivo, senza invii in rete, cookie, archiviazione persistente o dipendenze esterne. Non importa operazioni da Excel. Non supporta `.xls`, `.xlsm`, file cifrati o macro.

## Tabella riconosciuta

| Colonna | Uso |
| --- | --- |
| `CRIPTOVALUTA` | Identificatore dell'asset, normalizzato in maiuscolo. Non ne certifica la natura fiscale. |
| `TOTALE CRIPTO` | Quantità residua riportata nel file, da verificare esplicitamente. |
| `CRIPTO/EURO` | Valore unitario di significato da confermare: prezzo di mercato, costo medio o costo unitario di un singolo lotto. Non diventa automaticamente costo fiscale. |
| `EURO` | Totale informativo salvato nel file, anche se risultato di una formula. Non ricostruisce il costo fiscale. |

Le intestazioni possono essere precedute da note e righe vuote; sono cercate nei primi 100 record non vuoti, anche in ordine diverso. Colonne mancanti, duplicate o sconosciute bloccano la lettura. Ogni riga successiva deve essere una posizione; sono riconosciute separatamente le righe con asset vuoto e dicitura `TOTALE VALORE CRIPTO IN EURO:`. Righe ambigue non vengono scartate. La scelta fra più fogli è esplicita, inclusi eventuali fogli nascosti. Cambiare foglio ricomincia la verifica delle date e dei lotti.

## Data richiesta esplicitamente

La **Data della situazione** parte vuota. Il nome del file e le note del foglio non la impostano. Occorre scegliere anche il **Momento della giornata**:

- saldi all'inizio della giornata: apertura nella stessa data;
- saldi alla fine della giornata: apertura all'inizio del giorno successivo.

Esempio: saldi alla fine del **31 dicembre 2024** diventano disponibilità all'apertura del **1° gennaio 2025**. Il sito continua a calcolare soltanto il 2025 e il 2026; l'apertura risultante deve essere in questi anni. Non viene aggiunta una disciplina fiscale per il 2024.

La data dei saldi non è la data originaria di acquisto. Quest'ultima va inserita per ogni lotto: nessun acquisto viene datato automaticamente al 31 dicembre o al giorno di apertura.

## Costi e lotti

Un saldo aggregato e un valore di mercato non ricostruiscono i lotti LIFO. Per ogni posizione inserire i singoli acquisti originari ancora disponibili, con quantità residua, data e costo unitario fiscale documentato, esclusi commissioni e oneri accessori. La somma dei lotti deve coincidere esattamente con la quantità totale confermata per quella riga.

Se `CRIPTO/EURO` è stato esplicitamente qualificato come **costo unitario storico di un unico lotto per riga**, un pulsante permette di copiarlo nel costo di quel lotto. La copia non è automatica. Se si torna a un'altra interpretazione o si suddivide la riga in più lotti, i costi copiati da quella colonna vengono rimossi e vanno documentati singolarmente. I costi inseriti manualmente restano disponibili. Un costo pari a zero deve essere esplicitamente inserito e confermato.

Le formule non vengono eseguite. In quantità sono richiesti valori espliciti, senza formule; nella colonna dei costi il pulsante di copia non accetta formule, per le quali il costo va inserito manualmente. I valori salvati delle formule della colonna `EURO` e dei totali restano informativi e potrebbero essere obsoleti.

La riga `EUR` richiede una conferma esplicita che rappresenti liquidità in euro. Viene mostrata nell'anteprima, esclusa dai lotti crypto e dal calcolo e non viene conservata nel CSV della sessione. Se rappresenta altro, correggere il tracciato prima di confermare. Un prospetto composto solo da liquidità o posizioni nulle può impostare lotti vuoti, con le conferme richieste e la convalida delle operazioni esistenti.

## Precisione e limiti

I valori numerici XML vengono mantenuti come stringhe. La notazione scientifica è espansa senza passare per numeri JavaScript; la formattazione visiva delle celle non arrotonda i dati. Excel può conservare cifre diverse da quelle mostrate: verificare quantità e costi. Per correggere una quantità, modificare esplicitamente il totale confermato e i lotti; il dato originale viene mostrato nell'anteprima. I valori di calcolo ammettono 30 cifre intere e 18 decimali: ulteriori cifre richiedono una correzione documentata, senza tagli automatici.

Limiti del lettore: 5 MiB compressi, 20 MiB decompressi, 256 elementi ZIP, 20 fogli, 10.000 righe e 30.000 celle per foglio, 64 colonne. Il modello consente sempre al massimo 5.000 record complessivi fra lotti, operazioni e minusvalenze; anche il CSV completo deve restare entro 5 MiB. La decompressione usa `DecompressionStream` locale: il browser deve supportare `deflate-raw`.

## Conferma, annullamento ed esportazione

Il pulsante finale si abilita solo dopo le scelte esplicite, la riconciliazione dei lotti e la validazione del motore. La conferma **sostituisce tutti i lotti iniziali e aggiorna la data di apertura**, conservando operazioni e minusvalenze della sessione. Se i nuovi saldi non rendono valide queste operazioni, il file non viene applicato. Annullare la verifica, selezionare un file non valido o chiudere durante la lettura non applica dati alla sessione.

Se l'Excel viene aperto dalla verifica del CSV della piattaforma, quella verifica resta aperta e conserva classificazioni e rettifiche già salvate. Dopo la conferma dell'Excel, la sessione contiene subito i nuovi lotti; le operazioni del CSV richiedono ancora la propria conferma separata. Una rettifica CSV aperta deve essere salvata o annullata prima di aprire l'Excel.

Dopo la conferma usare **Esporta dati**: il CSV ricaricabile conserva apertura e lotti importati con le date, quantità e costi confermati. Note, valori informativi, formule, prezzi di mercato e liquidità EUR dell'Excel non fanno parte del dataset fiscale esportato: conservare anche il prospetto originale. Le rettifiche dell'anteprima annullata non vengono conservate.
