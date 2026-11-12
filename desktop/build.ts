// `bun desktop/build.ts` → desktop/dist/, the page the Mac app serves from its
// bundle (and the dev server serves to a browser).
import { copyFile, mkdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
export const desktopDir = join(root, "desktop");
export const distDir = join(desktopDir, "dist");
const SHARED_WEB = ["style.css", "links.js", "markdown.js", "transcript.js", "usage.js", "favicon.svg"];

async function mustExist(path: string): Promise<void> {
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) throw new Error(`desktop build: missing ${path}`);
}

export async function build(outdir = distDir): Promise<void> {
  const sources = [
    join(desktopDir, "index.html"),
    join(desktopDir, "desktop.css"),
    join(desktopDir, "src", "main.ts"),
    ...SHARED_WEB.map((file) => join(root, "web", file)),
  ];
  for (const source of sources) await mustExist(source);
  await rm(outdir, { recursive: true, force: true });
  await mkdir(join(outdir, "web"), { recursive: true });
  const result = await Bun.build({
    entrypoints: [join(desktopDir, "src", "main.ts")],
    format: "iife",
    target: "browser",
    sourcemap: "none",
    minify: false,
  });
  if (!result.success || result.outputs.length !== 1) {
    throw new Error(`desktop build: bundling failed\n${result.logs.map(String).join("\n")}`);
  }
  await Bun.write(join(outdir, "app.js"), result.outputs[0]!);
  await copyFile(join(desktopDir, "index.html"), join(outdir, "index.html"));
  await copyFile(join(desktopDir, "desktop.css"), join(outdir, "desktop.css"));
  for (const file of SHARED_WEB) await copyFile(join(root, "web", file), join(outdir, "web", file));
}

if (import.meta.main) {
  try {
    await build();
    console.log(`desktop build: wrote ${distDir}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
