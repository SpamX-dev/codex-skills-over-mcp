/**
 * Экспортирует самодостаточные SKILL.md из MCP в каталог файловых скиллов.
 * Серверы читаются полностью до записи. Маркер происхождения и SHA-256
 * защищают чужие файлы и локальные правки; каждый скилл заменяется целиком.
 */
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from
  "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { parse } from "yaml";

/** Строгий контракт имени исключает выход из каталога и неоднозначные URI. */
const SKILL_URI = /^skill:\/\/([a-z0-9]+(?:-[a-z0-9]+)*)$/;
/** Зарезервированные имена отвергаются и на Unix для переносимости экспорта. */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/;
/** Имя маркера принадлежности каталога адаптеру. */
const MARKER = ".skill-over-mcp.json";

/** Вычисляет контрольную сумму точного текста ресурса, включая frontmatter. */
function digest(text) {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Проверяет ресурс и совпадение имени URI с frontmatter. Ограничения вызова,
 * не имеющие точного отображения в Codex, явно отклоняются.
 */
export function validateSkill(uri, response) {
  const match = SKILL_URI.exec(uri);
  if (!match || match[1].length > 64 || RESERVED.test(match[1])) {
    throw new Error("Invalid portable skill URI: " + uri);
  }
  if (!Array.isArray(response.contents) || response.contents.length !== 1) {
    throw new Error(uri + ": expected one text resource");
  }
  const resource = response.contents[0];
  if (resource.uri !== uri || typeof resource.text !== "string" ||
      Object.hasOwn(resource, "blob")) {
    throw new Error(uri + ": invalid text resource");
  }
  const text = resource.text;
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!frontmatter || !text.slice(frontmatter[0].length).trim()) {
    throw new Error(uri + ": missing frontmatter or skill body");
  }
  const metadata = parse(frontmatter[1]);
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata) ||
      metadata.name !== match[1] || typeof metadata.description !== "string" ||
      !metadata.description.trim() || metadata.description.length > 1024) {
    throw new Error(uri + ": name/description do not satisfy the skill contract");
  }
  for (const legacy of ["disableModelInvocation", "modelInvocable", "userInvocable"]) {
    if (Object.hasOwn(metadata, legacy)) {
      throw new Error(uri + ": unsupported legacy invocation field " + legacy);
    }
  }
  for (const key of ["disable-model-invocation", "user-invocable"]) {
    if (metadata[key] !== undefined && typeof metadata[key] !== "boolean") {
      throw new Error(uri + ": " + key + " must be boolean");
    }
  }
  if (metadata["disable-model-invocation"] === true ||
      metadata["user-invocable"] === false) {
    throw new Error(uri + ": invocation restrictions cannot be exported losslessly");
  }
  return { name: metadata.name, uri, text, sha256: digest(text) };
}

/**
 * Читает все страницы ресурсов одного stdio-сервера, затем все его скиллы.
 * Повторный cursor, дубликаты URI и ошибка чтения завершают весь экспорт.
 */
async function collectServer(config) {
  const client = new Client({ name: "codex-skill-over-mcp", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: config.command, args: config.args ?? [], cwd: config.cwd,
    env: config.env, stderr: "inherit",
  });
  try {
    await client.connect(transport, { timeout: 30000 });
    const resources = [];
    const cursors = new Set();
    let cursor;
    do {
      const page = await client.listResources(cursor ? { cursor } : {},
        { timeout: 30000 });
      resources.push(...page.resources.filter((resource) =>
        typeof resource.uri === "string" && resource.uri.startsWith("skill://")));
      cursor = page.nextCursor;
      if (cursor !== undefined) {
        if (cursors.has(cursor)) throw new Error("Repeated resources cursor");
        cursors.add(cursor);
      }
    } while (cursor !== undefined);
    const seen = new Set();
    const skills = [];
    for (const resource of resources) {
      if (seen.has(resource.uri)) throw new Error("Duplicate resource: " + resource.uri);
      seen.add(resource.uri);
      const response = await client.readResource({ uri: resource.uri }, { timeout: 30000 });
      skills.push({ ...validateSkill(resource.uri, response), server: config.name });
    }
    return skills;
  } finally {
    await client.close();
  }
}

/**
 * Возвращает lstat или отсутствие, сохраняя ошибки доступа для вызывающего кода.
 * lstat необходим, чтобы не следовать ссылкам вместо управляемых файлов.
 */
async function infoOrMissing(file) {
  try {
    return await lstat(file);
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * Проверяет право обновить каталог скилла и обнаруживает локальные изменения.
 * Управляемый каталог содержит только SKILL.md и маркер, без чужих ресурсов.
 */
async function inspectExport(destination, skill) {
  const target = path.join(destination, skill.name);
  const info = await infoOrMissing(target);
  if (!info) return { ...skill, target, status: "created" };
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(target + ": target is not a regular skill directory");
  }
  const entries = await readdir(target);
  if (entries.some((entry) => entry !== "SKILL.md" && entry !== MARKER)) {
    throw new Error(target + ": directory contains unmanaged files");
  }
  for (const file of ["SKILL.md", MARKER]) {
    const fileInfo = await infoOrMissing(path.join(target, file));
    if (!fileInfo?.isFile() || fileInfo.isSymbolicLink()) {
      throw new Error(target + ": missing or unsafe managed file " + file);
    }
  }
  const marker = JSON.parse(await readFile(path.join(target, MARKER), "utf8"));
  const current = await readFile(path.join(target, "SKILL.md"), "utf8");
  if (marker.schema_version !== 1 || marker.server !== skill.server ||
      marker.uri !== skill.uri) {
    throw new Error(target + ": skill is not owned by this source");
  }
  if (marker.sha256 !== digest(current)) {
    throw new Error(target + ": local edits detected; preserve them before syncing");
  }
  return { ...skill, target, status: current === skill.text ? "unchanged" : "updated" };
}

/**
 * Записывает новый каталог рядом с целевым и публикует его переименованием.
 * При ошибке публикации восстанавливает прежнюю версию; удаляет только
 * собственные временные каталоги внутри явно заданного назначения.
 */
async function publishExport(destination, entry) {
  const staging = path.join(destination, ".skill-sync-" + randomUUID());
  const backup = path.join(destination, ".skill-backup-" + randomUUID());
  await mkdir(staging);
  let backedUp = false;
  try {
    await writeFile(path.join(staging, "SKILL.md"), entry.text, { flag: "wx" });
    await writeFile(path.join(staging, MARKER), JSON.stringify({
      schema_version: 1, server: entry.server, uri: entry.uri, sha256: entry.sha256,
    }, null, 2) + "\n", { flag: "wx" });
    if (entry.status === "updated") {
      await rename(entry.target, backup);
      backedUp = true;
    } else if (await infoOrMissing(entry.target)) {
      throw new Error(entry.target + ": destination appeared during sync");
    }
    try {
      await rename(staging, entry.target);
    } catch (error) {
      if (backedUp) {
        await rename(backup, entry.target);
        backedUp = false;
      }
      throw error;
    }
    if (backedUp) await rm(backup, { recursive: true });
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/**
 * Читает полный каталог, проверяет все коллизии и только затем пишет файлы.
 * check не создаёт даже каталог назначения. Исчезнувшие ресурсы не удаляются.
 * Сбой записи может оставить уже опубликованные независимые скиллы обновлёнными.
 */
export async function syncSkills({ servers, destination, check = false }) {
  if (!Array.isArray(servers) || servers.length === 0) {
    throw new Error("At least one server is required");
  }
  const serverNames = new Set();
  for (const server of servers) {
    if (typeof server.name !== "string" || !server.name.trim() ||
        typeof server.command !== "string" || !server.command.trim() ||
        (server.args !== undefined && (!Array.isArray(server.args) ||
          server.args.some((arg) => typeof arg !== "string"))) ||
        (server.cwd !== undefined && typeof server.cwd !== "string") ||
        (server.env !== undefined && (server.env === null ||
          typeof server.env !== "object" || Array.isArray(server.env) ||
          Object.values(server.env).some((value) => typeof value !== "string")))) {
      throw new Error("Invalid server configuration");
    }
    if (serverNames.has(server.name)) throw new Error("Duplicate server: " + server.name);
    serverNames.add(server.name);
  }
  if (typeof destination !== "string" || !destination.trim()) {
    throw new Error("Explicit destination is required");
  }
  const skills = [];
  for (const server of servers) skills.push(...await collectServer(server));
  const names = new Set();
  for (const skill of skills) {
    if (names.has(skill.name)) throw new Error("Skill name collision: " + skill.name);
    names.add(skill.name);
  }
  let targetRoot = path.resolve(destination);
  if (await infoOrMissing(targetRoot)) targetRoot = await realpath(targetRoot);
  const plan = [];
  for (const skill of skills) plan.push(await inspectExport(targetRoot, skill));
  if (!check && plan.some((entry) => entry.status !== "unchanged")) {
    await mkdir(targetRoot, { recursive: true });
    targetRoot = await realpath(targetRoot);
    for (const entry of plan) {
      if (entry.status !== "unchanged") {
        await publishExport(targetRoot, { ...entry,
          target: path.join(targetRoot, entry.name) });
      }
    }
  }
  return { check, skills: plan.map(({ name, server, uri, status, target }) =>
    ({ name, server, uri, status, path: target })) };
}
