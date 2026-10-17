import { type AgentId, isHostedProvider, type ReviewPlan } from '@hunkyard/domain';
import { agentMeta, providerMeta } from '../lib/meta';
import { Icon } from '../ui/Icon';
import { Avatar } from '../ui/primitives';

type Target = ReviewPlan['agents'][number]['target'];
const destinationKey = (target: Target) => `${target.provider}|${target.endpoint}|${target.model}`;

/**
 * Live diagram of the run before it starts: frozen snapshot → each reviewer → the exact endpoint
 * that will receive source code. Every destination is labelled; nothing is implied.
 */
export const FlightPlan = ({ plan, scope }: { plan: ReviewPlan | null; scope: string }) => {
  const agents = plan?.agents ?? [];
  const destinations: { key: string; target: Target; agents: AgentId[] }[] = [];
  for (const route of agents) {
    const key = destinationKey(route.target);
    const entry = destinations.find((item) => item.key === key);
    if (entry) entry.agents.push(route.id);
    else destinations.push({ key, target: route.target, agents: [route.id] });
  }
  const rows = Math.max(agents.length, destinations.length, 1);
  const row = 62;
  const height = rows * row;
  const yAt = (index: number, count: number) => (height / count) * (index + 0.5);
  const snapY = height / 2;
  return (
    <figure className="flight" aria-label="Where this review sends code">
      <div className="flight-stage" style={{ height }}>
        <svg
          className="flight-wires"
          viewBox={`0 0 1000 ${height}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          {agents.map((route, index) => {
            const y = yAt(index, agents.length);
            const dest = destinations.findIndex(
              (item) => item.key === destinationKey(route.target),
            );
            const dy = yAt(dest, destinations.length);
            const hosted = isHostedProvider(route.target.provider);
            return (
              <g key={route.id} className={hosted ? 'is-cloud' : 'is-local'}>
                <path
                  d={`M 250 ${snapY} C 310 ${snapY}, 300 ${y}, 360 ${y}`}
                  vectorEffect="non-scaling-stroke"
                />
                <path
                  d={`M 630 ${y} C 690 ${y}, 680 ${dy}, 740 ${dy}`}
                  vectorEffect="non-scaling-stroke"
                />
              </g>
            );
          })}
        </svg>
        <div className="flight-node flight-snap" style={{ top: snapY }}>
          <Icon name="snowflake" size={15} />
          <span>
            <strong>{scope}</strong>
            <small>frozen snapshot</small>
          </span>
        </div>
        {agents.map((route, index) => (
          <div
            key={route.id}
            className="flight-node flight-agent"
            style={{ top: yAt(index, agents.length), animationDelay: `${index * 60}ms` }}
          >
            <Avatar tint={agentMeta[route.id].tint} glyph={agentMeta[route.id].glyph} size={24} />
            <span>
              <strong>{agentMeta[route.id].name}</strong>
              <small>{route.target.model || 'no model'}</small>
            </span>
          </div>
        ))}
        {destinations.map(({ key, target }, index) => {
          const hosted = isHostedProvider(target.provider);
          const blocked = hosted && (target.privacy !== 'cloud-allowed' || !target.cloudConsent);
          return (
            <div
              key={key}
              className={`flight-node flight-dest ${hosted ? 'is-cloud' : 'is-local'}`}
              style={{ top: yAt(index, destinations.length) }}
            >
              <Icon name={hosted ? 'cloud' : 'lock'} size={15} />
              <span>
                <strong>{providerMeta[target.provider].name}</strong>
                <small title={target.endpoint}>{target.endpoint}</small>
                <em>
                  {blocked
                    ? 'needs cloud consent'
                    : hosted
                      ? 'leaves this machine'
                      : 'stays on this machine'}
                </em>
              </span>
            </div>
          );
        })}
        {!plan && <div className="flight-loading skeleton" />}
      </div>
    </figure>
  );
};
