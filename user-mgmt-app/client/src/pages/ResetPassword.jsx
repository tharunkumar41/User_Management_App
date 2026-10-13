import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import AuthShell from '../components/AuthShell';
import Field from '../components/Field';
import useForm from '../hooks/useForm';
import api, { parseError } from '../api/client';

export default function ResetPassword() {
  const [params] = useSearchParams();
  const token = params.get('token');
  const { values, onChange } = useForm({ password: '', confirm: '' });
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    if (values.password !== values.confirm) {
      setFieldErrors({ confirm: ['Passwords do not match'] });
      return;
    }
    setFieldErrors({});
    setBusy(true);
    try {
      await api.post('/auth/reset-password', { token, password: values.password });
      setDone(true);
    } catch (err) {
      const p = parseError(err);
      setError(p.message);
      setFieldErrors(p.fieldErrors);
    } finally {
      setBusy(false);
    }
  };

  if (!token) {
    return (
      <AuthShell title="Link not valid" footer={<Link to="/forgot-password">Request a new link</Link>}>
        <div className="alert alert-error">This reset link is missing its token.</div>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Choose a new password" footer={<Link to="/login">Back to sign in</Link>}>
      {done ? (
        <div className="alert alert-success">Password updated. <Link to="/login">Sign in</Link> with your new password.</div>
      ) : (
        <form onSubmit={submit} noValidate>
          {error && <div className="alert alert-error" role="alert">{error}</div>}
          <Field label="New password" name="password" type="password" autoComplete="new-password" value={values.password} onChange={onChange}
            error={fieldErrors.password} hint="At least 8 characters, with a letter and a number." />
          <Field label="Confirm new password" name="confirm" type="password" autoComplete="new-password" value={values.confirm} onChange={onChange} error={fieldErrors.confirm} />
          <button className="btn btn-primary btn-block" disabled={busy}>{busy ? 'Saving…' : 'Save new password'}</button>
        </form>
      )}
    </AuthShell>
  );
}
