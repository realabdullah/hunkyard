import type { AgentId, Finding, ReviewSession } from '@reviewlab/domain';
import { sortFindings } from '../lib/meta';

export type CardKind = 'snapshot' | 'pr' | 'chat' | 'agent' | 'file' | 'finding' | 'placeholder';
export type CardBox = {
  id: string;
  kind: CardKind;
  x: number;
  y: number;
  w: number;
  h: number;
  ref?: string;
};
export type Section = { id: string; title: string; tint: string; cards: string[] };

export const sizes = {
  snapshot: { w: 260, h: 184 },
  pr: { w: 260, h: 132 },
  chat: { w: 260, h: 104 },
  agent: { w: 232, h: 86 },
  file: { w: 270, h: 78 },
  finding: { w: 320, h: 138 },
  placeholder: { w: 320, h: 138 },
} as const;

const gap = 18;
const columns = { input: 0, crew: 330, files: 640, findings: 990 };

/** Pipeline layout: frozen input → crew → files → findings, with findings beside their file. */
export const layoutBoard = (session: ReviewSession) => {
  const cards: CardBox[] = [];
  const put = (id: string, kind: CardKind, x: number, y: number, ref?: string) => {
    const box: CardBox = { id, kind, x, y, ...sizes[kind], ...(ref ? { ref } : {}) };
    cards.push(box);
    return box;
  };
  let y = 0;
  put('snapshot', 'snapshot', columns.input, y);
  y += sizes.snapshot.h + gap;
  if (session.snapshot.pullRequest) {
    put('pr', 'pr', columns.input, y);
    y += sizes.pr.h + gap;
  }
  put('chat', 'chat', columns.input, y);

  const agents: AgentId[] = session.plan?.agents.map((route) => route.id) ?? [];
  agents.forEach((id, index) => {
    put(`agent:${id}`, 'agent', columns.crew, index * (sizes.agent.h + gap), id);
  });

  const byFile = new Map<string, Finding[]>();
  for (const finding of sortFindings(session.findings))
    byFile.set(finding.file, [...(byFile.get(finding.file) ?? []), finding]);
  const files = [...session.snapshot.files].sort(
    (a, b) => Number(byFile.has(b)) - Number(byFile.has(a)),
  );
  y = 0;
  for (const file of files) {
    put(`file:${file}`, 'file', columns.files, y, file);
    const findings = byFile.get(file) ?? [];
    findings.forEach((finding, index) => {
      put(
        `finding:${finding.id}`,
        'finding',
        columns.findings,
        y + index * (sizes.finding.h + gap),
        finding.id,
      );
    });
    const stack = findings.length * (sizes.finding.h + gap) - gap;
    y += Math.max(sizes.file.h, stack) + gap + (findings.length ? 14 : 0);
  }
  if (!session.findings.length) put('placeholder', 'placeholder', columns.findings, 0);

  const ids = (kind: CardKind) => cards.filter((card) => card.kind === kind).map((card) => card.id);
  const sections: Section[] = [
    {
      id: 'input',
      title: 'Frozen input',
      tint: 'blue',
      cards: [...ids('snapshot'), ...ids('pr'), ...ids('chat')],
    },
    { id: 'crew', title: 'Review crew', tint: 'purple', cards: ids('agent') },
    { id: 'files', title: 'Changed files', tint: 'gray', cards: ids('file') },
    {
      id: 'findings',
      title: session.findings.length ? `Findings · ${session.findings.length}` : 'Findings',
      tint: 'yellow',
      cards: [...ids('finding'), ...ids('placeholder')],
    },
  ];
  return { cards, sections };
};

export const boundsOf = (cards: { x: number; y: number; w: number; h: number }[], pad = 0) => {
  if (!cards.length) return { x: 0, y: 0, w: 0, h: 0 };
  const minX = Math.min(...cards.map((card) => card.x));
  const minY = Math.min(...cards.map((card) => card.y));
  const maxX = Math.max(...cards.map((card) => card.x + card.w));
  const maxY = Math.max(...cards.map((card) => card.y + card.h));
  return { x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 };
};
