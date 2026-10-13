const wrap = (title, body) => `
  <div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;padding:24px;color:#14201f">
    <h2 style="margin:0 0 16px">${title}</h2>
    ${body}
    <p style="color:#6b7a78;font-size:12px;margin-top:32px">If you didn't expect this email, you can ignore it.</p>
  </div>`;

exports.welcome = (name) =>
  wrap(`Welcome, ${name}`, '<p>Your account has been created. You can now sign in.</p>');

exports.resetPassword = (name, link) =>
  wrap(
    'Reset your password',
    `<p>Hi ${name}, use the button below to choose a new password. The link expires in 30 minutes.</p>
     <p><a href="${link}" style="background:#0f766e;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">Reset password</a></p>
     <p style="font-size:12px;word-break:break-all">${link}</p>`
  );

exports.passwordChanged = (name) =>
  wrap('Your password was changed', `<p>Hi ${name}, your password was just changed. If this wasn't you, reset it immediately.</p>`);

exports.otp = (name, code) =>
  wrap(
    'Your verification code',
    `<p>Hi ${name}, use this code to confirm your password change. It expires in 10 minutes.</p>
     <p style="font-size:32px;letter-spacing:8px;font-weight:bold">${code}</p>`
  );

exports.verifyEmail = (name, code) =>
  wrap(
    'Verify your email',
    `<p>Hi ${name}, enter this code to finish creating your account. It expires in 10 minutes.</p>
     <p style="font-size:32px;letter-spacing:8px;font-weight:bold">${code}</p>`
  );

exports.invite = (name, link) =>
  wrap(
    'Your account is ready',
    `<p>Hi ${name}, an administrator created an account for you. Choose a password to get started. The link expires in 3 days.</p>
     <p><a href="${link}" style="background:#0f766e;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">Set your password</a></p>
     <p style="font-size:12px;word-break:break-all">${link}</p>`
  );

exports.accountCreated = (name, url) =>
  wrap(
    'Your account is ready',
    `<p>Hi ${name}, an administrator created an account for you. They will share your password with you directly.</p>
     <p><a href="${url}/login">Go to sign in</a></p>`
  );
