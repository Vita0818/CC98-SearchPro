#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "./app.ts";
import { safeError } from "./errors.ts";

try { await buildServer().server.connect(new StdioServerTransport()); }
catch (error) { process.stderr.write(JSON.stringify(safeError(error)) + "\n"); process.exitCode = 1; }
