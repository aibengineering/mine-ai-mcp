/** Build this suite's viewer dependency; Mine Labs only installs the resulting JAR. */
import { cp, mkdir, rm, copyFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const root = path.resolve(import.meta.dirname, "../..");
const source = path.join(root, "node_modules/@aibengineering/minecraft-block-highlighter/mod");
const build = path.join(root, ".mine-labs/spectator-mod-build");
await mkdir(build, { recursive: true });
// Only generated sources inside this fixed build directory are replaced; Gradle caches remain.
await rm(path.join(build, "src"), { recursive: true, force: true });
for (const name of ["src", "gradle", "build.gradle", "settings.gradle", "gradle.properties"]) {
  await cp(path.join(source, name), path.join(build, name), { recursive: true });
}
const java = process.env.JAVA_HOME
  ? path.join(process.env.JAVA_HOME, "bin", process.platform === "win32" ? "java.exe" : "java")
  : "java";
const child = spawn(java, ["-jar", "gradle/wrapper/gradle-wrapper.jar", "build", "--no-daemon", "--console=plain"], {
  cwd: build, stdio: "inherit", windowsHide: true,
});
await new Promise<void>((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`Highlighter build exited ${code}`)));
});
const artifacts = path.join(root, ".mine-labs/mods");
await mkdir(artifacts, { recursive: true });
await copyFile(path.join(build, "build/libs/blockhighlighter-0.1.0.jar"), path.join(artifacts, "blockhighlighter.jar"));
