import { createCorrectnessReviewer } from '@hunkyard/agents';
import { type AgentId, type FindingDraft } from '@hunkyard/domain';

export const benchmarkCases: {
  agent: AgentId;
  file: string;
  bug: string;
  safe: string;
  title: string;
  impact: string;
  fix: string;
}[] = [
  {
    agent: 'correctness',
    file: 'nullable.ts',
    bug: 'export const label = (user: { name: string } | null) => user.name.toUpperCase();',
    safe: "export const label = (user: { name: string } | null) => user?.name.toUpperCase() ?? '';",
    title: 'Null user throws',
    impact: 'Passing null dereferences user.name and throws instead of returning an empty label.',
    fix: 'Guard null before accessing user.name.',
  },
  {
    agent: 'security',
    file: 'query.ts',
    bug: 'export const find = (db, id) => db.query("SELECT * FROM users WHERE id = " + id);',
    safe: 'export const find = (db, id) => db.query("SELECT * FROM users WHERE id = ?", [id]);',
    title: 'Untrusted ID enters SQL',
    impact: 'An attacker-controlled ID such as 0 OR 1=1 changes the query and reads all users.',
    fix: 'Pass the ID as a query parameter.',
  },
  {
    agent: 'frontend',
    file: 'button.tsx',
    bug: 'export const Save = () => <button aria-hidden="true" onClick={save}>Save</button>;',
    safe: 'export const Save = () => <button onClick={save}>Save</button>;',
    title: 'Focusable button hidden from screen readers',
    impact: 'Tab reaches the Save button but aria-hidden removes its accessible name and role.',
    fix: 'Remove aria-hidden from the interactive button.',
  },
  {
    agent: 'architecture',
    file: 'poll.ts',
    bug: 'export const poll = () => { setInterval(refresh, 1000); };',
    safe: 'export const poll = () => { const timer = setInterval(refresh, 1000); return () => clearInterval(timer); };',
    title: 'Polling interval has no cleanup',
    impact:
      'Every mount creates an interval that continues after unmount and accumulates refresh calls.',
    fix: 'Return cleanup that clears the interval.',
  },
  {
    agent: 'testing',
    file: 'save.test.ts',
    bug: "test('saves', () => { expect(save()).toBeTruthy; });",
    safe: "test('saves', () => { expect(save()).toBeTruthy(); });",
    title: 'Assertion matcher never called',
    impact: 'The test reads toBeTruthy without calling it, so a false return still passes.',
    fix: 'Invoke toBeTruthy().',
  },
];
export const benchmarkFinding = (index: number): FindingDraft => {
  const item = benchmarkCases[index];
  if (!item) throw new Error('Unknown benchmark case.');
  return {
    file: item.file,
    line: 1,
    side: 'new',
    severity: 'high',
    title: item.title,
    explanation: item.impact,
    evidence: item.bug,
    recommendation: item.fix,
    confidence: 'high',
  };
};

export const scriptedReviewer = (noisy = false) =>
  createCorrectnessReviewer(async (_url, body) => {
    const parsed = body as { messages: { content: string }[] };
    const system = parsed.messages[0]?.content ?? '';
    if (system.includes('Independent verifier')) {
      const text =
        parsed.messages[1]?.content.split('Untrusted candidates to verify:\n')[1] ?? '[]';
      const candidates = JSON.parse(text) as ReturnType<typeof benchmarkFinding>[];
      return {
        message: {
          content: JSON.stringify({
            findings: candidates.filter((finding) => !finding.title.includes('False positive')),
          }),
        },
        prompt_eval_count: 100,
        eval_count: 20,
      };
    }
    const index = benchmarkCases.findIndex((item) =>
      system
        .toLowerCase()
        .includes(
          `${item.agent === 'frontend' ? 'frontend / accessibility' : item.agent === 'architecture' ? 'architecture / performance' : item.agent} reviewer`,
        ),
    );
    const findings = [benchmarkFinding(0), ...(index > 0 ? [benchmarkFinding(index)] : [])];
    if (noisy)
      findings.push({
        ...benchmarkFinding(0),
        file: 'safe-nullable.ts',
        evidence: benchmarkCases[0]?.safe ?? '',
        title: 'False positive on guarded null',
        recommendation: 'Unnecessary guard',
      });
    return {
      message: { content: JSON.stringify({ findings }) },
      prompt_eval_count: 100,
      eval_count: 20,
    };
  });
