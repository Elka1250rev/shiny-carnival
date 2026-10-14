/** Keep a local PDF available for a manual download when automatic downloads are blocked. */
export function createPdfDownload({ button, link, status, container, build, URL, Blob }) {
  let generation = 0;
  let busy = false;
  let objectUrl = null;

  const clearDownload = () => {
    link.hidden = true;
    link.removeAttribute('href');
    link.removeAttribute('download');
    if (objectUrl !== null) {
      URL.revokeObjectURL(objectUrl);
      objectUrl = null;
    }
  };
  const readyButton = () => {
    busy = false;
    button.disabled = false;
    button.removeAttribute('aria-busy');
  };

  return {
    async export(report, filename) {
      if (busy) return false;
      const current = ++generation;
      busy = true;
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
      clearDownload();
      container.hidden = false;
      status.textContent = 'Preparazione del PDF in corso…';
      try {
        const bytes = await build(report);
        if (current !== generation) return false;
        objectUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
        link.href = objectUrl;
        link.download = filename;
        link.hidden = false;
        status.textContent = 'PDF pronto. Se il download non parte, tocca “Scarica il PDF”.';
        // Some mobile browsers require a second explicit tap after asynchronous generation.
        // Keep the link and its URL valid even when this automatic click is refused.
        try { link.click(); } catch { /* The visible link remains available. */ }
        return true;
      } catch (error) {
        if (current !== generation) return false;
        clearDownload();
        status.textContent = 'Impossibile preparare il PDF. Riprova.';
        throw error;
      } finally {
        if (current === generation) readyButton();
      }
    },
    reset() {
      generation += 1;
      clearDownload();
      container.hidden = true;
      status.textContent = '';
      readyButton();
    }
  };
}
