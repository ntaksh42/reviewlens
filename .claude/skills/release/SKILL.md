---
name: release
description: Release a new version of the ReviewLens VS Code extension to GitHub. Use when the user wants to cut a release, publish a new version, ship a .vsix, or bump the version and tag.
---

# ReviewLens リリース手順

ReviewLens は VS Code 拡張機能。リリースは `v*` タグを push すると GitHub Actions
(`.github/workflows/release.yml`) が `.vsix` をビルドして GitHub Release に添付する仕組み。

## 手順

1. **バージョン番号を決める**
   - 引数でバージョンが渡されていればそれを使う（例 `0.1.0`）。
   - 無ければ `package.json` の現在の `version` を読み、ユーザーに次のバージョンを確認する。
   - semver に従う: バグ修正=patch、機能追加=minor、破壊的変更=major。

2. **作業ツリーがクリーンか確認**
   ```bash
   git status --porcelain
   ```
   未コミットの変更があれば、リリースに含めるべきか先にユーザーへ確認する。

3. **`package.json` の version を更新**
   - `Edit` ツールで `"version": "X.Y.Z"` に書き換える。
   - lockfile も揃えたい場合は `npm install --package-lock-only` を実行。

4. **ローカル検証（任意だが推奨）**
   ```bash
   npm run typecheck && npx vsce package --out /tmp/reviewlens-check.vsix
   ```
   パッケージが通ることを確認。確認後 `/tmp` の .vsix は削除してよい。

5. **commit & push**
   ```bash
   git add package.json package-lock.json
   git commit -m "chore: release vX.Y.Z"
   git push
   ```

6. **タグを切って push（これがリリースをトリガーする）**
   ```bash
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```
   タグは `package.json` の version と一致させ、必ず `v` 接頭辞を付ける。

7. **Actions の完了を待って確認**
   ```bash
   gh run list --workflow=release.yml --limit 1
   gh run watch <run-id> --exit-status
   gh release view vX.Y.Z --json assets --jq '[.assets[].name]'
   ```
   `reviewlens-vX.Y.Z.vsix` が添付されていれば成功。リリースURLをユーザーに伝える。

## 注意

- タグ名と `package.json` の version が食い違うとファイル名が紛らわしくなる。必ず揃える。
- 同じタグを再 push するとワークフローは再実行されない。やり直す場合はタグを削除して切り直す:
  `git tag -d vX.Y.Z && git push origin :vX.Y.Z`
- マーケットプレイス公開（`vsce publish`）はしていない。GitHub Release への `.vsix` 添付のみ。
