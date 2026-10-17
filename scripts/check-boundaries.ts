import { readdir, readFile } from 'node:fs/promises';
import { isBuiltin } from 'node:module';
import { dirname, relative, resolve } from 'node:path';
import { allowedDependencies, assertAcyclic, importedModules } from './boundaries';
import { listFiles } from './files';

const root = process.cwd();
const graph = new Map<string, string[]>();
for (const group of ['apps', 'packages']) {
  for (const directory of await readdir(resolve(root, group))) {
    const workspace = resolve(root, group, directory);
    const manifest = JSON.parse(await readFile(resolve(workspace, 'package.json'), 'utf8')) as {
      name: string;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const declared = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
    graph.set(manifest.name, declared);
    const allowed = group === 'packages' ? allowedDependencies[manifest.name] : undefined;
    if (group === 'packages' && !allowed)
      throw new Error(`Define boundary rules for ${manifest.name}`);
    for (const dependency of declared) {
      if (allowed && !allowed.includes(dependency))
        throw new Error(`${manifest.name}: forbidden dependency ${dependency}`);
    }
    for (const file of (await listFiles(workspace)).filter((path) =>
      /\.[cm]?[jt]sx?$/.test(path),
    )) {
      for (const specifier of importedModules(await readFile(file, 'utf8'), file)) {
        if (specifier.startsWith('.')) {
          const destination = resolve(dirname(file), specifier);
          if (relative(workspace, destination).startsWith('..'))
            throw new Error(`${file}: cross-workspace relative import`);
          continue;
        }
        if (isBuiltin(specifier)) {
          if (manifest.name === '@hunkyard/domain' || manifest.name === '@hunkyard/core') {
            throw new Error(`${file}: forbidden platform import ${specifier}`);
          }
          continue;
        }
        const packageName = specifier.startsWith('@')
          ? specifier.split('/').slice(0, 2).join('/')
          : specifier.split('/')[0];
        // VS Code provides this module only inside its extension host.
        if (packageName === 'vscode' && manifest.name === 'hunkyard-vscode') continue;
        if (
          !packageName ||
          (!declared.includes(packageName) && !['vitest'].includes(packageName))
        ) {
          throw new Error(`${file}: undeclared dependency ${specifier}`);
        }
        if (packageName === 'vitest' && !file.endsWith('.test.ts'))
          throw new Error(`${file}: test runner in production code`);
      }
    }
  }
}
assertAcyclic(graph);
console.log(`Package boundaries and dependency cycles checked (${graph.size} workspaces).`);
