import { defineBackend } from "@aws-amplify/backend";
import { auth } from "./auth/resource";
import { data } from "./data/resource";
import { postConfirmation } from "./auth/post-confirmation/resource";
import { adminUsers } from "./data/admin-users/resource";

/**
 * CoreCRM backend
 * - auth: Cognito user pool, email login, groups ADMINS / SALES / IT
 * - data: AppSync + DynamoDB, access locked per group
 */
defineBackend({
  auth,
  data,
  postConfirmation,
  adminUsers,
});
