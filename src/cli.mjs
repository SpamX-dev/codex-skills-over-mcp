#!/usr/bin/env node
/**
 * CLI экспорта skill://. Конфигурация явно задаёт stdio-серверы; их cwd
 * разрешается относительно JSON-файла. Назначение задаётся относительно cwd
 * пользователя. Команда не читает и не изменяет глобальную конфигурацию Codex.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { syncSkills } from "./sync.mjs";

/** Параметры экспорта; --check возвращает 1, если управляемая копия устарела. */
const { values } = parseArgs({ options: {
  config: { type: "string" }, destination: { type: "string" },
  server: { type: "string", multiple: true }, check: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} });
if (values.help) {
  process.stdout.write("codex-skill-over-mcp --config FILE --destination DIR " +
    "[--server NAME] [--check]\n");
} else {
  try {
    if (!values.config || !values.destination) {
      throw new Error("--config and --destination are required");
    }
    const configPath = path.resolve(values.config);
    const config = JSON.parse(await readFile(configPath, "utf8"));
    if (!Array.isArray(config.servers)) throw new Error("config.servers must be an array");
    const selected = values.server;
    for (const name of selected ?? []) {
      if (!config.servers.some((server) => server.name === name)) {
        throw new Error("Unknown server: " + name);
      }
    }
    const servers = config.servers.filter((server) =>
      !selected || selected.includes(server.name)).map((server) => ({
      ...server, cwd: path.resolve(path.dirname(configPath), server.cwd ?? "."),
    }));
    const result = await syncSkills({ servers, destination: values.destination,
      check: values.check });
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    if (values.check && result.skills.some((skill) => skill.status !== "unchanged")) {
      process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write("codex-skill-over-mcp: " + error.message + "\n");
    process.exitCode = 2;
  }
}
