const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

async function main() {
  const ctx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    outfile: 'dist/extension.js',
    external: ['vscode'],
    sourcemap: !production,
    minify: production,
    logLevel: 'info',
  });
  // Also emit the vscode-free pure helpers as CJS modules so the unit tests can
  // require them directly (they can't reach into the bundled extension). Each
  // gets its own context to keep a flat dist/test/<name>.js layout.
  const testEntries = [
    { entry: 'src/domain/suggestion.ts', out: 'dist/test/suggestion.js' },
    { entry: 'src/domain/navigation.ts', out: 'dist/test/navigation.js' },
    { entry: 'src/domain/anchor.ts', out: 'dist/test/anchor.js' },
    { entry: 'src/domain/attach.ts', out: 'dist/test/attach.js' },
    { entry: 'src/domain/labels.ts', out: 'dist/test/labels.js' },
    // URI helpers import 'vscode'; the bundle keeps it external, so this is only
    // require-able from a test running inside the VS Code host (not pure mocha).
    { entry: 'src/ui/diffContentProvider.ts', out: 'dist/test/diffContentProvider.js' },
    { entry: 'src/ui/navigationCursor.ts', out: 'dist/test/navigationCursor.js' },
    // azure-devops-node-api stays external (resolved from node_modules at test
    // time) so adoClient's pure mappers import without bundling the SDK.
    { entry: 'src/infra/ado/adoClient.ts', out: 'dist/test/adoClient.js' },
  ];
  const testCtxs = await Promise.all(
    testEntries.map(({ entry, out }) =>
      esbuild.context({
        entryPoints: [entry],
        bundle: true,
        format: 'cjs',
        platform: 'node',
        target: 'node18',
        outfile: out,
        external: ['vscode', 'azure-devops-node-api'],
        sourcemap: !production,
        logLevel: 'info',
      })
    )
  );
  if (watch) {
    await Promise.all([ctx.watch(), ...testCtxs.map((c) => c.watch())]);
  } else {
    await Promise.all([ctx.rebuild(), ...testCtxs.map((c) => c.rebuild())]);
    await Promise.all([ctx.dispose(), ...testCtxs.map((c) => c.dispose())]);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
