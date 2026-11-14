import { defineAuth } from "@aws-amplify/backend";
import { adminUsers } from "../data/admin-users/resource";
import { APP_URL } from "../config";

/**
 * Invite-only sign-in (self sign-up is switched off in backend.ts).
 *
 * Cognito groups:
 *   MANAGERS     - see every department, create departments, add/remove people
 *   STAFF        - any approved user (gives access to the shared customer directory)
 *   dept-xxxxxx  - one group per department, created by managers from the app
 *
 * Two-step verification uses an authenticator app (TOTP). It's required for managers
 * (enforced by the app and by the admin function) and optional for everyone else.
 */
export const auth = defineAuth({
  loginWith: {
    email: {
      verificationEmailStyle: "CODE",
      verificationEmailSubject: "Your CoreCRM verification code",
      verificationEmailBody: (createCode) => `Your CoreCRM verification code is ${createCode()}`,
      userInvitation: {
        emailSubject: "You've been invited to CoreCRM",
        emailBody: (user, code) =>
          `Hello,<br><br>You've been given access to CoreCRM.<br><br>` +
          (APP_URL ? `Sign in at: ${APP_URL}<br>` : "") +
          `Email: ${user()}<br>Temporary password: ${code()}<br><br>` +
          `You'll be asked to choose your own password when you first sign in. This temporary password expires in 7 days.`,
      },
    },
  },
  multifactor: {
    mode: "OPTIONAL",
    totp: true,
  },
  userAttributes: {
    fullname: {
      required: false,
      mutable: true,
    },
  },
  groups: ["MANAGERS", "STAFF"],
  access: (allow) => [
    allow
      .resource(adminUsers)
      .to([
        "listUsers",
        "getUser",
        "listGroupsForUser",
        "listUsersInGroup",
        "addUserToGroup",
        "removeUserFromGroup",
        "manageGroups",
        "createUser",
        "deleteUser",
        "disableUser",
        "enableUser",
      ]),
  ],
});
