import type { ContextManifest } from '@reviewlab/domain';

export type SemanticRetriever = {
  provenance: Omit<NonNullable<ContextManifest['semantic']>, 'candidates'>;
  embed: (texts: string[]) => Promise<number[][]>;
};
export const semanticRank = async (
  query: string,
  candidates: { path: string; text: string }[],
  retriever: SemanticRetriever,
): Promise<string[]> => {
  if (!candidates.length || !query.trim()) return [];
  const queryVector = (await retriever.embed([query]))[0];
  if (!queryVector) throw new Error('Missing query embedding.');
  const scores: { path: string; score: number }[] = [];
  for (let offset = 0; offset < candidates.length; offset += 8) {
    const batch = candidates.slice(offset, offset + 8);
    const vectors = await retriever.embed(batch.map((entry) => entry.text));
    if (vectors.length !== batch.length) throw new Error('Embedding batch mismatch.');
    for (const [index, candidate] of batch.entries()) {
      const vector = vectors[index];
      if (!vector || vector.length !== queryVector.length)
        throw new Error('Embedding dimensions changed between batches.');
      const score = vector.reduce((sum, value, i) => sum + value * (queryVector[i] ?? 0), 0);
      if (!Number.isFinite(score)) throw new Error('Invalid semantic similarity.');
      if (score >= 0.25) scores.push({ path: candidate.path, score });
    }
  }
  return scores
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path, 'en'))
    .slice(0, 5)
    .map((entry) => entry.path);
};
