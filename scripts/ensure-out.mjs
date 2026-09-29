import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// wrangler refuses to start when assets.directory is missing, so make sure a
// placeholder exists before `npm run dev` on a fresh clone (a real build
// via `npm run build:web` overwrites it).
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'apps', 'web', 'out');
const indexFile = path.join(outDir, 'index.html');

if (!existsSync(indexFile)) {
  mkdirSync(outDir, { recursive: true });
  const stub =
    '<!doctype html><html><head><meta charset="utf-8"><title>Motoro</title></head>' +
    '<body style="font-family:system-ui;padding:2rem">Motoro placeholder — run ' +
    '<code>npm run build:web</code> to build the real frontend.</body></html>';
  writeFileSync(indexFile, stub);
  writeFileSync(path.join(outDir, '404.html'), stub);
  console.log('Created placeholder apps/web/out (run `npm run build:web` for the real build).');
}
