// Copy every source package (src/**/package/**/*.yaml) into dist/ at the same
// relative path, so `path.join(__dirname, 'package')` resolves from compiled
// code exactly as it does from src. tsc emits imported JSON but never copies
// YAML; this runs as the second half of `npm run build`.
import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src');
const dist = join(root, 'dist');

let copied = 0;
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { walk(p); continue; }
    if (!/\.ya?ml$/.test(name)) continue;
    const target = join(dist, relative(src, p));
    mkdirSync(dirname(target), { recursive: true });
    cpSync(p, target);
    copied++;
  }
}
if (!existsSync(dist)) {
  console.error('copy-package-data: dist/ does not exist — run tsc first');
  process.exit(1);
}
walk(src);
console.log(`copy-package-data: ${copied} YAML file(s) copied into dist/`);
if (copied === 0) {
  console.error('copy-package-data: no source packages found under src/ — a connector package is missing');
  process.exit(1);
}
