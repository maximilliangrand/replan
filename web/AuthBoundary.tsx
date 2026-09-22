import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

export interface Session {
  mode: 'demo' | 'pilot';
  principal: {
    id: string;
    name: string;
    role: 'viewer' | 'operator' | 'admin';
    workspaceId: string;
  } | null;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function sessionRequest(path: string, body?: object): Promise<Session> {
  const response = await fetch(path, {
    signal: AbortSignal.timeout(15_000),
    ...(body === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
  });
  const data = (await response.json().catch(() => null)) as (Session & { error?: string }) | null;
  if (!response.ok) {
    // Never echo a login response containing operator input back to the screen.
    throw new ApiError(
      response.status,
      [400, 401].includes(response.status)
        ? 'The operator key was not accepted. Check your provisioned key and try again.'
        : response.status === 403
          ? 'This sign-in address is not permitted. Use the pilot address supplied by your administrator.'
          : response.status === 429
            ? 'Too many sign-in attempts. Wait before trying again.'
            : 'Sign-in service unavailable. Please try again.',
    );
  }
  if (!data || !['demo', 'pilot'].includes(data.mode)) {
    throw new Error('The sign-in service returned an unreadable response. Please try again.');
  }
  return data;
}

const uncertainOutcome =
  'Your session ended while an action was in progress. A dispatch may already have happened. Sign in, review the recorded outcome, and use “Check & recover” before continuing.';

export function LoginScreen({
  pending,
  error,
  warning,
  onLogin,
}: {
  pending: boolean;
  error: string | null;
  warning: string | null;
  onLogin: (key: string) => Promise<void>;
}) {
  const [key, setKey] = useState('');
  return (
    <main className="access-screen">
      <section className="panel access-panel" aria-labelledby="access-title">
        <a className="access-brand" href="/" aria-label="Replan home">
          replan.
        </a>
        <span className="eyebrow">PRIVATE PILOT</span>
        <h1 id="access-title">Sign in to your workspace.</h1>
        <p className="panel-description">
          Use the operator key provisioned by your administrator. Your role determines which
          decisions you can review or execute.
        </p>
        {warning && (
          <p className="inline-note amber" role="alert">
            {warning}
          </p>
        )}
        {error && (
          <p className="inline-note amber" role="alert">
            {error}
          </p>
        )}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (pending || !key.trim()) return;
            const submittedKey = key.trim();
            setKey('');
            void onLogin(submittedKey);
          }}
        >
          <label htmlFor="operator-key">Operator key</label>
          <input
            id="operator-key"
            name="operator-key"
            type="password"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            value={key}
            onChange={(event) => setKey(event.target.value)}
            disabled={pending}
            required
          />
          <button className="button primary" type="submit" disabled={pending || !key.trim()}>
            {pending ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
        <p className="access-footnote">
          The key is exchanged for a browser session and is not saved by this application.
        </p>
      </section>
    </main>
  );
}

export function AuthBoundary({
  children,
}: {
  children: (
    session: Session,
    onUnauthorized: (mutationInFlight: boolean) => void,
    onLogout: () => void,
  ) => ReactNode;
}) {
  const [session, setSession] = useState<Session | null>(null);
  const [checking, setChecking] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const mounted = useRef(true);
  const sessionCheck = useRef(0);
  const authPending = useRef(false);

  const checkSession = useCallback(async () => {
    const currentCheck = ++sessionCheck.current;
    setChecking(true);
    setError(null);
    try {
      const current = await sessionRequest('/api/session');
      if (mounted.current && currentCheck === sessionCheck.current) setSession(current);
    } catch {
      if (mounted.current && currentCheck === sessionCheck.current)
        setError('Unable to check your session. Check the service connection and try again.');
    } finally {
      if (mounted.current && currentCheck === sessionCheck.current) setChecking(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void checkSession();
    return () => {
      mounted.current = false;
      ++sessionCheck.current;
    };
  }, [checkSession]);

  const onUnauthorized = useCallback((mutationInFlight: boolean) => {
    setSession({ mode: 'pilot', principal: null });
    setError('Your session has expired or was revoked. Sign in again to continue.');
    if (mutationInFlight) setWarning(uncertainOutcome);
  }, []);

  const login = async (key: string) => {
    if (authPending.current) return;
    authPending.current = true;
    setPending(true);
    setError(null);
    try {
      await sessionRequest('/api/auth/login', { key });
      // Fetch the authoritative identity after the cookie has been set.
      const current = await sessionRequest('/api/session');
      if (!current.principal)
        throw new Error('No active session was created. Try signing in again.');
      setSession(current);
    } catch (cause) {
      setError(
        cause instanceof ApiError
          ? cause.message
          : 'Sign-in could not be completed. Please try again.',
      );
    } finally {
      authPending.current = false;
      setPending(false);
    }
  };

  const logout = async () => {
    if (authPending.current) return;
    authPending.current = true;
    setPending(true);
    setError(null);
    try {
      const response = await fetch('/api/auth/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok && response.status !== 401) throw new Error('Sign-out was not confirmed.');
      setSession({ mode: 'pilot', principal: null });
    } catch {
      setError('Sign-out was not confirmed. Retry to close your browser session.');
    } finally {
      authPending.current = false;
      setPending(false);
    }
  };

  if (!session) {
    return (
      <main className="access-screen">
        <section className="panel access-panel" aria-live="polite">
          <a className="access-brand" href="/">
            replan.
          </a>
          <h1>{checking ? 'Checking your session…' : 'Unable to connect.'}</h1>
          {error && <p role="alert">{error}</p>}
          {!checking && (
            <button className="button primary" onClick={() => void checkSession()}>
              Retry connection
            </button>
          )}
        </section>
      </main>
    );
  }

  if (session.mode === 'pilot' && !session.principal) {
    return <LoginScreen pending={pending} error={error} warning={warning} onLogin={login} />;
  }

  return (
    <>
      {(error || warning || pending) && (
        <div className="session-message" role={error || warning ? 'alert' : 'status'}>
          {warning && <p>{warning}</p>}
          {error && <p>{error}</p>}
          {pending && <p>Closing your session…</p>}
          {warning && (
            <button className="text-button" onClick={() => setWarning(null)}>
              Dismiss reminder
            </button>
          )}
        </div>
      )}
      <div inert={pending} aria-busy={pending}>
        {children(session, onUnauthorized, () => void logout())}
      </div>
    </>
  );
}
