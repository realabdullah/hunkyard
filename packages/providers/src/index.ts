import {
  GitHubRepositorySchema,
  GitHubUrlSchema,
  type Publication,
  type PullRequestContext,
  PullRequestContextSchema,
  type PullRequestRequest,
} from '@reviewlab/domain';
import { z } from 'zod';
import { createGitHubClient, GitHubError, type GitHubTransport } from './transport';

export type { GitHubTransport } from './transport';
export { createGitHubClient, GitHubError, ghTransport } from './transport';

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const pullSchema = z.object({
  number: z.number().int(),
  html_url: GitHubUrlSchema,
  title: z.string().max(1000),
  body: z.string().max(65536).nullable(),
  state: z.enum(['open', 'closed']),
  base: z.object({ sha, repo: z.object({ full_name: GitHubRepositorySchema }) }),
  head: z.object({ sha }),
});
const commentSchema = z.object({
  id: z.number().int().positive(),
  html_url: GitHubUrlSchema,
  body: z.string().max(65536).nullable(),
  user: z.object({ login: z.string().max(200) }).nullable(),
  state: z.string().max(100).optional(),
  path: z.string().max(1000).optional(),
  line: z.number().int().positive().nullable().optional(),
  side: z.enum(['LEFT', 'RIGHT']).optional(),
  commit_id: sha.optional(),
  original_commit_id: sha.optional(),
});
const checkSchema = z.object({
  name: z.string().max(1000),
  status: z.string().max(100),
  conclusion: z.string().nullable(),
  html_url: z.string().nullable(),
});
const statusSchema = z.object({
  context: z.string().max(1000),
  state: z.string().max(100),
  target_url: z.string().nullable(),
});
const safeLink = (url: string | null) => {
  const parsed = GitHubUrlSchema.safeParse(url);
  return parsed.success ? parsed.data : null;
};
export const createGitHubProvider = (transport?: GitHubTransport) => {
  const client = createGitHubClient(transport);
  const get = async (request: Pick<PullRequestRequest, 'repository' | 'number'>) => {
    const pull = pullSchema.parse(
      await client.request('GET', `repos/${request.repository}/pulls/${request.number}`),
    );
    if (
      pull.number !== request.number ||
      pull.base.repo.full_name.toLowerCase() !== request.repository.toLowerCase() ||
      pull.html_url.toLowerCase() !==
        `https://github.com/${request.repository}/pull/${request.number}`.toLowerCase()
    )
      throw new Error('GitHub PR identity mismatch.');
    return pull;
  };
  return {
    head: async (request: Pick<PullRequestRequest, 'repository' | 'number'>) => {
      const pull = await get(request);
      return { headSha: pull.head.sha, baseSha: pull.base.sha, state: pull.state };
    },
    read: async (request: PullRequestRequest): Promise<PullRequestContext> => {
      const pull = await get(request);
      const prefix = `repos/${request.repository}`;
      const compared = z
        .object({ merge_base_commit: z.object({ sha }) })
        .parse(
          await client.request('GET', `${prefix}/compare/${pull.base.sha}...${pull.head.sha}`),
        );
      const comments: PullRequestContext['comments'] = [];
      const diagnostics: string[] = [];
      let remaining = 200000;
      let truncated = 0;
      const boundedBody = (body: string | null) => {
        const text = body ?? '';
        const retained = text.slice(0, Math.min(20000, remaining));
        remaining -= retained.length;
        if (retained.length < text.length) {
          truncated += 1;
          return `${retained}\n[Remote text truncated by context budget]`;
        }
        return retained;
      };
      const description = boundedBody(pull.body);
      for (const [kind, endpoint] of [
        ['issue', `${prefix}/issues/${request.number}/comments`],
        ['review', `${prefix}/pulls/${request.number}/reviews`],
        ['inline', `${prefix}/pulls/${request.number}/comments`],
      ] as const) {
        for (const entry of await client.list(endpoint)) {
          const value = commentSchema.parse(entry);
          comments.push({
            id: value.id,
            kind,
            author: value.user?.login ?? 'deleted-user',
            body: boundedBody(value.body),
            url: value.html_url,
            ...(value.state ? { state: value.state } : {}),
            ...(value.path ? { path: value.path } : {}),
            ...(value.line !== undefined ? { line: value.line } : {}),
            ...(value.side ? { side: value.side } : {}),
            ...(value.commit_id ? { commitSha: value.commit_id } : {}),
            outdated:
              kind === 'inline' && (value.line == null || value.commit_id !== pull.head.sha),
          });
        }
      }
      const checks: PullRequestContext['checks'] = [];
      try {
        for (let page = 1; page <= 10; page += 1) {
          const data = z
            .object({ total_count: z.number(), check_runs: z.array(checkSchema) })
            .parse(
              await client.request(
                'GET',
                `${prefix}/commits/${pull.head.sha}/check-runs?per_page=100&page=${page}`,
              ),
            );
          checks.push(
            ...data.check_runs.map((entry) => ({
              name: entry.name,
              state: entry.status,
              conclusion: entry.conclusion,
              url: safeLink(entry.html_url),
            })),
          );
          if (checks.length >= data.total_count) break;
          if (page === 10) throw new Error('GitHub check pagination budget exceeded.');
        }
        const statuses = z
          .array(statusSchema)
          .parse(await client.list(`${prefix}/commits/${pull.head.sha}/statuses`));
        const seen = new Set<string>();
        for (const status of statuses)
          if (!seen.has(status.context)) {
            seen.add(status.context);
            checks.push({
              name: status.context,
              state: status.state,
              conclusion: null,
              url: safeLink(status.target_url),
            });
          }
      } catch (error) {
        if (!(error instanceof GitHubError) || ![403, 404].includes(error.status)) throw error;
        diagnostics.push(
          'Some checks/statuses unavailable: GitHub permission or rate limit refusal. No approval inferred.',
        );
      }
      if (truncated)
        diagnostics.push(
          `${truncated} remote text entries truncated: 20000 characters/entry, 200000 total. Comments remain advisory; omitted text is not reviewed.`,
        );
      const after = await get(request);
      if (after.head.sha !== pull.head.sha || after.base.sha !== pull.base.sha)
        throw new Error('PR changed during ingestion. Retry to capture a consistent revision.');
      return PullRequestContextSchema.parse({
        repository: request.repository,
        number: request.number,
        url: pull.html_url,
        title: pull.title,
        body: description,
        state: pull.state,
        baseSha: pull.base.sha,
        headSha: pull.head.sha,
        mergeBaseSha: compared.merge_base_commit.sha,
        fetchedAt: new Date().toISOString(),
        comments,
        checks,
        diagnostics,
      });
    },
    findPublication: async (publication: Publication): Promise<string | undefined> => {
      const marker = `<!-- reviewlab:${publication.id} -->`;
      const entries = await client.list(
        `repos/${publication.repository}/issues/${publication.number}/comments`,
      );
      const comments = entries.map((entry) => commentSchema.parse(entry));
      for (const value of comments) {
        if (value.body?.includes(marker)) return value.html_url;
      }
      if (
        comments.some((value) =>
          publication.dedupeKeys.some((key) =>
            value.body?.includes(`<!-- reviewlab-finding:${key} -->`),
          ),
        )
      )
        throw new Error(
          'Matching findings already appear in a GitHub comment. Inspect existing comments before creating another publication.',
        );
      return undefined;
    },
    publish: async (publication: Publication): Promise<string> => {
      const value = z
        .object({ html_url: GitHubUrlSchema })
        .parse(
          await client.request(
            'POST',
            `repos/${publication.repository}/issues/${publication.number}/comments`,
            { body: publication.body },
          ),
        );
      return value.html_url;
    },
  };
};
