#!/usr/bin/env node
"use strict";
// Executable shim: the implementation lives in src/memcondom.ts and is compiled to dist/.
// Kept at this path because ~/.local/bin/memcondom and every agent's config call it directly.
require("../dist/memcondom.js").runCli();
