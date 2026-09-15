import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

/** Retain the actual uncommitted sources used by a whole-job qualification. */
export async function recordSourceIdentity(): Promise<void> {
  const artifacts = process.env.MINE_LABS_ARTIFACTS_DIR;
  if (!artifacts) throw new Error("Qualification requires an artifacts directory.");
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const files: { path: string; sha256: string; source: string }[] = [];
  for (const directory of ["src", "scenarios"]) {
    const entries = await readdir(path.join(root, directory), { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !/\.(ts|yaml|json)$/.test(entry.name)) continue;
      const filename = path.join(entry.parentPath, entry.name);
      const source = await readFile(filename, "utf8");
      files.push({
        path: path.relative(root, filename).replaceAll("\\", "/"),
        sha256: createHash("sha256").update(source).digest("hex"),
        source,
      });
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", windowsHide: true }).trim();
  const identity = { head, recordedAt: new Date().toISOString(), files };
  await writeFile(path.join(artifacts, "qualification-source.json.gz"), gzipSync(JSON.stringify(identity)));
  await writeFile(
    path.join(artifacts, "qualification-source.json"),
    JSON.stringify(
      {
        head,
        recordedAt: identity.recordedAt,
        files: files.map(({ path, sha256 }) => ({ path, sha256 })),
      },
      null,
      2,
    ),
  );
}
