import { timingSafeEqual } from 'node:crypto';
import type { createReviewService } from '@reviewlab/core';
import type { ModelTarget } from '@reviewlab/domain';
import {
  CaptureRequestSchema,
  ExportRequestSchema,
  ModelConfigSchema,
  PullRequestRefreshSchema,
  PullRequestRequestSchema,
  RetentionRequestSchema,
  ReviewOptionsSchema,
  RevisionRequestSchema,
  RunRequestSchema,
  SecretRequestSchema,
  StartReviewSchema,
} from '@reviewlab/domain';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { streamSSE } from 'hono/streaming';

export const problem = (c: Context, status: 400 | 401 | 403 | 404 | 409 | 413, title: string) =>
  c.json(
    { type: 'about:blank', title, status, requestId: c.res.headers.get('X-Request-ID') },
    status,
    { 'Content-Type': 'application/problem+json' },
  );

type Service = ReturnType<typeof createReviewService>;
export const createApi = (deps: {
  service: Service;
  token: string;
  origin: string;
  target: () => Promise<ModelTarget>;
  configure: (model: unknown, allowCloud?: boolean) => Promise<ModelTarget>;
  probe: () => Promise<unknown>;
  probeCapabilities?: () => Promise<unknown>;
  secret?: (provider: ModelTarget['provider'], secret: string | null) => Promise<void>;
  /** Display-only folder name of the repository, shown in the workspace header. */
  workspaceName?: string;
}) => {
  const app = new Hono();
  const origins = new Set([deps.origin, 'http://127.0.0.1:5173']);
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('X-Frame-Options', 'DENY');
    const requestId = globalThis.crypto.randomUUID();
    c.header('X-Request-ID', requestId);
    const reject = (status: 400 | 401 | 403 | 413, detail: string) => problem(c, status, detail);
    if (
      c.req.header('host') !== new URL(deps.origin).host &&
      c.req.header('host') !== '127.0.0.1:5173'
    )
      return reject(403, 'Host not allowed');
    if (c.req.path.startsWith('/api/')) {
      const authorization = c.req.header('authorization') ?? '';
      const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
      const supplied = Buffer.from(token);
      const expected = Buffer.from(deps.token);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
        return reject(401, 'API authorization required');
      const origin = c.req.header('origin');
      if (origin && !origins.has(origin)) return reject(403, 'Origin not allowed');
      if (!['GET', 'HEAD'].includes(c.req.method)) {
        if (!origin || !origins.has(origin) || c.req.header('x-reviewlab-csrf') !== '1')
          return reject(403, 'Mutation requires exact Origin and CSRF header');
        if (Number(c.req.header('content-length') ?? 0) > 64_000)
          return reject(413, 'Request too large');
      }
    }
    await next();
  });
  app.use(
    '/api/*',
    bodyLimit({ maxSize: 64_000, onError: (c) => problem(c, 413, 'Request too large') }),
  );
  app.onError((error, c) =>
    problem(c, error.message.includes('revision conflict') ? 409 : 400, error.message),
  );
  app.get('/api/v1/review-plan', async (c) => c.json(await deps.service.plan()));
  app.post('/api/v1/review-plan', async (c) =>
    c.json(await deps.service.plan(ReviewOptionsSchema.parse(await c.req.json()))),
  );
  app.get('/api/v1/health', async (c) =>
    c.json({ ok: true, target: await deps.target(), name: deps.workspaceName ?? null }),
  );
  app.get('/api/v1/sessions', async (c) =>
    c.json(
      (await deps.service.list()).map((session) => ({
        id: session.id,
        revision: session.revision,
        status: session.status,
        target: session.target,
        createdAt: session.createdAt,
        snapshot: {
          files: session.snapshot.files,
          scope: session.snapshot.scope,
          ...(session.snapshot.pullRequest
            ? {
                pullRequest: {
                  number: session.snapshot.pullRequest.number,
                  title: session.snapshot.pullRequest.title,
                },
              }
            : {}),
        },
        findingCount: session.findings.length,
      })),
    ),
  );
  app.get('/api/v1/sessions/:id', async (c) => {
    const session = await deps.service.get(c.req.param('id'));
    return session ? c.json(session) : problem(c, 404, 'Session not found');
  });
  app.get('/api/v1/sessions/:id/runs', async (c) => {
    if (!(await deps.service.get(c.req.param('id')))) return problem(c, 404, 'Session not found');
    return c.json(await deps.service.runs(c.req.param('id')));
  });
  app.get('/api/v1/sessions/:id/snapshots', async (c) => {
    if (!(await deps.service.get(c.req.param('id')))) return problem(c, 404, 'Session not found');
    return c.json(await deps.service.snapshots(c.req.param('id')));
  });
  app.get('/api/v1/sessions/:id/events', async (c) => {
    const id = c.req.param('id');
    if (!(await deps.service.get(id))) return problem(c, 404, 'Session not found');
    const supplied = c.req.header('last-event-id') ?? c.req.query('after') ?? '0';
    if (!/^\d+$/.test(supplied) || !Number.isSafeInteger(Number(supplied)))
      return problem(c, 400, 'Expected a nonnegative event cursor');
    let cursor = Number(supplied);
    c.header('X-Accel-Buffering', 'no');
    return streamSSE(c, async (stream) => {
      let ticks = 0;
      await stream.write(': connected\n\n');
      while (!stream.aborted) {
        const events = await deps.service.events(id, cursor);
        for (const event of events) {
          await stream.writeSSE({
            id: String(event.cursor),
            event: 'review',
            data: JSON.stringify(event),
          });
          cursor = event.cursor;
        }
        if (!(await deps.service.get(id))) break;
        if (++ticks % 15 === 0) await stream.write(': keepalive\n\n');
        await stream.sleep(1000);
      }
    });
  });
  app.post('/api/v1/sessions/:id/runs', async (c) => {
    const input = RunRequestSchema.parse(await c.req.json());
    const session = await deps.service.rerun(
      c.req.param('id'),
      input.revision,
      input.recapture,
      input.review,
      input.paths,
    );
    if (!session) return problem(c, 404, 'Session not found');
    launch(session.id);
    return c.json(session, 202);
  });
  app.post('/api/v1/sessions/:id/export', async (c) => {
    const input = ExportRequestSchema.parse(await c.req.json());
    if (!(await deps.service.get(c.req.param('id')))) return problem(c, 404, 'Session not found');
    return c.json(await deps.service.export(c.req.param('id'), !input.includeSource));
  });
  app.delete('/api/v1/sessions/:id', async (c) => {
    const input = RevisionRequestSchema.parse(await c.req.json());
    return (await deps.service.delete(c.req.param('id'), input.revision))
      ? c.json({ deleted: true })
      : problem(c, 404, 'Session not found');
  });
  app.get('/api/v1/storage', async (c) => c.json(await deps.service.usage()));
  app.post('/api/v1/retention', async (c) =>
    c.json({ deleted: await deps.service.prune(RetentionRequestSchema.parse(await c.req.json())) }),
  );
  app.get('/api/v1/github/repository', async (c) =>
    c.json({ repository: await deps.service.github.repository() }),
  );
  app.post('/api/v1/github/reviews', async (c) => {
    const { review, ...input } = PullRequestRequestSchema.extend({
      review: ReviewOptionsSchema.optional(),
    }).parse(await c.req.json());
    const session = await deps.service.startPullRequest(input, review);
    launch(session.id);
    return c.json(session, 202);
  });
  app.post('/api/v1/sessions/:id/github/refresh', async (c) => {
    const input = PullRequestRefreshSchema.parse(await c.req.json());
    await deps.service.github.context(c.req.param('id'));
    const session = await deps.service.rerun(
      c.req.param('id'),
      input.revision,
      true,
      undefined,
      undefined,
      input.allowGitHub,
    );
    if (!session) return problem(c, 404, 'Session not found');
    launch(session.id);
    return c.json(session, 202);
  });
  app.post('/api/v1/sessions/:id/github/previews', async (c) =>
    c.json(await deps.service.github.preview(c.req.param('id'), await c.req.json())),
  );
  app.post('/api/v1/sessions/:id/github/publications/:publicationId', async (c) =>
    c.json(
      await deps.service.github.publish(
        c.req.param('id'),
        c.req.param('publicationId'),
        await c.req.json(),
      ),
    ),
  );
  app.post('/api/v1/sessions', async (c) => {
    const body = await c.req.text();
    const value: unknown = body ? JSON.parse(body) : {};
    const input =
      value && typeof value === 'object' && 'scope' in value
        ? StartReviewSchema.parse(value)
        : { scope: CaptureRequestSchema.parse(value), review: undefined };
    const session = await deps.service.start(input.scope, input.review);
    launch(session.id);
    return c.json(session, 202);
  });
  const launch = (id: string) => {
    void deps.service.execute(id).catch(async () => {
      console.error(
        'Review state could not be persisted. Run reviewlab doctor and inspect storage.',
      );
      try {
        await deps.service.cancel(id);
      } catch {
        console.error('Interrupted review could not be cancelled because storage is unavailable.');
      }
    });
  };
  app.post('/api/v1/sessions/:id/cancel', async (c) => {
    const session = await deps.service.cancel(c.req.param('id'));
    return session ? c.json(session) : problem(c, 404, 'Session not found');
  });
  app.post('/api/v1/sessions/:id/findings/:findingId/dismiss', async (c) => {
    const body = RevisionRequestSchema.parse(await c.req.json());
    const session = await deps.service.dismiss(
      c.req.param('id'),
      c.req.param('findingId'),
      body.revision,
    );
    return session ? c.json(session) : problem(c, 404, 'Finding not found');
  });
  app.post('/api/v1/sessions/:id/patches/draft', async (c) =>
    c.json(await deps.service.interaction.draftPatch(c.req.param('id'), await c.req.json())),
  );
  app.post('/api/v1/sessions/:id/patches', async (c) =>
    c.json(await deps.service.interaction.propose(c.req.param('id'), await c.req.json())),
  );
  app.post('/api/v1/sessions/:id/patches/:patchId/approve', async (c) =>
    c.json(
      await deps.service.interaction.approve(
        c.req.param('id'),
        c.req.param('patchId'),
        await c.req.json(),
      ),
    ),
  );
  app.post('/api/v1/sessions/:id/patches/:patchId/apply', async (c) =>
    c.json(
      await deps.service.interaction.apply(
        c.req.param('id'),
        c.req.param('patchId'),
        await c.req.json(),
      ),
    ),
  );
  app.get('/api/v1/sessions/:id/patches/:patchId/effects', async (c) =>
    c.json({
      description: await deps.service.interaction.patchEffects(
        c.req.param('id'),
        c.req.param('patchId'),
        c.req.query('isolated') === 'true',
      ),
    }),
  );
  app.post('/api/v1/sessions/:id/rule-suggestions', async (c) => {
    const input = RevisionRequestSchema.parse(await c.req.json());
    return c.json(await deps.service.interaction.suggestRule(c.req.param('id'), input.revision));
  });
  app.post('/api/v1/sessions/:id/rule-suggestions/:ruleId', async (c) =>
    c.json(
      await deps.service.interaction.decideRule(
        c.req.param('id'),
        c.req.param('ruleId'),
        await c.req.json(),
      ),
    ),
  );
  app.get('/api/v1/sessions/:id/interaction', async (c) =>
    c.json(await deps.service.interaction.read(c.req.param('id'))),
  );
  app.post('/api/v1/sessions/:id/messages', async (c) =>
    c.json(await deps.service.interaction.message(c.req.param('id'), await c.req.json())),
  );
  app.post('/api/v1/sessions/:id/messages/:messageId/reaction', async (c) =>
    c.json(
      await deps.service.interaction.react(
        c.req.param('id'),
        c.req.param('messageId'),
        await c.req.json(),
      ),
    ),
  );
  app.post('/api/v1/sessions/:id/findings/:findingId/status', async (c) =>
    c.json(
      await deps.service.interaction.transition(
        c.req.param('id'),
        c.req.param('findingId'),
        await c.req.json(),
      ),
    ),
  );
  app.post('/api/v1/config', async (c) => {
    const body: unknown = await c.req.json();
    if (!body || typeof body !== 'object' || !('model' in body))
      return problem(c, 400, 'Expected model configuration');
    const allowCloud = 'allowCloud' in body ? body.allowCloud : undefined;
    if (allowCloud !== undefined && typeof allowCloud !== 'boolean')
      return problem(c, 400, 'Invalid consent');
    return c.json(await deps.configure(ModelConfigSchema.parse(body.model), allowCloud));
  });
  app.get('/api/v1/models', async (c) => c.json({ target: await deps.target() }));
  app.post('/api/v1/models/probe', async (c) => c.json(await deps.probe()));
  app.post('/api/v1/models/capabilities', async (c) =>
    deps.probeCapabilities
      ? c.json(await deps.probeCapabilities())
      : problem(c, 400, 'Capability probing unavailable'),
  );
  app.post('/api/v1/config/secret', async (c) => {
    if (!deps.secret) return problem(c, 400, 'Private secret storage unavailable');
    const input = SecretRequestSchema.parse(await c.req.json());
    await deps.secret(input.provider, input.secret);
    return c.json({ stored: input.secret !== null });
  });
  app.notFound((c) => problem(c, 404, 'Not found'));
  return app;
};
