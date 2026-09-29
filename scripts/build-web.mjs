import { spawnSync } from 'node:child_process';

// Static export of apps/web -> apps/web/out, served by the Cloudflare Worker.
const result = spawnSync('npm', ['run', 'build', '--workspace', '@rr/web'], {
  env: { ...process.env, NEXT_OUTPUT: 'export' },
  stdio: 'inherit',
  shell: true,
});

process.exit(result.status ?? 1);
