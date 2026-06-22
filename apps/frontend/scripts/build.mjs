import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const apiBaseUrl =
  process.env.CLOUDSANDBOX_API_BASE_URL ||
  process.env.VITE_API_BASE_URL ||
  "http://ccee-api-alb-371008494.us-east-1.elb.amazonaws.com";

const source = await readFile(join(root, "src", "index.html"), "utf8");
const output = source.replaceAll("%%CLOUDSANDBOX_API_BASE_URL%%", apiBaseUrl);

await mkdir(join(root, "dist"), { recursive: true });
await writeFile(join(root, "dist", "index.html"), output);

await mkdir(join(root, "dist", "admin", "observability"), { recursive: true });
await writeFile(join(root, "dist", "admin", "observability", "index.html"), output);
