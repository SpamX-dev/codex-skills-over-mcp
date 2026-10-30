/** Проверяет реальные MCP-соединения, обновления и защиту файлов назначения. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { syncSkills, validateSkill } from "../src/sync.mjs";

/** Создаёт явно ограниченное временное назначение без глобальных скиллов. */
async function destination(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-skill-export-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return path.join(root, "skills");
}

/** Создаёт конфигурацию stdio-фикстуры без оболочки и внешней сети. */
function fixture(mode = "v1", name = "fixture") {
  return { name, command: process.execPath, args: [
    fileURLToPath(new URL("../fixtures/server.mjs", import.meta.url)), mode,
  ] };
}

test("checks without writing, exports paginated resources and refreshes managed skills", async (t) => {
  const target = await destination(t);
  const servers = [fixture()];
  const check = await syncSkills({ servers, destination: target, check: true });
  assert.equal(check.skills.length, 1);
  assert.equal(check.skills[0].status, "created");
  await assert.rejects(stat(target), { code: "ENOENT" });
  const first = await syncSkills({ servers, destination: target });
  assert.equal(first.skills[0].status, "created");
  const file = path.join(target, "fixture-skill/SKILL.md");
  const original = await readFile(file, "utf8");
  assert.ok(original.includes("Workflow v1"));
  const unchanged = await syncSkills({ servers, destination: target, check: true });
  assert.equal(unchanged.skills[0].status, "unchanged");
  const changed = [fixture("v2")];
  const pending = await syncSkills({ servers: changed, destination: target, check: true });
  assert.equal(pending.skills[0].status, "updated");
  assert.equal(await readFile(file, "utf8"), original);
  await syncSkills({ servers: changed, destination: target });
  assert.ok((await readFile(file, "utf8")).includes("Workflow v2"));
});

test("preserves local edits and unmanaged directories", async (t) => {
  const target = await destination(t);
  const servers = [fixture()];
  await syncSkills({ servers, destination: target });
  const file = path.join(target, "fixture-skill/SKILL.md");
  await writeFile(file, "Local user edit");
  await assert.rejects(syncSkills({ servers, destination: target }), /local edits/);
  assert.equal(await readFile(file, "utf8"), "Local user edit");
  const other = await destination(t);
  await mkdir(path.join(other, "fixture-skill"), { recursive: true });
  await writeFile(path.join(other, "fixture-skill/SKILL.md"), "Unmanaged skill");
  await assert.rejects(syncSkills({ servers, destination: other }), /managed file/);
  assert.equal(await readFile(path.join(other, "fixture-skill/SKILL.md"), "utf8"),
    "Unmanaged skill");
});

test("fails before writing when any server fails or names collide", async (t) => {
  const target = await destination(t);
  await assert.rejects(syncSkills({ servers: [fixture(), fixture("broken", "second")],
    destination: target }), /Fixture read failed/);
  await assert.rejects(stat(target), { code: "ENOENT" });
  await assert.rejects(syncSkills({ servers: [fixture(), fixture("v2", "second")],
    destination: target }), /collision/);
  await assert.rejects(stat(target), { code: "ENOENT" });
});

test("rejects URI mismatch, blobs and lossy invocation-policy conversion", () => {
  const uri = "skill://sample";
  const raw = "---\nname: sample\ndescription: Example.\n---\n\nWorkflow.\n";
  const response = (text) => ({ contents: [{ uri, text }] });
  assert.equal(validateSkill(uri, response(raw)).text, raw);
  assert.throws(() => validateSkill("skill://../sample", response(raw)), /Invalid/);
  assert.throws(() => validateSkill(uri,
    response(raw.replace("name: sample", "name: other"))), /name\/description/);
  assert.throws(() => validateSkill(uri, { contents: [{ uri, blob: "YQ==" }] }),
    /invalid text/);
  assert.throws(() => validateSkill(uri, response(raw.replace("description: Example.",
    "description: Example.\nuser-invocable: false"))), /losslessly/);
});
