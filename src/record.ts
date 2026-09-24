/**
 * The record a page shows, read back from the org. Seen live: an agent set a loan product's Max Term to 1000 and
 * saved it, and the run went on because the reviewer, reading a managed-package page, never saw the save. The org
 * had it all along. So when the page is about one record, the reviewer is also given that record as it is saved.
 *
 * Read only: one SOQL query through the Salesforce CLI, the same way the audit trail is read.
 */

import { execFile } from 'node:child_process';
import type { Page } from './types.js';

export type Exec = (file: string, args: string[], done: (error: Error | null, stdout: string) => void) => void;
const sf: Exec = (file, args, done) => void execFile(file, args, { maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => done(error, stdout));

export interface SavedRecord {
  object: string;
  id: string;
  /** Non-empty fields as saved, system fields left out. */
  fields: Record<string, unknown>;
}

/** A Salesforce id: 15 or 18 characters, whose first three name the object. Only a known prefix is kept later. */
const ID = /(?:^|[/=%.?&])([a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?)(?=$|[/?&#%.])/g;

/** Candidate record ids in the page's and its frames' URLs, top URL first. */
export function recordIds(page: Page): string[] {
  const urls = [page.url, ...page.stats.map((s) => s.url)];
  const ids: string[] = [];
  for (const url of urls) {
    let path = url;
    try {
      const u = new URL(url);
      path = decodeURIComponent(u.pathname + u.search);
    } catch {
      continue;
    }
    for (const m of path.matchAll(ID)) if (/[0-9]/.test(m[1]) && !ids.includes(m[1])) ids.push(m[1]);
  }
  return ids;
}

const SYSTEM = /^(attributes|Id|IsDeleted|CreatedDate|CreatedById|LastModifiedDate|LastModifiedById|SystemModstamp|LastActivityDate|LastViewedDate|LastReferencedDate|OwnerId)$/;

/** `sf ... --json` wraps its answer in { status, result }; `sf api request rest` prints the API's own body. */
function run(exec: Exec, args: string[], raw = false): Promise<any> {
  return new Promise((resolve) => exec('sf', args, (_error, stdout) => {
    try {
      const parsed = JSON.parse(stdout);
      resolve(raw ? parsed : parsed.status === 0 ? parsed.result : null);
    } catch {
      resolve(null);
    }
  }));
}

/** Reads the first record the page's URLs name, or null. Never throws: no record just means no extra evidence. */
export class RecordReader {
  private prefixes: Promise<Map<string, string>> | null = null;
  constructor(private org: string, private exec: Exec = sf) {}

  private objects(): Promise<Map<string, string>> {
    this.prefixes ??= run(this.exec, ['api', 'request', 'rest', '/services/data/v64.0/sobjects', '-o', this.org], true).then((r) => {
      const map = new Map<string, string>();
      for (const o of r?.sobjects ?? []) if (o.keyPrefix && o.queryable) map.set(o.keyPrefix, o.name);
      return map;
    });
    return this.prefixes;
  }

  async read(page: Page): Promise<SavedRecord | null> {
    const ids = recordIds(page);
    if (!ids.length) return null;
    const objects = await this.objects();
    for (const id of ids) {
      const object = objects.get(id.slice(0, 3));
      if (!object) continue;
      const soql = `SELECT FIELDS(ALL) FROM ${object} WHERE Id = '${id}' LIMIT 1`;
      const result = await run(this.exec, ['data', 'query', '--target-org', this.org, '--json', '--query', soql]);
      const row = result?.records?.[0];
      if (!row) continue;
      const fields: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(row)) {
        if (SYSTEM.test(k) || v === null || v === '' || typeof v === 'object') continue;
        fields[k] = typeof v === 'string' ? v.slice(0, 200) : v;
        if (Object.keys(fields).length >= 120) break;
      }
      return { object, id, fields };
    }
    return null;
  }
}
