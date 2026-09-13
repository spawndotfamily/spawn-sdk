import { init, parse } from "es-module-lexer/minimal";
import { PublishCliError } from "./api.ts";

/** Packaging check only. Never evaluates imports or executes the creator's code. */
export const MODULE_INSPECTION_BYTES = 16 * 1024 * 1024;
export type ModuleReference = { importer: string; target: string };
export async function moduleReferences(
  source: string,
  importer: string,
): Promise<ModuleReference[]> {
  await init();
  let imports;
  try {
    [imports] = parse(source);
  } catch {
    throw new PublishCliError(
      `Cannot inspect JavaScript module ${importer}. Build browser-ready JavaScript and check its syntax.`,
    );
  }
  const base = new URL(importer, "https://build.invalid/root/");
  const references: ModuleReference[] = [];
  for (const item of imports) {
    const name = item.n;
    // Import maps, external origins and computed imports require browser testing.
    if (!name || !(name.startsWith("./") || name.startsWith("../"))) continue;
    let target: URL;
    try {
      target = new URL(name, base);
    } catch {
      throw new PublishCliError(`Invalid relative module URL in ${importer}.`);
    }
    if (!target.pathname.startsWith("/root/")) {
      throw new PublishCliError(
        `Module ${importer} imports outside the uploaded build folder. Include its dependencies inside the build.`,
      );
    }
    let path: string;
    try {
      path = decodeURIComponent(target.pathname.slice(6));
    } catch {
      throw new PublishCliError(`Invalid encoded module path in ${importer}.`);
    }
    references.push({ importer, target: path });
  }
  return references;
}
export function assertModuleFiles(
  references: ModuleReference[],
  files: readonly { path: string }[],
): void {
  const paths = new Set(files.map((file) => file.path));
  for (const { importer, target } of references) {
    if (!paths.has(target)) {
      throw new PublishCliError(
        `Module ${importer} requires missing file ${target}. Bundle the SDK with your game, or copy all required browser modules with their relative paths. Rebuild, run spawn-publish check and play-test with spawn-dev before uploading.`,
      );
    }
  }
}
