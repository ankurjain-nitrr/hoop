#!/usr/bin/env node
// The `hoop` command. It checks Node.js before it loads the rest of hoop, so on an older Node.js it
// says what to install and stops, instead of failing on something that Node.js lacks. It loads
// nothing else first, and keeps to syntax every Node.js with ES modules parses (see node-floor.ts).
import { nodeTooOld } from "./node-floor.js";

const problem = nodeTooOld(process.versions.node);
if (problem) {
  process.stderr.write(problem + "\n");
  process.exitCode = 1;
} else {
  import("./cli.js");
}
