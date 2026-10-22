import logger from '../utils/logger.js';

// Delivery of new alerts to the user's device or inbox. Nothing is wired in yet: replace `deliver`
// (or call setNotifier at boot) with a push or email sender. It is called once per newly created alert.
let deliver = async (alert) => {
  logger.debug(`Alert ${alert.id} created for user ${alert.userId} (${alert.type}); no notifier configured`);
};

export const setNotifier = (fn) => { deliver = fn; };
export const notifyAlert = (alert) => deliver(alert);
