/**
 * Salesforce's Setup Audit Trail: its own record of who changed what in Setup, queryable with plain SOQL.
 *
 * This is the independent check for steps that have no Metadata API. It involves no model and no page: after a
 * run, ask Salesforce what it recorded. Seen live, it logged the deliverability level, the fiscal year month
 * ("from 7 to 4"), the default workflow user, the time zone, a new certificate, the identity provider's
 * certificate, an org-wide address, and "Initiated sharing rule recalculation: Lead".
 *
 * Not everything is audited. Releasing a component from an unlocked package, scheduling the data export and
 * compiling all classes left no entry, so absence of an entry proves nothing unless the recipe expects one.
 */

import { execFile } from 'node:child_process';
import { postJson } from './http.js';
import type { Post } from './types.js';

export interface AuditEntry {
  at: string;
  action: string;
  section: string | null;
  display: string;
  by: string | null;
}

export type Exec = (file: string, args: string[], done: (error: Error | null, stdout: string) => void) => void;

const sf: Exec = (file, args, done) => void execFile(file, args, { maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => done(error, stdout));

/** At most this many entries are read. When a window holds more, the NEWEST are the ones kept. */
export const TRAIL_LIMIT = 200;

/**
 * Entries created at or after `since`, oldest first. A minute of slack is taken off, for clocks that disagree.
 *
 * The query asks for the newest first and the result is turned round. Asked oldest first, a busy sandbox over
 * 180 days returned 28 July to 4 August and stopped (seen live: 2,017 entries), so a change made that morning
 * was NOT CONFIRMED, and a later change that undid an earlier one would have been cut off just the same.
 */
export function setupAuditTrail(org: string, since: Date, exec: Exec = sf): Promise<AuditEntry[]> {
  const from = new Date(since.getTime() - 60_000).toISOString().replace(/\.\d+Z$/, 'Z');
  const soql = `SELECT CreatedDate, Action, Section, Display, CreatedBy.Username FROM SetupAuditTrail WHERE CreatedDate >= ${from} ORDER BY CreatedDate DESC, Id DESC LIMIT ${TRAIL_LIMIT}`;
  return new Promise((resolve, reject) => {
    exec('sf', ['data', 'query', '--target-org', org, '--json', '--query', soql], (_error, stdout) => {
      try {
        const parsed = JSON.parse(stdout);
        if (parsed.status !== 0) throw new Error(String(parsed.message ?? 'query failed').replace(/\s+/g, ' ').slice(0, 200));
        resolve(parsed.result.records.map((r: any) => ({
          at: r.CreatedDate, action: r.Action, section: r.Section ?? null, display: r.Display ?? '', by: r.CreatedBy?.Username ?? null,
        })).reverse());
      } catch (error) {
        reject(new Error(`Could not read the Setup Audit Trail of ${org}: ${(error as Error).message}`));
      }
    });
  });
}

/** Did Salesforce record the action this procedure is known to leave? */
export function audited(entries: AuditEntry[], expected: string): AuditEntry | undefined {
  return entries.find((e) => e.action.toLowerCase() === expected.toLowerCase());
}

export interface AuditVerdict {
  /** Jev's probability that the audit trail shows the requested change was made. */
  probability: number;
  confirmed: boolean;
  /** The entries Jev was shown. Empty means there was nothing to judge, and the question was not asked. */
  entries: AuditEntry[];
}

/** At or above this, the trail is taken as confirming the step. A threshold to tune on real steps, not a law. */
export const AUDIT_THRESHOLD = 0.8;

/**
 * Jev reads Salesforce's record and says whether it shows the step was done. A recipe can name the audit action
 * it expects; a freshly planned step cannot, and wording varies ("from 7 to 4", "from off to on"). This is one
 * yes/no judgment over a few log lines, returned as a probability: the kind of thing Jev is for. It looks at
 * Salesforce's log, not at a page, so it is independent of the browser run it is checking.
 */
export async function confirmFromAudit(
  step: string,
  entries: AuditEntry[],
  options: { post?: Post; apiKey?: string } = {},
): Promise<AuditVerdict> {
  if (!entries.length) return { probability: 0, confirmed: false, entries };
  const apiKey = options.apiKey ?? process.env.TYPESAFE_API_KEY;
  if (!apiKey) throw new Error('TYPESAFE_API_KEY is not set');
  const base = (process.env.TYPESAFE_BASE_URL ?? 'https://api.typesafe.ai/v1').replace(/\/$/, '');
  const result = await (options.post ?? postJson)(`${base}/systemone`, apiKey, {
    model: process.env.TYPESAFE_MODEL ?? 'jev-latest',
    state: { manual_step: step, audit_entries: entries.map((e) => ({ action: e.action, section: e.section, recorded: e.display })) },
    questions: {
      confirmed: {
        type: 'noul',
        instructions:
          'Do the `audit_entries`, which are Salesforce\'s own Setup Audit Trail for the period, show that the change ' +
          'asked for in `manual_step` was actually made, to the values it asked for?',
        criteria: {
          true: 'An entry records this very change, and any value it names (a level, a month, a user, a name) is the one the step asked for.',
          false: 'No entry records this change; or one records the same setting changed to a different value than was asked; or the entries are only about unrelated settings.',
        },
      },
    },
  });
  const probability = result?.answers?.confirmed?.noul;
  if (typeof probability !== 'number' || !Number.isFinite(probability) || probability < 0 || probability > 1) {
    throw new Error('Invalid TypeSafe response; the audit trail was not judged.');
  }
  return { probability, confirmed: probability >= AUDIT_THRESHOLD, entries };
}
