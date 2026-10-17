import type { Interaction } from '@reviewlab/domain';
import { useState } from 'react';
import { api } from '../../api';
import { isLive, runIdOf } from '../../lib/meta';
import { useWorkspace } from '../../lib/workspace';
import { Icon } from '../../ui/Icon';
import { Button, Pill, Switch } from '../../ui/primitives';
import { useReview } from '../context';

type Patch = Interaction['patches'][number];
const patchTint = {
  proposed: 'blue',
  approved: 'purple',
  applying: 'orange',
  applied: 'green',
  conflict: 'red',
} as const;

/**
 * Propose → preview → approve → apply. Each step is explicit; nothing is written to the
 * working tree until the user approves the exact patch and destination.
 */
export const PatchFlow = ({ file, findingId }: { file: string; findingId?: string }) => {
  const { session, interaction, refresh } = useReview();
  const { act, busy, target } = useWorkspace();
  const change = session.snapshot.changes.find((entry) => entry.newPath === file);
  const eligible = Boolean(
    change && !change.binary && ['100644', '100755'].includes(change.newMode ?? ''),
  );
  const original =
    session.snapshot.sources.find((entry) => entry.oid === change?.newOid)?.text ?? '';
  const [editing, setEditing] = useState(false);
  const [replacement, setReplacement] = useState(original);
  const runId = runIdOf(session);
  const patches =
    interaction?.patches.filter((entry) => entry.runId === runId && entry.file === file) ?? [];
  const revision = async () =>
    (await api<Interaction>(`/sessions/${session.id}/interaction`)).revision;
  if (!eligible)
    return (
      <p className="muted small">
        Patches work on changed text files that still exist after the change.
      </p>
    );
  return (
    <div className="patch-flow">
      <div className="patch-start">
        <Button
          variant="primary"
          size="sm"
          icon="sparkle"
          disabled={busy}
          onClick={() =>
            void act(async () => {
              await api(`/sessions/${session.id}/patches/draft`, {
                method: 'POST',
                body: JSON.stringify({ revision: await revision(), runId, file }),
              });
              await refresh();
            }, 'Draft ready — preview it below')
          }
        >
          Draft a fix with AI
        </Button>
        <Button size="sm" variant="ghost" icon="wrench" onClick={() => setEditing(!editing)}>
          {editing ? 'Close editor' : 'Write it myself'}
        </Button>
      </div>
      <p className="muted small">
        <Icon name={target?.privacy === 'cloud-allowed' ? 'cloud' : 'lock'} size={12} /> AI drafts
        go to {target?.endpoint}. Every patch is previewed against the frozen snapshot and needs
        your approval.
      </p>
      {editing && (
        <div className="patch-editor">
          <textarea
            value={replacement}
            maxLength={50000}
            rows={14}
            spellCheck={false}
            aria-label={`Full replacement for ${file}`}
            onChange={(event) => setReplacement(event.target.value)}
          />
          <Button
            size="sm"
            disabled={busy || replacement === original}
            onClick={() =>
              void act(async () => {
                await api(`/sessions/${session.id}/patches`, {
                  method: 'POST',
                  body: JSON.stringify({
                    revision: await revision(),
                    runId,
                    file,
                    replacement,
                    ...(findingId ? { findingId } : {}),
                  }),
                });
                setEditing(false);
                await refresh();
              }, 'Patch preview created')
            }
          >
            Create preview
          </Button>
        </div>
      )}
      {patches.map((patch) => (
        <PatchCard key={patch.id} patch={patch} />
      ))}
    </div>
  );
};

const PatchCard = ({ patch }: { patch: Patch }) => {
  const { session, latest, refresh } = useReview();
  const { act, busy } = useWorkspace();
  const [isolated, setIsolated] = useState(false);
  const [effects, setEffects] = useState<string | null>(null);
  const revision = async () =>
    (await api<Interaction>(`/sessions/${session.id}/interaction`)).revision;
  const steps = ['Preview', 'Approve', 'Apply'];
  const step =
    patch.status === 'proposed' ? (effects ? 1 : 0) : patch.status === 'approved' ? 2 : 3;
  return (
    <div className="patch-card">
      <header>
        <strong>{patch.file}</strong>
        <Pill tint={patchTint[patch.status]}>{patch.status}</Pill>
      </header>
      <ol className="stepper">
        {steps.map((name, index) => (
          <li key={name} className={index < step ? 'is-done' : index === step ? 'is-now' : ''}>
            <span>{index < step ? <Icon name="check" size={11} /> : index + 1}</span>
            {name}
          </li>
        ))}
      </ol>
      <pre
        className="patch-preview no-canvas-scroll"
        tabIndex={0}
        aria-label={`Patch preview for ${patch.file}`}
      >
        {patch.preview.split('\n').map((line, index) => (
          <span
            key={index}
            className={
              line.startsWith('+') && !line.startsWith('+++')
                ? 'add'
                : line.startsWith('-') && !line.startsWith('---')
                  ? 'del'
                  : ''
            }
          >
            {line || ' '}
            {'\n'}
          </span>
        ))}
      </pre>
      {patch.error && (
        <p className="note is-error" role="alert">
          {patch.error}
        </p>
      )}
      {patch.status === 'applying' && (
        <p className="note is-warn" role="alert">
          Applying was interrupted or is still running. Check the file, backup and worktree before
          going on — this approval can’t be replayed.
        </p>
      )}
      {patch.destination && (
        <p className="note is-ok">
          <Icon name="check" size={13} /> Applied at <code>{patch.destination}</code>. Backup:{' '}
          <code>{patch.backup}</code>. Re-review to confirm the finding is gone.
        </p>
      )}
      {patch.status === 'proposed' && (
        <div className="patch-actions">
          <Switch
            checked={isolated}
            onChange={(value) => {
              setIsolated(value);
              setEffects(null);
            }}
            label="Apply in an isolated worktree"
            hint="Try it without touching your working copy."
          />
          {effects ? (
            <div className="confirm-box">
              <p>{effects}</p>
              <Button
                variant="primary"
                size="sm"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    await api(`/sessions/${session.id}/patches/${patch.id}/approve`, {
                      method: 'POST',
                      body: JSON.stringify({
                        revision: await revision(),
                        approved: true,
                        isolated,
                      }),
                    });
                    setEffects(null);
                    await refresh();
                  }, 'Approved — apply when ready')
                }
              >
                Approve this exact patch
              </Button>
            </div>
          ) : (
            <Button
              size="sm"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  const result = await api<{ description: string }>(
                    `/sessions/${session.id}/patches/${patch.id}/effects?isolated=${isolated}`,
                  );
                  setEffects(result.description);
                })
              }
            >
              What will this change?
            </Button>
          )}
        </div>
      )}
      {patch.status === 'approved' && (
        <Button
          variant="primary"
          size="sm"
          icon="wrench"
          disabled={busy || isLive(latest.status)}
          onClick={() =>
            void act(async () => {
              await api(`/sessions/${session.id}/patches/${patch.id}/apply`, {
                method: 'POST',
                body: JSON.stringify({
                  revision: await revision(),
                  approvalToken: patch.approvalToken,
                }),
              });
              await refresh();
            }, 'Patch applied')
          }
        >
          Apply {patch.isolated ? 'in isolated worktree' : 'to my working file'}
        </Button>
      )}
    </div>
  );
};
