# @formachines/errata

> **Not maintained.** Errata was stopped on 10 November 2026. The database at formachines.ai/errata is frozen as of that date: new releases and existing entries are no longer checked. This repository is archived and kept for reference; do not rely on it for current code.

Check a project's dependencies against [Errata](https://formachines.ai/errata/): places where AI models write
outdated code for PyPI and npm libraries, each with a fix verified in a sandbox.

```
npx @formachines/errata check
```

Node 20 or newer. No API key and no account.

| | |
|---|---|
| Executes fix examples | never |
| Reads | lockfiles and manifests |
| Sends | package names to fetch entries (versions are matched locally); no search-miss reports (the MCP server's `search_error` sends them, off: `ERRATA_NO_TELEMETRY=1`) |

The CLI downloads the public index and the JSON of the packages that have corrections (the package name is in the
URL) and matches versions on your machine; it has no error search, so it sends no search-miss reports.

## What it reads

`errata check [path]` reads these files in `path` (default: the current directory), or the single file you name:

| file | gives |
|---|---|
| `package-lock.json` (v1, v2, v3) | exact npm versions, every copy of a package (two versions of one package are checked separately) |
| `uv.lock`, `poetry.lock` | exact PyPI versions |
| `package.json` | npm ranges, for packages the lockfile does not pin |
| `requirements.txt` (with `-r` includes) | `==` pins as exact versions, anything else as a range |

A lockfile wins over a manifest for the same package. A range is never turned into a guessed installed version.

## Output

On the control project in `test/fixtures/control` (the six cases below), against the live base on 2026-11-09. The first five lines are the summary (since 0.1.3): dependencies read and how many have an exact version; how many Errata covers; the entries that match your versions, by readiness (`patch`: the short patch applies word for word; `partial`: it covers part of the change; `lead`: it does not apply word for word, the entry has a full example that works); how many need a person — to confirm your code uses the changed name (`detect`) before applying, or to decide on a lead; and the dependencies Errata does not cover. The last line says what a miss means.

```
errata 0.1.3: read package-lock.json, package.json, uv.lock, requirements.txt

Dependencies found: 9, 8 with an exact version
In Errata: 5 of them
Match your versions: 5 entries — 2 patch, 1 partial, 2 lead
Need a person: 1 to apply once your code is seen to use the changed name (detect), 4 for a manual decision (lead)
Not covered: 4 dependencies
No match does not mean your project is free of such errors.

verdict  readiness  package         installed          checked on    entry                       grade     link
-------  ---------  --------------  -----------------  ------------  --------------------------  --------  ------------------------------------------------------------
apply    patch      pypi/click      8.5.0              8.5.0, 8.5.1  click.Parameter (0001)      verified  https://formachines.ai/errata/pypi/click/0001-click-parameter/
lead     patch      pypi/scipy      >=1.17,<2 (range)  1.18.1        scipy.optimize.nnls (0001)  possible  https://formachines.ai/errata/pypi/scipy/0001-scipy-optimize-nnls/
lead     lead       pypi/scipy      >=1.17,<2 (range)  1.18.1        scipy.linalg.sqrtm (0003)   possible  https://formachines.ai/errata/pypi/scipy/0003-scipy-linalg-sqrtm/
lead     partial    npm/typeorm     1.1.2              1.1.2         Connection (0001)           verified  https://formachines.ai/errata/npm/typeorm/0001-connection/
lead     lead       npm/typescript  7.0.2              7.0.2         ts.ScriptTarget (0001)      verified  https://formachines.ai/errata/npm/typescript/0001-baseurl/

apply = checked on your installed version and proof.auto_apply is true; lead = may apply, review first or show to a person. readiness: patch = the short patch applies word for word; partial = it covers part of the change; lead = it does not apply word for word, the entry has a full example. Reasons are in --json.

1 entry does not apply: the installed version predates the change (--all shows them).

Not offered, merged or withdrawn (ids in --json): npm/typescript 4 merged, 8 withdrawn; pypi/openai 1 withdrawn; pypi/scipy 1 withdrawn

6 requests, 65.8 kB, 0.31 s
```

`--json` prints the same as one JSON object: `summary` (the five counts and `note`) and `summary_lines`; every entry with `verdict`, `readiness`, `grade`, `reason`, `wrong`, `right`,
`detect`, `error`, `fails_on`, `verified_on`, `url`; `not_offered` with ids and where merged entries went; `overhead`.

### Verdicts and grades

| grade | means | verdict |
|---|---|---|
| `verified` | the entry was checked on exactly your installed version (`fails_on`, or a later recheck) | `apply` if `proof.auto_apply` is true, else `lead` |
| `possible` | your version is newer than the checked ones, lies between `works_on` and `fails_on`, or your range (no lockfile) includes a checked version | `lead` |
| `unknown` | no version known, or a range that does not include a checked version | `lead` |
| `not_affected` | your version is not newer than `works_on`, where the old code works | `none` (shown with `--all`) |

The rule, the same on the site (every page footer, `llms.txt`, the JSON `agent_rule`), in the skill and in the MCP
server: *apply a correction on your own only when the installed version is one it was checked on
(`versions.checked_on`: `fails_on` and every recheck) and its `proof.auto_apply` is true; otherwise show it to the user
as a lead.* One checked version is not a range, so a newer installed version is `lead`, not `apply`.

## Reporting back

```
npx @formachines/errata check --report
npx @formachines/errata report pypi/click/8.5.0/0001 confirm --note "worked on 8.5.0"
```

`--report` asks, for each `apply`/`lead` entry, whether the fix worked (confirm / dispute / skip), shows what will be
sent and sends it only after `y`. `report` does the same for one entry; without a terminal it needs `--yes`.
Merged entries are refused with the id that carries them now; withdrawn and unknown ids are not sent. Reports go to
`POST https://formachines.ai/v1/feedback`, are quarantined and rechecked in the sandbox; nothing is published as is.

## Exit codes and environment

`0` done · `1` `--fail-on apply|lead` matched · `2` the base could not be read (network, timeout, HTTP error) — this
is never reported as "no corrections" · `64` usage.

| variable | default |
|---|---|
| `ERRATA_BASE_URL` | `https://formachines.ai` |
| `ERRATA_FEEDBACK_URL` | `<base>/v1/feedback` |
| `ERRATA_TIMEOUT_MS` | `8000` per request |
| `ERRATA_CACHE_TTL_S` | `600` (in-process cache) |
| `ERRATA_LOG_LEVEL` | `error` (`debug`, `info`, `warn`; logs go to stderr) |
| `ERRATA_NO_TELEMETRY` | unset; `1` (or `DO_NOT_TRACK=1`) turns off search-miss reports |

Requests carry the User-Agent `formachines-errata-cli/<version>`, so the site counts CLI traffic apart from other
clients. No other data is sent: the CLI has no error search, so it never sends search-miss reports (the MCP server's
`search_error` does, see its README); `ERRATA_NO_TELEMETRY=1` would stop them if it ever gets one.

## Overhead

Measured 2026-11-02 on the control project (9 dependencies, 5 with corrections) against formachines.ai, five cold
runs on one Mac: **6 requests** (index, changelog, 4 package JSONs), **64.6 kB** of JSON (the changelog is 31 kB of
it; the summary line counts uncompressed bytes). Since 2026-11-02 the site sends JSON gzipped: on the same project
70.5 kB of JSON came over the wire as **14.4 kB**; **0.30–0.34 s** in requests, **0.37–0.43 s** wall time for the whole
`npx`-less run. The table is 1.7 kB of output, `--json` 9.8 kB. Requests grow with the number of dependencies that
have corrections (one package JSON each), not with the size of the lockfile.

## What the CLI does not promise

- **Not a full scan.** The base covers a few dozen packages; "no correction" means the base has none for this version,
  not that your code is current.
- **Not a dependency resolver.** Without a lockfile it does not know what is installed and says so; it does not run
  `npm` or `pip`, read `node_modules` or virtual environments, or follow `pyproject.toml`, `yarn.lock`, `pnpm-lock.yaml`.
- **Not a code scanner.** It does not read your source. Whether your code uses the outdated call is for you or your
  agent: each entry has `detect` names and the `error_signature` to look for.
- **Not an applier.** It never edits files. `apply` says the base allows applying the fix as is; doing it is yours.
- **No range proof.** Until the base proves version ranges, a version newer than the checked ones is `lead`.
- **No offline mode.** When the base is unreachable the run fails with exit 2.

## Development

```
npm install
npm test
npm run typecheck
npm pack
```

`src/core` is shared with [errata-mcp](https://github.com/formachines-ai/errata-mcp) and kept identical in both. Tests run against a snapshot of formachines.ai/errata in `test/fixtures/site` (2026-11-02); the control project with the six acceptance cases is `test/fixtures/control`.

MIT licence. The data is CC BY 4.0 (formachines.ai/errata).
