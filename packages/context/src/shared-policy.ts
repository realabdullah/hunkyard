import { createHash } from 'node:crypto';
import type { ReviewPolicyBundle, ShareablePolicy } from '@hunkyard/domain';

export const withSharedPolicy = (
  policy: ReviewPolicyBundle,
  shared: ShareablePolicy,
): ReviewPolicyBundle => {
  const content = JSON.stringify(shared);
  const { hash: _hash, ...original } = policy;
  const bundle = {
    ...original,
    instructions: [
      ...policy.instructions,
      ...shared.rules.map(
        (rule) => `Explicitly selected shared policy ${JSON.stringify(shared.name)}: ${rule}`,
      ),
    ],
    exclusions: [...new Set([...policy.exclusions, ...shared.exclude])],
    sources: [
      ...policy.sources,
      {
        path: `policy://${encodeURIComponent(shared.name)}`,
        hash: createHash('sha256').update(content).digest('hex'),
        truncated: false,
        format: 'shareable-policy-v1',
        content,
      },
    ],
  };
  if (Buffer.byteLength(bundle.instructions.join('\n')) > 48000)
    throw new Error('Effective rules exceed the 48 KB limit.');
  return { ...bundle, hash: createHash('sha256').update(JSON.stringify(bundle)).digest('hex') };
};
