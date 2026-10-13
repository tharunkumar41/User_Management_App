import { useState } from 'react';
import { Link } from 'react-router-dom';
import AuthShell from '../components/AuthShell';
import Field from '../components/Field';
import api, { parseError } from '../api/client';

export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setFieldErrors({});
    setBusy(true);
    try {
      await api.post('/auth/forgot-password', { email });
      setSent(true);
    } catch (err) {
      const p = parseError(err);
      setError(p.message);
      setFieldErrors(p.fieldErrors);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell title="Reset your password" subtitle="Enter your email and we'll send you a reset link."
      footer={<Link to="/login">Back to sign in</Link>}>
      {sent ? (
        <div className="alert alert-success">If that email is registered, a reset link is on its way. It expires in 30 minutes.</div>
      ) : (
        <form onSubmit={submit} noValidate>
          {error && <div className="alert alert-error" role="alert">{error}</div>}
          <Field label="Email" name="email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} error={fieldErrors.email} />
          <button className="btn btn-primary btn-block" disabled={busy}>{busy ? 'Sending…' : 'Send reset link'}</button>
        </form>
      )}
    </AuthShell>
  );
}
