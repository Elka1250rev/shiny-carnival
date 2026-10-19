# Regole fiscali supportate

Il calcolatore riguarda **persone fisiche residenti in Italia, fuori dall'attività d'impresa, in regime dichiarativo**. Gestisce compravendite contro euro, permute classificate esplicitamente e proventi da detenzione qualificati dall'utente. Non certifica documentazione, natura fiscale degli asset o correttezza della dichiarazione.

## Annualità e limiti

| Anno dell'operazione | Aliquota ordinaria | Soglia di esenzione |
| --- | --- | --- |
| 2025 | 26% | Nessuna |
| 2026 | 33% | Nessuna |

Il motore accetta apertura e transazioni nel 2025 o nel 2026; le transazioni non possono precedere l'apertura. Le date originarie dei lotti iniziali possono risalire ad anni precedenti. Per l'imposta di un intero anno occorrono tutte le operazioni dal 1° gennaio: un'apertura successiva produce un riepilogo parziale.

La legge 207/2024, art. 1, commi 24–25, ha introdotto il 33% dal 2026 ed eliminato la soglia di 2.000 euro dal 2025. La legge 199/2025, art. 1, comma 28, ha previsto il 26% per determinati token di moneta elettronica denominati in euro e la neutralità della mera conversione euro/token e del rimborso nominale in euro. **Questo trattamento speciale non è implementato**: non inserire tali operazioni nell'aliquota ordinaria senza verificarne la disciplina. Il ticker non identifica automaticamente la categoria fiscale.

## Commissioni: costo gestionale e costo fiscale distinti

La circolare AdE 30/E del 27 ottobre 2023, § 3.1, p. 50, interpreta l'art. 68, comma 9-bis, escludendo i costi inerenti l'acquisto e la cessione dalla determinazione dei redditi crypto. Il motore distingue quindi:

```text
nuovo costo gestionale = costo gestionale precedente + controvalore dell'acquisto + commissioni
nuovo prezzo medio gestionale = nuovo costo gestionale / nuova quantità
costo fiscale del nuovo lotto = controvalore dell'acquisto, esclusi gli oneri
risultato fiscale della vendita = corrispettivo lordo − costo fiscale dei lotti ceduti in LIFO
risultato gestionale della vendita = ricavo al netto delle commissioni − costo medio gestionale ceduto
```

Una vendita riduce proporzionalmente il costo gestionale e lascia invariato il prezzo medio delle unità residue. A saldo zero la media non è definita. Fiscalmente si consumano invece prima i lotti più recenti, secondo il LIFO descritto al § 3.2.1 della circolare.

Esempio: acquisto di 2 unità a 100 euro con 10 euro di commissioni. Il costo gestionale è 210 euro (105 per unità), quello fiscale 200 euro (100 per unità). Vendendo un'unità a 130 euro con commissione 2 si ottengono **30 euro di plusvalenza fiscale** e 23 euro di risultato gestionale. Vendendo l'altra a 90 euro con commissione 2 si ottengono **10 euro di minusvalenza fiscale** e −17 euro gestionali. Nello stesso anno il saldo fiscale è 20 euro, quello gestionale 6 euro.

Un importo effettivo già netto delle commissioni non è necessariamente il corrispettivo lordo richiesto per il calcolo fiscale. Nell'importazione exchange i valori originali restano conservati; l'utente deve verificare e, quando necessario, rettificare gli importi fiscali. Il sito non ricostruisce un lordo incerto e non applica nuovamente commissioni già comprese.

## Lotti iniziali e dati delle versioni precedenti

Ogni lotto iniziale indica quantità residua, data originaria e **costo unitario fiscale documentato, esclusi gli oneri**. Se era stato parzialmente ceduto, inserire solo il residuo. Un saldo con il solo prezzo medio non ricostruisce il LIFO. Il software non inventa costi o lotti mancanti e non riconosce automaticamente successioni, donazioni o rivalutazioni.

Le precedenti versioni chiedevano di includere le commissioni storiche nei lotti iniziali: **i file già esportati devono essere verificati e corretti manualmente** rispetto alla documentazione. La versione del CSV non permette di separare retroattivamente una commissione incorporata nel costo. Non è applicata una migrazione stimata. Lo stesso costo iniziale viene usato come base di partenza gestionale e fiscale; gli oneri storici non sono un campo separato.

L'ordine delle operazioni della stessa data deve riflettere la sequenza effettiva. I lotti iniziali precedono tutte le operazioni, anche nella data di apertura; la loro sequenza è distinta da quella delle operazioni. Una cessione superiore alla disponibilità blocca il calcolo.

## Permute tra cripto-attività

L'art. 67, comma 1, lettera c-sexies), esclude le permute **tra attività aventi eguali caratteristiche e funzioni**, non ogni scambio crypto/crypto. La circolare 30/E, § 3.1, pp. 47–49, descrive per esempio lo scambio bitcoin/ether come neutrale e l'acquisto di un NFT con criptovaluta come rilevante. Per le stablecoin distingue EMT e ART sulla base dei diritti e delle funzioni: la sola etichetta stablecoin non basta.

- **Permuta neutrale:** nessuna plusvalenza o minusvalenza al momento dello scambio. Il costo storico fiscale dei lotti ceduti viene attribuito proporzionalmente alle unità ricevute; il valore corrente EUR non rivaluta il costo. Il costo gestionale consumato viene anch'esso trasferito.
- **Permuta imponibile:** risultato pari al valore normale documentato della cripto ricevuta meno il costo fiscale LIFO ceduto. Lo stesso valore costituisce il costo del nuovo lotto ricevuto.

Per le permute neutrali il sito richiede una scelta esplicita fra conservare le date storiche dei lotti ceduti (`historical`) oppure usare la data dello scambio (`exchange`). La data incide sul LIFO successivo. **Questa scelta non è presentata come una prescrizione espressa della norma**: deve essere verificata rispetto alla fattispecie e alla documentazione, anche con il professionista. Le provenienze originarie dei lotti restano tracciate.

La classificazione nell'importatore avviene per coppia di asset e vale per le righe di quella coppia. Se la stessa coppia richiede trattamenti diversi, occorre riconciliare i dati prima dell'importazione. Non è disponibile un riconoscimento automatico di NFT, security token, EMT o altri regimi speciali.

## Premi EARN e proventi da detenzione

L'art. 68, comma 9-bis, ultimo periodo, assoggetta i proventi da detenzione a tassazione nel periodo della percezione senza deduzioni. La circolare 30/E, § 3.1, p. 51, comprende lo staking e richiede il **provento lordo**, anche se la piattaforma trattiene una commissione. I proventi in natura si valorizzano secondo l'art. 9 TUIR.

La descrizione `Receive / Reward / EARN` non dimostra la natura del reddito. L'importatore permette una qualificazione per singola riga. Un provento confermato da detenzione è imponibile alla ricezione: non è un semplice acquisto gratuito che rinvia tutta la tassazione alla vendita. Per un premio di altra natura, per esempio promozionale, può essere registrato un ingresso come acquisto con costo fiscale totale esplicitamente documentato (`documented_acquisition`). Questa registrazione non dichiara il premio esente e non calcola eventuali obblighi derivanti dalla sua diversa qualificazione. Se la natura non è verificata, non si deve completare la conversione attribuendole automaticamente quella di provento da detenzione o di acquisto gratuito.

Il **costo fiscale dei token ricevuti per le vendite future è un dato distinto dal provento imponibile**. Il sito non afferma una regola generale di costo zero né un automatico riconoscimento del valore già tassato: richiede una scelta documentata di costo zero, valore già tassato oppure costo totale per singola riga. Una conferma dell'utente non sostituisce la documentazione fiscale. Il costo gestionale del token ricevuto corrisponde al provento EUR inserito.

I depositi EUR sono conservati come movimenti informativi: non generano reddito e non costituiscono un portafoglio di liquidità usato per autorizzare gli acquisti.

## Minusvalenze e imposta

Il motore somma plusvalenze, proventi da detenzione e minusvalenze crypto del periodo, secondo la compensazione descritta dalla circolare 30/E, § 3.1, p. 50. Il requisito di proventi lordi esclude la deduzione delle loro commissioni; non viene trasformato in un'esclusione automatica dalla compensazione. Le istruzioni AdE 730/2026 riuniscono i corrispettivi da cessione, permuta e detenzione nella sezione V.

Un saldo positivo viene compensato con le minusvalenze crypto già dichiarate e ancora utilizzabili, partendo da quelle che scadono prima. Il residuo pregresso deve essere disponibile all'apertura e appartenere alla stessa categoria: non sono ammesse perdite di altre categorie finanziarie. La scadenza è il quarto periodo successivo all'origine; per esempio, una perdita 2022 è utilizzabile fino al 2026, una del 2021 è scaduta nel 2026.

Per perdite originate fino al 2024, il requisito storico dell'eccedenza di 2.000 euro riguarda la perdita originaria dichiarata. Un residuo oggi più basso non viene per questo eliminato: occorre verificarne l'effettiva disponibilità. Un saldo negativo del periodo è mostrato come perdita potenzialmente riportabile; il suo utilizzo dipende dalla corretta dichiarazione.

L'imponibile non negativo è moltiplicato per l'aliquota dell'anno. L'aritmetica interna è esatta; l'imposta finale è arrotondata ai centesimi, con metà centesimo verso l'alto. I totali EUR importati sono conservati direttamente, senza ricostruirli da prezzi unitari arrotondati.

## Esclusioni

Restano esclusi gli anni diversi dal 2025–2026, regimi speciali EMT in euro, derivati, attività d'impresa, successioni, donazioni e rivalutazioni automatiche; la classificazione di prodotti DeFi complessi o NFT richiede un'analisi specifica. L'opzione di permuta imponibile non certifica che un asset sia nel perimetro dell'art. 67, lettera c-sexies). Non sono calcolati monitoraggio, quadri dichiarativi, imposta sul valore o sul possesso e bollo.

## Fonti verificate

- [TUIR, art. 67](https://www.normattiva.it/uri-res/N2Ls?urn:nir:stato:decreto.presidente.repubblica:1986-12-22;917~art67!vig=), lettera c-sexies): fattispecie e neutralità delle permute omogenee.
- [TUIR, art. 68](https://def.finanze.it/DocTribFrontend/getAttoNormativoDetail.do?ACTION=getArticolo&articolo=Articolo+68&codiceOrdinamento=0000000000000680000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000&id=%7B31D694E8-4398-4030-873B-FEAF5A6647F9%7D), comma 9-bis: determinazione del reddito, costi documentati e proventi da detenzione.
- [TUIR, art. 9](https://www.normattiva.it/uri-res/N2Ls?urn:nir:presidente.repubblica:decreto:1986-12-22;917~art9=): valorizzazione dei proventi in natura.
- [AdE, circolare 30/E del 27 ottobre 2023, collegamento ufficiale](https://www.agenziaentrate.gov.it/portale/documents/20143/5589638/Circolare+criptoattivita+del+27+ottobre+2023.pdf); [copia del documento verificata](https://www.dirittobancario.it/wp-content/uploads/2023/10/Circolare-Agenzia-delle-Entrate-27-ottobre-2023-n.-30-E.pdf): § 3.1, pp. 47–51, e § 3.2.1 per il LIFO dichiarativo. La circolare precede le modifiche 2025–2026 a soglia e aliquota.
- [Legge 207/2024](https://www.normattiva.it/uri-res/N2Ls?urn:nir:stato:legge:2024-12-30;207), art. 1, commi 24–25; [legge 199/2025](https://www.normattiva.it/eli/id/2025/12/30/25G00212/ORIGINAL), art. 1, comma 28.
- [AdE, istruzioni 730/2026](https://www.agenziaentrate.gov.it/portale/730-2026/modello-e-istruzioni); [copia aggiornata al 13 aprile 2026](https://www.informazionefiscale.it/IMG/pdf/730_2026_istruzioni_agg_13_04_2026_1_.pdf), pp. 130–131, sezione V.

Un nuovo anno o una nuova fattispecie richiede un aggiornamento esplicito del motore e della documentazione.
