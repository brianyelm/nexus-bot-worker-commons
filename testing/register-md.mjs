// Installs the markdown loader for the test run. Wired in via `node --import`
// in the test script, so every test file can import the knowledge modules the
// same way the Workers do.
import { register } from "node:module";

register("./md-hooks.mjs", import.meta.url);
