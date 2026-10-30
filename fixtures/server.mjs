/** MCP-фикстура с пагинацией и управляемым сбоем чтения ресурса. */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListResourcesRequestSchema, ReadResourceRequestSchema } from
  "@modelcontextprotocol/sdk/types.js";

/** Режим задаёт версию содержимого либо ошибку чтения. */
const mode = process.argv[2] ?? "v1";
/** Самодостаточный ресурс позволяет проверять точность экспортированных байтов. */
const text = "---\nname: fixture-skill\ndescription: Fixture skill.\n---\n\n" +
  "Workflow " + mode + "\n";
/** Сервер публикует и посторонний ресурс, который адаптер должен пропустить. */
const server = new Server({ name: "skill-export-fixture", version: "1.0.0" },
  { capabilities: { resources: {} } });
server.setRequestHandler(ListResourcesRequestSchema, async (request) =>
  request.params?.cursor === "second" ? {
    resources: [{ uri: "skill://fixture-skill", name: "fixture-skill" }],
  } : {
    resources: [{ uri: "file:///not-a-skill", name: "ordinary-resource" }],
    nextCursor: "second",
  });
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  if (mode === "broken") throw new Error("Fixture read failed");
  return { contents: [{ uri: request.params.uri, mimeType: "text/markdown", text }] };
});
await server.connect(new StdioServerTransport());
