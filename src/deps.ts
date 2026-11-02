// Dependencies of a project as Errata needs them: ecosystem, name and what is known about the installed version.
// Lockfiles (package-lock.json, uv.lock, poetry.lock) give exact versions, possibly several of one package;
// manifests (package.json, requirements.txt) give ranges, which stay ranges: no installed version is made up.

import { readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname, basename, resolve } from "node:path";
import { Ecosystem, Installed, fromSpec, normName } from "./core/index.js";

export const FILES = ["package-lock.json", "package.json", "uv.lock", "poetry.lock", "requirements.txt"] as const;
const LOCKS: Record<string, Ecosystem> = { "package-lock.json": "npm", "uv.lock": "pypi", "poetry.lock": "pypi" };
const MAX_INCLUDE_DEPTH = 5;

export interface Dep { ecosystem: Ecosystem; name: string; installed: Installed }
export interface Discovery { root: string; files: string[]; deps: Dep[]; warnings: string[] }

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function fromPackageLock(path: string): Dep[] {
  const d = readJson(path);
  const out: Dep[] = [];
  const src = basename(path);
  if (d.packages && typeof d.packages === "object") {                  // lockfileVersion 2 and 3
    for (const [key, v] of Object.entries<any>(d.packages)) {
      if (!key || v?.link || !v?.version) continue;
      const i = key.lastIndexOf("node_modules/");
      if (i < 0) continue;
      out.push({ ecosystem: "npm", name: key.slice(i + "node_modules/".length), installed: { kind: "exact", version: v.version, source: src } });
    }
    return out;
  }
  const walk = (deps: any) => {                                        // lockfileVersion 1
    for (const [name, v] of Object.entries<any>(deps || {})) {
      if (v?.version && /^\d/.test(v.version)) out.push({ ecosystem: "npm", name, installed: { kind: "exact", version: v.version, source: src } });
      walk(v?.dependencies);
    }
  };
  walk(d.dependencies);
  return out;
}

export function fromPackageJson(path: string): Dep[] {
  const d = readJson(path);
  const out: Dep[] = [];
  for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    for (const [name, spec] of Object.entries<any>(d[field] || {})) {
      out.push({ ecosystem: "npm", name, installed: fromSpec("npm", String(spec), basename(path)) });
    }
  }
  return out;
}

/** [[package]] blocks of uv.lock and poetry.lock: name and version only. */
export function fromTomlLock(path: string): Dep[] {
  const out: Dep[] = [];
  const src = basename(path);
  for (const block of readFileSync(path, "utf8").split(/^\[\[package\]\]\s*$/m).slice(1)) {
    const body = block.split(/^\[(?!\[package\]\])/m)[0];             // stop at the next table header
    const name = /^name\s*=\s*"([^"]+)"/m.exec(body)?.[1];
    const version = /^version\s*=\s*"([^"]+)"/m.exec(body)?.[1];
    if (name && version) out.push({ ecosystem: "pypi", name, installed: { kind: "exact", version, source: src } });
  }
  return out;
}

export function fromRequirements(path: string, depth = 0, warnings: string[] = []): Dep[] {
  const out: Dep[] = [];
  const src = basename(path);
  for (let line of readFileSync(path, "utf8").split(/\r?\n/)) {
    line = line.replace(/(^|\s)#.*$/, "").trim();
    if (!line) continue;
    const inc = /^(?:-r|--requirement)\s*=?\s*(\S+)/.exec(line);
    if (inc) {
      const p = resolve(dirname(path), inc[1]);
      if (depth < MAX_INCLUDE_DEPTH && existsSync(p)) out.push(...fromRequirements(p, depth + 1, warnings));
      else warnings.push(`${src}: include ${inc[1]} not read`);
      continue;
    }
    if (line.startsWith("-") || /^[a-z+]+:\/\//i.test(line)) continue;  // options, -e, -c, bare URLs
    const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(\[[^\]]*\])?\s*(.*)$/.exec(line.split(";")[0].trim());
    if (!m) continue;
    const spec = m[3].trim();
    if (spec.startsWith("@")) {                                        // name @ url: version not known
      out.push({ ecosystem: "pypi", name: m[1], installed: { kind: "none", spec, source: src } });
      continue;
    }
    out.push({ ecosystem: "pypi", name: m[1], installed: fromSpec("pypi", spec.replace(/\s+/g, ""), src) });
  }
  return out;
}

const key = (d: Dep) => `${d.ecosystem}/${normName(d.ecosystem, d.name)}`;

/** Read the project at `path` (a directory, or one of the files). A package a lockfile pins is taken from the
 * lockfile (every version it pins); a package only a manifest names keeps the manifest's range. */
export function discover(path: string): Discovery {
  const abs = resolve(path || ".");
  const isFile = existsSync(abs) && statSync(abs).isFile();
  const root = isFile ? dirname(abs) : abs;
  const files = isFile ? [abs] : FILES.map((f) => join(root, f)).filter((f) => existsSync(f));
  const warnings: string[] = [];
  const locked = new Map<string, Dep[]>();
  const manifest = new Map<string, Dep>();
  for (const f of files) {
    const b = basename(f);
    let deps: Dep[] = [];
    try {
      if (b === "package-lock.json" || b === "npm-shrinkwrap.json") deps = fromPackageLock(f);
      else if (b === "package.json") deps = fromPackageJson(f);
      else if (b === "uv.lock" || b === "poetry.lock") deps = fromTomlLock(f);
      else if (b.endsWith(".txt")) deps = fromRequirements(f, 0, warnings);
      else { warnings.push(`${b}: not a file errata reads`); continue; }
    } catch (e) {
      warnings.push(`${b}: could not be read (${(e as Error).message})`);
      continue;
    }
    for (const d of deps) {
      if (LOCKS[b] || d.installed.kind === "exact" && b.endsWith(".lock")) {
        const list = locked.get(key(d)) ?? [];
        if (!list.some((x) => x.installed.kind === "exact" && d.installed.kind === "exact" && x.installed.version === d.installed.version)) list.push(d);
        locked.set(key(d), list);
      } else if (!manifest.has(key(d)) || manifest.get(key(d))!.installed.kind !== "exact") {
        manifest.set(key(d), d);
      }
    }
  }
  const deps: Dep[] = [];
  for (const list of locked.values()) deps.push(...list);
  for (const [k, d] of manifest) if (!locked.has(k)) deps.push(d);
  return { root, files: files.map((f) => basename(f)), deps, warnings };
}
