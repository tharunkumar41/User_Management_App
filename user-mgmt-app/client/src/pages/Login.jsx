import { useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import ReCAPTCHA from 'react-google-recaptcha';
import { GoogleLogin } from '@react-oauth/google';
import AuthShell from '../components/AuthShell';
import Field from '../components/Field';
import useForm from '../hooks/useForm';
import { useAuth } from '../context/AuthContext';
import { parseError } from '../api/client';

const SITE_KEY = import.meta.env.VITE_RECAPTCHA_SITE_KEY;
const GOOGLE_ENABLED = Boolean(import.meta.env.VITE_GOOGLE_CLIENT_ID);

export default function Login() {
  const { values, onChange } = useForm({ email: '', password: '' });
  const [captchaToken, setCaptchaToken] = useState('');
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const captchaRef = useRef(null);
  const { login, googleLogin } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const redirectTo = location.state?.from?.pathname || '/';

  // reCAPTCHA tokens work once, so reset the widget after every attempt.
  const resetCaptcha = () => {
    captchaRef.current?.reset();
    setCaptchaToken('');
  };

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setFieldErrors({});
    if (!captchaToken) {
      setFieldErrors({ captchaToken: ['Please confirm you are not a robot'] });
      return;
    }
    setBusy(true);
    try {
      await login({ ...values, captchaToken });
      navigate(redirectTo, { replace: true });
    } catch (err) {
      const p = parseError(err);
      if (p.code === 'EMAIL_NOT_VERIFIED') {
        navigate('/verify-email', { state: { email: p.email || values.email, sent: true } });
        return;
      }
      setError(p.message);
      setFieldErrors(p.fieldErrors);
      resetCaptcha();
    } finally {
      setBusy(false);
    }
  };

  const onGoogleSuccess = async (response) => {
    setError('');
    try {
      await googleLogin(response.credential);
      navigate(redirectTo, { replace: true });
    } catch (err) {
      setError(parseError(err).message);
    }
  };

  return (
    <AuthShell title="Sign in" subtitle="Welcome back."
      footer={<>New here? <Link to="/register">Create an account</Link></>}>
      <form onSubmit={submit} noValidate>
        {error && <div className="alert alert-error" role="alert">{error}</div>}
        <Field label="Email" name="email" type="email" autoComplete="email" value={values.email} onChange={onChange} error={fieldErrors.email} />
        <Field label="Password" name="password" type="password" autoComplete="current-password" value={values.password} onChange={onChange} error={fieldErrors.password} />
        <p className="inline-link"><Link to="/forgot-password">Forgot password?</Link></p>

        <div className={`captcha ${fieldErrors.captchaToken ? 'has-error' : ''}`}>
          {SITE_KEY ? (
            <ReCAPTCHA ref={captchaRef} sitekey={SITE_KEY} onChange={(t) => setCaptchaToken(t || '')} onExpired={() => setCaptchaToken('')} />
          ) : (
            <div className="alert alert-error">Captcha isn't configured. Add VITE_RECAPTCHA_SITE_KEY to client/.env.</div>
          )}
          {fieldErrors.captchaToken && <p className="error-text">{fieldErrors.captchaToken[0]}</p>}
        </div>

        <button className="btn btn-primary btn-block" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>

      {GOOGLE_ENABLED && (
        <>
          <div className="divider"><span>or</span></div>
          <div className="google-btn">
            <GoogleLogin onSuccess={onGoogleSuccess} onError={() => setError('Google sign-in was cancelled or failed. Please try again.')}
              text="signin_with" shape="rectangular" width="300" />
          </div>
        </>
      )}
    </AuthShell>
  );
}
