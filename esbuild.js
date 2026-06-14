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
  // Also emit the vscode-free pure helpers as a CJS module so the unit tests can
  // require them directly (they can't reach into the bundled extension).
  const testCtx = await esbuild.context({
    entryPoints: ['src/domain/suggestion.ts'],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    outfile: 'dist/test/suggestion.js',
    sourcemap: !production,
    logLevel: 'info',
  });
  if (watch) {
    await Promise.all([ctx.watch(), testCtx.watch()]);
  } else {
    await Promise.all([ctx.rebuild(), testCtx.rebuild()]);
    await Promise.all([ctx.dispose(), testCtx.dispose()]);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
