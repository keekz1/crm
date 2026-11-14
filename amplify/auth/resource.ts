import { defineAuth } from "@aws-amplify/backend";
import { postConfirmation } from "./post-confirmation/resource";
import { adminUsers } from "../data/admin-users/resource";

/**
 * Groups decide what each person can see (enforced by the data API):
 *   ADMINS - everything + user management
 *   SALES  - companies, contacts, deals
 *   IT     - companies, contacts, IT tickets
 * Users in no group ("pending") can't read any CRM data.
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
  groups: ["ADMINS", "SALES", "IT"],
  triggers: {
    postConfirmation,
  },
  access: (allow) => [
    allow.resource(postConfirmation).to(["addUserToGroup", "listUsersInGroup"]),
    allow
      .resource(adminUsers)
      .to(["listUsers", "listGroupsForUser", "listUsersInGroup", "addUserToGroup", "removeUserFromGroup"]),
  ],
});
