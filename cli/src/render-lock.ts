import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { CliError } from "./log.ts";
import { sleep } from "./util.ts";

function releaseLock(lock: string, owner?: string): void {
  if (owner) rmSync(join(lock, owner), { force: true });
  try {
    rmdirSync(lock);
  } catch (error) {
    if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function reclaimStaleLock(lock: string): void {
  try {
    const [owner, ...others] = readdirSync(lock);
    if (!owner || others.length) return;
    const pid = Number(readFileSync(join(lock, owner), "utf8"));
    const held = Number.isInteger(pid) && pid > 0 ? alive(pid) : Date.now() - statSync(lock).mtimeMs <= 5_000;
    if (!held) releaseLock(lock, owner);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function withRenderLock<T>(lock: string, fn: () => Promise<T>): Promise<T> {
  mkdirSync(dirname(lock), { recursive: true });
  const candidate = mkdtempSync(`${lock}-`);
  const owner = `owner-${randomUUID()}`;
  const deadline = Date.now() + 30_000;
  let acquired = false;
  try {
    writeFileSync(join(candidate, owner), String(process.pid));
    for (;;) {
      reclaimStaleLock(lock);
      try {
        renameSync(candidate, lock);
        acquired = true;
        break;
      } catch (error) {
        if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      }
      if (Date.now() >= deadline)
        throw new CliError(`Another qm operation holds ${lock}; wait for it to finish and retry`);
      await sleep(50);
    }
    return await fn();
  } finally {
    if (acquired) releaseLock(lock, owner);
    else rmSync(candidate, { recursive: true, force: true });
  }
}
