const MAX_BYTES = 5 * 1024 * 1024;

function error(line, message) {
  return new Error(`Riga ${line}: ${message}`);
}

/** Read CSV records without interpreting their columns or decimal values. */
export function readCsvRecords(text, { delimiter = ';', maxRecords = 5002 } = {}) {
  if (delimiter !== ';' && delimiter !== ',') {
    throw error(1, 'il separatore CSV deve essere una virgola o un punto e virgola.');
  }
  if (!Number.isSafeInteger(maxRecords) || maxRecords < 0) {
    throw error(1, 'il limite di record deve essere un intero non negativo.');
  }
  if (typeof text !== 'string') throw error(1, 'il contenuto CSV deve essere testo.');
  if (new TextEncoder().encode(text).byteLength > MAX_BYTES) {
    throw error(1, 'il file supera il limite di 5 MiB.');
  }
  const source = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
  const records = [];
  let fields = [];
  let value = '';
  let state = 'plain';
  let line = 1;
  let recordLine = 1;
  let touched = false;

  function finishRecord() {
    if (touched || fields.length || value.length) {
      fields.push(value);
      records.push({ fields, line: recordLine });
      if (records.length > maxRecords) {
        throw error(recordLine, 'il file supera il limite di 5000 record di dati.');
      }
    }
    fields = [];
    value = '';
    state = 'plain';
    touched = false;
  }

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (state === 'quoted') {
      if (character === '"') {
        if (source[index + 1] === '"') {
          value += '"';
          index += 1;
        } else state = 'closed';
      } else if (character === '\r' || character === '\n') {
        value += character;
        if (character === '\r' && source[index + 1] === '\n') {
          value += '\n';
          index += 1;
        }
        line += 1;
      } else value += character;
      continue;
    }
    if (character === delimiter) {
      fields.push(value);
      value = '';
      state = 'plain';
      touched = true;
    } else if (character === '\r' || character === '\n') {
      finishRecord();
      if (character === '\r' && source[index + 1] === '\n') index += 1;
      line += 1;
      recordLine = line;
    } else if (state === 'closed') {
      throw error(line, 'carattere inatteso dopo la chiusura delle virgolette.');
    } else if (character === '"') {
      if (value.length) throw error(line, 'virgolette inattese in un campo non racchiuso tra virgolette.');
      state = 'quoted';
      touched = true;
    } else {
      value += character;
      touched = true;
    }
  }
  if (state === 'quoted') throw error(recordLine, 'campo con virgolette non chiuse.');
  finishRecord();
  return records;
}
