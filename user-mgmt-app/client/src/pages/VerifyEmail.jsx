import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import AuthShell from '../components/AuthShell';
import Field from '../components/Field';
import { useAuth } from '../context/AuthContext';
import api, { parseError } from '../api/client';

const COOLDOWN = 60;

export default function VerifyEmail() {
  const location = useLocation();
  const navigate = useNavigate();
  const { setUser } = useAuth();

  const [email, setEmail] = useState(location.state?.email || '');
  const [otp, setOtp] = useState('');
  const [error, setError] = useState('');
  const [info, setInfo] = useState(location.state?.sent ? 'We emailed you a 6-digit code. It expires in 10 minutes.' : '');
  const [fieldErrors, setFieldErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState(location.state?.sent ? COOLDOWN : 0);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setInfo('');
    setFieldErrors({});
    setBusy(true);
    try {
      const res = await api.post('/auth/verify-email', { email, otp });
      setUser(res.data.user);
      navigate('/', { replace: true });
    } catch (err) {
      const p = parseError(err);
      setError(p.message);
      setFieldErrors(p.fieldErrors);
    } finally {
      setBusy(false);
    }
  };

  const resend = async () => {
    setError('');
    setInfo('');
    setFieldErrors({});
    try {
      await api.post('/auth/resend-verification', { email });
      setInfo('A new code is on its way.');
      setCooldown(COOLDOWN);
    } catch (err) {
      const p = parseError(err);
      setError(p.message);
      setFieldErrors(p.fieldErrors);
    }
  };

  return (
    <AuthShell
      title="Verify your email"
      subtitle={email ? `Enter the 6-digit code we sent to ${email}.` : 'Enter your email and the 6-digit code we sent you.'}
      footer={<>Wrong account? <Link to="/register">Start over</Link> or <Link to="/login">sign in</Link></>}
    >
      <form onSubmit={submit} noValidate>
        {error && <div className="alert alert-error" role="alert">{error}</div>}
        {info && <div className="alert alert-success">{info}</div>}
        {!location.state?.email && (
          <Field label="Email" name="email" type="email" autoComplete="email" value={email}
            onChange={(e) => setEmail(e.target.value)} error={fieldErrors.email} />
        )}
        <Field label="6-digit code" name="otp" inputMode="numeric" maxLength={6} autoComplete="one-time-code"
          value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))} error={fieldErrors.otp} />
        <button className="btn btn-primary btn-block" disabled={busy}>{busy ? 'Verifying…' : 'Verify email'}</button>
      </form>
      <p className="resend">
        Didn't get it?{' '}
        <button type="button" className="link-btn" onClick={resend} disabled={cooldown > 0 || !email}>
          {cooldown > 0 ? `Resend code in ${cooldown}s` : 'Resend code'}
        </button>
      </p>
    </AuthShell>
  );
}
