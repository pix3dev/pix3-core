import { defineConfig } from 'vite';
import { pix3 } from '@pix3/vite-plugin';

// `npm run dev`: the game at /, the Pix3 editor at /__pix3/.
// `npm run build`: dist/index.html, one self-contained file (pix3({ build: 'zip' }) for a zip).
export default defineConfig({
  plugins: [pix3()],
});
