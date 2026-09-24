/**
 * The files a run may upload. The operator names them (--file) or points at a folder (--files) whose files the
 * step itself names. Code does the matching; no model ever produces a path, and models only ever see names.
 */

import { readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, extname, join, relative, resolve, sep } from 'node:path';
import type { Attachment } from './types.js';

/** Salesforce's own limit for one file through the browser is larger; a runbook attachment never is. */
const MAX_BYTES = 25 * 1024 * 1024;
/** A name without its extension must be at least this long to count as named: "Template" alone names nothing. */
const MIN_STEM = 12;
const SKIP = new Set(['.git', 'node_modules']);

export interface Candidate {
  /** Path relative to the folder, with forward slashes. */
  rel: string;
  path: string;
}

const norm = (s: string) => s.toLowerCase().replace(/\\/g, '/').replace(/\s+/g, ' ');

/**
 * Which candidates does the step name? By relative path (with or without its extension), by file name, or by a
 * long enough name without its extension (runbooks write "Upload the file: Welcome Letter V3"). A folder the
 * step names ("upload the file from 'runbook/release-2.11'") offers its own attachments when the step names none
 * of them. A step that asks for an upload and names nothing gets the folder's only attachment, when there is exactly
 * one, or, in the runbook's own folder, its few attachments. Anything ambiguous is left out: two files with one name
 * cannot be told apart by a model that sees only names.
 */
export function matchFiles(step: string, candidates: Candidate[], strict = false): Candidate[] {
  const text = norm(step);
  const attachment = (c: Candidate) => !/\.(md|txt)$/i.test(c.rel);
  const stemOf = (rel: string) => rel.slice(0, rel.length - extname(rel).length);
  const pathNamed = (c: Candidate) => text.includes(norm(c.rel)) || (norm(stemOf(c.rel)).includes('/') && text.includes(norm(stemOf(c.rel))));
  // Strict (a folder searched after the runbook's own): only a path counts. Seen live: a bare "Draft Account Summary"
  // matched a namesake from an older release's folder, the wrong version to upload.
  const named = candidates.filter((c) => {
    const name = norm(basename(c.rel));
    const stem = stemOf(name);
    return pathNamed(c) || (!strict && (text.includes(name) || (stem.length >= MIN_STEM && text.includes(stem))));
  });
  const counts = new Map<string, number>();
  for (const c of named) counts.set(basename(c.rel), (counts.get(basename(c.rel)) ?? 0) + 1);
  const unique = named.filter((c) => counts.get(basename(c.rel)) === 1 || pathNamed(c));
  if (unique.length) return unique;
  const dirs = [...new Set(candidates.map((c) => c.rel.slice(0, Math.max(0, c.rel.lastIndexOf('/')))))]
    .filter((d) => d.length >= 8 && text.includes(norm(d)));
  const inNamedDir = candidates.filter((c) => attachment(c) && dirs.includes(c.rel.slice(0, Math.max(0, c.rel.lastIndexOf('/')))));
  if (!named.length && inNamedDir.length && inNamedDir.length <= 10) return inNamedDir;
  // The runbook's own folder, when the step uploads but names no file ("update the documents attached for the
  // templates below", with the files beside it): its few attachments are offered, and a model picks per control.
  const attachments = candidates.filter(attachment);
  const uploads = /\b(upload|attach|new version|update the (attached )?documents?|replace the (file|document))/i.test(step);
  return !strict && !named.length && uploads && attachments.length >= 1 && attachments.length <= 6 ? attachments : [];
}

/** Regular files under a folder, never following a link out of it. */
export function listFiles(folder: string, limit = 5000): Candidate[] {
  const root = realpathSync(folder);
  const found: Candidate[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 6 || found.length >= limit) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path, depth + 1);
      else if (entry.isFile() && statSync(path).size <= MAX_BYTES) found.push({ rel: relative(root, path).split(sep).join('/'), path });
      if (found.length >= limit) return;
    }
  };
  walk(root, 0);
  return found;
}

/**
 * --file paths as given, plus the files the step names under the first --files folder that yields any: pass the
 * runbook's own folder first and the repository's after it, and a nearby file wins over a namesake elsewhere.
 * Two attachments never share a name.
 */
export function attachments(step: string, file: string[] = [], folders: string | string[] = []): Attachment[] {
  const out: Attachment[] = [];
  for (const given of file) {
    const path = realpathSync(resolve(given));
    const stat = statSync(path);
    if (!stat.isFile()) throw new Error(`--file ${given} is not a file`);
    if (stat.size > MAX_BYTES) throw new Error(`--file ${given} is larger than 25 MB`);
    out.push({ name: basename(path), path });
  }
  for (const [index, folder] of (typeof folders === 'string' ? [folders] : folders).entries()) {
    const found = matchFiles(step, listFiles(folder), index > 0);
    for (const c of found) out.push({ name: basename(c.rel), path: c.path });
    if (found.length) break;
  }
  const names = new Set<string>();
  return out.filter((a) => !names.has(a.name) && names.add(a.name));
}
