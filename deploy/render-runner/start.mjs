import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function git(args, cwd, env) {
  return new Promise((resolveGit, rejectGit) => {
    const child = spawn("git", args, { cwd, env, stdio: ["ignore", "pipe", "ignore"], timeout: 120_000 });
    const stdout = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.on("error", () => rejectGit(new Error("Could not start Git for the app source")));
    child.on("exit", (code) =>
      code === 0
        ? resolveGit(Buffer.concat(stdout).toString("utf8"))
        : rejectGit(new Error(`App source Git command failed (${code})`)),
    );
  });
}

export async function prepareRenderApp(manifestPath, appDir, env = process.env) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const url = new URL(manifest.url);
  if (
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    typeof manifest.token !== "string" ||
    !manifest.token ||
    /[\r\n\0]/.test(manifest.token) ||
    typeof manifest.commit !== "string" ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(manifest.commit) ||
    typeof manifest.entrypoint !== "string" ||
    !manifest.entrypoint.trim() ||
    manifest.entrypoint.includes("\0")
  )
    throw new Error("Invalid Render app source manifest");
  const staging = await mkdtemp(join(tmpdir(), "qm-render-source-"));
  const gitEnv = {
    ...env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_COUNT: "3",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: `Authorization: Bearer ${manifest.token}`,
    GIT_CONFIG_KEY_1: "http.followRedirects",
    GIT_CONFIG_VALUE_1: "false",
    GIT_CONFIG_KEY_2: "credential.helper",
    GIT_CONFIG_VALUE_2: "",
  };
  try {
    await git(["init", "--quiet"], staging, gitEnv);
    await git(["fetch", "--quiet", "--no-tags", "--depth=1", url.toString(), manifest.commit], staging, gitEnv);
    await git(["checkout", "--quiet", "--detach", "FETCH_HEAD"], staging, gitEnv);
    if ((await git(["rev-parse", "HEAD"], staging, gitEnv)).trim() !== manifest.commit)
      throw new Error("Render app source does not match the selected commit");
    await rm(join(staging, ".git"), { recursive: true });
    await mkdir(appDir, { recursive: true });
    for (const entry of await readdir(appDir)) await rm(join(appDir, entry), { recursive: true, force: true });
    await cp(staging, appDir, { recursive: true, verbatimSymlinks: true });
    return manifest.entrypoint;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export async function runRenderApp({
  manifestPath = "/etc/secrets/qm-render-artifact.json",
  appDir = "/app",
  env = process.env,
} = {}) {
  const entrypoint = await prepareRenderApp(manifestPath, appDir, env);
  const appEnv = { ...env, PORT: "8080" };
  for (const key of Object.keys(appEnv))
    if (key.startsWith("GIT_CONFIG_") || key === "GIT_ASKPASS" || key === "SSH_ASKPASS") delete appEnv[key];
  const child = spawn("bash", ["-c", entrypoint], {
    cwd: appDir,
    env: appEnv,
    stdio: "inherit",
    detached: true,
  });
  const forward = (signal) => {
    if (!child.pid) return;
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  };
  const term = () => forward("SIGTERM");
  const interrupt = () => forward("SIGINT");
  process.on("SIGTERM", term);
  process.on("SIGINT", interrupt);
  try {
    return await new Promise((resolveExit, rejectExit) => {
      child.on("error", rejectExit);
      child.on("exit", (code, signal) => resolveExit(code ?? (signal === "SIGTERM" ? 143 : 1)));
    });
  } finally {
    process.off("SIGTERM", term);
    process.off("SIGINT", interrupt);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await runRenderApp();
  } catch {
    console.error("Render app startup failed; check its source, credential, and entrypoint");
    process.exitCode = 1;
  }
}
