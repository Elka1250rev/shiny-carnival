/** Prepare a temporary report for the browser's local Save as PDF command. */
export function printPdfReport(html, title, { document, window }) {
  const report = document.getElementById('pdf-report');
  if (!report || typeof window.print !== 'function') throw new Error('La stampa PDF non è disponibile in questo browser.');
  if (document.body.classList.contains('pdf-export')) return false;
  const previousTitle = document.title;
  const cleanup = () => {
    window.removeEventListener('afterprint', cleanup);
    document.body.classList.remove('pdf-export');
    report.replaceChildren();
    report.hidden = true;
    document.title = previousTitle;
  };
  try {
    report.innerHTML = html;
    report.hidden = false;
    document.title = title;
    document.body.classList.add('pdf-export');
    window.addEventListener('afterprint', cleanup);
    window.print();
    return true;
  } catch (error) {
    cleanup();
    throw error;
  }
}
