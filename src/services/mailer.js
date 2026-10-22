import logger from '../utils/logger.js';

// Delivery of password-reset links. No email provider is wired in yet: replace `deliver` (or call
// setMailer at boot) with one that sends the email. Until then the token is only logged outside production,
// since a token in production logs would be a way to take over accounts.
let deliver = async ({ email, token }) => {
  if (process.env.NODE_ENV === 'production') {
    logger.warn('Password reset requested but no email provider is configured (see src/services/mailer.js)');
  } else {
    logger.info(`Password reset token for ${email}: ${token}`);
  }
};

export const setMailer = (fn) => { deliver = fn; };
export const sendPasswordReset = (email, token) => deliver({ email, token });
