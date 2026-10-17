type Job = {
  id: string;
  priority: number;
  limit: number;
  work: () => Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
};
export const createReviewQueue = () => {
  const pending: Job[] = [];
  const running = new Map<string, number>();
  const promises = new Map<string, Promise<void>>();
  const pump = () => {
    pending.sort((a, b) => a.priority - b.priority);
    while (pending.length) {
      const job = pending[0];
      if (!job || running.size >= Math.min(job.limit, ...running.values())) break;
      pending.shift();
      running.set(job.id, job.limit);
      void job
        .work()
        .then(job.resolve, job.reject)
        .finally(() => {
          running.delete(job.id);
          promises.delete(job.id);
          pump();
        });
    }
  };
  return {
    add: (
      id: string,
      priority: 'interactive' | 'background',
      limit: number,
      work: () => Promise<void>,
    ) => {
      const existing = promises.get(id);
      if (existing) return existing;
      const result = new Promise<void>((resolve, reject) =>
        pending.push({
          id,
          priority: priority === 'interactive' ? 0 : 1,
          limit,
          work,
          resolve,
          reject,
        }),
      );
      promises.set(id, result);
      pump();
      return result;
    },
    cancel: (id: string) => {
      const index = pending.findIndex((job) => job.id === id);
      const job = pending[index];
      if (job) {
        pending.splice(index, 1);
        promises.delete(id);
        job.resolve();
        pump();
      }
    },
  };
};
