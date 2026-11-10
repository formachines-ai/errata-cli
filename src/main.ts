// errata — the Errata CLI. `errata check [path]` reads the project's manifests and lockfiles and lists the corrections
// that may apply, with links; `--json` for machines; `--report` asks, per correction, whether it worked and sends
// confirm/dispute after a yes. `errata report <id> confirm|dispute` does the same for one entry.

import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import {
  AGENT_RULE, CLIENT_RULE, ErrataClient, ErrataUnavailable, PackageResult, checkPackage, optionsFromEnv, planReport,
  sendReport, summarize, summaryLines, MAX_NOTE,
} from "./core/index.js";
import { discover } from "./deps.js";
import { VERSION } from "./version.js";

export const USER_AGENT = `formachines-errata-cli/${VERSION}`;
export const EXIT = { OK: 0, FOUND: 1, TECHNICAL: 2, USAGE: 64 } as const;
const CONCURRENCY = 8;

export interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
  isTTY: boolean;
  ask?: (q: string) => Promise<string>;
  env: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

const HELP = `errata ${VERSION} — corrections where AI models write outdated code for your dependencies (formachines.ai/errata)

Usage:
  errata check [path] [--json] [--all] [--report] [--fail-on apply|lead]
  errata report <id> <confirm|dispute> [--note TEXT] [--yes]
  errata --version | --help

check reads package.json, package-lock.json, requirements.txt, uv.lock, poetry.lock in [path] (default: .).
Exit codes: 0 done, 1 --fail-on matched, 2 the base could not be read, 64 usage.
Environment: ERRATA_BASE_URL, ERRATA_FEEDBACK_URL, ERRATA_TIMEOUT_MS, ERRATA_CACHE_TTL_S, ERRATA_LOG_LEVEL, ERRATA_NO_TELEMETRY.`;

async function mapLimit<T, R>(items: T[], n: number, f: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await f(items[k]); }
  }));
  return out;
}

function installedText(r: PackageResult): string {
  const i = r.installed;
  return i.kind === "exact" ? i.version : i.kind === "range" ? `${i.spec} (range)` : "unknown";
}

function table(rows: string[][]): string {
  const w = rows[0].map((_, c) => Math.max(...rows.map((r) => r[c].length)));
  return rows.map((r, k) => {
    const line = r.map((x, c) => (c === r.length - 1 ? x : x.padEnd(w[c]))).join("  ").trimEnd();
    return k === 0 ? `${line}\n${w.map((n, c) => "-".repeat(c === w.length - 1 ? Math.min(n, 60) : n)).join("  ")}` : line;
  }).join("\n");
}

function makeClient(io: Io, log: (l: any, m: string) => void) {
  return new ErrataClient({ ...optionsFromEnv(USER_AGENT, io.env), fetchImpl: io.fetchImpl, log });
}

export async function run(argv: string[], io: Io): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv, allowPositionals: true,
      options: {
        json: { type: "boolean" }, all: { type: "boolean" }, report: { type: "boolean" }, yes: { type: "boolean", short: "y" },
        note: { type: "string" }, "fail-on": { type: "string" }, help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
    });
  } catch (e) {
    io.err(`${(e as Error).message}\n\n${HELP}`);
    return EXIT.USAGE;
  }
  const { values: o, positionals: pos } = parsed;
  if (o.version) { io.out(VERSION); return EXIT.OK; }
  if (o.help || !pos.length) { io.out(HELP); return pos.length || o.help ? EXIT.OK : EXIT.USAGE; }
  const LEVELS = ["debug", "info", "warn", "error"];
  const min = Math.max(0, LEVELS.indexOf(io.env.ERRATA_LOG_LEVEL || "error"));
  const log = (level: string, msg: string) => { if (LEVELS.indexOf(level) >= min) io.err(`${new Date().toISOString()} ${level.toUpperCase()} ${msg}`); };
  const [cmd, ...rest] = pos;
  if (cmd === "check") return check(rest[0] || ".", o, io, makeClient(io, log), log);
  if (cmd === "report") return report(rest, o, io, makeClient(io, log));
  io.err(`unknown command '${cmd}'\n\n${HELP}`);
  return EXIT.USAGE;
}

async function check(path: string, o: any, io: Io, client: ErrataClient, log: (l: string, m: string) => void): Promise<number> {
  if (o["fail-on"] && !["apply", "lead"].includes(o["fail-on"])) { io.err("--fail-on must be apply or lead"); return EXIT.USAGE; }
  const t0 = Date.now();
  const found = discover(path);
  log("info", `read ${found.files.join(", ") || "nothing"} in ${found.root}: ${found.deps.length} dependencies`);
  for (const w of found.warnings) io.err(`warning: ${w}`);
  if (!found.files.length) {
    io.err(`no package.json, package-lock.json, requirements.txt, uv.lock or poetry.lock in ${found.root}`);
    return EXIT.USAGE;
  }
  let results: PackageResult[];
  try {
    results = await mapLimit(found.deps, CONCURRENCY, (d) => checkPackage(client, d.ecosystem, d.name, d.installed));
  } catch (e) {
    const why = e instanceof ErrataUnavailable ? `${e.reason} (${e.url})` : (e as Error).message;
    if (o.json) io.out(JSON.stringify({ status: "technical_error", message: `the Errata base could not be read: ${why}` }));
    io.err(`errata: the base could not be read: ${why}. Nothing is known about your dependencies from this run.`);
    return EXIT.TECHNICAL;
  }
  const ms = Date.now() - t0;
  const shown = results.flatMap((r) => r.entries.filter((e) => o.all || e.verdict !== "none").map((e) => ({ r, e })));
  const seen = new Set<string>();                    // two versions of one package share its merged/withdrawn ids
  const excluded = results.flatMap((r) => r.excluded.map((x) => ({ r, x }))).filter(({ x }) => !seen.has(x.id) && !!seen.add(x.id));
  const covered = results.filter((r) => r.coverage === "covered");
  const overhead = { ms, requests: client.stats.requests, bytes: client.stats.bytes, cache_hits: client.stats.cacheHits };
  const summary = summarize(results);                 // FB-4: the five lines first
  log("info", `summary: ${JSON.stringify(summary)}`);
  log("info", `overhead: ${JSON.stringify(overhead)}`);

  if (o.json) {
    io.out(JSON.stringify({
      status: shown.length ? "found" : "none", tool: USER_AGENT, root: found.root, files: found.files,
      dependencies: found.deps.length, covered: covered.length, summary, summary_lines: summaryLines(summary),
      rule: AGENT_RULE, client_rule: CLIENT_RULE,
      entries: shown.map(({ r, e }) => ({ ecosystem: r.ecosystem, package: r.package, installed: installedText(r), ...e })),
      not_offered: excluded.map(({ r, x }) => ({ package: `${r.ecosystem}/${r.package}`, installed: installedText(r), ...x })),
      warnings: found.warnings, overhead,
    }, null, 2));
  } else {
    io.out(`errata ${VERSION}: read ${found.files.join(", ")}\n\n` + summaryLines(summary).join("\n"));
    if (shown.length) {
      const rows = [["verdict", "readiness", "package", "installed", "checked on", "entry", "grade", "link"]];
      const order = { apply: 0, lead: 1, none: 2 } as const;
      shown.sort((a, b) => order[a.e.verdict] - order[b.e.verdict] || a.r.package.localeCompare(b.r.package));
      for (const { r, e } of shown) {
        rows.push([e.verdict, e.readiness, `${r.ecosystem}/${r.package}`, installedText(r), e.verified_on.join(", "),
          `${e.symbol ?? ""} (${e.id.split("/").pop()})`, e.grade, e.url]);
      }
      io.out("\n" + table(rows));
      io.out(`\napply = checked on your installed version and proof.auto_apply is true; lead = may apply, review first ` +
        `or show to a person. readiness: patch = the short patch applies word for word; partial = it covers part of ` +
        `the change; lead = it does not apply word for word, the entry has a full example. Reasons are in --json.`);
    }
    const hidden = results.reduce((n, r) => n + r.entries.filter((e) => e.verdict === "none").length, 0);
    if (hidden && !o.all) io.out(`\n${hidden} ${hidden === 1 ? "entry does" : "entries do"} not apply: the installed version predates the change (--all shows them).`);
    if (excluded.length) {
      const by = new Map<string, { merged: number; withdrawn: number }>();
      for (const { r, x } of excluded) {
        const k = `${r.ecosystem}/${r.package}`;
        const c = by.get(k) ?? { merged: 0, withdrawn: 0 };
        c[x.status]++;
        by.set(k, c);
      }
      io.out(`\nNot offered, merged or withdrawn (ids in --json): ` + [...by].map(([k, c]) =>
        `${k} ${[c.merged ? `${c.merged} merged` : "", c.withdrawn ? `${c.withdrawn} withdrawn` : ""].filter(Boolean).join(", ")}`).join("; "));
    }
    io.out(`\n${overhead.requests} requests, ${(overhead.bytes / 1024).toFixed(1)} kB, ${(ms / 1000).toFixed(2)} s`);
  }
  if (o.report) {
    const code = await reportLoop(shown.filter(({ e }) => e.verdict !== "none").map(({ e }) => e.id), o, io, client);
    if (code) return code;
  }
  const fail = o["fail-on"];
  if (fail && shown.some(({ e }) => e.verdict === "apply" || (fail === "lead" && e.verdict === "lead"))) return EXIT.FOUND;
  return EXIT.OK;
}

async function confirmSend(io: Io, text: string, yes: boolean): Promise<boolean> {
  if (yes) return true;
  const a = (await io.ask!(`${text} Send? [y/N] `)).trim().toLowerCase();
  return a === "y" || a === "yes";
}

async function reportLoop(ids: string[], o: any, io: Io, client: ErrataClient): Promise<number> {
  if (!io.isTTY || !io.ask) {
    io.err("--report asks before sending and needs a terminal; use `errata report <id> confirm|dispute --yes` in scripts");
    return EXIT.USAGE;
  }
  for (const id of ids) {
    const a = (await io.ask(`\n${id}: did the fix work? [c]onfirm / [d]ispute / [s]kip / [q]uit: `)).trim().toLowerCase();
    if (a.startsWith("q")) break;
    if (!a.startsWith("c") && !a.startsWith("d")) continue;
    const note = (await io.ask(`note (optional, at most ${MAX_NOTE} characters, no secrets): `)).trim().slice(0, MAX_NOTE);
    const code = await sendOne(id, a.startsWith("c") ? "confirm" : "dispute", note, false, io, client);
    if (code === EXIT.TECHNICAL) return code;
  }
  return 0;
}

async function sendOne(id: string, verdict: string, note: string, yes: boolean, io: Io, client: ErrataClient): Promise<number> {
  try {
    const plan = await planReport(client, id, verdict, note);
    if (!plan.ok) { io.err(`not sent: ${plan.message}`); return plan.status === "invalid" ? EXIT.USAGE : EXIT.OK; }
    if (!(await confirmSend(io, `${plan.message}\n  ${JSON.stringify(plan.payload)}\n`, yes))) { io.out("not sent"); return EXIT.OK; }
    const r = await sendReport(client, plan);
    (r.sent ? io.out : io.err)(r.sent ? `sent: ${r.message}` : `not accepted: ${r.message}`);
    return r.sent ? EXIT.OK : EXIT.TECHNICAL;
  } catch (e) {
    const why = e instanceof ErrataUnavailable ? `${e.reason} (${e.url})` : (e as Error).message;
    io.err(`errata: not sent, the base could not be reached: ${why}`);
    return EXIT.TECHNICAL;
  }
}

async function report(args: string[], o: any, io: Io, client: ErrataClient): Promise<number> {
  const [id, verdict] = args;
  if (!id || !verdict) { io.err("usage: errata report <id> <confirm|dispute> [--note TEXT] [--yes]"); return EXIT.USAGE; }
  if (!o.yes && (!io.isTTY || !io.ask)) { io.err("report asks before sending; pass --yes when there is no terminal"); return EXIT.USAGE; }
  return sendOne(id, verdict, o.note ?? "", !!o.yes, io, client);
}

export function processIo(): Io {
  const rl = process.stdin.isTTY ? createInterface({ input: process.stdin, output: process.stderr }) : null;
  return {
    out: (s) => process.stdout.write(s + "\n"),
    err: (s) => process.stderr.write(s + "\n"),
    isTTY: !!process.stdin.isTTY,
    ask: rl ? (q) => rl.question(q) : undefined,
    env: process.env,
  };
}
