import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateConfig } from '@hunkyard/context';
import { startServer } from '@hunkyard/server/runtime';
import { createGitFixture } from '@hunkyard/testing';
import { createGitHubFixture } from './github';
import { fixtureStatePath } from './runtime-path';

const fixture = await createGitFixture();
const configDir = await mkdtemp(join(tmpdir(), 'hunkyard-e2e-config-'));
process.env.HUNKYARD_USER_CONFIG = join(configDir, 'config.json');
await writeFile(
  join(fixture.root, 'example.ts'),
  'export const divide = (value: number) => value / 0;\n',
);
await fixture.git('add', 'example.ts');
await writeFile(
  join(fixture.root, 'example.ts'),
  'export const divide = (value: number) => value / 2;\n',
);
const model = createServer(async (request, response) => {
  if (request.url === '/api/tags') {
    response.setHeader('Content-Type', 'application/json');
    response.end(
      JSON.stringify({
        models: [{ name: 'fixture' }, { name: 'slow-fixture' }, { name: 'broken-fixture' }],
      }),
    );
    return;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
    model: string;
    messages?: { content: string }[];
  };
  if (input.model === 'slow-fixture') return;
  const findings = [
    {
      file: 'example.ts',
      line: 1,
      side: 'new',
      severity: 'major',
      title: 'Division by zero',
      explanation: 'The staged implementation divides every value by zero.',
      evidence: 'value / 0',
      recommendation: 'Use the intended nonzero denominator.',
    },
  ];
  response.setHeader('Content-Type', 'application/json');
  const candidates = input.messages?.[1]?.content.split('Untrusted candidates to verify:\n')[1];
  response.end(
    JSON.stringify({
      message: {
        content: input.messages?.[0]?.content.startsWith('Discuss the frozen review evidence.')
          ? 'Suggested answer: use a nonzero denominator. No tests were run.'
          : input.model === 'broken-fixture'
            ? 'invalid JSON'
            : candidates
              ? JSON.stringify({ findings: JSON.parse(candidates) })
              : JSON.stringify({
                  findings: input.messages?.some((message) =>
                    message.content.includes(
                      '+export const divide = (value: number) => value / 0;',
                    ),
                  )
                    ? findings
                    : [],
                }),
      },
    }),
  );
});
await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve));
const address = model.address();
if (!address || typeof address === 'string') throw new Error('Model fixture failed');
await updateConfig(fixture.root, {
  model: {
    provider: 'ollama',
    endpoint: `http://127.0.0.1:${address.port}`,
    model: 'fixture',
    privacy: 'local-only',
    timeoutMs: 10_000,
    maxTokens: 1000,
  },
});
const github = await createGitHubFixture(fixture.root);
const server = await startServer(fixture.root, 4317, { github: github.adapter });
await writeFile(
  fixtureStatePath,
  JSON.stringify({
    token: server.token,
    root: fixture.root,
    githubRoot: github.root,
    githubFirst: github.first,
    githubSecond: github.second,
    configFile: process.env.HUNKYARD_USER_CONFIG,
  }),
  { mode: 0o600 },
);
console.log('Disposable Phase 1 API and loopback model fixture ready.');
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await server.close();
  await github.dispose();
  model.closeAllConnections();
  await new Promise<void>((resolve) => model.close(() => resolve()));
  await fixture.dispose();
  await rm(configDir, { recursive: true, force: true });
  await rm(fixtureStatePath, { force: true });
  process.exit(0);
};
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
