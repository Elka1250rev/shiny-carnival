# Regole fiscali supportate

Il calcolatore riguarda **persone fisiche residenti in Italia, fuori dall'attività d'impresa, in regime dichiarativo**, che acquistano o vendono cripto-attività ordinarie contro euro. Il risultato è una stima basata sui dati forniti: non certifica la correttezza della documentazione, della categoria fiscale dell'asset o della dichiarazione.

## Annualità

| Anno dell'operazione | Aliquota ordinaria | Soglia di esenzione |
| --- | --- | --- |
| 2025 | 26% | Nessuna |
| 2026 | 33% | Nessuna |

Il motore accetta transazioni soltanto per queste annualità. La situazione iniziale deve avere una data nel 2025 o nel 2026 e le transazioni devono essere successive o coincidenti con quella data. Le date originarie dei lotti iniziali possono appartenere ad anni precedenti.

Per stimare l'imposta dell'intero anno, occorre includere tutte le operazioni dal 1° gennaio. Un'apertura successiva produce un riepilogo parziale; i lotti iniziali ricostruiscono le disponibilità ma non le plusvalenze o minusvalenze realizzate prima dell'apertura.

Le modifiche delle aliquote e l'eliminazione della soglia a partire dal 2025 derivano dalla legge 207/2024. La legge 199/2025 ha previsto una disciplina specifica per determinati token di moneta elettronica denominati in euro: questa categoria è esclusa dalla prima versione. L'applicazione non individua le categorie fiscali dal nome dell'asset.

## Prezzo medio gestionale e LIFO fiscale

Il portafoglio mostra un prezzo medio ponderato gestionale:

```text
nuovo costo gestionale = costo gestionale precedente + quantità acquistata × prezzo unitario + commissioni
nuovo prezzo medio = nuovo costo gestionale / nuova quantità
```

Una vendita riduce il costo gestionale in proporzione alle unità vendute e lascia invariato il prezzo medio delle unità residue. Quando la quantità arriva a zero, il prezzo medio non è definito.

Per il risultato fiscale viene applicato il **LIFO** descritto dalla circolare dell'Agenzia delle Entrate 30/E/2023, paragrafo 3.2.1: si considerano cedute per prime le unità acquistate più recentemente. Per questo il costo fiscale della vendita può differire dal costo calcolato usando la media gestionale.

```text
ricavo netto = quantità venduta × prezzo unitario − commissioni della vendita
risultato fiscale = ricavo netto − costo dei lotti consumati in LIFO
```

Le commissioni dell'acquisto concorrono al costo del nuovo lotto. Le commissioni storiche dei lotti iniziali devono essere già incluse nel loro costo unitario. La prima versione gestisce soltanto commissioni espresse e pagate in euro.

Esempio senza commissioni: acquistare 1 BTC a 30.000 euro, poi 1 BTC a 50.000 euro, produce un prezzo medio di 40.000 euro. Vendere successivamente 1 BTC a 60.000 euro produce una plusvalenza fiscale LIFO di 10.000 euro. La media gestionale del BTC residuo resta 40.000 euro; il suo lotto fiscale ha costo 30.000 euro.

## Situazione iniziale e documentazione

Ogni lotto iniziale rappresenta una quantità ancora disponibile alla data di apertura, con la sua **data originaria di acquisto** e il costo unitario riconosciuto. Se un lotto è stato parzialmente venduto prima dell'apertura, va indicata soltanto la quantità residua.

Un saldo unico con prezzo medio non permette di ricostruire automaticamente il LIFO. L'utente deve disporre dei lotti e della documentazione dei costi: il software non riconosce automaticamente rivalutazioni fiscali, successioni, donazioni o costi mancanti. Un'operazione antecedente alla situazione iniziale non va inserita di nuovo tra le transazioni del periodo.

L'ordine delle operazioni dello stesso giorno deve riflettere la loro sequenza effettiva. Una vendita superiore alla disponibilità produce un errore; non vengono simulati saldi negativi o vendite allo scoperto.

I lotti della situazione iniziale precedono tutte le operazioni inserite, anche quando la data originaria di acquisto coincide con la data di apertura. La sequenza dei lotti iniziali ordina soltanto quei lotti per asset e data; la sequenza delle operazioni è distinta e può ripartire da 1. Per esempio, con un lotto iniziale acquistato nella data di apertura a 100 euro e un nuovo acquisto nella stessa data a 200 euro, la vendita successiva utilizza per primo il nuovo acquisto da 200 euro, qualunque sia la sequenza assegnata al lotto iniziale.

## Minusvalenze e compensazione

Il motore somma algebricamente le plusvalenze e le minusvalenze del periodo. Compensa un saldo positivo con le minusvalenze della stessa categoria fiscale, già dichiarate e ancora utilizzabili, partendo da quelle che scadono prima.

Le minusvalenze pregresse richiedono l'anno di origine e **l'importo residuo dichiarato e disponibile alla data di apertura**. Sono utilizzabili entro i quattro periodi d'imposta successivi all'anno di origine. Per esempio, una minusvalenza del 2022 può essere utilizzata fino al 2026; una del 2021 è scaduta nel 2026. L'applicazione esclude dal calcolo le perdite scadute e le segnala.

Per le annualità fino al 2024, l'eventuale requisito storico dell'eccedenza di minusvalenze superiore a 2.000 euro riguarda la perdita originaria dichiarata. Un residuo disponibile oggi può essere inferiore a 2.000 euro: il motore non lo elimina per questo motivo. L'utente deve verificare la provenienza e l'effettiva disponibilità del credito fiscale.

Un saldo negativo del periodo viene mostrato come perdita potenzialmente riportabile. Il suo utilizzo futuro dipende dalla corretta dichiarazione; il software non la presenta né registra alcun credito presso l'Agenzia delle Entrate. Le perdite di altre categorie di redditi finanziari non sono accettate come minusvalenze pregresse crypto.

L'imposta stimata è il saldo imponibile non negativo moltiplicato per l'aliquota dell'anno. L'aritmetica interna è esatta; l'importo finale è arrotondato ai centesimi, con metà centesimo arrotondato verso l'alto.

## Operazioni e obblighi esclusi

Non sono gestiti permute fra crypto, proventi da staking, lending o DeFi, derivati, NFT, donazioni, successioni, rivalutazioni e trattamenti speciali dei token di moneta elettronica in euro. Sono esclusi il monitoraggio fiscale, i quadri dichiarativi e l'imposta sul valore o sul possesso delle cripto-attività. L'importo stimato riguarda esclusivamente l'imposta sui risultati delle compravendite supportate.

## Fonti

- [Agenzia delle Entrate, circolare 30/E del 27 ottobre 2023](https://www.agenziaentrate.gov.it/portale/documents/20143/5589638/Circolare+criptoattivita+del+27+ottobre+2023.pdf/1154a95a-80ea-a6ec-bcc0-731b844db9e6): disciplina delle cripto-attività; LIFO nel regime dichiarativo al paragrafo 3.2.1.
- [Legge 30 dicembre 2024, n. 207](https://www.normattiva.it/uri-res/N2Ls?urn:nir:stato:legge:2024-12-30;207): modifiche alle aliquote e alla soglia.
- [Legge 30 dicembre 2025, n. 199](https://www.normattiva.it/eli/id/2025/12/30/25G00212/ORIGINAL): disciplina relativa ai token di moneta elettronica denominati in euro.
- [Agenzia delle Entrate, quadro T](https://infoprecompilata.agenziaentrate.gov.it/portale/web/guest/quadro-t): indicazioni dichiarative, soglia e compensazione delle minusvalenze.

L'implementazione è limitata alle regole descritte qui. Un nuovo anno fiscale o un nuovo tipo di operazione richiede un aggiornamento esplicito del motore e della documentazione.
