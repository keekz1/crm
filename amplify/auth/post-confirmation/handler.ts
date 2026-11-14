import {
  CognitoIdentityProviderClient,
  ListUsersInGroupCommand,
  AdminAddUserToGroupCommand,
} from "@aws-sdk/client-cognito-identity-provider";

const cognito = new CognitoIdentityProviderClient();

// If nobody is a manager yet, make this new user the manager. Everyone else starts with no group (pending).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const handler = async (event: any) => {
  if (event.triggerSource !== "PostConfirmation_ConfirmSignUp") return event;
  try {
    const managers = await cognito.send(
      new ListUsersInGroupCommand({ UserPoolId: event.userPoolId, GroupName: "MANAGERS", Limit: 1 })
    );
    if (!managers.Users || managers.Users.length === 0) {
      for (const GroupName of ["MANAGERS", "STAFF"]) {
        await cognito.send(
          new AdminAddUserToGroupCommand({ UserPoolId: event.userPoolId, Username: event.userName, GroupName })
        );
      }
      console.log("First user made manager", event.userName);
    }
  } catch (err) {
    // Never block sign-up because of this; a manager can be assigned in the AWS console.
    console.error("post-confirmation failed", err);
  }
  return event;
};
