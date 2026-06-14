# ReviewLens アーキテクチャ（開発者向け）

技術的な設計の要点をまとめた文書です。全体像をやさしく知りたい場合は
[`設計ドキュメント.md`](./設計ドキュメント.md) を先に読んでください。

## レイヤリング

ソースは依存方向が一方向（上→下）の 4 層構成です。下の層は上の層を import
しません。

```
ui/      VS Code API に依存する表示・操作の層（TreeDataProvider, CommentController,
         TextDocumentContentProvider, コマンド配線は extension.ts）
  │ depends on
app/     ユースケース層。PullRequestService / ReviewService。VS Code 非依存に近く、
         「PR を開く」「投票する」等の段取りと状態（ActiveReview）を保持
  │ depends on
infra/   外界との境界。ADO REST（azure-devops-node-api）、認証（SecretStorage）、
         設定、git worktree、言語サーバー呼び出し、永続化（Memento）
  │ depends on
domain/  純粋なデータ型と列挙のみ（vscode / ADO を import しない）
```

`extension.ts` が合成ルート（composition root）。各サービス・プロバイダを
生成し、コマンドとビューを `context.subscriptions` に配線します。

## 主要コンポーネント

| ファイル | 責務 |
|---|---|
| `extension.ts` | activate でのワイヤリング、全コマンド登録、ローカルレビューの状態機械 |
| `app/pullRequestService.ts` | アクティブ PR 一覧の取得 |
| `app/reviewService.ts` | 開いている PR（`ActiveReview`）の保持、ファイル内容・スレッド取得、投票/完了/中止、ローカルパス管理 |
| `infra/ado/adoClient.ts` | ADO GitApi の薄いラッパー。全 REST 呼び出しの単一窓口 |
| `infra/ado/clientFactory.ts` | 設定＋PAT をキーにした AdoClient のキャッシュ |
| `infra/ado/authProvider.ts` | PAT を SecretStorage に保存/取得/削除 |
| `infra/git/worktree.ts` | detached worktree の作成・解決・LRU プルーニング（manifest.json） |
| `infra/lsp/impactAnalyzer.ts` | `git diff` で変更行を抽出 → DocumentSymbol → CallHierarchy で呼び出し元を集計 |
| `infra/state/viewedStore.ts` | 既読状態を workspaceState に永続化（PR 単位） |
| `infra/state/anchorStore.ts` | コメント行の正規化テキストを保存（再アンカリング用） |
| `ui/prListTreeProvider.ts` | project → repository → PR の階層ツリー＋フィルタ |
| `ui/changedFilesTreeProvider.ts` | 変更ファイル一覧＋既読表示 |
| `ui/diffContentProvider.ts` | `reviewlens:` スキームの read-only 仮想ドキュメント、head URI 解決 |
| `ui/commentsController.ts` | ADO スレッド ↔ VS Code Comment UI の橋渡し、再アンカリング |
| `ui/impactTreeProvider.ts` | 影響分析結果のツリー表示 |
| `ui/navigationCursor.ts` | 変更ファイル間ナビゲーションのカーソル |

## 横断的な設計判断

- **差分の表示**：base/head を `reviewlens:` スキームの仮想ドキュメントとして
  push し `vscode.diff` で開く。URI に元の拡張子を残してシンタックスハイライト
  を効かせる。
- **ローカルレビュー時の head**：worktree 上の実ファイル（`file:` スキーム）を
  head 側に使い、フルのコードインテリジェンスを得る。セッション中は read-only
  に設定してアンカードリフトと作業コピー汚染を防ぐ。
- **キャッシュ**：(1) AdoClient（resource-area ルックアップの往復を回避）、
  (2) コミット固定のファイル内容（`${commit}:${path}` キー）、(3) GitApi promise。
- **再アンカリング**：コメント作成時に行テキストを正規化保存。再描画時に保存
  行→一致しなければ ±200 行を探索し `moved`/`lost` を判定、ラベルに `↕`/`⚠`。
- **コンテキストキー**：`reviewlens.reviewActive` / `localActive` /
  `prFilterActive` で when 句とキーバインドのゲートを制御。
- **不可逆操作**：complete / abandon はモーダル確認を挟む。

## データ永続化

| 種別 | ストア | スコープ |
|---|---|---|
| PAT | SecretStorage | グローバル（暗号化） |
| 既読 / アンカースナップショット | workspaceState (Memento) | ワークスペース |
| worktree キャッシュ + manifest | globalStorageUri 配下 | グローバル |
| コメント / 投票 / PR 状態 | Azure DevOps | リモート（信頼できる正） |

## ビルドとテスト

```bash
npm run build      # esbuild で dist/extension.js にバンドル
npm run typecheck  # tsc --noEmit
npm test           # @vscode/test-electron による起動テスト
```
