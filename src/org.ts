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
