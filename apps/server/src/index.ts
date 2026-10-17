import { startServer } from './runtime';

const runtime = await startServer(
  process.env.HUNKYARD_REPO || process.env.REVIEWLAB_REPO || process.cwd(),
);
console.log(
  `Hunkyard is listening at ${runtime.origin}. Use hunkyard open to launch an authorized workspace.`,
);
const stop = async () => {
  await runtime.close();
  process.exit(0);
};
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
