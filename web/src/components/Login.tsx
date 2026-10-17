import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api';

const DEMO = [
  ['admin@newtonite.test', 'Admin · all teams'],
  ['priya@newtonite.test', 'Lead · Payments'],
  ['rahul@newtonite.test', 'Member · Payments, Eng'],
  ['meera@newtonite.test', 'Member · Payments, Support'],
  ['vikram@newtonite.test', 'Lead · Eng, Ops'],
  ['kabir@newtonite.test', 'Lead · Support'],
  ['dev@newtonite.test', 'Lead · Compliance'],
  ['vera@newtonite.test', 'Viewer · read-only'],
];

export function Login() {
  const qc = useQueryClient();
  const [email, setEmail] = useState('rahul@newtonite.test');
  const [password, setPassword] = useState('password');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e?: React.FormEvent, as?: string) => {
    e?.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.login(as ?? email, password);
      await qc.invalidateQueries();
    } catch (err) {
      setError((err as ApiError).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <form className="login-card" onSubmit={submit}>
        <div className="brand big"><span className="logo">N</span> Newtonite Ops</div>
        <p className="muted">Operational work, owned and visible.</p>
        <label>Email<input value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" /></label>
        <label>Password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" /></label>
        {error && <div className="form-error">{error}</div>}
        <button className="btn primary" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        <div className="demo">
          <div className="muted small">Demo accounts (password “password”) — open two browsers as different people to see live collaboration:</div>
          {DEMO.map(([e, label]) => (
            <button type="button" key={e} className="demo-user" onClick={() => submit(undefined, e)} disabled={busy}>
              <b>{e.split('@')[0]}</b> <span className="muted">{label}</span>
            </button>
          ))}
        </div>
      </form>
    </div>
  );
}
