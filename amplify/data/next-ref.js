import { util } from "@aws-appsync/utils";

// Atomically increments the counter row for one department (key = department id)
// and returns the new value. Used for ticket numbers like IT-1001, SAL-1001.
export function request(ctx) {
  const key = ctx.args.key;
  if (!key || key.length > 100) {
    util.error("Invalid counter key", "BadRequest");
  }
  return {
    operation: "UpdateItem",
    key: util.dynamodb.toMapValues({ id: key }),
    update: {
      expression: "ADD #v :one",
      expressionNames: { "#v": "value" },
      expressionValues: util.dynamodb.toMapValues({ ":one": 1 }),
    },
  };
}

export function response(ctx) {
  if (ctx.error) {
    util.error(ctx.error.message, ctx.error.type);
  }
  return ctx.result.value;
}
