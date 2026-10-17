import { chmod, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { build } from 'esbuild';

// A self-contained npm tarball: no workspace links or TypeScript runtime at install time.
const directory = resolve('dist/release');
await rm(directory, { recursive: true, force: true });
await mkdir(directory, { recursive: true });
await build({
  entryPoints: ['apps/cli/src/index.ts'],
  outfile: `${directory}/cli.mjs`,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
});
await chmod(`${directory}/cli.mjs`, 0o755);
await cp('apps/web/dist', `${directory}/web`, { recursive: true });
await cp('README.md', `${directory}/README.md`);
await cp('CHANGELOG.md', `${directory}/CHANGELOG.md`);
await cp('LICENSE', `${directory}/LICENSE`);
await cp('examples', `${directory}/examples`, { recursive: true });
const require = createRequire(import.meta.url);
const dependencies: Record<string, string> = {};
for (const name of ['zod', 'hono', '@hono/node-server']) {
  let directory = dirname(
    require.resolve(name, { paths: [resolve('packages/domain'), resolve('apps/server')] }),
  );
  for (;;) {
    const metadata = await readFile(join(directory, 'package.json'), 'utf8').catch(() => '{}');
    const pkg = JSON.parse(metadata) as { name?: string; version?: string };
    if (pkg.name === name && pkg.version) {
      dependencies[name] = pkg.version;
      break;
    }
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`Missing metadata for ${name}`);
    directory = parent;
  }
}
await writeFile(`${directory}/bundled-dependencies.json`, JSON.stringify(dependencies, null, 2));
await writeFile(
  `${directory}/package.json`,
  JSON.stringify(
    {
      name: '@hunkyard/cli',
      version: '0.1.0',
      description: 'Local-first AI code review workspace for Git',
      keywords: ['code-review', 'git', 'ai', 'local-first', 'ollama', 'cli'],
      license: 'MIT',
      homepage: 'https://hunkyard.dev',
      repository: { type: 'git', url: 'git+https://github.com/realabdullah/hunkyard.git' },
      bugs: { url: 'https://github.com/realabdullah/hunkyard/issues' },
      type: 'module',
      bin: { hunkyard: 'cli.mjs' },
      files: ['cli.mjs', 'web', 'examples', 'CHANGELOG.md', 'LICENSE', 'bundled-dependencies.json'],
      engines: { node: '>=22.22.0' },
      publishConfig: { access: 'public' },
    },
    null,
    2,
  ),
);
console.log(`Release prepared at ${directory}. Pack locally; publication requires owner approval.`);
