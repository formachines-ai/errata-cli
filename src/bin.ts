#!/usr/bin/env node
import { run, processIo } from "./main.js";

run(process.argv.slice(2), processIo()).then((code) => process.exit(code), (e) => {
  process.stderr.write(`errata: ${(e as Error)?.stack || String(e)}\n`);
  process.exit(2);
});
