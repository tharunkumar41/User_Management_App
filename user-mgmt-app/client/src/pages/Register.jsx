import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import AuthShell from '../components/AuthShell';
import Field from '../components/Field';
import useForm from '../hooks/useForm';
import { useAuth } from '../context/AuthContext';
import { parseError } from '../api/client';

export default function Register() {
  const { values, onChange } = useForm({ name: '', email: '', password: '', confirm: '' });
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const { register } = useAuth();
  const navigate = useNavigate();

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
      await register({ name: values.name, email: values.email, password: values.password });
      navigate('/verify-email', { state: { email: values.email, sent: true } });
    } catch (err) {
      const p = parseError(err);
      setError(p.message);
      setFieldErrors(p.fieldErrors);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell title="Create your account" subtitle="It takes less than a minute."
      footer={<>Already registered? <Link to="/login">Sign in</Link></>}>
      <form onSubmit={submit} noValidate>
        {error && <div className="alert alert-error" role="alert">{error}</div>}
        <Field label="Full name" name="name" autoComplete="name" value={values.name} onChange={onChange} error={fieldErrors.name} />
        <Field label="Email" name="email" type="email" autoComplete="email" value={values.email} onChange={onChange} error={fieldErrors.email} />
        <Field label="Password" name="password" type="password" autoComplete="new-password" value={values.password} onChange={onChange}
          error={fieldErrors.password} hint="At least 8 characters, with a letter and a number." />
        <Field label="Confirm password" name="confirm" type="password" autoComplete="new-password" value={values.confirm} onChange={onChange} error={fieldErrors.confirm} />
        <button className="btn btn-primary btn-block" disabled={busy}>{busy ? 'Creating account…' : 'Create account'}</button>
      </form>
    </AuthShell>
  );
}
