import { readFile } from 'node:fs/promises';

const file = process.argv[2];
const message = file ? await readFile(file, 'utf8') : process.env.REVIEWLAB_COMMIT_MESSAGE;
if (!message) throw new Error('Usage: pnpm check:commit <commit-message-file>');
const subject = message.split('\n')[0] ?? '';
if (
  !/^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([a-z0-9-]+\))?!?: .+/.test(
    subject,
  )
) {
  throw new Error(
    'Use a Conventional Commit subject, for example: feat(git): capture immutable index tree',
  );
}
console.log('Conventional Commit subject checked.');
