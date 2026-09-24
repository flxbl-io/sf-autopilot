/** "Give it an org": the Salesforce CLI turns an alias into a signed-in URL. No password is ever handled here. */

import { execFile } from 'node:child_process';

/**
 * The returned URL carries a live session. It must never be printed, logged, or written to a trace.
 * SF_FRONTDOOR_URL overrides the CLI, for environments where `sf` is not installed.
 */
export function frontdoorUrl(org: string | undefined, startPath: string): Promise<string> {
  if (process.env.SF_FRONTDOOR_URL) return Promise.resolve(process.env.SF_FRONTDOOR_URL);
  if (!org) return Promise.reject(new Error('Supply --org <alias or username>, or set SF_FRONTDOOR_URL'));
  return new Promise((resolve, reject) => {
    const args = ['org', 'open', '--target-org', org, '--url-only', '--json', '--path', startPath];
    execFile('sf', args, { maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      // stdout may contain the URL, so it is parsed and never echoed, even on failure.
      let parsed: any = null;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        parsed = null;
      }
      const url = parsed?.result?.url;
      if (typeof url === 'string' && url.startsWith('https://')) return resolve(url);
      let reason = 'sf org open did not return a URL';
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
        reason = 'the Salesforce CLI (sf) is not installed or not on PATH';
      } else if (typeof parsed?.message === 'string') {
        // sf messages span lines and end with a usage hint; keep the sentence, add its suggestion.
        const hint = Array.isArray(parsed.actions) && typeof parsed.actions[0] === 'string' ? ` ${parsed.actions[0]}` : '';
        reason = parsed.message.replace(/See more help with --help/g, '').replace(/\s+/g, ' ').trim() + hint;
      }
      reject(new Error(`Could not sign in to ${org}: ${reason}`));
    });
  });
}

/** What the org has: its apps, its tabs (App Launcher items) and its installed packages. Labels only. */
export interface OrgContext {
  apps: string[];
  tabs: string[];
  packages: string[];
}

type Exec = (file: string, args: string[], done: (error: Error | null, stdout: string) => void) => void;
const sf: Exec = (file, args, done) => void execFile(file, args, { maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => done(error, stdout));

function query(org: string, soql: string, tooling: boolean, exec: Exec): Promise<any[]> {
  const args = ['data', 'query', '--target-org', org, '--json', '--query', soql, ...(tooling ? ['--use-tooling-api'] : [])];
  return new Promise((resolve) => exec('sf', args, (_error, stdout) => {
    try {
      const parsed = JSON.parse(stdout);
      resolve(parsed.status === 0 ? parsed.result.records : []);
    } catch {
      resolve([]);
    }
  }));
}

/**
 * Seen live: "remove the duplicate criteria from the Non-standard commission rate rule" was refused as vague,
 * because nothing told the planner that this org has a Rules tab from a lending package. A person who knows the
 * org would not have asked. Read, never required: a query that fails leaves that list empty.
 */
export async function orgContext(org: string, exec: Exec = sf): Promise<OrgContext> {
  const [apps, tabs, packages] = await Promise.all([
    query(org, "SELECT Label FROM AppMenuItem WHERE Type = 'TabSet'", false, exec),
    query(org, 'SELECT Label FROM TabDefinition WHERE IsCustom = true', false, exec),
    query(org, 'SELECT SubscriberPackage.Name FROM InstalledSubscriberPackage', true, exec),
  ]);
  const labels = (rows: any[], pick: (r: any) => unknown) =>
    [...new Set(rows.map(pick).filter((v): v is string => typeof v === 'string' && v.trim() !== ''))].sort().slice(0, 600);
  return { apps: labels(apps, (r) => r.Label), tabs: labels(tabs, (r) => r.Label), packages: labels(packages, (r) => r.SubscriberPackage?.Name) };
}
