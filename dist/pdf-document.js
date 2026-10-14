import { PDFDocument, PDFHexString, PDFName, PDFOperator, StandardFonts, rgb } from './vendor/pdf-lib.esm.min.js';

const PAGE = [841.89, 595.28];
const MARGIN = 34;
const BOTTOM = 42;
const WIDTH = PAGE[0] - MARGIN * 2;
const INK = rgb(0.14, 0.19, 0.13);
const MUTED = rgb(0.34, 0.38, 0.32);
const GREEN = rgb(0.22, 0.34, 0.16);
const PALE = rgb(0.95, 0.97, 0.93);
const LINE = rgb(0.81, 0.85, 0.78);
const normalized = value => String(value ?? '').replace(/\u2212/g, '-').replace(/\r\n?/g, '\n');

/** Create a local PDF with selectable text. The optional document supplies Unicode glyphs. */
export async function buildPdfDocument(report, { document } = {}) {
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  pdf.setTitle(normalized(report.title));
  pdf.setAuthor('CriptoConti');
  pdf.setSubject('Riepilogo delle operazioni e dei risultati fiscali della sessione');
  pdf.setLanguage('it-IT');
  const images = new Map();
  const supported = new Map();
  let measureContext;
  let page;
  let cursor;

  const fontFor = isBold => isBold ? bold : regular;
  const supports = text => {
    if (!supported.has(text)) {
      try { regular.encodeText(text); supported.set(text, true); }
      catch { supported.set(text, false); }
    }
    return supported.get(text);
  };
  const canvasContext = () => {
    if (!measureContext) {
      if (!document?.createElement) throw new Error('Per esportare i nomi Unicode delle crypto è necessario un browser con supporto canvas.');
      measureContext = document.createElement('canvas').getContext('2d');
      if (!measureContext) throw new Error('Il browser non permette di disegnare i nomi Unicode nel PDF.');
    }
    return measureContext;
  };
  const canvasFont = (size, isBold) => `${isBold ? 'bold ' : ''}${size}px Arial, "Noto Sans CJK SC", sans-serif`;
  const measure = (text, size, isBold) => {
    if (supports(text)) return fontFor(isBold).widthOfTextAtSize(text, size);
    const context = canvasContext();
    context.font = canvasFont(size, isBold);
    return context.measureText(text).width;
  };

  // Break long identifiers and amounts by code point, never discard digits or append ellipses.
  const wrap = (value, width, size, isBold = false) => normalized(value).split('\n').flatMap(paragraph => {
    if (!paragraph) return [''];
    const lines = [];
    let line = '';
    for (const word of paragraph.split(/(\s+)/).filter(Boolean)) {
      if (measure(line + word, size, isBold) <= width) { line += word; continue; }
      if (line.trim()) { lines.push(line.trimEnd()); line = ''; }
      if (!word.trim()) continue;
      for (const character of word) {
        if (line && measure(line + character, size, isBold) > width) { lines.push(line); line = ''; }
        line += character;
      }
    }
    if (line.trim()) lines.push(line.trimEnd());
    return lines.length ? lines : [''];
  });

  const beginText = text => page.pushOperators(PDFOperator.of('BDC', [
    PDFName.of('Span'), pdf.context.obj({ ActualText: PDFHexString.fromText(normalized(text)) })
  ]));
  const endText = () => page.pushOperators(PDFOperator.of('EMC'));

  const drawLine = async (text, x, baseline, size, isBold = false, color = INK) => {
    if (!text) return;
    if (supports(text)) {
      page.drawText(text, { x, y: baseline, font: fontFor(isBold), size, color });
      return;
    }
    // Only unsupported labels are images. /ActualText preserves their original Unicode text.
    const key = JSON.stringify([text, size, isBold]);
    let rendered = images.get(key);
    if (!rendered) {
      const context = canvasContext();
      context.font = canvasFont(size, isBold);
      const metrics = context.measureText(text);
      const ascent = Math.max(size, metrics.actualBoundingBoxAscent || 0);
      const descent = Math.max(size * 0.3, metrics.actualBoundingBoxDescent || 0);
      const left = Math.max(0, metrics.actualBoundingBoxLeft || 0);
      const right = Math.max(metrics.width, metrics.actualBoundingBoxRight || 0);
      const padding = 1;
      const width = left + right + padding * 2;
      const height = ascent + descent + padding * 2;
      const canvas = document.createElement('canvas');
      const scale = 3;
      canvas.width = Math.ceil(width * scale);
      canvas.height = Math.ceil(height * scale);
      const drawing = canvas.getContext('2d');
      if (!drawing) throw new Error('Il browser non permette di disegnare i nomi Unicode nel PDF.');
      drawing.scale(scale, scale);
      drawing.font = canvasFont(size, isBold);
      drawing.fillStyle = '#243021';
      drawing.textBaseline = 'alphabetic';
      drawing.fillText(text, left + padding, ascent + padding);
      const data = canvas.toDataURL('image/png').split(',')[1];
      if (!data) throw new Error('Non è stato possibile disegnare i nomi Unicode nel PDF.');
      const bytes = Uint8Array.from(atob(data), character => character.charCodeAt(0));
      rendered = { image: await pdf.embedPng(bytes), width: canvas.width / scale, height: canvas.height / scale, left: left + padding, descent: descent + padding };
      images.set(key, rendered);
    }
    page.drawImage(rendered.image, {
      x: x - rendered.left, y: baseline - rendered.descent,
      width: rendered.width, height: rendered.height
    });
  };

  const newPage = () => {
    page = pdf.addPage(PAGE);
    page.drawText('CriptoConti', { x: MARGIN, y: PAGE[1] - 27, size: 8, font: bold, color: GREEN });
    page.drawLine({ start: { x: MARGIN, y: PAGE[1] - 33 }, end: { x: PAGE[0] - MARGIN, y: PAGE[1] - 33 }, thickness: 0.5, color: LINE });
    cursor = PAGE[1] - 49;
  };
  const ensure = height => { if (cursor - height < BOTTOM) newPage(); };
  const textBlock = async (value, { size = 9, isBold = false, color = INK, gap = 6, width = WIDTH, x = MARGIN, keepWithNext = 0 } = {}) => {
    const text = normalized(value);
    const lines = wrap(text, width, size, isBold);
    const leading = size * 1.35;
    if (lines.length * leading + keepWithNext <= PAGE[1] - 49 - BOTTOM) ensure(lines.length * leading + keepWithNext);
    // Start a marked span on each page, so no marked-content operator crosses a page boundary.
    let start = 0;
    while (start < lines.length) {
      ensure(leading);
      const count = Math.min(lines.length - start, Math.floor((cursor - BOTTOM) / leading));
      const part = lines.slice(start, start + count);
      beginText(start === 0 && count === lines.length ? text : part.join('\n'));
      for (const line of part) { await drawLine(line, x, cursor - size, size, isBold, color); cursor -= leading; }
      endText();
      start += count;
    }
    cursor -= gap;
  };
  const heading = (text, small = false) => textBlock(text, { size: small ? 10 : 12, isBold: true, color: GREEN, gap: 7, keepWithNext: 30 });

  newPage();
  await textBlock(report.title, { size: 19, isBold: true, color: GREEN, gap: 10 });
  for (const item of report.header) await textBlock(item, { size: 8.5, color: MUTED, gap: 4 });
  cursor -= 6;
  await heading(report.summaryTitle);
  for (const item of report.scope) await textBlock(item, { size: 8, color: MUTED, gap: 5 });

  const cardWidth = WIDTH / 3;
  for (let start = 0; start < report.summary.length; start += 3) {
    const cards = report.summary.slice(start, start + 3).map(item => ({
      ...item, labels: wrap(item.label, cardWidth - 18, 8), values: wrap(item.value, cardWidth - 18, 11, true)
    }));
    const height = Math.max(...cards.map(item => item.labels.length * 10 + item.values.length * 14 + 15));
    ensure(height);
    for (let index = 0; index < cards.length; index++) {
      const item = cards[index];
      const x = MARGIN + index * cardWidth;
      page.drawRectangle({ x, y: cursor - height, width: cardWidth - 4, height: height - 4, color: PALE });
      let baseline = cursor - 15;
      beginText(item.label);
      for (const line of item.labels) { await drawLine(line, x + 7, baseline, 8, false, MUTED); baseline -= 10; }
      endText();
      baseline -= 3;
      beginText(item.value);
      for (const line of item.values) { await drawLine(line, x + 7, baseline, 11, true, GREEN); baseline -= 14; }
      endText();
    }
    cursor -= height;
  }
  cursor -= 10;
  if (report.warnings.length) {
    await heading('Avvertenze del calcolo', true);
    for (const warning of report.warnings) await textBlock('• ' + warning, { size: 8.5 });
  }

  if (report.rows.length) {
    await heading('Tutte le operazioni della sessione');
    const proportions = [73, 76, 56, 116, 85, 109, 119, 140];
    const widths = proportions.map(width => width * WIDTH / 774);
    const size = 8.2;
    const leading = 10.7;
    const padding = 6;
    const headers = report.columns.map((label, index) => wrap(label, widths[index] - padding * 2, 7.5, true));
    const headerHeight = Math.max(...headers.map(lines => lines.length)) * 10 + padding * 2;
    const drawHeader = async () => {
      page.drawRectangle({ x: MARGIN, y: cursor - headerHeight, width: WIDTH, height: headerHeight, color: GREEN });
      let x = MARGIN;
      for (let index = 0; index < headers.length; index++) {
        beginText(report.columns[index]);
        for (let line = 0; line < headers[index].length; line++) await drawLine(headers[index][line], x + padding, cursor - padding - 7.5 - line * 10, 7.5, true, rgb(1, 1, 1));
        endText();
        x += widths[index];
      }
      cursor -= headerHeight;
    };
    ensure(headerHeight + 40);
    await drawHeader();
    const tablePage = async () => { newPage(); await drawHeader(); };
    for (let rowIndex = 0; rowIndex < report.rows.length; rowIndex++) {
      const row = report.rows[rowIndex];
      if (row.length !== widths.length) throw new Error('Il riepilogo PDF contiene un’operazione con colonne incomplete.');
      const cells = row.map((cell, index) => wrap(cell, widths[index] - padding * 2, size));
      const lineCount = Math.max(...cells.map(lines => lines.length));
      const height = lineCount * leading + padding * 2;
      if (cursor - height < BOTTOM) await tablePage();
      let offset = 0;
      while (offset < lineCount) {
        const count = Math.min(lineCount - offset, Math.floor((cursor - BOTTOM - padding * 2) / leading));
        if (count <= 0) { await tablePage(); continue; }
        const partHeight = count * leading + padding * 2;
        if (rowIndex % 2 === 0) page.drawRectangle({ x: MARGIN, y: cursor - partHeight, width: WIDTH, height: partHeight, color: PALE });
        let x = MARGIN;
        for (let index = 0; index < cells.length; index++) {
          const part = cells[index].slice(offset, offset + count);
          if (part.length) {
            beginText(offset === 0 && count === lineCount ? row[index] : part.join('\n'));
            for (let line = 0; line < part.length; line++) {
              const lineWidth = measure(part[line], size, false);
              const textX = index >= 3 ? x + widths[index] - padding - lineWidth : x + padding;
              await drawLine(part[line], textX, cursor - padding - size - line * leading, size);
            }
            endText();
          }
          x += widths[index];
        }
        cursor -= partHeight;
        page.drawLine({ start: { x: MARGIN, y: cursor }, end: { x: PAGE[0] - MARGIN, y: cursor }, thickness: 0.35, color: LINE });
        offset += count;
        if (offset < lineCount) await tablePage();
      }
    }
    cursor -= 12;
  } else await textBlock(report.emptyNote, { size: 9 });

  for (const note of report.notes) await textBlock(note, { size: 8, color: MUTED, gap: 6 });
  for (const section of report.lossSections) {
    await heading(section.title, true);
    for (const item of section.items) await textBlock('• ' + item, { size: 8.5 });
  }
  await textBlock(report.recoveryNote, { size: 8, color: MUTED, gap: 9 });
  await heading(report.disclaimer.title, true);
  await textBlock(report.disclaimer.text, { size: 8, color: MUTED });

  const pages = pdf.getPages();
  for (let index = 0; index < pages.length; index++) {
    const label = `Pagina ${index + 1} di ${pages.length}`;
    pages[index].drawText(label, { x: PAGE[0] - MARGIN - regular.widthOfTextAtSize(label, 8), y: 22, size: 8, font: regular, color: MUTED });
  }
  return pdf.save();
}
