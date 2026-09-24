/** Which files a step may upload. Pure matching, plus a real folder; no browser, no models, no network. */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { attachments, matchFiles, type Candidate } from '../src/files.js';

const c = (rel: string): Candidate => ({ rel, path: `/root/${rel}` });
const names = (found: Candidate[]) => found.map((f) => f.rel);

test('a file is named by its path, its name, or a long enough name without its extension', () => {
  const folder = [c('TKT-1001/Invoice_Template_v5.1.docx'), c('Welcome Letter V3.docx'), c('Template.docx'), c('notes.md')];
  assert.deepEqual(names(matchFiles("Upload the file from 'runbook/x/TKT-1001/Invoice_Template_v5.1.docx' as a new version.", folder)),
    ['TKT-1001/Invoice_Template_v5.1.docx']);
  assert.deepEqual(names(matchFiles('Upload the file: Welcome Letter V3', folder)), ['Welcome Letter V3.docx']);
  assert.deepEqual(names(matchFiles('Upload the new Template as a version', folder, true)), [], 'a short stem names nothing');
  assert.deepEqual(names(matchFiles('upload template.docx', folder)), ['Template.docx'], 'a full name does, in any case');
  assert.deepEqual(names(matchFiles('runbook\\x\\TKT-1001\\Invoice_Template_v5.1.docx', folder)),
    ['TKT-1001/Invoice_Template_v5.1.docx'], 'Windows separators in a runbook still match');
});

test('two files with one name are ambiguous unless the step gives the path', () => {
  const folder = [c('25.7/Loan Offer.docx'), c('25.8/Loan Offer.docx')];
  assert.deepEqual(names(matchFiles('Upload Loan Offer.docx', folder)), []);
  assert.deepEqual(names(matchFiles('Upload 25.8/Loan Offer.docx', folder)), ['25.8/Loan Offer.docx']);
});

test("an upload that names no file gets the runbook folder's few attachments, and nothing past six", () => {
  assert.deepEqual(names(matchFiles('Upload the attached template as a new version.', [c('a.docx'), c('runbook.md')])), ['a.docx']);
  assert.deepEqual(names(matchFiles('Update the documents attached for the below templates: Account Summary, Draft Account Summary',
    [c('Conga/Account Summary Updated.docx'), c('Conga/Draft Account Summary Updated.docx'), c('runbook.md')])),
  ['Conga/Account Summary Updated.docx', 'Conga/Draft Account Summary Updated.docx']);
  assert.deepEqual(names(matchFiles('Upload the attached template.', Array.from({ length: 7 }, (_, i) => c(`t${i}.docx`)))), []);
  assert.deepEqual(names(matchFiles('Activate the flow.', [c('a.docx')])), [], 'a step that uploads nothing gets nothing');
  assert.deepEqual(names(matchFiles('Upload the attached template.', [c('a.docx')], true)), [], 'never from a folder searched later');
});

test('a folder searched after the runbook\'s own matches only by path, never by a bare name', () => {
  const repo = [c('release_24/Draft Account Summary.docx')];
  assert.deepEqual(names(matchFiles('Update Account Summary, Draft Account Summary', repo, true)), []);
  assert.deepEqual(names(matchFiles('Upload runbook/release_24/Draft Account Summary.docx', repo, true)), ['release_24/Draft Account Summary.docx']);
});

test('a folder offers only the files the step names, never a link out of it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sf-autopilot-files-'));
  const outside = await mkdtemp(join(tmpdir(), 'sf-autopilot-outside-'));
  try {
    await mkdir(join(root, 'CE-1'));
    await writeFile(join(root, 'CE-1', 'Letter v2.docx'), 'x');
    await writeFile(join(root, 'Other.docx'), 'x');
    await writeFile(join(outside, 'secret.docx'), 'x');
    await symlink(join(outside, 'secret.docx'), join(root, 'secret.docx'));
    const found = attachments('Upload Letter v2.docx, then secret.docx', [], root);
    assert.deepEqual(found.map((f) => f.name), ['Letter v2.docx'], 'a symlink is not a regular file in the folder');
    assert.ok(found[0].path.endsWith(join('CE-1', 'Letter v2.docx')));
    assert.deepEqual(attachments('Upload it', [join(root, 'Other.docx')]).map((f) => f.name), ['Other.docx'], '--file is taken as given');
    assert.throws(() => attachments('x', [root]), /is not a file/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('a folder the step names offers its attachments, and a path may omit the extension', () => {
  const repo = [c('release-2.11/Offer Template V6.docx'), c('release-2.11/runbook.md'), c('team/release_2.21/Account Summary Template.docx'), c('other/x.docx')];
  assert.deepEqual(names(matchFiles("Upload the file from 'runbook/release-2.11' as a new version.", repo)), ['release-2.11/Offer Template V6.docx']);
  assert.deepEqual(names(matchFiles('documents runbook\\team\\release_2.21\\Account Summary Template', repo)), ['team/release_2.21/Account Summary Template.docx']);
});

test('the first --files folder that names anything wins, so a nearby file beats a namesake elsewhere', async () => {
  const near = await mkdtemp(join(tmpdir(), 'sf-autopilot-near-'));
  const far = await mkdtemp(join(tmpdir(), 'sf-autopilot-far-'));
  try {
    await writeFile(join(near, 'Draft Account Summary.docx'), 'new');
    await mkdir(join(far, 'old'));
    await writeFile(join(far, 'old', 'Draft Account Summary.docx'), 'old');
    const found = attachments('Upload Draft Account Summary.docx', [], [near, far]);
    assert.equal(found.length, 1);
    assert.ok(found[0].path.startsWith(near) || found[0].path.includes(near.split('/').pop()!));
  } finally {
    await rm(near, { recursive: true, force: true });
    await rm(far, { recursive: true, force: true });
  }
});
