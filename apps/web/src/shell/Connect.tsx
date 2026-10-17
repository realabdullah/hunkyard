import { useState } from 'react';
import { BrandMark } from '../ui/BrandMark';
import { Icon } from '../ui/Icon';
import { Button } from '../ui/primitives';

export const Connect = ({ connect }: { connect: (token: string) => void }) => {
  const [token, setToken] = useState('');
  return (
    <main className="connect" id="main-content">
      <section className="connect-card" aria-labelledby="connect-title">
        <BrandMark size={36} />
        <h1 id="connect-title">Connect to your local workspace</h1>
        <p>
          Hunkyard runs on your machine. Start it from your project with <code>hunkyard</code> and
          this page connects on its own. Started with <code>--no-browser</code>? Paste the token it
          printed.
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            connect(token);
          }}
        >
          <label className="field">
            <span className="field-label">API connection token</span>
            <input
              type="password"
              autoComplete="off"
              required
              value={token}
              onChange={(event) => setToken(event.target.value)}
              placeholder="Paste token"
            />
          </label>
          <Button type="submit" variant="primary" size="lg">
            Connect <Icon name="arrowRight" size={16} />
          </Button>
        </form>
        <p className="connect-foot">
          <Icon name="lock" size={14} /> The token stays in this tab’s memory and is never stored.
        </p>
      </section>
    </main>
  );
};
