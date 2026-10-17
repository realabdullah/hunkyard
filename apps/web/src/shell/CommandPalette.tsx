import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon, type IconName } from '../ui/Icon';
import { Kbd } from '../ui/primitives';

export type Command = {
  id: string;
  label: string;
  hint?: string;
  icon: IconName;
  group: string;
  kbd?: string;
  run: () => void;
};

const score = (text: string, query: string) => {
  const haystack = text.toLowerCase();
  const needle = query.toLowerCase().trim();
  if (!needle) return 1;
  if (haystack.includes(needle)) return 2 - haystack.indexOf(needle) / 1000;
  let index = 0;
  for (const char of needle) {
    index = haystack.indexOf(char, index);
    if (index < 0) return 0;
    index += 1;
  }
  return 0.5;
};

export const CommandPalette = ({ commands, close }: { commands: Command[]; close: () => void }) => {
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useMemo(
    () =>
      commands
        .map((command) => ({
          command,
          score: score(`${command.label} ${command.hint ?? ''}`, query),
        }))
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score)
        .map((entry) => entry.command),
    [commands, query],
  );
  useEffect(() => input.current?.focus(), []);
  useEffect(() => setCursor(0), [query]);
  const pick = (command: Command | undefined) => {
    if (!command) return;
    close();
    command.run();
  };
  let lastGroup = '';
  return (
    <div className="palette-backdrop" onPointerDown={close}>
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="palette-input">
          <Icon name="search" />
          <input
            ref={input}
            value={query}
            placeholder="Jump to a review or run a command…"
            aria-label="Search commands"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') close();
              else if (event.key === 'ArrowDown') {
                event.preventDefault();
                setCursor((value) => Math.min(value + 1, list.length - 1));
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                setCursor((value) => Math.max(value - 1, 0));
              } else if (event.key === 'Enter') pick(list[cursor]);
            }}
          />
          <Kbd>esc</Kbd>
        </div>
        <div className="palette-list" role="listbox">
          {list.length === 0 && <p className="palette-empty">Nothing matches “{query}”.</p>}
          {list.map((command, index) => {
            const header = command.group !== lastGroup ? command.group : null;
            lastGroup = command.group;
            return (
              <div key={command.id}>
                {header && <div className="palette-group">{header}</div>}
                <button
                  type="button"
                  role="option"
                  aria-selected={index === cursor}
                  className={`palette-item ${index === cursor ? 'is-on' : ''}`}
                  onPointerMove={() => setCursor(index)}
                  onClick={() => pick(command)}
                >
                  <Icon name={command.icon} />
                  <span>{command.label}</span>
                  {command.hint && <small>{command.hint}</small>}
                  {command.kbd && <Kbd>{command.kbd}</Kbd>}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export const ShortcutHelp = ({ close }: { close: () => void }) => {
  const groups: [string, [string, string][]][] = [
    [
      'Everywhere',
      [
        ['⌘K', 'Search & commands'],
        ['N', 'New review'],
        ['?', 'This cheat sheet'],
      ],
    ],
    [
      'On a board',
      [
        ['B / T', 'Board or triage view'],
        ['Space + drag', 'Pan the canvas'],
        ['⌘ + scroll', 'Zoom'],
        ['0', 'Fit everything'],
        ['Esc', 'Close the side panel'],
      ],
    ],
    [
      'Triage',
      [
        ['J / K', 'Next / previous finding'],
        ['A', 'Will fix'],
        ['F', 'Mark fixed'],
        ['I', 'Investigating'],
        ['D', 'Dismiss (then 1–5 for reason)'],
        ['U', 'Reopen'],
      ],
    ],
  ];
  return (
    <div className="palette-backdrop" onPointerDown={close}>
      <div
        className="palette shortcuts"
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Escape') close();
        }}
      >
        <header>
          <h2>Keyboard shortcuts</h2>
          <button type="button" className="icon-btn" aria-label="Close" onClick={close} autoFocus>
            <Icon name="close" />
          </button>
        </header>
        <div className="shortcut-grid">
          {groups.map(([title, rows]) => (
            <section key={title}>
              <h3>{title}</h3>
              {rows.map(([key, label]) => (
                <p key={label}>
                  <span>{label}</span>
                  <Kbd>{key}</Kbd>
                </p>
              ))}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
};
