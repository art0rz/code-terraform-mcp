import assert from "node:assert/strict";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";

// Clients such as the Claude desktop app compile tool schemas with a
// 2020-12-only validator and reject any tool that declares another dialect.
test("every listed tool schema compiles as JSON Schema 2020-12", async (context) => {
  const server = createServer({ load: async () => ({}) });
  const client = new Client({ name: "schema-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  context.after(async () => client.close());

  const { tools } = await client.listTools();
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  assert.ok(tools.length > 20);
  for (const tool of tools) {
    for (const key of ["inputSchema", "outputSchema"]) {
      const schema = tool[key];
      if (!schema) continue;
      assert.equal(schema.$schema, undefined, `${tool.name}.${key} declares ${schema.$schema}`);
      assert.doesNotThrow(() => ajv.compile(schema), `${tool.name}.${key} must compile`);
    }
  }
});
