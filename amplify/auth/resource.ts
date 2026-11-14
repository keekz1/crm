import { defineAuth } from "@aws-amplify/backend";
import { postConfirmation } from "./post-confirmation/resource";
import { adminUsers } from "../data/admin-users/resource";

/**
 * Cognito groups:
 *   MANAGERS     - see every department, create departments, manage the team
 *   STAFF        - any approved user (gives access to the shared customer directory)
 *   dept-xxxxxx  - one group per department, created by managers from the app.
 *                  Tickets carry their department's group name and AppSync only
 *                  returns them to members of that group (or MANAGERS).
 * Users in no group are "pending" and can't read any CRM data.
 */
export const auth = defineAuth({
  loginWith: {
    email: true,
  },
  userAttributes: {
    fullname: {
      required: false,
      mutable: true,
    },
  },
  groups: ["MANAGERS", "STAFF"],
  triggers: {
    postConfirmation,
  },
  access: (allow) => [
    allow.resource(postConfirmation).to(["addUserToGroup", "listUsersInGroup"]),
    allow
      .resource(adminUsers)
      .to(["listUsers", "listGroupsForUser", "listUsersInGroup", "addUserToGroup", "removeUserFromGroup", "manageGroups"]),
  ],
});
