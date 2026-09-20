/**
 * Loading a source package from disk.
 *
 * A package is a directory: `package.yaml` (the manifest) plus one file per
 * dataset under `datasets/` (source entities) and `model/` (template
 * dimensions and facts). Small connectors may inline `datasets` in the
 * manifest instead. Files merge into ONE document, which is validated whole —
 * a cross-reference between two files is still a cross-reference.
 *
 * Loading is synchronous and happens at connector-module load: the package
 * is compile-time data with a runtime home, and a connector whose package
 * does not validate must fail at import (CI's conformance suite, then the
 * backend's boot), never at the first sync.
 *
 * The YAML lives next to the connector's code (`src/<connector>/package/`)
 * and is COPIED into `dist/` by the build (`scripts/copy-package-data.mjs`),
 * so `path.join(__dirname, 'package')` resolves in both trees.
 */
import * as fs from 'fs';
import * as path from 'path';
import { parse as parseYaml } from 'yaml';
import type { PackageDataset, SourcePackage } from './types';
import { validateSourcePackage } from './validate';

const cache = new Map<string, SourcePackage>();

function readYaml(file: string): unknown {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new Error(`source package: cannot read ${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    return parseYaml(text);
  } catch (e) {
    throw new Error(`source package: ${file} is not valid YAML: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function yamlFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
    .sort()
    .map((f) => path.join(dir, f));
}

/**
 * Read + merge + validate. Throws with every violation listed when the
 * package is invalid. Memoised per directory.
 */
export function loadSourcePackage(dir: string): SourcePackage {
  const key = path.resolve(dir);
  const hit = cache.get(key);
  if (hit) return hit;

  const manifestPath = path.join(key, 'package.yaml');
  const manifest = readYaml(manifestPath);
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error(`source package: ${manifestPath} must be a YAML mapping`);
  }
  const doc = { ...(manifest as Record<string, unknown>) };
  const inline = Array.isArray(doc.datasets) ? (doc.datasets as PackageDataset[]) : [];
  const datasets: PackageDataset[] = [...inline];
  for (const sub of ['datasets', 'model']) {
    for (const file of yamlFiles(path.join(key, sub))) {
      const d = readYaml(file);
      if (!d || typeof d !== 'object' || Array.isArray(d)) {
        throw new Error(`source package: ${file} must hold one dataset mapping`);
      }
      datasets.push(d as PackageDataset);
    }
  }
  doc.datasets = datasets;

  const errs = validateSourcePackage(doc);
  if (errs.length > 0) {
    throw new Error(`source package at ${key} is invalid:\n  - ${errs.join('\n  - ')}`);
  }
  const pkg = doc as unknown as SourcePackage;
  pkg.datasets = canonicalOrder(pkg);
  cache.set(key, pkg);
  return pkg;
}

/**
 * The order the platform sees datasets in, whatever order the files were read:
 * source datasets by the manifest's category order then by name (the wizard
 * groups by category and keeps first-appearance order), then dimensions,
 * then facts, each by name. Deterministic, and independent of file names.
 */
function canonicalOrder(pkg: SourcePackage): PackageDataset[] {
  const cats = pkg.clarion.categories ?? [];
  const catIndex = (d: PackageDataset) => {
    const i = d.clarion.category ? cats.indexOf(d.clarion.category) : -1;
    return i === -1 ? cats.length : i;
  };
  const kindRank: Record<string, number> = { source: 0, dimension: 1, fact: 2 };
  return [...pkg.datasets].sort((a, b) =>
    (kindRank[a.clarion.kind] ?? 9) - (kindRank[b.clarion.kind] ?? 9)
    || catIndex(a) - catIndex(b)
    || a.name.localeCompare(b.name, 'en'));
}

/** Tests only: forget loaded packages so a rewritten file is re-read. */
export function _clearSourcePackageCacheForTests(): void {
  cache.clear();
}
