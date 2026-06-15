import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const source = join(
  process.cwd(),
  "node_modules",
  "node-notifier",
  "vendor",
  "snoreToast",
  "snoretoast-x64.exe"
);
const target = join(process.cwd(), "dist", "helpers", "SnoreToast", "snoretoast.exe");

mkdirSync(dirname(target), { recursive: true });
copyFileSync(source, target);
