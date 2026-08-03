// Let `import KNOWLEDGE from "./THING.md"` work under `node --test`.
//
// In a Worker this is wrangler's Text module rule, declared in each consumer's
// wrangler.toml. Node has no equivalent, which is why nothing in this repo could
// test src/personas/luna.js or src/knowledge/ at all: importing either one blew
// up on the first markdown file. Luna shipped a leak to the live website that a
// three line test would have caught, so the runner learns to read markdown.

/**
 * Treat .md as a text module.
 * @param {string} url
 * @param {object} context
 * @param {Function} nextLoad
 */
export async function load(url, context, nextLoad) {
  if (!url.endsWith(".md")) return nextLoad(url, context);
  const raw = await nextLoad(url, { ...context, format: "module", importAttributes: {} })
    .catch(() => null);
  // nextLoad cannot parse markdown as a module, so read it ourselves.
  const { readFile } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const text = raw && typeof raw.source === "string"
    ? raw.source
    : await readFile(fileURLToPath(url), "utf8");
  return {
    format: "module",
    shortCircuit: true,
    source: `export default ${JSON.stringify(String(text))};`,
  };
}
