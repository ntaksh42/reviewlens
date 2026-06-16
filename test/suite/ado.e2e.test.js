// Live ADO E2E. Skipped unless ADO_PAT is set, so the normal `npm test` run and
// CI stay offline. Drives the real AdoClient against a configured PR.
//
//   ADO_PAT=<pat> npm test
//
// Defaults target the ReviewLens test fixture PR (PersonalProject/TestRepos #68
// on branch feature/large-test-pr). Override via env to point elsewhere:
//   ADO_ORG, ADO_PROJECT, ADO_REPO, ADO_E2E_BRANCH, ADO_E2E_PR
// Write-path checks (comment/vote create+cleanup) only run with ADO_E2E_WRITE=1.
const assert = require('assert');
const path = require('path');

const pat = process.env.ADO_PAT;
const config = {
  orgUrl: process.env.ADO_ORG || 'https://dev.azure.com/aksh0402',
  project: process.env.ADO_PROJECT || 'PersonalProject',
  repository: process.env.ADO_REPO || 'TestRepos',
};
const BRANCH = process.env.ADO_E2E_BRANCH || 'feature/large-test-pr';
const EXPECT_PR = process.env.ADO_E2E_PR ? Number(process.env.ADO_E2E_PR) : 68;
const WRITE = process.env.ADO_E2E_WRITE === '1';

const suite = pat ? describe : describe.skip;

suite('ADO E2E (live, needs ADO_PAT)', function () {
  this.timeout(60000);
  let AdoClient, client, pr, repoId;

  before(async () => {
    ({ AdoClient } = require(path.resolve(__dirname, '../../dist/test/adoClient.js')));
    client = new AdoClient(config, pat);
    pr = await client.findActivePrBySourceBranch(BRANCH);
    assert.ok(pr, `no active PR found for branch ${BRANCH}`);
    repoId = pr.repositoryId;
  });

  it('finds the PR for the source branch', () => {
    assert.strictEqual(pr.id, EXPECT_PR);
    assert.strictEqual(pr.sourceBranch, BRANCH);
    assert.strictEqual(pr.targetBranch, 'main');
    assert.ok(pr.repositoryId);
    assert.ok(pr.url.includes(`/pullrequest/${EXPECT_PR}`));
  });

  it('lists changed files with base/head commits', async () => {
    const review = await client.getReview(pr.id, repoId);
    assert.ok(review.files.length > 0, 'expected changed files');
    assert.ok(review.baseCommit, 'expected baseCommit');
    assert.ok(review.headCommit, 'expected headCommit');
    assert.ok(review.files.every((f) => !f.path.startsWith('/')), 'paths must not start with /');
  });

  it('includes deleted files in the changed-files list (regression)', async () => {
    const review = await client.getReview(pr.id, repoId);
    const deleted = review.files.filter((f) => f.status === 'deleted');
    assert.ok(deleted.length > 0, 'expected at least one deleted file in the fixture PR');
  });

  it('reads head and base file content', async () => {
    const review = await client.getReview(pr.id, repoId);
    const added = review.files.find((f) => f.status === 'added');
    assert.ok(added, 'fixture PR should add a file');
    const head = await client.getFileContent(repoId, added.path, review.headCommit);
    assert.ok(head.length > 0, 'added file should have head content');
    const base = await client.getFileContent(repoId, added.path, review.baseCommit);
    assert.strictEqual(base, '', 'added file should not exist at base');
  });

  it('reads overview (description / reviewers / work items)', async () => {
    const ov = await client.getOverview(pr.id, repoId);
    assert.strictEqual(typeof ov.description, 'string');
    assert.ok(Array.isArray(ov.reviewers));
    assert.ok(Array.isArray(ov.workItems));
  });

  it('reads threads', async () => {
    const threads = await client.getThreads(pr.id, repoId);
    assert.ok(Array.isArray(threads));
  });

  const writeSuite = WRITE ? describe : describe.skip;
  writeSuite('write path (ADO_E2E_WRITE=1, creates + cleans up)', function () {
    this.timeout(60000);
    const stamp = `reviewlens-e2e ${Date.now()}`;
    let threadId, git, GitInterfaces;

    before(async () => {
      const azdev = require('azure-devops-node-api');
      const conn = new azdev.WebApi(config.orgUrl, azdev.getPersonalAccessTokenHandler(pat));
      git = await conn.getGitApi();
      GitInterfaces = require('azure-devops-node-api/interfaces/GitInterfaces');
    });

    after(async () => {
      if (threadId && git) {
        try {
          const t = await git.getPullRequestThread(repoId, pr.id, threadId, config.project);
          for (const c of t.comments || []) {
            if (c.id) {
              try { await git.deleteComment(repoId, pr.id, threadId, c.id, config.project); } catch (_) {}
            }
          }
          await git.updateThread({ status: GitInterfaces.CommentThreadStatus.Closed }, repoId, pr.id, threadId, config.project);
        } catch (_) {}
      }
      try { await client.setVote(pr.id, repoId, 'reset'); } catch (_) {}
    });

    it('creates a comment thread and reads it back', async () => {
      const review = await client.getReview(pr.id, repoId);
      const file = (review.files.find((f) => f.status === 'added') || review.files[0]).path;
      threadId = await client.createComment(pr.id, repoId, file, { startLine: 1, startOffset: 1, endLine: 1, endOffset: 5 }, `${stamp} first`);
      assert.ok(threadId, 'createComment should return a thread id');
      const threads = await client.getThreads(pr.id, repoId);
      const mine = threads.find((t) => t.id === String(threadId));
      assert.ok(mine, 'new thread should be readable');
      assert.strictEqual(mine.anchor.filePath, file);
      assert.strictEqual(mine.anchor.side, 'right');
      assert.strictEqual(mine.comments[0].content, `${stamp} first`);
    });

    it('replies to the thread', async () => {
      await client.replyToThread(pr.id, repoId, threadId, `${stamp} reply`);
      const threads = await client.getThreads(pr.id, repoId);
      const mine = threads.find((t) => t.id === String(threadId));
      assert.strictEqual(mine.comments.length, 2);
      assert.ok(mine.comments.some((c) => c.content === `${stamp} reply`));
    });

    it('updates thread status to fixed', async () => {
      await client.setThreadStatus(pr.id, repoId, threadId, 'fixed');
      const threads = await client.getThreads(pr.id, repoId);
      const mine = threads.find((t) => t.id === String(threadId));
      assert.strictEqual(mine.status, 'fixed');
    });

    it('sets and resets the reviewer vote', async () => {
      await client.setVote(pr.id, repoId, 'approve');
      let ov = await client.getOverview(pr.id, repoId);
      assert.ok(ov.reviewers.some((r) => r.vote === 'approved'), 'vote should read back as approved');
      await client.setVote(pr.id, repoId, 'reset');
      ov = await client.getOverview(pr.id, repoId);
      assert.ok(!ov.reviewers.some((r) => r.vote === 'approved'), 'reset should clear approval');
    });
  });
});
