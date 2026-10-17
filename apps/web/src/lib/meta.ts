import type {
  AgentId,
  CaptureRequest,
  Finding,
  FindingStatus,
  Interaction,
  Provider,
  ReviewSession,
} from '@reviewlab/domain';

export type Tint = 'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'purple' | 'gray';

export const severityMeta: Record<
  Finding['severity'],
  { label: string; tint: Tint; rank: number }
> = {
  critical: { label: 'Critical', tint: 'red', rank: 0 },
  high: { label: 'High', tint: 'orange', rank: 1 },
  major: { label: 'Major', tint: 'orange', rank: 1 },
  medium: { label: 'Medium', tint: 'purple', rank: 2 },
  minor: { label: 'Minor', tint: 'blue', rank: 3 },
  low: { label: 'Low', tint: 'blue', rank: 3 },
  info: { label: 'Info', tint: 'gray', rank: 4 },
};

export const statusMeta: Record<FindingStatus, { label: string; tint: Tint; settled: boolean }> = {
  open: { label: 'Open', tint: 'gray', settled: false },
  investigating: { label: 'Investigating', tint: 'yellow', settled: false },
  reintroduced: { label: 'Reintroduced', tint: 'red', settled: false },
  accepted: { label: 'Will fix', tint: 'blue', settled: true },
  fixed: { label: 'Fixed', tint: 'green', settled: true },
  dismissed: { label: 'Dismissed', tint: 'gray', settled: true },
  stale: { label: 'Stale', tint: 'gray', settled: true },
};

export const dismissReasons = [
  { id: 'false-positive', label: 'False positive', hint: 'The reviewer is wrong' },
  { id: 'preference', label: 'Preference', hint: 'Style we don’t follow' },
  { id: 'accepted-risk', label: 'Accepted risk', hint: 'Known and acceptable' },
  { id: 'duplicate', label: 'Duplicate', hint: 'Already covered' },
  { id: 'out-of-scope', label: 'Out of scope', hint: 'Not for this change' },
] as const;

export const agentMeta: Record<AgentId, { name: string; role: string; tint: Tint; glyph: string }> =
  {
    correctness: { name: 'Correctness', role: 'Logic bugs & edge cases', tint: 'blue', glyph: 'C' },
    security: { name: 'Security', role: 'Vulnerabilities & secrets', tint: 'red', glyph: 'S' },
    frontend: { name: 'Frontend', role: 'UI, a11y & rendering', tint: 'purple', glyph: 'F' },
    architecture: { name: 'Architecture', role: 'Design & coupling', tint: 'orange', glyph: 'A' },
    testing: { name: 'Testing', role: 'Coverage & test gaps', tint: 'green', glyph: 'T' },
    verifier: { name: 'Verifier', role: 'Double-checks every finding', tint: 'gray', glyph: 'V' },
  };

export const profiles = [
  { id: 'quick', name: 'Quick', blurb: 'One reviewer, fast feedback' },
  { id: 'standard', name: 'Standard', blurb: 'Logic, security and UI' },
  { id: 'deep', name: 'Deep', blurb: 'All five specialists' },
] as const;

export const scopeMeta: Record<
  CaptureRequest['kind'],
  { title: string; blurb: string; short: string }
> = {
  staged: {
    title: 'Staged changes',
    blurb: 'Exactly what `git commit` would take',
    short: 'Staged',
  },
  unstaged: { title: 'Unstaged edits', blurb: 'Work you haven’t staged yet', short: 'Unstaged' },
  'working-tree': {
    title: 'Everything local',
    blurb: 'Staged + unstaged against HEAD',
    short: 'Local',
  },
  branch: { title: 'This branch', blurb: 'Compare against a base branch', short: 'Branch' },
  'commit-range': { title: 'Commit range', blurb: 'Any two refs', short: 'Range' },
};

export const providerMeta: Record<Provider, { name: string; hosted: boolean; blurb: string }> = {
  ollama: { name: 'Ollama', hosted: false, blurb: 'Local models on this machine' },
  'lm-studio': { name: 'LM Studio', hosted: false, blurb: 'Local server from LM Studio' },
  'llama-cpp': { name: 'llama.cpp', hosted: false, blurb: 'Local llama.cpp server' },
  compatible: { name: 'Compatible API', hosted: false, blurb: 'Any loopback OpenAI-style API' },
  openai: { name: 'OpenAI', hosted: true, blurb: 'Hosted · api.openai.com' },
  deepseek: { name: 'DeepSeek', hosted: true, blurb: 'Hosted · api.deepseek.com' },
  agentrouter: { name: 'AgentRouter', hosted: true, blurb: 'Hosted gateway to many models' },
};

export const runIdOf = (session: Pick<ReviewSession, 'id' | 'runId'>) =>
  session.runId ?? session.id;

export const statusOf = (state: Interaction | null, runId: string, finding: Finding) =>
  [...(state?.transitions ?? [])]
    .reverse()
    .find((entry) => entry.runId === runId && entry.findingId === finding.id)?.to ?? finding.status;

export const isLive = (status: string) => status === 'queued' || status === 'running';

export const shortSha = (sha: string | null | undefined) => (sha ? sha.slice(0, 7) : '—');

export const fileName = (path: string) => path.split('/').pop() ?? path;
export const dirName = (path: string) => {
  const parts = path.split('/');
  return parts.length > 1 ? `${parts.slice(0, -1).join('/')}/` : '';
};

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
export const ago = (iso: string) => {
  const seconds = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
  ];
  for (const [unit, size] of units)
    if (Math.abs(seconds) >= size) return rtf.format(Math.round(seconds / size), unit);
  return 'just now';
};

type Titled = {
  snapshot: {
    files: string[];
    scope?: CaptureRequest['kind'] | undefined;
    pullRequest?: { number: number; title: string } | undefined;
  };
};
export const sessionTitle = ({ snapshot }: Titled) => {
  const pr = snapshot.pullRequest;
  if (pr) return `#${pr.number} ${pr.title}`;
  const files = snapshot.files;
  const label = snapshot.scope ? scopeMeta[snapshot.scope].short : 'Review';
  if (files.length === 1 && files[0]) return `${label} · ${fileName(files[0])}`;
  return `${label} · ${files.length} files`;
};

export const sortFindings = <T extends Finding>(findings: T[]) =>
  [...findings].sort(
    (a, b) =>
      severityMeta[a.severity].rank - severityMeta[b.severity].rank ||
      a.file.localeCompare(b.file) ||
      a.line - b.line,
  );
