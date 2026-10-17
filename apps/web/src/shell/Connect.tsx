import { useState } from 'react';
import { Icon } from '../ui/Icon';
import { Button } from '../ui/primitives';

export const Connect = ({ connect }: { connect: (token: string) => void }) => {
  const [token, setToken] = useState('');
  return (
    <main className="connect" id="main-content">
      <div className="connect-art" aria-hidden="true">
        <div className="art-card art-a">
          <i />
          <b />
          <b className="short" />
        </div>
        <div className="art-card art-b tint-red">
          <i />
          <b />
        </div>
        <div className="art-card art-c tint-green">
          <i />
          <b className="short" />
        </div>
        <svg className="art-links" viewBox="0 0 320 200">
          <path d="M120 60 C 170 60, 160 120, 210 120" />
          <path d="M120 60 C 170 60, 150 30, 200 30" />
        </svg>
      </div>
      <section className="connect-card" aria-labelledby="connect-title">
        <span className="brand-mark" aria-hidden="true">
          R
        </span>
        <h1 id="connect-title">Connect to your local workspace</h1>
        <p>
          ReviewLab runs on your machine. Start it from your project with <code>reviewlab</code> and
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
