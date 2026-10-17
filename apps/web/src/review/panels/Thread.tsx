import { useState } from 'react';
import { api } from '../../api';
import { runIdOf } from '../../lib/meta';
import { useWorkspace } from '../../lib/workspace';
import { Icon } from '../../ui/Icon';
import { Button, Segmented } from '../../ui/primitives';
import { useReview } from '../context';

type Kind = 'note' | 'decision' | 'question';

/** Notes, tracked decisions and model questions, scoped to the session or one finding. */
export const Thread = ({ findingId }: { findingId?: string }) => {
  const { session, interaction, refresh } = useReview();
  const { act, busy, target } = useWorkspace();
  const [text, setText] = useState('');
  const [kind, setKind] = useState<Kind>('question');
  const [model, setModel] = useState(session.target.model);
  const [parentId, setParentId] = useState('');
  const runId = runIdOf(session);
  const messages =
    interaction?.messages.filter(
      (entry) => entry.runId === runId && (entry.findingId ?? '') === (findingId ?? ''),
    ) ?? [];
  const send = () =>
    void act(async () => {
      const current = interaction?.revision ?? 0;
      await api(`/sessions/${session.id}/messages`, {
        method: 'POST',
        body: JSON.stringify({
          revision: current,
          runId,
          text,
          kind,
          ...(findingId
            ? { findingId, citations: [{ runId, snapshotId: session.snapshot.id, findingId }] }
            : {}),
          ...(parentId ? { parentId } : {}),
          ...(kind === 'question' ? { model } : {}),
        }),
      });
      setText('');
      setParentId('');
      await refresh();
    });
  return (
    <div className="thread">
      {messages.length === 0 && (
        <div className="thread-empty">
          <Icon name="chat" size={18} />
          <p>
            {findingId
              ? 'Ask why this matters, how to fix it, or leave a note for future you.'
              : 'Ask the model about the whole review, or keep notes and decisions here.'}
          </p>
          {kind === 'question' && (
            <div className="suggestions">
              {(findingId
                ? [
                    'Is this a real problem?',
                    'Show me a minimal fix',
                    'What tests would catch this?',
                  ]
                : ['What’s the riskiest change here?', 'Summarise this review for a PR description']
              ).map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  className="suggestion"
                  onClick={() => setText(prompt)}
                >
                  {prompt}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      <ol className="messages">
        {messages.map((entry) => (
          <li key={entry.id} className={`message is-${entry.actor} kind-${entry.kind}`}>
            <div className="message-head">
              <span className="who">
                {entry.actor === 'assistant' ? <Icon name="sparkle" size={12} /> : null}
                {entry.actor === 'assistant' ? (entry.target?.model ?? 'Model') : 'You'}
              </span>
              {entry.kind !== 'note' && entry.kind !== 'answer' && (
                <span className="kind">{entry.kind}</span>
              )}
              <time dateTime={entry.createdAt}>
                {new Date(entry.createdAt).toLocaleTimeString()}
              </time>
            </div>
            <p>{entry.text}</p>
            {entry.actor === 'assistant' && (
              <small className="muted">
                Suggestion only. It can’t change files or decide for you.
              </small>
            )}
            <div className="message-actions">
              <button type="button" className="link small" onClick={() => setParentId(entry.id)}>
                Reply
              </button>
              {(['helpful', 'disagree'] as const).map((reaction) => (
                <button
                  key={reaction}
                  type="button"
                  className={`react ${entry.reactions.includes(reaction) ? 'is-on' : ''}`}
                  aria-pressed={entry.reactions.includes(reaction)}
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      await api(`/sessions/${session.id}/messages/${entry.id}/reaction`, {
                        method: 'POST',
                        body: JSON.stringify({ revision: interaction?.revision ?? 0, reaction }),
                      });
                      await refresh();
                    })
                  }
                >
                  {reaction === 'helpful' ? '👍 Helpful' : '👎 Disagree'}
                </button>
              ))}
            </div>
          </li>
        ))}
      </ol>
      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          if (text.trim()) send();
        }}
      >
        <Segmented
          label="Message type"
          value={kind}
          onChange={setKind}
          options={[
            { id: 'question', label: 'Ask AI', icon: 'sparkle' },
            { id: 'note', label: 'Note' },
            { id: 'decision', label: 'Decision' },
          ]}
        />
        {parentId && (
          <p className="replying">
            Replying to a message ·{' '}
            <button type="button" className="link" onClick={() => setParentId('')}>
              cancel
            </button>
          </p>
        )}
        <textarea
          rows={3}
          maxLength={8000}
          value={text}
          aria-label="Message"
          placeholder={kind === 'question' ? 'Ask about this…' : 'Write a note…'}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              if (text.trim()) send();
            }
          }}
        />
        <div className="composer-foot">
          {kind === 'question' ? (
            <label className="composer-model">
              <Icon name={target?.privacy === 'cloud-allowed' ? 'cloud' : 'lock'} size={12} />
              <span>Sent to {target?.endpoint ?? 'configured model'} ·</span>
              <input
                value={model}
                aria-label="Answer model"
                onChange={(event) => setModel(event.target.value)}
              />
            </label>
          ) : (
            <small className="muted">Saved locally with this run.</small>
          )}
          <Button type="submit" variant="primary" size="sm" disabled={busy || !text.trim()}>
            {kind === 'question' ? 'Ask' : 'Save'}
          </Button>
        </div>
      </form>
    </div>
  );
};
