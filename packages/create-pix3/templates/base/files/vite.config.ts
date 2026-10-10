import { defineConfig } from 'vite';
import { pix3 } from '@pix3/vite-plugin';

// `npm run dev`: the game at /, the Pix3 editor at /__pix3/.
// `npm run build`: dist/index.html, one self-contained file, plus dist/index.report.json (what it
// weighs and why). pix3({ compress: true }) gzips the bundle into the page (about two thirds
// off); pix3({ build: 'zip' }) makes a zip to host (not for file://).
export default defineConfig({
  plugins: [pix3()],
});
