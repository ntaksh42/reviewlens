# Run the ExTester UI walkthrough against the fixture PR.
#
#   $env:ADO_PAT = "<pat>"; ./scripts/ui-verify.ps1
#
# Clones the PR's source branch into a temp workspace (branch-attach keys off the
# open branch), then runs `npm run test:ui` pointed at it. Screenshots land in
# test-resources/screenshots/<timestamp>/.
$ErrorActionPreference = 'Stop'

if (-not $env:ADO_PAT) {
  Write-Error 'Set $env:ADO_PAT first (Azure DevOps PAT, scope Code Read & Write).'
}

$org    = if ($env:ADO_ORG)     { $env:ADO_ORG }     else { 'https://dev.azure.com/aksh0402' }
$project = if ($env:ADO_PROJECT) { $env:ADO_PROJECT } else { 'PersonalProject' }
$repo   = if ($env:ADO_REPO)    { $env:ADO_REPO }    else { 'TestRepos' }
$branch = if ($env:ADO_E2E_BRANCH) { $env:ADO_E2E_BRANCH } else { 'feature/large-test-pr' }
$ws     = if ($env:RL_UI_WORKSPACE) { $env:RL_UI_WORKSPACE } else { Join-Path $env:TEMP 'reviewlens-ui-ws' }

if (-not (Test-Path (Join-Path $ws '.git'))) {
  Write-Host "Cloning $repo @ $branch into $ws ..."
  Remove-Item -Recurse -Force $ws -ErrorAction SilentlyContinue
  $env:GIT_TERMINAL_PROMPT = '0'
  # PAT as the basic-auth password; the org's MSA backing rejects AAD bearer tokens.
  $authUrl = $org -replace '^https://', "https://anything:$($env:ADO_PAT)@"
  git clone --branch $branch "$authUrl/$project/_git/$repo" $ws
  # Strip the PAT back out of the stored remote URL.
  git -C $ws remote set-url origin "$org/$project/_git/$repo"
} else {
  Write-Host "Reusing workspace at $ws"
}

$env:RL_UI_WORKSPACE = $ws
Write-Host 'Running UI walkthrough (downloads VS Code + ChromeDriver on first run)...'
npm run test:ui
