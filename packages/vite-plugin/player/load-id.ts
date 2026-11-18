/**
 * A page load's id (plan play-in-page D6): random, one per document. `crypto.randomUUID` needs a
 * secure context; a phone on the LAN IP of the dev server is not one.
 */
export const newLoadId = (): string =>
  typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : Array.from(crypto.getRandomValues(new Uint8Array(16)), byte =>
        byte.toString(16).padStart(2, '0')
      ).join('');
