import { type ReactNode, useState } from 'react';
import { Icon } from './Icon';

/**
 * A small, safe Markdown renderer for model answers. It builds React nodes (never HTML strings),
 * so untrusted model output cannot inject markup. Handles the subset models actually emit:
 * headings, paragraphs, lists, quotes, fenced code, and inline code/bold/italic/links.
 */

type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; ordered: boolean; start: number; items: string[] }
  | { kind: 'quote'; text: string }
  | { kind: 'code'; lang: string; text: string; open: boolean }
  | { kind: 'rule' };

const bullet = /^\s*[-*+]\s+(.*)$/;
const numbered = /^\s*(\d+)[.)]\s+(.*)$/;

const parse = (source: string): Block[] => {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? '';
    const fence = /^\s*(```|~~~)\s*([\w+-]*)/.exec(line);
    if (fence) {
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !(lines[index] ?? '').trim().startsWith(fence[1] ?? '```')) {
        body.push(lines[index] ?? '');
        index += 1;
      }
      // An unclosed fence is normal while an answer is still being revealed.
      blocks.push({
        kind: 'code',
        lang: fence[2] ?? '',
        text: body.join('\n'),
        open: index >= lines.length,
      });
      index += 1;
      continue;
    }
    if (!line.trim()) {
      index += 1;
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1]?.length ?? 1, text: heading[2] ?? '' });
      index += 1;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push({ kind: 'rule' });
      index += 1;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (index < lines.length && /^\s*>/.test(lines[index] ?? '')) {
        body.push((lines[index] ?? '').replace(/^\s*>\s?/, ''));
        index += 1;
      }
      blocks.push({ kind: 'quote', text: body.join(' ') });
      continue;
    }
    const first = bullet.exec(line) ?? numbered.exec(line);
    if (first) {
      const ordered = numbered.test(line);
      const pattern = ordered ? numbered : bullet;
      const items: string[] = [];
      while (index < lines.length) {
        const current = lines[index] ?? '';
        const match = pattern.exec(current);
        if (match) items.push((ordered ? match[2] : match[1]) ?? '');
        else if (current.trim() && /^\s{2,}/.test(current) && items.length)
          items[items.length - 1] += ` ${current.trim()}`;
        else break;
        index += 1;
      }
      blocks.push({
        kind: 'list',
        ordered,
        start: ordered ? Number(numbered.exec(line)?.[1] ?? 1) : 1,
        items,
      });
      continue;
    }
    const body: string[] = [];
    while (index < lines.length) {
      const current = lines[index] ?? '';
      if (
        !current.trim() ||
        /^(#{1,4})\s/.test(current) ||
        /^\s*(```|~~~|>)/.test(current) ||
        bullet.test(current) ||
        numbered.test(current)
      )
        break;
      body.push(current);
      index += 1;
    }
    blocks.push({ kind: 'paragraph', text: body.join('\n') });
  }
  return blocks;
};

const inlinePattern =
  /(`[^`\n]+`)|(\*\*[^*\n]+\*\*|__[^_\n]+__)|(\*[^*\s][^*\n]*\*|_[^_\s][^_\n]*_)|(\[[^\]\n]+\]\([^)\s]+\))/g;

const inline = (text: string, key = ''): ReactNode[] => {
  const nodes: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(inlinePattern)) {
    const at = match.index ?? 0;
    if (at > last) nodes.push(text.slice(last, at));
    const token = match[0];
    const id = `${key}${at}`;
    if (match[1]) nodes.push(<code key={id}>{token.slice(1, -1)}</code>);
    else if (match[2]) nodes.push(<strong key={id}>{inline(token.slice(2, -2), id)}</strong>);
    else if (match[3]) nodes.push(<em key={id}>{inline(token.slice(1, -1), id)}</em>);
    else {
      const [, label = '', href = ''] = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token) ?? [];
      nodes.push(
        /^https?:\/\//.test(href) ? (
          <a key={id} href={href} target="_blank" rel="noreferrer noopener">
            {label}
          </a>
        ) : (
          <span key={id}>{label}</span>
        ),
      );
    }
    last = at + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
};

export const copyText = (text: string) => navigator.clipboard?.writeText(text);

const CodeBlock = ({ lang, text }: { lang: string; text: string }) => {
  const [copied, setCopied] = useState(false);
  return (
    <figure className="md-code">
      <figcaption>
        <span>{lang || 'code'}</span>
        <button
          type="button"
          className={copied ? 'is-done' : ''}
          aria-label="Copy code"
          onClick={() => {
            void copyText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1400);
          }}
        >
          <Icon name={copied ? 'check' : 'copy'} size={12} />
          {copied ? 'Copied' : 'Copy'}
        </button>
      </figcaption>
      <pre>
        <code>{text}</code>
      </pre>
    </figure>
  );
};

export const Markdown = ({ text, className = '' }: { text: string; className?: string }) => (
  <div className={`md ${className}`}>
    {parse(text).map((block, index) => {
      const key = `${block.kind}${index}`;
      switch (block.kind) {
        case 'heading':
          return (
            <p key={key} className={`md-h md-h${block.level}`}>
              {inline(block.text)}
            </p>
          );
        case 'paragraph':
          return <p key={key}>{inline(block.text)}</p>;
        case 'quote':
          return <blockquote key={key}>{inline(block.text)}</blockquote>;
        case 'rule':
          return <hr key={key} />;
        case 'code':
          return <CodeBlock key={key} lang={block.lang} text={block.text} />;
        case 'list': {
          const items = block.items.map((item, at) => <li key={at}>{inline(item, `${at}-`)}</li>);
          return block.ordered ? (
            <ol key={key} start={block.start}>
              {items}
            </ol>
          ) : (
            <ul key={key}>{items}</ul>
          );
        }
      }
    })}
  </div>
);
