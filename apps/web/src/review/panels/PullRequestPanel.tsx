import type { Interaction, Publication } from '@hunkyard/domain';
import { useState } from 'react';
import { api } from '../../api';
import { isLive, runIdOf, severityMeta, shortSha, statusMeta } from '../../lib/meta';
import { useWorkspace } from '../../lib/workspace';
import { Icon } from '../../ui/Icon';
import { Button, Pill, Switch } from '../../ui/primitives';
import { useReview } from '../context';

export const PullRequestPanel = () => {
  const { session, latest, historical, interaction, status, refresh } = useReview();
  const { act, busy } = useWorkspace();
  const [consent, setConsent] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [preview, setPreview] = useState<Publication | null>(null);
  const pr = session.snapshot.pullRequest;
  if (!pr) return null;
  const headChanged = pr.headSha !== latest.snapshot.pullRequest?.headSha;
  const revision = async () =>
    (await api<Interaction>(`/sessions/${session.id}/interaction`)).revision;
  const publishable = session.findings.filter(
    (finding) => !['fixed', 'dismissed', 'stale'].includes(status(finding)),
  );
  return (
    <div className="pr-panel">
      <div className="pr-head">
        <a href={pr.url} target="_blank" rel="noreferrer" className="pr-link">
          <Icon name="github" size={14} /> {pr.repository} #{pr.number} ↗
        </a>
        <h2>{pr.title}</h2>
        <p className="muted small">
          <Pill tint={pr.state === 'open' ? 'green' : 'gray'}>{pr.state}</Pill> head{' '}
          <code>{shortSha(pr.headSha)}</code> · base <code>{shortSha(pr.baseSha)}</code> · captured{' '}
          {new Date(pr.fetchedAt).toLocaleString()}
        </p>
      </div>
      <p className="note">
        This is a saved copy. Remote changes appear only after an explicit refresh. External gates
        (like Qodo or your org’s review) still need to happen on GitHub — Hunkyard can’t certify
        them.
      </p>
      {headChanged && (
        <p className="note is-warn">
          This run saw an older PR head; inline comments may be outdated.
        </p>
      )}
      {pr.diagnostics.map((entry) => (
        <p key={entry} className="note is-error">
          {entry}
        </p>
      ))}
      <Switch
        checked={consent}
        disabled={busy || historical}
        onChange={setConsent}
        label="Allow GitHub requests"
        hint="Needed to refresh the PR or publish a comment you confirm."
      />
      <Button
        size="sm"
        icon="refresh"
        disabled={busy || !consent || historical || isLive(latest.status)}
        onClick={() =>
          void act(async () => {
            await api(`/sessions/${session.id}/github/refresh`, {
              method: 'POST',
              body: JSON.stringify({ revision: latest.revision, allowGitHub: true }),
            });
            setPreview(null);
            setSelected([]);
            await refresh();
          }, 'PR refreshed; reviewing the new snapshot')
        }
      >
        Refresh PR & review again
      </Button>

      <h3 className="panel-h3">Description</h3>
      <p className="remote-text">{pr.body || 'No description.'}</p>

      {pr.checks.length > 0 && (
        <>
          <h3 className="panel-h3">Checks · {pr.checks.length}</h3>
          <ul className="plain-list">
            {pr.checks.map((entry, index) => (
              <li key={`${entry.name}:${index}`}>
                <Pill
                  tint={
                    entry.conclusion === 'success'
                      ? 'green'
                      : entry.conclusion === 'failure'
                        ? 'red'
                        : 'gray'
                  }
                >
                  {entry.conclusion ?? entry.state}
                </Pill>{' '}
                {entry.url ? (
                  <a href={entry.url} target="_blank" rel="noreferrer">
                    {entry.name}
                  </a>
                ) : (
                  entry.name
                )}
              </li>
            ))}
          </ul>
        </>
      )}

      <h3 className="panel-h3">Discussion · {pr.comments.length}</h3>
      {pr.comments.map((entry) => (
        <article key={`${entry.kind}:${entry.id}`} className="remote-comment">
          <p className="small">
            <a href={entry.url} target="_blank" rel="noreferrer">
              <strong>{entry.author}</strong>
            </a>{' '}
            · {entry.kind} {entry.state ?? ''}
            {(entry.outdated || (entry.kind === 'inline' && headChanged)) && (
              <Pill tint="gray">outdated</Pill>
            )}
          </p>
          {entry.path && (
            <p className="mono small">
              {entry.path}:{entry.line ?? '?'} · {entry.side ?? ''}
            </p>
          )}
          <p className="remote-text">{entry.body || 'No comment body.'}</p>
        </article>
      ))}

      {!historical && session.status === 'completed' && (
        <section className="publish">
          <h3 className="panel-h3">
            <Icon name="chat" size={14} /> Post findings to the PR
          </h3>
          <p className="muted small">
            Pick findings to post as one timeline comment with exact source links. You’ll see the
            exact text first. No approval or inline review is submitted.
          </p>
          {publishable.map((finding) => (
            <label key={finding.id} className="check-row">
              <input
                type="checkbox"
                checked={selected.includes(finding.id)}
                disabled={busy}
                onChange={(event) => {
                  setPreview(null);
                  setSelected(
                    event.target.checked
                      ? [...selected, finding.id]
                      : selected.filter((id) => id !== finding.id),
                  );
                }}
              />
              <Pill tint={severityMeta[finding.severity].tint} dot>
                {severityMeta[finding.severity].label}
              </Pill>
              <span>{finding.title}</span>
              <small>{statusMeta[status(finding)].label}</small>
            </label>
          ))}
          <Button
            size="sm"
            disabled={busy || !selected.length}
            onClick={() =>
              void act(async () => {
                setPreview(
                  await api<Publication>(`/sessions/${session.id}/github/previews`, {
                    method: 'POST',
                    body: JSON.stringify({
                      revision: await revision(),
                      runId: session.runId,
                      findingIds: selected,
                    }),
                  }),
                );
                await refresh();
              })
            }
          >
            Preview comment
          </Button>
          {preview && (
            <div className="confirm-box">
              <p className="small">
                Comment to{' '}
                <strong>
                  {preview.repository} #{preview.number}
                </strong>{' '}
                · {preview.status}
              </p>
              <pre className="block">{preview.body}</pre>
              {preview.url ? (
                <a href={preview.url} target="_blank" rel="noreferrer">
                  Open published comment ↗
                </a>
              ) : (
                <Button
                  variant="primary"
                  size="sm"
                  disabled={busy || !consent}
                  onClick={() =>
                    void act(async () => {
                      try {
                        await api<Publication>(
                          `/sessions/${session.id}/github/publications/${preview.id}`,
                          {
                            method: 'POST',
                            body: JSON.stringify({
                              revision: await revision(),
                              confirm: true,
                              allowGitHub: true,
                            }),
                          },
                        );
                      } finally {
                        const saved = await api<Interaction>(`/sessions/${session.id}/interaction`);
                        setPreview(
                          saved.publications.find((entry) => entry.id === preview.id) ?? preview,
                        );
                        await refresh();
                      }
                    })
                  }
                >
                  {preview.status === 'preview'
                    ? 'Publish this exact comment'
                    : 'Check for publication receipt'}
                </Button>
              )}
              {!consent && (
                <p className="muted small">Turn on “Allow GitHub requests” to publish.</p>
              )}
            </div>
          )}
          {interaction?.publications
            .filter((entry) => entry.runId === runIdOf(session))
            .map((entry) => (
              <p key={entry.id} className="small">
                <Pill tint={entry.status === 'published' ? 'green' : 'gray'}>{entry.status}</Pill>{' '}
                {entry.url ? (
                  <a href={entry.url} target="_blank" rel="noreferrer">
                    Open comment ↗
                  </a>
                ) : (
                  <button type="button" className="link" onClick={() => setPreview(entry)}>
                    Reopen preview
                  </button>
                )}
              </p>
            ))}
        </section>
      )}
    </div>
  );
};
