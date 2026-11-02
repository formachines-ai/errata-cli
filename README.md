# @formachines/errata

Check a project's dependencies against [Errata](https://formachines.ai/errata/): places where AI models write
outdated code for PyPI and npm libraries, each with a fix verified in a sandbox.

```
npx @formachines/errata check
```

Node 20 or newer. No API key and no account. Nothing about your project leaves your machine: the CLI downloads the
public index and the JSON of the packages that have corrections, and matches versions locally.

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

On the control project in `test/fixtures/control` (the six cases below), against the live base on 2026-11-02:

```
errata 0.1.1: 9 dependencies from package-lock.json, package.json, uv.lock, requirements.txt; 5 have corrections in the base

verdict  package         installed          checked on  entry                       grade     link
-------  --------------  -----------------  ----------  --------------------------  --------  ------------------------------------------------------------
apply    pypi/click      8.5.0              8.5.0       click.Parameter (0001)      verified  https://formachines.ai/errata/pypi/click/0001-click-parameter/
lead     pypi/scipy      >=1.17,<2 (range)  1.18.1      scipy.optimize.nnls (0001)  possible  https://formachines.ai/errata/pypi/scipy/0001-scipy-optimize-nnls/
lead     pypi/scipy      >=1.17,<2 (range)  1.18.1      scipy.linalg.sqrtm (0003)   possible  https://formachines.ai/errata/pypi/scipy/0003-scipy-linalg-sqrtm/
lead     npm/typeorm     1.1.2              1.1.2       Connection (0001)           verified  https://formachines.ai/errata/npm/typeorm/0001-connection/
lead     npm/typescript  7.0.2              7.0.2       ts.ScriptTarget (0001)      verified  https://formachines.ai/errata/npm/typescript/0001-baseurl/
lead     npm/typescript  7.0.2              7.0.2       ts.ModuleKind (0004)        verified  https://formachines.ai/errata/npm/typescript/0004-moduleresolution-node/

apply = checked on your installed version and proof.auto_apply is true; lead = may apply, review first or show to a person; the reason for each is in --json.

2 entries do not apply: the installed version predates the change (--all shows them).

Not offered, merged or withdrawn (ids in --json): npm/typescript 6 merged, 5 withdrawn; pypi/openai 1 withdrawn; pypi/scipy 1 withdrawn

6 requests, 64.6 kB, 0.31 s
```

`--json` prints the same as one JSON object: every entry with `verdict`, `grade`, `reason`, `wrong`, `right`,
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

Requests carry the User-Agent `formachines-errata-cli/<version>`, so the site counts CLI traffic apart from other
clients. No other data is sent.

## Overhead

Measured 2026-11-02 on the control project (9 dependencies, 5 with corrections) against formachines.ai, five cold
runs on one Mac: **6 requests** (index, changelog, 4 package JSONs), **64.6 kB** downloaded (the server sends JSON
uncompressed; the changelog is 31 kB of it), **0.30–0.34 s** in requests, **0.37–0.43 s** wall time for the whole
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
