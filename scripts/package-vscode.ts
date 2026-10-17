import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';

const root = resolve('dist/vscode');
await rm(root, { recursive: true, force: true });
await mkdir(`${root}/extension/dist`, { recursive: true });
await build({
  entryPoints: ['apps/vscode/src/extension.ts'],
  outfile: `${root}/extension/dist/extension.cjs`,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
});
const manifest = JSON.parse(await readFile('apps/vscode/package.json', 'utf8')) as Record<
  string,
  unknown
>;
delete manifest.dependencies;
delete manifest.devDependencies;
await writeFile(`${root}/extension/package.json`, JSON.stringify(manifest, null, 2));
await cp('docs/power-users/vscode.md', `${root}/extension/README.md`);
await writeFile(
  `${root}/[Content_Types].xml`,
  '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="json" ContentType="application/json"/><Default Extension="cjs" ContentType="application/javascript"/><Default Extension="md" ContentType="text/markdown"/><Default Extension="vsixmanifest" ContentType="text/xml"/></Types>',
);
await writeFile(
  `${root}/extension.vsixmanifest`,
  `<?xml version="1.0"?><PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011"><Metadata><Identity Language="en-US" Id="reviewlab-vscode" Version="0.1.1" Publisher="reviewlab"/><DisplayName>ReviewLab</DisplayName><Description xml:space="preserve">Local-first explicit Git reviews</Description><Tags>review</Tags><Categories>Other</Categories><GalleryFlags>Public</GalleryFlags><Properties><Property Id="Microsoft.VisualStudio.Code.Engine" Value="^1.95.0"/><Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace"/></Properties></Metadata><Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation><Dependencies/><Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/></Assets></PackageManifest>`,
);
const archive = resolve('dist/reviewlab-vscode-0.1.1.zip');
await rm(archive, { force: true });
if (process.platform === 'win32') {
  execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "Compress-Archive -LiteralPath @((Join-Path $env:REVIEWLAB_VSIX_ROOT 'extension'),(Join-Path $env:REVIEWLAB_VSIX_ROOT '[Content_Types].xml'),(Join-Path $env:REVIEWLAB_VSIX_ROOT 'extension.vsixmanifest')) -DestinationPath $env:REVIEWLAB_VSIX_ARCHIVE",
    ],
    { env: { ...process.env, REVIEWLAB_VSIX_ROOT: root, REVIEWLAB_VSIX_ARCHIVE: archive } },
  );
} else
  execFileSync(
    'zip',
    ['-q', '-r', archive, 'extension', '[Content_Types].xml', 'extension.vsixmanifest'],
    { cwd: root },
  );
const destination = resolve('dist/reviewlab-vscode-0.1.1.vsix');
await rm(destination, { force: true });
await rename(archive, destination);
console.log(
  `Prepared ${destination}. Install explicitly with code --install-extension PATH. No publication performed.`,
);
