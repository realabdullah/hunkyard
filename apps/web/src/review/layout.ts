import type { AgentId, Finding, ReviewSession } from '@hunkyard/domain';
import { severityMeta, sortFindings } from '../lib/meta';
import { squarify, type Tile } from './treemap';

export type CardKind = 'snapshot' | 'pr' | 'chat' | 'agent' | 'files' | 'finding' | 'placeholder';
export type CardBox = {
  id: string;
  kind: CardKind;
  x: number;
  y: number;
  w: number;
  h: number;
  ref?: string;
};
export type Section = { id: string; title: string; count?: number; cards: string[] };
export type Stats = Map<string, { added: number; removed: number }>;

export const sizes = {
  snapshot: { w: 264, h: 176 },
  pr: { w: 264, h: 124 },
  chat: { w: 264, h: 96 },
  agent: { w: 240, h: 84 },
  files: { w: 380, h: 300 },
  finding: { w: 320, h: 120 },
  placeholder: { w: 320, h: 138 },
} as const;

/** Inner geometry of the change map card: header strip, then the tile field. */
export const mapInset = { top: 52, side: 10, bottom: 10 };

const gap = 16;
const columns = { input: 0, crew: 330, files: 650, findings: 1110 };

const mapHeight = (count: number) =>
  count <= 3 ? 220 : count <= 10 ? 300 : count <= 30 ? 380 : 460;

/**
 * Pipeline layout: frozen input → crew → change map → findings. The change map is one fixed-size
 * treemap whatever the file count, so the board never grows a column per file.
 */
export const layoutBoard = (session: ReviewSession, stats: Stats) => {
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

  const files = session.snapshot.files;
  const map = put('files', 'files', columns.files, 0);
  map.h = mapHeight(files.length);
  const weight = (path: string) => {
    const stat = stats.get(path);
    return Math.max(1, (stat?.added ?? 0) + (stat?.removed ?? 0)) ** 0.7;
  };
  const heaviest = Math.max(1, ...files.map(weight));
  const tiles = squarify(
    files,
    (path) => Math.max(weight(path), heaviest * 0.12),
    map.w - mapInset.side * 2,
    map.h - mapInset.top - mapInset.bottom,
  );
  const tileByPath = new Map(tiles.map((tile) => [tile.item, tile]));

  const findings = sortFindings(session.findings).sort((a, b) => {
    const ta = tileByPath.get(a.file);
    const tb = tileByPath.get(b.file);
    const ca = ta ? ta.y + ta.h / 2 : 0;
    const cb = tb ? tb.y + tb.h / 2 : 0;
    return (
      ca - cb ||
      (ta?.x ?? 0) - (tb?.x ?? 0) ||
      severityMeta[a.severity].rank - severityMeta[b.severity].rank
    );
  });
  findings.forEach((finding, index) => {
    put(
      `finding:${finding.id}`,
      'finding',
      columns.findings,
      index * (sizes.finding.h + gap),
      finding.id,
    );
  });
  if (!session.findings.length) put('placeholder', 'placeholder', columns.findings, 0);

  const ids = (kind: CardKind) => cards.filter((card) => card.kind === kind).map((card) => card.id);
  const sections: Section[] = [
    {
      id: 'input',
      title: 'Frozen input',
      cards: [...ids('snapshot'), ...ids('pr'), ...ids('chat')],
    },
    { id: 'crew', title: 'Crew', count: agents.length, cards: ids('agent') },
    { id: 'files', title: 'Change map', count: files.length, cards: ids('files') },
    {
      id: 'findings',
      title: 'Findings',
      count: session.findings.length,
      cards: [...ids('finding'), ...ids('placeholder')],
    },
  ];
  return { cards, sections, tiles };
};

/** A file tile's rectangle in board coordinates, given the (possibly dragged) map card. */
export const tileRect = (map: CardBox, tile: Tile<string>) => ({
  x: map.x + mapInset.side + tile.x,
  y: map.y + mapInset.top + tile.y,
  w: tile.w,
  h: tile.h,
});

export const worstSeverity = (findings: Finding[]) =>
  findings.reduce<Finding['severity'] | null>(
    (worst, finding) =>
      !worst || severityMeta[finding.severity].rank < severityMeta[worst].rank
        ? finding.severity
        : worst,
    null,
  );

export const boundsOf = (cards: { x: number; y: number; w: number; h: number }[], pad = 0) => {
  if (!cards.length) return { x: 0, y: 0, w: 0, h: 0 };
  const minX = Math.min(...cards.map((card) => card.x));
  const minY = Math.min(...cards.map((card) => card.y));
  const maxX = Math.max(...cards.map((card) => card.x + card.w));
  const maxY = Math.max(...cards.map((card) => card.y + card.h));
  return { x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 };
};
