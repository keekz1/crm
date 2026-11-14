import { defineBackend } from "@aws-amplify/backend";
import { AwsCustomResource, AwsCustomResourcePolicy, PhysicalResourceId } from "aws-cdk-lib/custom-resources";
import { auth } from "./auth/resource";
import { data } from "./data/resource";
import { adminUsers } from "./data/admin-users/resource";
import { MANAGER_EMAIL } from "./config";

/**
 * CoreCRM backend
 * - auth: Cognito user pool, invite-only, TOTP two-step verification
 * - data: AppSync + DynamoDB, access locked per department (Cognito groups)
 */
const backend = defineBackend({
  auth,
  data,
  adminUsers,
});

const { cfnUserPool } = backend.auth.resources.cfnResources;
const userPool = backend.auth.resources.userPool;

// 1) Nobody can sign themselves up. Only managers (through the app) can create accounts.
cfnUserPool.addPropertyOverride("AdminCreateUserConfig.AllowAdminCreateUserOnly", true);

// 2) Create the owner's manager account on deploy. Cognito emails it a temporary password.
const bootstrap = backend.createStack("ManagerBootstrap");
const policy = AwsCustomResourcePolicy.fromSdkCalls({ resources: [userPool.userPoolArn] });

const createManagerCall = {
  service: "CognitoIdentityServiceProvider",
  action: "adminCreateUser",
  parameters: {
    UserPoolId: userPool.userPoolId,
    Username: MANAGER_EMAIL,
    UserAttributes: [
      { Name: "email", Value: MANAGER_EMAIL },
      { Name: "email_verified", Value: "true" },
      { Name: "name", Value: "Manager" },
    ],
    DesiredDeliveryMediums: ["EMAIL"],
  },
  physicalResourceId: PhysicalResourceId.of(`manager-${MANAGER_EMAIL}`),
  ignoreErrorCodesMatching: "UsernameExistsException",
};
const createManager = new AwsCustomResource(bootstrap, "CreateManagerUser", {
  onCreate: createManagerCall,
  onUpdate: createManagerCall,
  policy,
  installLatestAwsSdk: false,
});

for (const group of ["MANAGERS", "STAFF"]) {
  const addToGroupCall = {
    service: "CognitoIdentityServiceProvider",
    action: "adminAddUserToGroup",
    parameters: { UserPoolId: userPool.userPoolId, Username: MANAGER_EMAIL, GroupName: group },
    physicalResourceId: PhysicalResourceId.of(`manager-${MANAGER_EMAIL}-${group}`),
  };
  const add = new AwsCustomResource(bootstrap, `AddManagerTo${group}`, {
    onCreate: addToGroupCall,
    onUpdate: addToGroupCall,
    policy,
    installLatestAwsSdk: false,
  });
  add.node.addDependency(createManager);
}
