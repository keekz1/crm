import { util } from "@aws-appsync/utils";

// Atomically increments a counter row ("deal" or "ticket") and returns the new value.
// Used for human-friendly numbers: SAL-1001, IT-1001, ...
export function request(ctx) {
  const kind = ctx.args.kind;
  if (kind !== "deal" && kind !== "ticket") {
    util.error("kind must be 'deal' or 'ticket'", "BadRequest");
  }
  return {
    operation: "UpdateItem",
    key: util.dynamodb.toMapValues({ id: kind }),
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
