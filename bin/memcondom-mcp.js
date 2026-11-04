#!/usr/bin/env node
"use strict";
// Executable shim: the MCP server lives in src/memcondom-mcp.ts and is compiled to dist/.
// The compactor config starts this exact path, so it must stay a JS file.
require("../dist/memcondom-mcp.js");
