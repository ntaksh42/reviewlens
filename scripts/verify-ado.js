// Dev probe: verify ReviewLens's ADO calls + field mapping against the real API.
// Prefer a PAT (matches the extension, D6). Falls back to an AAD bearer token.
// NOTE: MSA-backed orgs reject AAD bearer tokens (TF400813) — use a PAT there.
// The PAT stays in your shell; do not share it.
//
//   ADO_PAT=<your-pat> ADO_PROJECT=DashboardDemo node scripts/verify-ado.js
// or (AAD-backed orgs only):
//   ADO_TOKEN=$(az account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798 --query accessToken -o tsv) node scripts/verify-ado.js

const azdev = require('azure-devops-node-api');

const pat = process.env.ADO_PAT;
const token = process.env.ADO_TOKEN;
const org = process.env.ADO_ORG || 'https://dev.azure.com/aksh0402';
const project = process.env.ADO_PROJECT || 'DashboardDemo';

async function main() {
  let handler;
  if (pat) {
    handler = azdev.getPersonalAccessTokenHandler(pat);
  } else if (token) {
    handler = azdev.getBearerHandler(token);
  } else {
    throw new Error('set ADO_PAT (recommended) or ADO_TOKEN');
  }
  const conn = new azdev.WebApi(org, handler);
  const git = await conn.getGitApi();
  const prs = await git.getPullRequestsByProject(project, { status: 1 /* Active */ });

  console.log(`Found ${prs.length} active PRs in "${project}":\n`);
  for (const pr of prs.slice(0, 8)) {
    const src = (pr.sourceRefName || '').replace('refs/heads/', '');
    const tgt = (pr.targetRefName || '').replace('refs/heads/', '');
    const author = pr.createdBy && pr.createdBy.displayName;
    const repo = pr.repository && pr.repository.name;
    console.log(`#${pr.pullRequestId} ${pr.title}`);
    console.log(`   author=${author} repo=${repo} ${src} -> ${tgt}`);
  }

  const s = prs[0];
  console.log(
    '\nField presence (what AdoClient maps):',
    JSON.stringify(
      {
        pullRequestId: typeof s.pullRequestId,
        title: typeof s.title,
        'createdBy.displayName': s.createdBy && typeof s.createdBy.displayName,
        'repository.name': s.repository && typeof s.repository.name,
        sourceRefName: typeof s.sourceRefName,
        targetRefName: typeof s.targetRefName,
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
