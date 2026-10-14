# pdf-lib

`pdf-lib.esm.min.js` è la distribuzione ESM originale di **pdf-lib 1.17.1**,
inclusa localmente per generare i PDF nel browser anche senza supporto alla stampa.

- Progetto: https://github.com/Hopding/pdf-lib
- Pacchetto: https://www.npmjs.com/package/pdf-lib/v/1.17.1
- Licenza MIT: `pdf-lib.LICENSE.md`
- SHA-256: `72c052d97b4d5d9fa6cdbdcb7ad709f03d4ddb1122390cb3afeba4d88651d969`

Il file è copiato senza modifiche da `pdf-lib@1.17.1/dist/pdf-lib.esm.min.js`.
Viene caricato dal sito soltanto alla prima esportazione PDF, senza CDN o servizi
di conversione. I dati sono passati in memoria a `PDFDocument.create`, ai font
standard inclusi e, per i nomi Unicode, a immagini PNG create da canvas locali.
Non vengono usate le funzioni della libreria che accettano URL esterni.
La CSP del sito mantiene `connect-src 'none'`.

Per aggiornare la dipendenza, sostituire il file e la licenza, aggiornare versione
e checksum anche in `scripts/check.mjs`, ed eseguire i test dei PDF scaricati.
