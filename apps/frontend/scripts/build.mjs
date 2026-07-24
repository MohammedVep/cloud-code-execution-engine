import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const apiBaseUrl = process.env.CLOUDSANDBOX_API_BASE_URL || process.env.VITE_API_BASE_URL || "";
const wakeUrl = process.env.CLOUDSANDBOX_WAKE_URL || process.env.VITE_WAKE_URL || "";

const encodeInlineScriptString = (value) =>
  JSON.stringify(value)
    .slice(1, -1)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026");

const source = await readFile(join(root, "src", "index.html"), "utf8");
const output = source
  .replaceAll("%%CLOUDSANDBOX_API_BASE_URL%%", encodeInlineScriptString(apiBaseUrl))
  .replaceAll("%%CLOUDSANDBOX_WAKE_URL%%", encodeInlineScriptString(wakeUrl));

await mkdir(join(root, "dist"), { recursive: true });
await writeFile(join(root, "dist", "index.html"), output);

await mkdir(join(root, "dist", "admin", "observability"), { recursive: true });
await writeFile(join(root, "dist", "admin", "observability", "index.html"), output);
