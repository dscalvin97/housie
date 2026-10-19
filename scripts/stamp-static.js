// Stamp the static build: flip HOUSIE_STATIC on so the client uses the in-browser hub.
// Run as part of `npm run build:static` after public/ is copied to dist/.
import { readFileSync, writeFileSync } from 'node:fs';

const file = new URL('../dist/config.js', import.meta.url);
const src = readFileSync(file, 'utf8');
const out = src.replace('window.HOUSIE_STATIC = false', 'window.HOUSIE_STATIC = true');
if (out === src) {
  console.error('stamp-static: HOUSIE_STATIC flag not found in config.js');
  process.exit(1);
}
writeFileSync(file, out);
console.log('stamped dist/config.js -> HOUSIE_STATIC = true');
