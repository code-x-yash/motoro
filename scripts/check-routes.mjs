/**
 * Static checks that every UI call target actually exists:
 *  - API helpers used in apps/web must match a Worker route (read from source)
 *  - internal links (href / router.push) must map to a real page
 *
 *   node scripts/check-routes.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();

function walk(dir, out = [], filter = () => true) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.next', '.wrangler', 'dist'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out, filter);
    else if (filter(entry.name)) out.push(full);
  }
  return out;
}

// --- worker routes (from source + app mounts) --------------------------------
const appSource = fs.readFileSync(path.join(root, 'apps/worker/src/app.ts'), 'utf8');
const mounts = [...appSource.matchAll(/\.route\(\s*'([^']+)'\s*,\s*(\w+)\s*\)/g)].map((m) => ({
  prefix: m[1],
  varName: m[2],
}));
const varToFile = new Map(
  [...appSource.matchAll(/import\s+(\w+)\s+from\s+'\.\/routes\/([\w-]+)'/g)].map((m) => [m[1], m[2]]),
);

const routeDir = path.join(root, 'apps/worker/src/routes');
const routes = new Set();
for (const mount of mounts) {
  const file = varToFile.get(mount.varName);
  if (!file) continue;
  const src = fs.readFileSync(path.join(routeDir, `${file}.ts`), 'utf8');
  for (const m of src.matchAll(/routes\.(get|post|patch|delete|put)\(\s*'([^']*)'/g)) {
    const method = m[1].toUpperCase();
    const suffix = m[2] === '/' ? '' : m[2];
    routes.add(`${method} ${mount.prefix}${suffix}`.replace(/\{[^}]+\}/g, '*').replace(/:([A-Za-z0-9_]+)/g, '*'));
  }
}
if (routes.size === 0) {
  console.error('✗ no worker routes parsed');
  process.exit(1);
}

// --- UI sources --------------------------------------------------------------
const webFiles = walk(path.join(root, 'apps/web/src'), [], (n) => /\.(ts|tsx)$/.test(n));
const uiAll = webFiles.map((f) => fs.readFileSync(f, 'utf8')).join('\n');

const apiCalls = [];
const helperRe = /\bapi(Get|Post|Patch|Delete)\s*\(\s*[`'"]([^`'"]+)[`'"]/g;
let m;
while ((m = helperRe.exec(uiAll))) {
  const method = { Get: 'GET', Post: 'POST', Patch: 'PATCH', Delete: 'DELETE' }[m[1]];
  apiCalls.push({ method, path: m[2], helper: `api${m[1]}` });
}
const fetchRe = /\bfetch\s*\(\s*[`'"]([^`'"]+)[`'"]/g;
while ((m = fetchRe.exec(uiAll))) {
  if (m[1].startsWith('/api')) apiCalls.push({ method: 'GET', path: m[1], helper: 'fetch' });
}

const normalize = (p) => p.split('?')[0].replace(/\$\{[^}]+\}/g, '*').replace(/\/+$/, '');
function matchRoute(method, raw) {
  const target = normalize(raw);
  return [...routes].some((r) => {
    const [rm, rp] = r.split(' ');
    if (rm !== method) return false;
    if (rp === target) return true;
    // parameterised match (call site interpolates a path segment)
    const re = new RegExp(`^${rp.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]+')}$`);
    if (re.test(target)) return true;
    // action-style paths (/x/${id}/${action}): accept when the static prefix has routes
    if (target.includes('*')) {
      const tPrefix = target.slice(0, target.indexOf('*'));
      const rPrefix = rp.includes('*') ? rp.slice(0, rp.indexOf('*')) : rp;
      return rp.startsWith(tPrefix) || tPrefix.startsWith(rPrefix);
    }
    return false;
  });
}

const missingApi = apiCalls.filter((c) => c.path.startsWith('/api') && !matchRoute(c.method, c.path));

// --- internal links ----------------------------------------------------------
const pages = [];
(function findPages(dir, seg = '') {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) findPages(full, `${seg}/${entry.name}`);
    else if (entry.name === 'page.tsx') pages.push(seg || '/');
  }
})(path.join(root, 'apps/web/src/app'));

const pagePatterns = pages.map((p) => p.replace(/\[[^\]]+\]/g, '*'));
const linkTargets = new Set();
const linkRe = /href=(?:"|`|\{["'`])(\/[^"'`}\s]*)/g;
const pushRe = /router\.(push|replace)\(\s*[`'"](\/[^`'"]*)[`'"]/g;
while ((m = linkRe.exec(uiAll))) linkTargets.add(m[1]);
while ((m = pushRe.exec(uiAll))) linkTargets.add(m[2]);

function pageExists(target) {
  const clean = target.split('?')[0].split('#')[0];
  if (!clean.startsWith('/')) return true;
  if (clean.startsWith('/api/')) return true;
  const p = clean.replace(/\/+$/, '') || '/';
  if (pagePatterns.includes(p)) return true;
  return pagePatterns.some((pat) => {
    if (!pat.includes('*')) return false;
    const re = new RegExp(`^${pat.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]+')}$`);
    return re.test(p);
  });
}
const missingLinks = [...linkTargets].filter((t) => !pageExists(t)).sort();

// --- report ------------------------------------------------------------------
console.log(`worker routes parsed: ${routes.size}`);
console.log(`api call sites:       ${apiCalls.length}`);
console.log(`internal links:       ${linkTargets.size}`);
console.log(`pages:                ${pages.length}`);

let failed = false;
if (missingApi.length) {
  failed = true;
  console.log('\n✗ API calls with no matching worker route:');
  for (const c of missingApi) console.log(`   ${c.helper}('${c.path}')`);
}
if (missingLinks.length) {
  failed = true;
  console.log('\n✗ internal links with no matching page:');
  for (const t of missingLinks) console.log(`   ${t}`);
}
if (!failed) console.log('\n✓ every UI API call and internal link resolves');
process.exit(failed ? 1 : 0);
