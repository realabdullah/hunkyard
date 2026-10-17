import { isHostedProvider } from '@reviewlab/domain';
import { type ReactNode, useState } from 'react';
import { agentMeta, providerMeta, scopeMeta, shortSha } from '../../lib/meta';
import { Icon, type IconName } from '../../ui/Icon';
import { Avatar, Pill } from '../../ui/primitives';
import { useReview } from '../context';

/** A hash as text plus a six-band colour fingerprint, so equal inputs are recognisable at a glance. */
export const HashChip = ({ value, label }: { value: string | null | undefined; label: string }) => {
  const [copied, setCopied] = useState(false);
  if (!value) return <span className="hash is-empty">—</span>;
  const hex = value.replace(/[^0-9a-f]/gi, '').padEnd(12, '0');
  const bands = Array.from({ length: 6 }, (_, index) => {
    const hue = (Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16) / 255) * 360;
    return `oklch(0.74 0.13 ${hue.toFixed(0)})`;
  });
  return (
    <button
      type="button"
      className="hash"
      title={`${label}: ${value} (click to copy)`}
      aria-label={`Copy ${label} ${value}`}
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
    >
      <span className="hash-bands" aria-hidden="true">
        {bands.map((color, index) => (
          <i key={index} style={{ background: color }} />
        ))}
      </span>
      <code>{copied ? 'copied' : value.slice(0, 12)}</code>
    </button>
  );
};

const Stage = ({
  icon,
  title,
  aside,
  children,
}: {
  icon: IconName;
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) => (
  <li className="stage-node">
    <span className="stage-icon" aria-hidden="true">
      <Icon name={icon} size={15} />
    </span>
    <section className="stage-card" aria-label={title}>
      <header>
        <h3>{title}</h3>
        {aside}
      </header>
      {children}
    </section>
  </li>
);

const Fact = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="fact">
    <span>{label}</span>
    <span>{children}</span>
  </div>
);

const Ring = ({ value, total }: { value: number; total: number }) => {
  const share = total ? value / total : 0;
  const circumference = 2 * Math.PI * 22;
  return (
    <svg className="ring" viewBox="0 0 56 56" aria-hidden="true">
      <circle cx="28" cy="28" r="22" className="ring-track" />
      <circle
        cx="28"
        cy="28"
        r="22"
        className="ring-value"
        strokeDasharray={`${share * circumference} ${circumference}`}
      />
      <text x="28" y="32" textAnchor="middle">
        {Math.round(share * 100)}%
      </text>
    </svg>
  );
};

/**
 * Evidence as a lineage: each stage consumed the previous one, so any finding can be traced
 * from your repository through the frozen inputs to the model that read them.
 */
export const EvidencePanel = () => {
  const { session } = useReview();
  const { snapshot, context, policy, plan, orchestration } = session;
  const included = context?.files.length ?? 0;
  const omissions = [...(snapshot.omissions ?? []), ...(context?.omissions ?? [])];
  const diagnostics = [...(snapshot.diagnostics ?? []), ...(policy.diagnostics ?? [])];
  const reserved = orchestration?.reservedTokens ?? 0;
  const budget = plan?.maxTokens ?? 0;
  return (
    <div className="evidence">
      <p className="evidence-lede">
        Everything the crew read is frozen. Follow the chain from your repository to each model;
        hashes are colour-fingerprinted so matching inputs look the same.
      </p>
      <ol className="lineage">
        <Stage
          icon="branch"
          title="Repository"
          aside={
            <Pill tint="gray">{snapshot.scope ? scopeMeta[snapshot.scope].short : 'Scope'}</Pill>
          }
        >
          <Fact label="HEAD">
            <HashChip value={snapshot.headSha} label="HEAD" />
          </Fact>
          {snapshot.baseSha && (
            <Fact label="Base commit">
              <HashChip value={snapshot.baseSha} label="Base commit" />
            </Fact>
          )}
          {snapshot.comparisonSha && (
            <Fact label="Comparison">
              <HashChip value={snapshot.comparisonSha} label="Comparison" />
            </Fact>
          )}
          <Fact label="Paths">{snapshot.capture?.paths.join(', ') || 'Whole scope'}</Fact>
          <Fact label="Untracked">
            {snapshot.capture?.includeUntracked ? 'Included' : 'Excluded'}
          </Fact>
        </Stage>

        <Stage
          icon="snowflake"
          title="Frozen snapshot"
          aside={<time>{new Date(snapshot.createdAt).toLocaleString()}</time>}
        >
          <Fact label="Snapshot">
            <HashChip value={snapshot.id} label="Snapshot" />
          </Fact>
          <Fact label="Diff SHA-256">
            <HashChip value={snapshot.diffHash} label="Diff hash" />
          </Fact>
          <Fact label="Base tree">
            <HashChip value={snapshot.baseTree} label="Base tree" />
          </Fact>
          <Fact label="Target tree">
            <HashChip value={snapshot.indexTree} label="Index tree" />
          </Fact>
          {snapshot.sourceIndexTree && (
            <Fact label="Your index">
              <HashChip value={snapshot.sourceIndexTree} label="Developer index" />
            </Fact>
          )}
          {session.runId && (
            <Fact label="Run">
              <HashChip value={session.runId} label="Run" />
            </Fact>
          )}
          <details className="disclosure">
            <summary>{snapshot.changes.length} changed files</summary>
            <ul className="file-ledger">
              {snapshot.changes.map((change) => (
                <li key={change.newPath ?? change.oldPath}>
                  <span className={`file-status st-${change.status}`}>{change.status}</span>
                  <code>{change.newPath ?? change.oldPath}</code>
                  <small>
                    {shortSha(change.oldOid)} → {shortSha(change.newOid)}
                    {change.binary ? ' · binary' : ''}
                  </small>
                </li>
              ))}
            </ul>
          </details>
        </Stage>

        <Stage icon="eye" title="Context the crew saw">
          <div className="coverage">
            <Ring value={included} total={snapshot.files.length} />
            <div>
              <strong>
                {included} of {snapshot.files.length} changed files
              </strong>
              <small>
                {(context?.usedBytes ?? 0).toLocaleString()} bytes · budget{' '}
                {context?.maxInputTokens?.toLocaleString() ?? '—'} tokens
              </small>
            </div>
          </div>
          {omissions.length > 0 ? (
            <ul className="omissions">
              {omissions.map((entry, index) => (
                <li key={`${index}:${entry.path}`}>
                  <code>{entry.path}</code>
                  <span>{entry.reason}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="evidence-ok">
              <Icon name="check" size={13} /> Nothing omitted.
            </p>
          )}
          {diagnostics.map((message) => (
            <p key={message} className="note">
              {message}
            </p>
          ))}
          {context?.entries?.length ? (
            <details className="disclosure">
              <summary>{context.entries.length} frozen related excerpts</summary>
              {context.entries.map((entry) => (
                <details
                  key={`${entry.path}:${entry.startLine}:${entry.reason}`}
                  className="disclosure nested"
                >
                  <summary>
                    <code>
                      {entry.path}:{entry.startLine}–{entry.endLine}
                    </code>{' '}
                    · {entry.reason}
                  </summary>
                  <pre className="block">{entry.text}</pre>
                  <p className="mono small muted">
                    blob {shortSha(entry.oid)} · sha256 {entry.hash.slice(0, 16)}
                  </p>
                </details>
              ))}
            </details>
          ) : null}
        </Stage>

        <Stage
          icon="book"
          title="Rules & instructions"
          aside={<HashChip value={policy.hash} label="Rules hash" />}
        >
          {policy.sources.length ? (
            <ol className="rule-stack" aria-label="Rule sources, lowest to highest precedence">
              {policy.sources.map((source, index) => (
                <li key={source.path} style={{ ['--i' as string]: index }}>
                  <Icon name="book" size={12} />
                  <code>{source.path}</code>
                  {source.truncated && <Pill tint="yellow">truncated 12 KB</Pill>}
                </li>
              ))}
            </ol>
          ) : (
            <p className="muted small">No repository or user rule files.</p>
          )}
          <p className="muted small">
            Later sources win, then project rules, then user rules. Set{' '}
            <code>instructionOrder</code> in project config to choose explicitly.
          </p>
          {policy.conflicts?.map((conflict) => (
            <p key={conflict.path} className="note is-warn small">
              <code>{conflict.path}</code>: {conflict.sources.join(' → ')}. {conflict.resolution}
            </p>
          ))}
          <Fact label="Excluded">{policy.exclusions.join(', ') || 'none'}</Fact>
          {policy.fileRules?.length ? (
            <details className="disclosure">
              <summary>Rules per file</summary>
              {policy.fileRules.map((rule) => (
                <p key={rule.path} className="small">
                  <code>{rule.path}</code>:{' '}
                  {rule.sourcePaths.join(' → ') || 'No repository instructions'}
                </p>
              ))}
            </details>
          ) : null}
          {session.instructions.length > 0 && (
            <details className="disclosure">
              <summary>Effective instructions ({session.instructions.length})</summary>
              {session.instructions.map((instruction, index) => (
                <pre key={`${index}:${instruction.slice(0, 20)}`} className="block">
                  {instruction}
                </pre>
              ))}
            </details>
          )}
        </Stage>

        {plan && (
          <Stage
            icon="sparkle"
            title="Crew & destinations"
            aside={
              <Pill tint="gray">
                {plan.options.workflow ? 'Custom workflow' : plan.options.profile} ·{' '}
                {plan.options.verify ? 'verified' : 'unverified'}
              </Pill>
            }
          >
            <ul className="route-ledger">
              {plan.agents.map((route) => {
                const hosted = isHostedProvider(route.target.provider);
                return (
                  <li key={route.id}>
                    <Avatar
                      tint={agentMeta[route.id].tint}
                      glyph={agentMeta[route.id].glyph}
                      size={22}
                    />
                    <span>
                      <strong>{agentMeta[route.id].name}</strong>
                      <small>
                        {providerMeta[route.target.provider].name} · {route.target.model}
                      </small>
                    </span>
                    <span className={`dest ${hosted ? 'is-cloud' : 'is-local'}`}>
                      <Icon name={hosted ? 'cloud' : 'lock'} size={12} />
                      {route.target.endpoint}
                    </span>
                  </li>
                );
              })}
            </ul>
          </Stage>
        )}

        {plan && (
          <Stage icon="bolt" title="Budget & usage">
            <div className="budget">
              <div className="budget-bar" aria-hidden="true">
                <span
                  style={{ width: `${budget ? Math.min(100, (reserved / budget) * 100) : 0}%` }}
                />
              </div>
              <div className="budget-legend">
                <span>
                  <b>{reserved.toLocaleString()}</b> reserved
                </span>
                <span>
                  of <b>{budget.toLocaleString()}</b> tokens
                </span>
              </div>
            </div>
            <div className="usage-grid">
              <div>
                <small>Input</small>
                <strong>{(orchestration?.reportedInputTokens ?? 0).toLocaleString()}</strong>
              </div>
              <div>
                <small>Output</small>
                <strong>{(orchestration?.reportedOutputTokens ?? 0).toLocaleString()}</strong>
              </div>
              <div>
                <small>API cost</small>
                <strong>${orchestration?.estimatedCostUsd.toFixed(4) ?? '0'}</strong>
              </div>
            </div>
            <p className="muted small">
              {orchestration?.usageComplete ? '' : 'Reported usage is incomplete. '}
              {orchestration?.costComplete ? '' : 'Hosted pricing unavailable. '}Estimates use
              conservative byte bounds and supplied prices; local hardware cost is excluded.
            </p>
          </Stage>
        )}
      </ol>
    </div>
  );
};
