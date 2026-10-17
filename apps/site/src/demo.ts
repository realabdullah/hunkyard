import { $ } from './dom';

type Severity = 'high' | 'medium' | 'low';
type Reviewer = 'correctness' | 'security' | 'frontend' | 'architecture' | 'testing';
type Finding = {
  id: string;
  reviewer: Reviewer;
  severity: Severity;
  title: string;
  location: string;
  code: { line: number; text: string; flagged?: boolean }[];
  rule: string;
  patch: string[];
};

const scopes = [
  {
    label: 'staged changes',
    title: 'Staged changes',
    meta: '3 files · partial hunks included',
    add: 48,
    del: 12,
    github: false,
  },
  {
    label: 'branch feature/limits',
    title: 'feature/limits vs main',
    meta: '7 files · 4 commits',
    add: 212,
    del: 37,
    github: false,
  },
  {
    label: 'pull request #123',
    title: 'Pull request #123',
    meta: '5 files · fetched with gh',
    add: 131,
    del: 54,
    github: true,
  },
];

// Mirrors the CLI's quick/standard/deep profiles.
const crews: { label: string; reviewers: Reviewer[] }[] = [
  { label: 'standard crew', reviewers: ['correctness', 'security', 'frontend'] },
  {
    label: 'deep crew',
    reviewers: ['correctness', 'security', 'frontend', 'architecture', 'testing'],
  },
  { label: 'quick crew', reviewers: ['correctness'] },
];

const models = [
  {
    label: 'qwen2.5-coder:7b',
    short: 'qwen2.5-coder:7b',
    dest: '127.0.0.1:11434 · Ollama',
    local: true,
  },
  {
    label: 'a model in LM Studio',
    short: 'LM Studio',
    dest: 'localhost:1234 · LM Studio',
    local: true,
  },
  {
    label: 'deepseek-flash',
    short: 'deepseek-flash',
    dest: 'api.deepseek.com · DeepSeek',
    local: false,
  },
];

const findings: Finding[] = [
  {
    id: 'f1',
    reviewer: 'security',
    severity: 'high',
    title: 'Rate-limit key trusts X-Forwarded-For',
    location: 'src/middleware/limit.ts:42',
    code: [
      { line: 41, text: 'export const keyFor = (req: Request) =>' },
      { line: 42, text: "  req.headers['x-forwarded-for'] ?? req.ip;", flagged: true },
      { line: 43, text: '' },
    ],
    rule: 'AGENTS.md › Never trust client IP headers',
    patch: [
      "-  req.headers['x-forwarded-for'] ?? req.ip;",
      '+  req.ip; // trust proxy is set in app.ts',
    ],
  },
  {
    id: 'f2',
    reviewer: 'correctness',
    severity: 'medium',
    title: 'Retry loop never resets its attempt counter',
    location: 'src/queue/worker.ts:118',
    code: [
      { line: 117, text: 'if (ok) {' },
      { line: 118, text: '  queue.ack(job);', flagged: true },
      { line: 119, text: '}' },
    ],
    rule: 'Reviewer default › retries',
    patch: ['   queue.ack(job);', '+  attempts = 0;'],
  },
  {
    id: 'f3',
    reviewer: 'frontend',
    severity: 'low',
    title: 'Icon-only button has no accessible name',
    location: 'web/Toolbar.tsx:31',
    code: [
      { line: 30, text: '<button onClick={onClose}>' },
      { line: 31, text: '  <Icon name="close" />', flagged: true },
      { line: 32, text: '</button>' },
    ],
    rule: 'CLAUDE.md › Every control is labelled',
    patch: ['-<button onClick={onClose}>', '+<button onClick={onClose} aria-label="Close">'],
  },
  {
    id: 'f4',
    reviewer: 'architecture',
    severity: 'medium',
    title: 'Order loader queries inside a loop',
    location: 'src/orders/load.ts:27',
    code: [
      { line: 26, text: 'for (const order of orders)' },
      { line: 27, text: '  order.items = await db.items(order.id);', flagged: true },
      { line: 28, text: '' },
    ],
    rule: 'Reviewer default › performance',
    patch: [
      '-for (const order of orders)',
      '+const items = await db.itemsFor(orders.map((o) => o.id));',
    ],
  },
  {
    id: 'f5',
    reviewer: 'testing',
    severity: 'low',
    title: 'No test covers the partial-refund path',
    location: 'src/billing/refund.ts:64',
    code: [
      { line: 63, text: 'if (amount < charge.total) {' },
      { line: 64, text: '  return partialRefund(charge, amount);', flagged: true },
      { line: 65, text: '}' },
    ],
    rule: 'packages/billing/AGENTS.md › Refunds need tests',
    patch: ["+it('refunds part of a charge', async () => { … });"],
  },
];

const severityBadge: Record<Severity, [string, string]> = {
  high: ['High', 'badge-red'],
  medium: ['Medium', 'badge-yellow'],
  low: ['Low', 'badge-gray'],
};

const escape = (text: string) =>
  text.replace(
    /[&<>"]/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char] ?? char,
  );

/** The interactive review on the canvas. `onLayout` runs whenever card positions may have moved. */
export const initDemo = (onLayout: () => void) => {
  const state = { scope: 0, crew: 0, model: 0, selected: 'f1', patched: new Set<string>() };
  const current = () => ({
    scope: scopes[state.scope] ?? scopes[0]!,
    crew: crews[state.crew] ?? crews[0]!,
    model: models[state.model] ?? models[0]!,
  });
  const visible = () =>
    findings.filter((finding) => current().crew.reviewers.includes(finding.reviewer));

  const renderLauncher = () => {
    const { scope, crew, model } = current();
    $('[data-token="scope"]').textContent = scope.label;
    $('[data-token="crew"]').textContent = crew.label;
    $('[data-token="model"]').textContent = model.label;
    const destinations = [{ dest: model.dest, local: model.local }];
    if (scope.github) destinations.push({ dest: 'api.github.com · GitHub', local: false });
    const blocked = destinations.some((item) => !item.local);
    $('#route-dest').textContent = destinations.map((item) => item.dest).join('  +  ');
    const badge = $('#route-badge');
    badge.textContent = blocked ? 'Needs consent for this repository' : 'Local-only';
    badge.className = `badge ${blocked ? 'badge-orange' : 'badge-green'}`;
    const run = $('#run');
    run.setAttribute('aria-disabled', String(blocked));
    run.textContent = blocked ? 'Blocked in local-only mode' : 'Start review';
  };

  const renderSnapshot = () => {
    const { scope, crew, model } = current();
    $('#snap-title').textContent = scope.title;
    $('#snap-meta').textContent = scope.meta;
    $('#snap-add').textContent = `+${scope.add}`;
    $('#snap-del').textContent = `−${scope.del}`;
    $('#crew-model').textContent = model.short;
    $('#crew-list').innerHTML = crew.reviewers.map((reviewer) => `<li>${reviewer}</li>`).join('');
  };

  const renderEvidence = () => {
    const finding = findings.find((item) => item.id === state.selected);
    if (!finding) return;
    const { model } = current();
    $('#ev-loc').textContent = finding.location;
    $('#ev-code').innerHTML = finding.code
      .map(
        (row) =>
          `<span class="ln${row.flagged ? ' flagged' : ''}"><span class="num">${row.line}</span>${escape(row.text) || ' '}</span>`,
      )
      .join('');
    const provenance: [string, string][] = [
      ['Snapshot', '7f3a91c'],
      ['Reviewer', finding.reviewer],
      ['Model', `${model.short} · ${model.local ? 'local' : 'hosted'}`],
      ['Rule', finding.rule],
    ];
    $('#ev-prov').innerHTML = provenance
      .map(([term, value]) => `<div><dt>${term}</dt><dd>${escape(value)}</dd></div>`)
      .join('');
    $('#ev-patch').innerHTML = finding.patch
      .map((line) => {
        const kind = line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : '';
        return `<span class="ln ${kind}">${escape(line)}</span>`;
      })
      .join('');
    const patched = state.patched.has(finding.id);
    const badge = $('#patch-state');
    badge.textContent = patched ? 'Applied after approval' : 'Awaiting your approval';
    badge.className = `badge ${patched ? 'badge-green' : 'badge-gray'}`;
    $<HTMLButtonElement>('#patch-approve').disabled = patched;
  };

  const renderFindings = (animate = false) => {
    const list = visible();
    if (!list.some((finding) => finding.id === state.selected)) state.selected = list[0]?.id ?? '';
    $('#findings').innerHTML = list
      .map((finding, index) => {
        const [label, tone] = severityBadge[finding.severity];
        return `
        <button type="button" role="option" class="node finding${animate ? ' enter' : ''}"
          data-id="${finding.id}" aria-selected="${finding.id === state.selected}" style="--i:${index}">
          <span class="finding-top">
            <span class="badge ${tone}">${label}</span>
            <span class="finding-who">${finding.reviewer}</span>
            ${state.patched.has(finding.id) ? '<span class="badge badge-green">Fixed</span>' : ''}
          </span>
          <span class="finding-title">${escape(finding.title)}</span>
          <span class="finding-loc mono">${escape(finding.location)}</span>
        </button>`;
      })
      .join('');
    renderEvidence();
    requestAnimationFrame(onLayout);
  };

  const select = (id: string, focus = false) => {
    state.selected = id;
    for (const node of Array.from($('#findings').children))
      node.setAttribute('aria-selected', String(node.getAttribute('data-id') === id));
    renderEvidence();
    onLayout();
    if (focus) $<HTMLElement>(`[data-id="${id}"]`).focus();
  };

  for (const token of Array.from(document.querySelectorAll<HTMLButtonElement>('[data-token]'))) {
    token.addEventListener('click', () => {
      const key = token.dataset.token as 'scope' | 'crew' | 'model';
      const length = { scope: scopes.length, crew: crews.length, model: models.length }[key];
      state[key] = (state[key] + 1) % length;
      renderLauncher();
      renderSnapshot();
      renderFindings(key !== 'model');
    });
  }

  $('#run').addEventListener('click', () => {
    if ($('#run').getAttribute('aria-disabled') === 'true') {
      const badge = $('#route-badge');
      badge.classList.remove('nudge');
      void badge.offsetWidth;
      badge.classList.add('nudge');
      return;
    }
    state.patched.clear();
    renderFindings(true);
  });

  $('#findings').addEventListener('click', (event) => {
    const id = (event.target as Element).closest<HTMLElement>('[data-id]')?.dataset.id;
    if (id) select(id);
  });

  $('#findings').addEventListener('keydown', (event) => {
    const step = { ArrowDown: 1, j: 1, ArrowUp: -1, k: -1 }[event.key];
    if (!step) return;
    event.preventDefault();
    event.stopPropagation();
    const list = visible();
    const index = list.findIndex((finding) => finding.id === state.selected);
    const next = list[(index + step + list.length) % list.length];
    if (next) select(next.id, true);
  });

  $('#patch-approve').addEventListener('click', () => {
    state.patched.add(state.selected);
    renderFindings();
  });

  $('#patch-preview').addEventListener('click', () => {
    $('#patch-state').textContent = '1 file changes · nothing staged or committed';
  });

  renderLauncher();
  renderSnapshot();
  renderFindings();
};
