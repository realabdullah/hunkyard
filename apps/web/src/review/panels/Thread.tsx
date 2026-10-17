import type { Interaction } from '@hunkyard/domain';
import { useEffect, useRef, useState } from 'react';
import { api, eventStream, sseFrames } from '../../api';
import { runIdOf } from '../../lib/meta';
import { useWorkspace } from '../../lib/workspace';
import { Icon, type IconName } from '../../ui/Icon';
import { copyText, Markdown } from '../../ui/Markdown';
import { Kbd } from '../../ui/primitives';
import { useReview } from '../context';

type Kind = 'note' | 'decision' | 'question';
type Message = Interaction['messages'][number];

const kinds: { id: Kind; label: string; icon: IconName; hint: string }[] = [
  { id: 'question', label: 'Ask AI', icon: 'sparkle', hint: 'Sent to the model below' },
  { id: 'note', label: 'Note', icon: 'chat', hint: 'Saved locally with this run' },
  { id: 'decision', label: 'Decision', icon: 'check', hint: 'A tracked call, saved locally' },
];

const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** What was just sent, shown immediately while the request is in flight. */
type Pending = {
  text: string;
  kind: Kind;
  parentId: string;
  model: string;
  at: number;
  /** Message ids present at send time, to spot the saved echo. */
  known: Set<string>;
};

const calm = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Fallback for answers that arrive whole (another tab, or a reload mid-answer): plays them in
 * roughly word by word, finishing within ~1.6s whatever the length. Streamed answers skip it.
 */
const useReveal = (text: string, active: boolean, onTick: () => void) => {
  const [shown, setShown] = useState(active && !calm() ? 0 : text.length);
  const tick = useRef(onTick);
  tick.current = onTick;
  useEffect(() => {
    if (!active || calm()) return setShown(text.length);
    let frame = 0;
    let at = 0;
    const step = Math.max(2, Math.ceil(text.length / 95));
    const advance = () => {
      at = Math.min(text.length, at + step);
      // Land on a word boundary so half-words never flash.
      const space = text.indexOf(' ', at);
      const next = space === -1 || space - at > 12 ? at : space;
      at = next;
      setShown(next);
      tick.current();
      if (next < text.length) frame = requestAnimationFrame(advance);
    };
    frame = requestAnimationFrame(advance);
    return () => cancelAnimationFrame(frame);
  }, [text, active]);
  return {
    shown: text.slice(0, shown),
    done: shown >= text.length,
    skip: () => setShown(text.length),
  };
};

const Answer = ({
  text,
  reveal,
  onTick,
}: {
  text: string;
  reveal: boolean;
  onTick: () => void;
}) => {
  const { shown, done, skip } = useReveal(text, reveal, onTick);
  return (
    <div className={`msg-answer ${done ? '' : 'is-typing'}`} onClick={done ? undefined : skip}>
      <Markdown text={shown} />
    </div>
  );
};

/** The in-flight answer: a thinking row until the first token, then the live text. */
const Thinking = ({
  model,
  since,
  local,
  live,
}: {
  model: string;
  since: number;
  local: boolean;
  live: string;
}) => {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - since) / 1000)), 250);
    return () => clearInterval(timer);
  }, [since]);
  // Before the first token, a single quiet line in the answer's place, as AI chats do.
  if (!live)
    return (
      <li className="msg is-assistant is-thinking" aria-live="polite">
        <div className="thinking">
          <span className="msg-avatar is-ai is-busy">
            <Icon name="sparkle" size={12} />
          </span>
          <span className="thinking-label">
            {elapsed < 12
              ? 'Thinking'
              : local
                ? 'Still thinking, local models take a while'
                : 'Still thinking'}
          </span>
          {elapsed >= 3 && <time className="thinking-time">{elapsed}s</time>}
        </div>
      </li>
    );
  return (
    <li className="msg is-assistant is-streaming">
      <div className="msg-card">
        <div className="msg-head">
          <span className="msg-avatar is-ai is-busy">
            <Icon name="sparkle" size={12} />
          </span>
          <strong>{model || 'Model'}</strong>
          <span className={`msg-dest ${local ? 'is-local' : 'is-cloud'}`}>
            <Icon name={local ? 'lock' : 'cloud'} size={11} />
            {local ? 'local' : 'cloud'}
          </span>
          <time>{elapsed}s</time>
        </div>
        <div className="msg-answer is-typing">
          <Markdown text={live} />
        </div>
      </div>
    </li>
  );
};

/** Notes, tracked decisions and model questions, scoped to the session or one finding. */
export const Thread = ({ findingId }: { findingId?: string }) => {
  const { session, interaction, refresh } = useReview();
  const { act, busy, target } = useWorkspace();
  const [text, setText] = useState('');
  const [kind, setKind] = useState<Kind>('question');
  const [model, setModel] = useState(session.target.model);
  const [parentId, setParentId] = useState('');
  const [sending, setSending] = useState<Pending | null>(null);
  const [copied, setCopied] = useState('');
  /** Answer text received so far for the question in flight. */
  const [live, setLive] = useState('');
  /** Cancels the answer in flight; the question itself stays saved. */
  const stopper = useRef<AbortController | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const end = useRef<HTMLDivElement>(null);
  /** Ids present when the thread opened; answers that arrive later are revealed, not dumped. */
  const initial = useRef<Set<string> | null>(null);
  if (!initial.current && interaction)
    initial.current = new Set(interaction.messages.map((entry) => entry.id));
  const runId = runIdOf(session);
  const messages =
    interaction?.messages.filter(
      (entry) => entry.runId === runId && (entry.findingId ?? '') === (findingId ?? ''),
    ) ?? [];
  const roots = messages.filter(
    (entry) => !entry.parentId || !messages.some((other) => other.id === entry.parentId),
  );
  const repliesTo = (id: string) => messages.filter((entry) => entry.parentId === id);
  const parent = messages.find((entry) => entry.id === parentId);
  // Hand over to the saved message the moment it lands, so the two never show together.
  const echo = sending
    ? messages.find(
        (entry) =>
          entry.actor === 'user' && entry.text === sending.text && !sending.known.has(entry.id),
      )
    : undefined;
  const pending = sending && !echo ? sending : null;
  const follow = () => end.current?.scrollIntoView({ block: 'nearest' });
  useEffect(() => {
    if (messages.length || pending)
      end.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [messages.length, pending]);
  useEffect(() => {
    const element = input.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(200, element.scrollHeight)}px`;
  }, [text]);
  const send = () => {
    const draft = text.trim();
    if (!draft || sending) return;
    setSending({
      text: draft,
      kind,
      parentId,
      model,
      at: Date.now(),
      known: new Set(messages.map((entry) => entry.id)),
    });
    setText('');
    setParentId('');
    void act(async () => {
      const body = JSON.stringify({
        revision: interaction?.revision ?? 0,
        runId,
        text: draft,
        kind,
        ...(findingId
          ? { findingId, citations: [{ runId, snapshotId: session.snapshot.id, findingId }] }
          : {}),
        ...(parentId ? { parentId } : {}),
        ...(kind === 'question' ? { model } : {}),
      });
      if (kind === 'question') await stream(body);
      else await api(`/sessions/${session.id}/messages`, { method: 'POST', body });
      await refresh();
    }).then(async (ok) => {
      // Questions are saved before the model is called, so a failed answer still leaves the
      // question in the thread; only restore the draft when nothing was saved.
      if (!ok) {
        await refresh().catch(() => undefined);
        if (kind !== 'question') setText((current) => current || draft);
      }
      setSending(null);
      setLive('');
    });
  };
  /** Posts a question and shows the answer token by token as the model writes it. */
  const stream = async (body: string) => {
    const controller = new AbortController();
    stopper.current = controller;
    const response = await eventStream(
      `/sessions/${session.id}/messages/stream`,
      controller.signal,
      { method: 'POST', body },
    ).catch((error: unknown) => {
      if (controller.signal.aborted) return null;
      throw error;
    });
    if (!response) return;
    if (!response.ok || !response.body) {
      const problem = (await response.json().catch(() => ({}))) as { title?: string };
      throw new Error(problem.title ?? 'Request failed');
    }
    // Coalesce tokens to one render per frame; long answers can arrive faster than they paint.
    let text = '';
    let frame = 0;
    const paint = () => {
      frame = 0;
      setLive(text);
      follow();
    };
    try {
      for await (const { event, data } of sseFrames(response.body)) {
        const payload = JSON.parse(data) as { text?: string; title?: string } & Interaction;
        if (event === 'delta' && payload.text) {
          text += payload.text;
          frame ||= requestAnimationFrame(paint);
        } else if (event === 'error') throw new Error(payload.title ?? 'Request failed');
        else if (event === 'done') {
          // Already seen live, so the saved copy must not replay through the reveal.
          const answer = payload.messages.at(-1);
          if (answer?.actor === 'assistant') initial.current?.add(answer.id);
          return;
        }
      }
    } catch (error) {
      // Stopped by the user: not a failure, and nothing partial is kept.
      if (controller.signal.aborted) return;
      throw error;
    } finally {
      cancelAnimationFrame(frame);
      stopper.current = null;
    }
    if (controller.signal.aborted) return;
    throw new Error('Answer stream closed early. Question remains saved.');
  };
  const react = (entry: Message, reaction: 'helpful' | 'disagree') =>
    void act(async () => {
      await api(`/sessions/${session.id}/messages/${entry.id}/reaction`, {
        method: 'POST',
        body: JSON.stringify({ revision: interaction?.revision ?? 0, reaction }),
      });
      await refresh();
    });
  const suggestions = findingId
    ? ['Is this a real problem?', 'Show me a minimal fix', 'What tests would catch this?']
    : [
        'What’s the riskiest change here?',
        'Summarise this review for a PR description',
        'Which finding should I fix first?',
      ];
  const local = target?.privacy !== 'cloud-allowed';
  const mode = kinds.find((entry) => entry.id === kind) ?? kinds[0];

  const bubble = (entry: Message, depth = 0) => (
    <li key={entry.id} className={`msg is-${entry.actor} kind-${entry.kind}`}>
      <div className="msg-card">
        <div className="msg-head">
          <span className={`msg-avatar ${entry.actor === 'assistant' ? 'is-ai' : ''}`}>
            {entry.actor === 'assistant' ? (
              <Icon name="sparkle" size={12} />
            ) : entry.kind === 'decision' ? (
              <Icon name="check" size={12} />
            ) : (
              'Y'
            )}
          </span>
          <strong>{entry.actor === 'assistant' ? (entry.target?.model ?? 'Model') : 'You'}</strong>
          {entry.kind === 'decision' && <span className="msg-kind">Decision</span>}
          {entry.kind === 'question' && <span className="msg-kind">Asked AI</span>}
          {entry.actor === 'assistant' && entry.target && (
            <span
              className={`msg-dest ${entry.target.privacy === 'cloud-allowed' ? 'is-cloud' : 'is-local'}`}
              title={entry.target.endpoint}
            >
              <Icon name={entry.target.privacy === 'cloud-allowed' ? 'cloud' : 'lock'} size={11} />
              {entry.target.privacy === 'cloud-allowed' ? 'cloud' : 'local'}
            </span>
          )}
          <time dateTime={entry.createdAt}>{clock(entry.createdAt)}</time>
        </div>
        {entry.actor === 'assistant' ? (
          <Answer text={entry.text} reveal={!initial.current?.has(entry.id)} onTick={follow} />
        ) : (
          <p className="msg-text">{entry.text}</p>
        )}
        {entry.actor === 'assistant' && (
          <small className="msg-fine">
            Suggestion only. It can’t change files or decide for you.
          </small>
        )}
        <div className="msg-actions">
          {depth === 0 && (
            <button
              type="button"
              className="msg-act"
              onClick={() => {
                setParentId(entry.id);
                input.current?.focus();
              }}
            >
              <Icon name="arrowLeft" size={12} /> Reply
            </button>
          )}
          {entry.actor === 'assistant' && (
            <button
              type="button"
              className={`msg-act ${copied === entry.id ? 'is-on' : ''}`}
              onClick={() => {
                void copyText(entry.text);
                setCopied(entry.id);
                setTimeout(
                  () => setCopied((current) => (current === entry.id ? '' : current)),
                  1400,
                );
              }}
            >
              <Icon name={copied === entry.id ? 'check' : 'copy'} size={12} />
              {copied === entry.id ? 'Copied' : 'Copy'}
            </button>
          )}
          {(['helpful', 'disagree'] as const).map((reaction) => (
            <button
              key={reaction}
              type="button"
              className={`msg-act react ${entry.reactions.includes(reaction) ? 'is-on' : ''}`}
              aria-pressed={entry.reactions.includes(reaction)}
              disabled={busy}
              onClick={() => react(entry, reaction)}
            >
              {reaction === 'helpful' ? '👍 Helpful' : '👎 Disagree'}
            </button>
          ))}
        </div>
      </div>
      {(repliesTo(entry.id).length > 0 || pending?.parentId === entry.id) && (
        <ol className="msg-replies">
          {repliesTo(entry.id).map((reply) => bubble(reply, depth + 1))}
          {pending?.parentId === entry.id && outgoing(pending)}
        </ol>
      )}
      {sending?.kind === 'question' &&
        echo?.id === entry.id &&
        repliesTo(entry.id).length === 0 && (
          <ol className="msg-replies">
            <Thinking model={sending.model} since={sending.at} local={local} live={live} />
          </ol>
        )}
    </li>
  );

  /** The just-sent message, plus a live thinking row nested where the answer will land. */
  const outgoing = (draft: Pending) => (
    <li key="pending" className={`msg is-user kind-${draft.kind} is-pending`}>
      <div className="msg-card">
        <div className="msg-head">
          <span className="msg-avatar">
            {draft.kind === 'decision' ? <Icon name="check" size={12} /> : 'Y'}
          </span>
          <strong>You</strong>
          {draft.kind === 'decision' && <span className="msg-kind">Decision</span>}
          {draft.kind === 'question' && <span className="msg-kind">Asked AI</span>}
          <time className="msg-sending">{draft.kind === 'question' ? 'sent' : 'saving…'}</time>
        </div>
        <p className="msg-text">{draft.text}</p>
      </div>
      {draft.kind === 'question' && (
        <ol className="msg-replies">
          <Thinking model={draft.model} since={draft.at} local={local} live={live} />
        </ol>
      )}
    </li>
  );

  return (
    <div className="thread">
      {messages.length === 0 && !pending ? (
        <div className="thread-empty">
          <span className="thread-orb" aria-hidden="true">
            <Icon name="sparkle" size={18} />
          </span>
          <h3>{findingId ? 'Challenge this finding' : 'Talk through this review'}</h3>
          <p>
            {findingId
              ? 'Ask why it matters or how to fix it, or leave a note for future you.'
              : 'Ask the model about the whole review, or keep notes and decisions here.'}
          </p>
          <div className="suggestions">
            {suggestions.map((prompt) => (
              <button
                key={prompt}
                type="button"
                className="suggestion"
                onClick={() => {
                  setKind('question');
                  setText(prompt);
                  input.current?.focus();
                }}
              >
                <Icon name="sparkle" size={13} />
                <span>{prompt}</span>
                <Icon name="arrowRight" size={13} />
              </button>
            ))}
          </div>
        </div>
      ) : (
        <ol className="messages" aria-label="Messages">
          {roots.map((entry) => bubble(entry))}
          {pending && !pending.parentId && outgoing(pending)}
        </ol>
      )}
      <div ref={end} />
      <form
        className={`composer mode-${kind}`}
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        {parent && (
          <p className="replying">
            <Icon name="arrowLeft" size={12} /> Replying to “{parent.text.slice(0, 60)}
            {parent.text.length > 60 ? '…' : ''}”
            <button type="button" className="link" onClick={() => setParentId('')}>
              Cancel
            </button>
          </p>
        )}
        <div className="composer-modes" role="radiogroup" aria-label="Message type">
          {kinds.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="radio"
              aria-checked={kind === entry.id}
              className={kind === entry.id ? 'is-on' : ''}
              onClick={() => setKind(entry.id)}
            >
              <Icon name={entry.icon} size={12} /> {entry.label}
            </button>
          ))}
        </div>
        <textarea
          ref={input}
          rows={2}
          maxLength={8000}
          value={text}
          aria-label="Message"
          placeholder={
            kind === 'question'
              ? findingId
                ? 'Ask about this finding…'
                : 'Ask about this review…'
              : kind === 'decision'
                ? 'Record a decision…'
                : 'Write a note…'
          }
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              send();
            }
          }}
        />
        <div className="composer-foot">
          {kind === 'question' ? (
            <label className="composer-model" title={target?.endpoint}>
              <Icon name={local ? 'lock' : 'cloud'} size={12} />
              <span>{target?.endpoint ?? 'configured model'}</span>
              <input
                value={model}
                aria-label="Answer model"
                onChange={(event) => setModel(event.target.value)}
                style={{ width: `${Math.max(8, model.length + 1)}ch` }}
              />
            </label>
          ) : (
            <small className="composer-local">
              <Icon name="lock" size={12} /> {mode?.hint}
            </small>
          )}
          {sending?.kind === 'question' ? (
            <button
              type="button"
              className="composer-send is-stop"
              aria-label="Stop answer"
              title="Stop answer"
              onClick={() => stopper.current?.abort()}
            >
              <span className="composer-stop" aria-hidden="true" />
            </button>
          ) : (
            <button
              type="submit"
              className={`composer-send ${sending ? 'is-busy' : ''}`}
              disabled={busy || Boolean(sending) || !text.trim()}
              aria-label={sending ? 'Saving' : undefined}
            >
              {sending ? (
                <span className="composer-spin" aria-hidden="true" />
              ) : (
                <>
                  {kind === 'question' ? 'Ask' : 'Save'}
                  <Kbd>⌘↵</Kbd>
                </>
              )}
            </button>
          )}
        </div>
      </form>
    </div>
  );
};
