/** Only the latest file selected in the current import dialog may be applied. */
export function createImportSession(parse) {
  let revision = 0;
  let pending = null;
  return {
    get pending() { return pending; },
    reset() { revision += 1; pending = null; },
    async read(file) {
      const request = ++revision;
      pending = null;
      try {
        if (file.size > 5 * 1024 * 1024) throw new Error('Il file supera il limite di 5 MB.');
        const content = await file.text();
        if (request !== revision) return null;
        const dataset = parse(content, file.name);
        pending = dataset;
        return { dataset, name: file.name };
      } catch (error) {
        if (request !== revision) return null;
        throw error;
      }
    },
  };
}
