/**
 * The account that owns this CRM. It's created automatically on deploy as a manager,
 * receives an email with a temporary password, and must set up two-step verification
 * (authenticator app) on first sign-in. It can't be removed, disabled or demoted from the app.
 *
 * To use a different address, set the MANAGER_EMAIL environment variable in
 * Amplify Hosting (App settings -> Environment variables) and redeploy.
 */
export const MANAGER_EMAIL = (process.env.MANAGER_EMAIL || "hello@soustap.com").trim().toLowerCase();

/** Public link to the app, included in invitation emails when known. */
export const APP_URL =
  process.env.APP_URL ||
  (process.env.AWS_APP_ID && process.env.AWS_BRANCH ? `https://${process.env.AWS_BRANCH}.${process.env.AWS_APP_ID}.amplifyapp.com` : "");
