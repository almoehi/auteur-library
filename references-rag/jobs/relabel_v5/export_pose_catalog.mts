/**
 * Exports the server pose catalog (video-harness `src/design/pose-catalog.ts`, THE definition of every
 * position) to `pose_catalog.json`, so the relabel audit judges the library's `sex_positions` against
 * the server's meaning (one authority; re-export when the catalog changes).
 *
 * Run from the video-harness package (it resolves tsx):
 *   cd <video-harness>/video-harness && npx tsx <this file> <path to pose-catalog.ts> <out.json>
 *
 * Sentences are rendered with the placeholder names "person A" / "person B" (a one-person pose: "person A" twice).
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

type Role = "a" | "b";
interface Names { a: string; b: string }
interface Part { role: Role; part: string; anyOf?: readonly string[] }
interface Support { parts: readonly Part[]; essential: boolean; sentence: (n: Names) => string }
interface Entry {
  name: string;
  content: "sfw" | "nsfw";
  roles: { a: string; b?: string };
  postures: { a: string | null; b?: string | null };
  above?: Role;
  arrangement: (n: Names) => string;
  supports: readonly Support[];
}
interface CatalogModule { POSE_CATALOG: readonly Entry[] }

interface ExportedSupport { essential: boolean; sentence: string; parts: string[] }
interface ExportedEntry {
  name: string;
  content: "sfw" | "nsfw";
  people: 1 | 2;
  roles: { a: string; b: string | null };
  postures: { a: string | null; b: string | null };
  above: Role | null;
  arrangement: string;
  supports: ExportedSupport[];
}

const [catalogPath, outPath] = process.argv.slice(2);
if (!catalogPath || !outPath) {
  console.error("usage: export_pose_catalog.mts <pose-catalog.ts> <out.json>");
  process.exit(2);
}

const mod = (await import(pathToFileURL(resolve(catalogPath)).href)) as CatalogModule;

const partText = (p: Part): string =>
  `${p.role === "a" ? "A" : "B"}:${[p.part, ...(p.anyOf ?? [])].join("|")}`;

const exported: ExportedEntry[] = mod.POSE_CATALOG.map((entry) => {
  const two = entry.roles.b !== undefined;
  const names: Names = { a: "person A", b: two ? "person B" : "person A" };
  return {
    name: entry.name,
    content: entry.content,
    people: two ? 2 : 1,
    roles: { a: entry.roles.a, b: entry.roles.b ?? null },
    postures: { a: entry.postures.a, b: entry.postures.b ?? null },
    above: entry.above ?? null,
    arrangement: entry.arrangement(names),
    supports: entry.supports.map((s) => ({
      essential: s.essential,
      sentence: s.sentence(names),
      parts: s.parts.map(partText),
    })),
  };
});

writeFileSync(outPath, `${JSON.stringify({ source: "video-harness/src/design/pose-catalog.ts", entries: exported }, null, 2)}\n`);
console.log(`${exported.length} entries -> ${outPath}`);
