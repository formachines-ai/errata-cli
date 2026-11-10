// D9 acceptance: the control project (test/fixtures/control) with six cases, each with its own answer; the parsers;
// --report asks before sending. The base is the snapshot of formachines.ai (core/test/fixtures/site).
import { describe, it, expect } from "vitest";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync, spawn } from "node:child_process";
import { run, Io, EXIT, USER_AGENT } from "../src/main.js";
import { NO_MATCH_NOTE } from "../src/core/index.js";
import { discover, fromRequirements, fromTomlLock, fromPackageLock } from "../src/deps.js";
import { VERSION } from "../src/version.js";
import { snapshotFetch, serveSnapshot, deadUrl, Recorded } from "./helpers.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONTROL = join(ROOT, "test", "fixtures", "control");

function io(answers: string[] = [], opts: Partial<Io> = {}, log: Recorded[] = []) {
  const out: string[] = [], err: string[] = [], asked: string[] = [];
  const q = [...answers];
  const x: Io = {
    out: (s) => out.push(s), err: (s) => err.push(s), isTTY: true, env: {},
    ask: async (p) => { asked.push(p); return q.shift() ?? ""; }, fetchImpl: snapshotFetch(log), ...opts,
  };
  return { io: x, out, err, asked, log };
}

async function checkJson(args: string[] = []) {
  const t = io();
  const code = await run(["check", CONTROL, "--json", ...args], t.io);
  return { code, body: JSON.parse(t.out.join("\n")), t };
}

describe("parsers", () => {
  it("package-lock v3 keeps every version of a package", () => {
    const deps = fromPackageLock(join(CONTROL, "package-lock.json")).filter((d) => d.name === "typescript");
    expect(deps.map((d) => (d.installed as any).version).sort()).toEqual(["6.0.2", "7.0.2"]);
  });
  it("uv.lock and poetry.lock blocks", () => {
    expect(fromTomlLock(join(CONTROL, "uv.lock")).map((d) => `${d.name}==${(d.installed as any).version}`))
      .toEqual(["click==8.5.0", "openai==3.35.1", "httpx==0.28.1"]);
    const dir = mkdtempSync(join(tmpdir(), "errata-"));
    writeFileSync(join(dir, "poetry.lock"), '[[package]]\nname = "huggingface-hub"\nversion = "2.4.0"\ndescription = "x"\n\n[package.dependencies]\nfilelock = "*"\n\n[metadata]\nlock-version = "2.0"\n');
    expect(fromTomlLock(join(dir, "poetry.lock"))).toEqual([{ ecosystem: "pypi", name: "huggingface-hub", installed: { kind: "exact", version: "2.4.0", source: "poetry.lock" } }]);
  });
  it("requirements.txt: pins, ranges, markers, extras, includes, urls", () => {
    const dir = mkdtempSync(join(tmpdir(), "errata-"));
    writeFileSync(join(dir, "base.txt"), "networkx==3.7\n");
    writeFileSync(join(dir, "requirements.txt"), "-r base.txt\n# c\nrequests[socks]>=2 ; python_version>'3'\n-e .\nfoo @ https://x/y.whl\nbar\nhttps://x/z.whl\n");
    const d = fromRequirements(join(dir, "requirements.txt"));
    expect(d.map((x) => [x.name, x.installed.kind])).toEqual([["networkx", "exact"], ["requests", "range"], ["foo", "none"], ["bar", "none"]]);
  });
  it("discover: a lockfile wins over the manifest; a manifest-only package keeps its range", () => {
    const d = discover(CONTROL);
    expect(d.files).toEqual(["package-lock.json", "package.json", "uv.lock", "requirements.txt"]);
    const click = d.deps.filter((x) => x.name === "click");
    expect(click).toEqual([expect.objectContaining({ installed: expect.objectContaining({ kind: "exact", version: "8.5.0" }) })]);
    expect(d.deps.find((x) => x.name === "scipy")?.installed).toMatchObject({ kind: "range", spec: ">=1.17,<2" });
  });
});

describe("control project: six cases", () => {
  it("1 exact version from a lockfile → apply (click) and verified lead (typeorm, auto_apply false)", async () => {
    const { code, body } = await checkJson();
    expect(code).toBe(EXIT.OK);
    expect(body.entries.find((e: any) => e.package === "click")).toMatchObject({ installed: "8.5.0", verdict: "apply", grade: "verified" });
    expect(body.entries.find((e: any) => e.package === "typeorm")).toMatchObject({ installed: "1.1.2", verdict: "lead", grade: "verified" });
  });
  it("2 range without a lockfile → possible, lead, no version made up", async () => {
    const { body } = await checkJson();
    const scipy = body.entries.filter((e: any) => e.package === "scipy");
    expect(scipy.length).toBe(2);
    for (const e of scipy) expect(e).toMatchObject({ installed: ">=1.17,<2 (range)", grade: "possible", verdict: "lead" });
  });
  it("3 two versions of one package → each its own answer", async () => {
    const { body } = await checkJson(["--all"]);
    const ts = body.entries.filter((e: any) => e.package === "typescript");
    expect(ts.filter((e: any) => e.installed === "7.0.2").map((e: any) => e.grade)).toEqual(["verified", "verified"]);
    expect(ts.filter((e: any) => e.installed === "6.0.2").map((e: any) => e.verdict)).toEqual(["none", "none"]);
    const plain = await checkJson();
    expect(plain.body.entries.some((e: any) => e.installed === "6.0.2")).toBe(false);          // hidden without --all
  });
  it("4 unknown package → not in the table, counted as without corrections", async () => {
    const { body } = await checkJson();
    expect(body.entries.some((e: any) => e.package === "left-pad" || e.package === "httpx")).toBe(false);
    expect(body).toMatchObject({ dependencies: 9, covered: 5 });
  });
  it("5 withdrawn entry → not offered, named with its status", async () => {
    const { body } = await checkJson();
    expect(body.entries.some((e: any) => e.package === "openai")).toBe(false);
    expect(body.not_offered).toContainEqual(expect.objectContaining({ id: "pypi/openai/3.35.1/0001", status: "withdrawn", package: "pypi/openai" }));
    expect(body.not_offered.filter((x: any) => x.id === "npm/typescript/7.0.2/0007").length).toBe(1);
  });
  it("6 base unavailable → exit 2 and a technical error, not 'no corrections'", async () => {
    const t = io([], { fetchImpl: undefined, env: { ERRATA_BASE_URL: await deadUrl(), ERRATA_TIMEOUT_MS: "2000" } });
    expect(await run(["check", CONTROL], t.io)).toBe(EXIT.TECHNICAL);
    expect(t.err.join("\n")).toContain("could not be read: ECONNREFUSED");
    expect(t.out.join("\n")).not.toContain("No correction");
    const j = io([], { fetchImpl: undefined, env: { ERRATA_BASE_URL: await deadUrl() } });
    expect(await run(["check", CONTROL, "--json"], j.io)).toBe(EXIT.TECHNICAL);
    expect(JSON.parse(j.out[0]).status).toBe("technical_error");
  });
});

describe("five-line summary (FB-4)", () => {
  it("opens the text output and the JSON with the same counts and the closing note", async () => {
    const t = io();
    expect(await run(["check", CONTROL], t.io)).toBe(EXIT.OK);
    const lines = t.out.join("\n").split("\n");
    const k = lines.findIndex((l) => l.startsWith("Dependencies found: "));
    expect(k).toBeGreaterThan(0);
    expect(lines[k]).toBe("Dependencies found: 9, 8 with an exact version");
    expect(lines[k + 1]).toBe("In Errata: 5 of them");
    expect(lines[k + 2]).toMatch(/^Match your versions: \d+ entries — \d+ patch, \d+ partial, \d+ lead$/);
    expect(lines[k + 3]).toMatch(/^Need a person: \d+ to apply once your code is seen to use the changed name \(detect\), \d+ for a manual decision \(lead\)$/);
    expect(lines[k + 4]).toBe("Not covered: 4 dependencies");
    expect(lines[k + 5]).toBe(NO_MATCH_NOTE);
    const j = io();
    await run(["check", CONTROL, "--json"], j.io);
    const body = JSON.parse(j.out[0]);
    const m = body.summary.matching;
    expect(body.summary).toMatchObject({ dependencies: 9, exact: 8, covered: 5, not_covered: 4, note: NO_MATCH_NOTE });
    expect(m.patch + m.partial + m.lead).toBe(m.entries);
    expect(body.summary.to_check.usage + body.summary.to_check.manual).toBe(m.entries);
    expect(m.entries).toBe(body.entries.filter((e: any) => e.verdict !== "none").length);
    expect(body.summary_lines.slice(0, 6)).toEqual(lines.slice(k, k + 6));
    expect(body.entries.find((e: any) => e.package === "click")).toMatchObject({ verdict: "apply", readiness: "patch" });
    expect(body.entries.find((e: any) => e.package === "typeorm")).toMatchObject({ verdict: "lead", readiness: "partial" });
  });
});

describe("table, flags, report", () => {
  it("table names verdicts and links; overhead line; --fail-on", async () => {
    const t = io();
    expect(await run(["check", CONTROL], t.io)).toBe(EXIT.OK);
    const s = t.out.join("\n");
    expect(s).toMatch(/apply\s+patch\s+pypi\/click\s+8\.5\.0/);
    expect(s).toContain("https://formachines.ai/errata/pypi/click/0001-click-parameter/");
    expect(s).toMatch(/\d+ requests, [\d.]+ kB, [\d.]+ s/);
    expect(await run(["check", CONTROL, "--fail-on", "apply"], io().io)).toBe(EXIT.FOUND);
  });
  it("every request carries the CLI User-Agent", async () => {
    const log: Recorded[] = [];
    await run(["check", CONTROL], io([], {}, log).io);
    expect(new Set(log.map((x) => x.ua))).toEqual(new Set([USER_AGENT]));
    expect(USER_AGENT).toBe(`formachines-errata-cli/${VERSION}`);
    expect(VERSION).toBe(JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version);
  });
  it("--report asks per entry and before sending; 'n' sends nothing, 'y' sends once", async () => {
    const log: Recorded[] = [];
    const no = io(["c", "worked on 8.5.0", "n", "q"], {}, log);
    await run(["check", CONTROL, "--report"], no.io);
    expect(log.some((x) => x.method === "POST")).toBe(false);
    expect(no.asked.some((q) => q.includes("Send? [y/N]"))).toBe(true);
    const yes = io(["s", "d", "", "y", "q"], {}, log);
    await run(["check", CONTROL, "--report"], yes.io);
    const posts = log.filter((x) => x.method === "POST");
    expect(posts.length).toBe(1);
    expect(JSON.parse(posts[0].body!)).toMatchObject({ kind: "dispute", outcome: "failed" });
  });
  it("report without a terminal needs --yes; refuses merged ids", async () => {
    const t = io([], { isTTY: false, ask: undefined });
    expect(await run(["report", "pypi/click/8.5.0/0001", "confirm"], t.io)).toBe(EXIT.USAGE);
    const log: Recorded[] = [];
    const y = io([], { isTTY: false, ask: undefined }, log);
    expect(await run(["report", "pypi/click/8.5.0/0001", "confirm", "--note", "test from W3-1", "--yes"], y.io)).toBe(EXIT.OK);
    expect(y.out.join("")).toContain("sent: received as fb-test-0001");
    const m = io([], { isTTY: false, ask: undefined }, log);
    await run(["report", "npm/typescript/7.0.2/0007", "confirm", "--yes"], m.io);
    expect(m.err.join("")).toContain("merged into npm/typescript/7.0.2/0004");
    expect(log.filter((x) => x.method === "POST").length).toBe(1);
  });
  it("--report without a terminal is refused, usage errors are 64", async () => {
    expect(await run(["check", CONTROL, "--report"], io([], { isTTY: false, ask: undefined }).io)).toBe(EXIT.USAGE);
    expect(await run(["frobnicate"], io().io)).toBe(EXIT.USAGE);
    expect(await run(["check", CONTROL, "--fail-on", "x"], io().io)).toBe(EXIT.USAGE);
  });
});

describe("the built binary", () => {
  it("runs against the snapshot over HTTP like npx would", async () => {
    const log: Recorded[] = [];
    const site = await serveSnapshot(log);
    try {
      const r = await new Promise<{ status: number | null; stdout: string }>((resolve) => {
        const p = spawn(process.execPath, [join(ROOT, "dist", "bin.js"), "check", CONTROL, "--json"], { env: { ...process.env, ERRATA_BASE_URL: site.url } });
        let stdout = "";
        p.stdout.on("data", (c: Buffer) => (stdout += c));
        p.on("close", (status: number) => resolve({ status, stdout }));
      });
      expect(r.status).toBe(0);
      expect(JSON.parse(r.stdout).entries.find((e: any) => e.package === "click").verdict).toBe("apply");
      expect(log.every((x) => x.ua === USER_AGENT)).toBe(true);
    } finally {
      await site.close();
    }
  });
  it("--version and --help", () => {
    expect(execFileSync(process.execPath, [join(ROOT, "dist", "bin.js"), "--version"]).toString().trim()).toBe(VERSION);
    const h = spawnSync(process.execPath, [join(ROOT, "dist", "bin.js"), "--help"]);
    expect(h.status).toBe(0);
    expect(h.stdout.toString()).toContain("errata check [path]");
  });
});
