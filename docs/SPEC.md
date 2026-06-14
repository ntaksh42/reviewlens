# ReviewLens 仕様書（SPEC）

本書は ReviewLens の **現在の実装に基づく仕様** を定義する。設計のやさしい
解説は [`設計ドキュメント.md`](./設計ドキュメント.md)、開発者向けの内部構成は
[`ARCHITECTURE.md`](./ARCHITECTURE.md) を参照。

- 対象バージョン: `0.0.1`
- 対象 VS Code: `^1.90.0`
- 連携先: Azure DevOps（`azure-devops-node-api` 経由）

---

## 1. 目的とスコープ

ReviewLens は、Azure DevOps（以下 ADO）のプルリクエスト（PR）レビューを
**VS Code 内で完結** させ、**キーボード中心** かつ **ナビゲーション重視** で
行うための VS Code 拡張機能である。

### 1.1 実装済みの範囲
- アクティブ PR の一覧表示・絞り込み
- PR の変更ファイル一覧と base↔head 差分表示
- コメントスレッドの表示・作成・返信・解決
- 投票（承認/却下等）・PR の完了（マージ）・中止
- 既読管理
- ローカル（worktree）レビュー
- 影響分析（変更関数の呼び出し元抽出）
- キーボードナビゲーション

### 1.2 未実装（将来）
- 修正提案（suggestion）— ADO に対応 UI が無いため見送り
- AI 機能（PR 要約・リスク判定・差分説明）— `ChangedFile.riskScore` を予約済み
  （現状は常に `null`）

---

## 2. 用語

| 用語 | 定義 |
|---|---|
| PR | プルリクエスト。ADO 上の変更提案単位 |
| イテレーション | PR への push ごとに ADO が作る版。最新版を base/head の基準にする |
| base / head | 差分の左（マージ基点）/ 右（PR ソース）コミット |
| スレッド | ADO のコメントスレッド（1 行に紐づく一連のコメント） |
| 既読 | レビュアーが確認済みと印を付けたファイル状態 |
| ローカルレビュー | PR の head を git worktree として取り出して行うレビュー |
| 影響分析 | 変更関数の呼び出し元を列挙し、未変更の呼び出し元を警告する機能 |
| PAT | Personal Access Token。ADO への認証に使う |

---

## 3. アクティベーションと UI 構成

### 3.1 アクティベーション
- `activationEvents` は空。拡張はビューコンテナ／コマンドの登録により起動し、
  `activate` で全サービス・プロバイダ・コマンドを配線する。

### 3.2 ビュー
アクティビティバーに `ReviewLens`（アイコン `$(git-pull-request)`）コンテナを
追加し、以下 3 ビューを提供する。

| ビュー ID | 表示名 | 内容 |
|---|---|---|
| `reviewlens.prList` | Pull Requests | アクティブ PR を project→repository→PR で階層表示 |
| `reviewlens.changedFiles` | Changed Files | 開いた PR の変更ファイル一覧 |
| `reviewlens.impact` | Impact | 影響分析の結果 |

### 3.3 コンテキストキー
when 句・キーバインドの制御に使用する。

| キー | 真になる条件 |
|---|---|
| `reviewlens.reviewActive` | PR を開いてレビュー中 |
| `reviewlens.localActive` | ローカルレビューが ON |
| `reviewlens.prFilterActive` | PR 一覧にフィルタ文字列が設定済み |

---

## 4. 機能仕様

### 4.1 認証（サインイン）
- **R-4.1.1** `ReviewLens: Sign in (PAT)` で PAT を入力すると、入力欄は伏字
  表示（password）でフォーカスを失っても閉じない。値は前後空白を除去して
  **SecretStorage** に `reviewlens.pat` キーで保存する。
- **R-4.1.2** サインイン成功後は PR 一覧を再取得する。
- **R-4.1.3** `ReviewLens: Sign out` は PAT を削除し、ローカルレビューを解除し、
  PR 一覧を再取得する。
- **R-4.1.4** 必要な PAT スコープは **Code（Read & Write）**。
- **R-4.1.5** PAT は画面・ログ・コミット等に出力しない。

### 4.2 PR 一覧（reviewlens.prList）
- **R-4.2.1** 設定 `repository` が空ならプロジェクト全体、指定があればその
  リポジトリの **Active** な PR を取得する。
- **R-4.2.2** 一覧は **project → repository → PR** の 3 段ツリー。project /
  repository 節点には件数を表示する。
- **R-4.2.3** PR 行は `#<id> <title>` を表示し、説明に `<author> · <source> →
  <target>`、ツールチップに Web URL を出す。PR は id 降順に並べる。
- **R-4.2.4** フィルタ（`ReviewLens: Filter Pull Requests`）は入力テキストを
  小文字化し、`#id・title・author・project・repository・sourceBranch・
  targetBranch` の連結に対する部分一致で絞り込む。
- **R-4.2.5** フィルタが有効な間はツールバーアイコンが `clearFilter`
  （`$(filter-filled)`）に切り替わり、空文字設定で解除する。
- **R-4.2.6** 取得 0 件・フィルタ一致 0 件・エラー時は、それぞれ説明文の
  ヒント行を表示する。
- **R-4.2.7** `ReviewLens: Refresh Pull Requests` で再取得する。

### 4.3 PR を開く
- **R-4.3.1** PR 行をクリックすると `reviewlens.openPr` が走り、進行中だった
  ローカルレビューを解除し、既存の差分・コメント表示をクリアする。
- **R-4.3.2** その PR の **最新イテレーション** から base/head コミットと
  変更ファイル一覧を取得し、同時に **コメントスレッド** も取得する（並行）。
- **R-4.3.3** base コミットは `commonRefCommit` を優先し、無ければ
  `targetRefCommit` を用いる。head コミットは `sourceRefCommit`。
- **R-4.3.4** 変更ファイルはフォルダ項目を除外し、`added/modified/deleted/
  renamed` のいずれかに分類する。
- **R-4.3.5** Changed Files ビューに一覧を表示し、ビュー説明に `#<id>
  <title>` を出す。既読状態は永続化済みの値で復元する。
- **R-4.3.6** 取得失敗時はエラーメッセージを表示し、一覧を空にする。

### 4.4 差分表示
- **R-4.4.1** 変更ファイルをクリックすると base↔head の差分エディタを開く
  （`vscode.diff`、タイトル `<name> (base ↔ head) — PR #<id>`）。
- **R-4.4.2** 通常モードでは base/head とも **`reviewlens:` スキームの
  読み取り専用仮想ドキュメント** として ADO の内容 API から供給する。URI は
  元のファイル拡張子を保持し、シンタックスハイライトを効かせる。
- **R-4.4.3** ファイル内容は `${commit}:${path}` をキーに **キャッシュ** し、
  ファイル間を行き来しても再取得しない（コミット固定の内容は不変のため）。
- **R-4.4.4** 開いたファイルの該当コメントを head 側に描画する（§4.6）。

### 4.5 既読（Viewed）
- **R-4.5.1** Changed Files の行内アクション（`$(check)`）で既読を切り替える。
- **R-4.5.2** 既読は **PR ごと・ファイルパスごと** に永続化し、PR を開き直し
  ても復元する。

### 4.6 コメント
- **R-4.6.1** ADO スレッドを差分の **head（右）側** に描画する。ラベルは
  `ReviewLens · <status>` とし、再アンカリング状態に応じ `↕ re-anchored` /
  `⚠ anchor drifted` を付す。
- **R-4.6.2** **全行** にコメント可能（変更行に限らず、文脈行にも付けられる）。
  ただしローカルレビューで head が実ファイルの場合は、文脈で開いた近隣ファイル
  にガターが出ないよう **PR の変更ファイルに限定** する。
- **R-4.6.3** 新規コメントは head 側のキャラクタ範囲に anchor する。エディタで
  範囲選択があればその範囲、無ければ行全体を対象にする（VS Code の 0 始まり列を
  ADO の 1 始まり offset に変換）。
- **R-4.6.4** 既存スレッドへの入力は返信、未保存スレッドへの入力は新規作成と
  して ADO に往復する。作成・返信・解決の後はスレッドを再取得して再描画する。
- **R-4.6.5** スレッドの解決はステータスを `closed` に更新する。
- **R-4.6.6** キーボード操作：`Ctrl+;`（mac `Cmd+;`）でカーソル行にコメント
  入力を開き、`Ctrl+Enter`（mac `Cmd+Enter`）で送信する。

#### 再アンカリング
- **R-4.6.7** コメント作成時、anchor 行の **正規化テキスト**（前後空白除去・
  連続空白を 1 つに圧縮）を PR・スレッド単位で永続化する。
- **R-4.6.8** 再描画時、保存行のテキストがスナップショットと一致すればその行
  （`none`）。一致しなければ保存行から **上下 200 行** を外側へ探索し、最初に
  一致した行へ移す（`moved`）。見つからなければ保存行のまま（`lost`）。
- **R-4.6.9** スナップショットが無い既存スレッドは、描画時にその行のテキストで
  ベースラインを記録し、次回以降の移動を検出可能にする。

### 4.7 投票・完了・中止
- **R-4.7.1** Changed Files ツールバーの `Vote / complete…`（`$(thumbsup)`）
  からクイックピックを開く。
- **R-4.7.2** 投票は次の 5 種で、ADO の数値投票へ写像する。

  | 選択 | ADO 値 |
  |---|---|
  | Approve | 10 |
  | Approve with suggestions | 5 |
  | Wait for the author | -5 |
  | Reject | -10 |
  | Reset vote | 0 |

- **R-4.7.3** 投票は **サインイン中ユーザー自身** のレビュアー投票として記録
  する（PAT 所有者の GUID を解決して付与）。
- **R-4.7.4** **Complete（マージ）** は head コミットを最終マージ元として
  ADO に送る。マージ方式・ブランチ削除は ADO/ブランチポリシーの既定に従う。
- **R-4.7.5** **Abandon（中止）** は PR を Abandoned 状態にする。
- **R-4.7.6** Complete / Abandon は不可逆操作のため **モーダル確認** を挟み、
  実行後はレビュー UI を閉じて PR 一覧を再取得する。

### 4.8 ローカル（worktree）レビュー
- **R-4.8.1** Changed Files ツールバーの `Review locally`（`$(repo-clone)`）で
  開始、`Stop local review`（`$(repo)`）で解除する（`localActive` で切替）。
- **R-4.8.2** 開始には PR を開いていること、head コミットが既知であること、
  **フォルダ／ワークスペースが 1 つ以上開いていること** が必要。
- **R-4.8.3** 対応するローカルクローンを解決する。優先順位は
  (1) 設定 `localRepoPath`、(2) 開いている各フォルダの `origin` リモート URL を
  PR の remoteUrl と **正規化比較**（scheme・`user@`・末尾 `.git`・https/ssh の
  差を吸収）して一致するもの。見つからなければエラー。
- **R-4.8.4** head コミットが手元に無ければ、まず `git fetch origin <sha>`、
  失敗したら `git fetch --all --prune` を試みる。なお取得できなければエラー。
- **R-4.8.5** head を **detached worktree** として
  `<globalStorage>/worktrees/<repo>-<sha[:12]>` に作成する。これにより
  **利用者のブランチや作業ツリーには一切触れない**。
- **R-4.8.6** worktree はワークスペースフォルダとして追加し（名前 `PR #<id>
  (head)`）、言語サーバーに head 版をインデックスさせる。これにより head 側で
  定義ジャンプ・参照検索・grep・近隣ファイルのオープンが可能になる。
- **R-4.8.7** ローカルレビュー時、差分の head 側は **worktree の実ファイル**
  （`file:` スキーム、ディスク上に存在する場合）を用い、**セッション中は
  読み取り専用** にする（アンカードリフト・作業コピー汚染の防止）。実ファイルが
  無いものは従来どおり仮想ドキュメントにフォールバックする。
- **R-4.8.8** worktree は同一 head なら **再利用** する。`manifest.json` で
  使用時刻を記録し、`localWorktreeLimit`（既定 5）を超えた分を **LRU で削除**
  する（使用中のものは除外）。
- **R-4.8.9** 解除時、worktree フォルダをワークスペースから外す（先頭フォルダは
  外さずリロードを避ける）。worktree 本体はディスクに残し、再利用に備える。
- **R-4.8.10** サインアウト・別 PR を開く・解除のいずれでもローカル状態を
  破棄する。

### 4.9 影響分析（reviewlens.impact）
- **R-4.9.1** ツールバーの `Analyze Impact`（`$(search)`）で実行する。
- **R-4.9.2** 解析対象は、ローカルレビュー ON のときは worktree（基準は PR の
  base コミット）、OFF のときは先頭ワークスペースフォルダ（基準は設定
  `baseRef`、既定 `main`）。フォルダが無ければヒントを表示する。
- **R-4.9.3** 変更行は `git diff --unified=0 <base>...HEAD` で抽出する
  （空なら `HEAD`、さらに作業ツリー差分の順にフォールバック）。
- **R-4.9.4** 変更行を含む **最も外側の名前付き呼び出し可能シンボル**
  （Function / Method / Constructor）を、言語サーバーの DocumentSymbol から
  特定する。
- **R-4.9.5** 各シンボルについて CallHierarchy の incoming calls を取得し、
  呼び出し元を列挙する。呼び出し元が **この PR の変更行に含まれるか** を判定
  する。
- **R-4.9.6** 呼び出し元は **未変更を先頭** に並べ、結果ツリーでは未変更を
  `$(warning)`（巻き込み範囲）、変更済みを `$(check)` で示す。シンボル節点には
  `<総数> callers · <未変更数> unchanged` を表示する。
- **R-4.9.7** 呼び出し元行のクリックで該当ファイル・行へジャンプする。
- **R-4.9.8** 言語サーバーが応答しない場合は結果なしとして扱い、失敗時は
  エラーメッセージを表示する。

### 4.10 ナビゲーション
- **R-4.10.1** 変更ファイル間を移動する（`Next/Previous changed file`）。移動先の
  差分を自動で開く。
- **R-4.10.2** 差分内の変更箇所間を移動する（`Next/Previous change`、VS Code の
  compare-editor の前後変更コマンドに委譲）。

---

## 5. コマンド一覧

| コマンド ID | タイトル | 公開 |
|---|---|---|
| `reviewlens.signIn` | Sign in (PAT) | コマンド |
| `reviewlens.signOut` | Sign out | コマンド |
| `reviewlens.refreshPrs` | Refresh Pull Requests | prList ツールバー |
| `reviewlens.filterPrs` | Filter Pull Requests | prList ツールバー |
| `reviewlens.clearFilter` | Clear Pull Request Filter | prList ツールバー |
| `reviewlens.toggleViewed` | Toggle viewed | changedFiles 行内 |
| `reviewlens.createOrReply` | Comment | コメント UI |
| `reviewlens.addComment` | Add comment on current line | キーバインド |
| `reviewlens.resolveThread` | Resolve thread | スレッドタイトル |
| `reviewlens.castVote` | Vote / complete pull request… | changedFiles ツールバー |
| `reviewlens.analyzeImpact` | Analyze Impact | impact ツールバー |
| `reviewlens.reviewLocally` | Review locally (checkout PR) | changedFiles ツールバー |
| `reviewlens.stopLocalReview` | Stop local review | changedFiles ツールバー |
| `reviewlens.nextFile` / `prevFile` | Next / Previous changed file | キーバインド |
| `reviewlens.nextChange` / `prevChange` | Next / Previous change | キーバインド |

> `reviewlens.openPr` / `openFileDiff` / `openImpactLocation` は内部配線用で、
> コマンドパレットには公開しない。

---

## 6. キーバインド

| 操作 | キー | 有効条件（when） |
|---|---|---|
| 次/前の変更ファイル | `shift+alt+]` / `shift+alt+[` | `reviewlens.reviewActive` |
| 差分内の次/前の変更 | `alt+down` / `alt+up` | `reviewActive && textInputFocus` |
| 現在行にコメント | `ctrl+;`（mac `cmd+;`） | `reviewActive && editorTextFocus && resourceScheme == reviewlens` |
| コメント送信 | `ctrl+enter`（mac `cmd+enter`） | `commentEditorFocused && commentController == reviewlens` |

---

## 7. 設定項目

| 設定キー | 型 | 既定 | 説明 |
|---|---|---|---|
| `reviewlens.orgUrl` | string | `""` | ADO 組織 URL（例 `https://dev.azure.com/your-org`）。末尾スラッシュは除去 |
| `reviewlens.project` | string | `""` | ADO プロジェクト名 |
| `reviewlens.repository` | string | `""` | 対象リポジトリ名。空ならプロジェクト全体 |
| `reviewlens.baseRef` | string | `main` | 影響分析の基準 ref（`git diff <baseRef>...HEAD`） |
| `reviewlens.localRepoPath` | string | `""` | ローカルレビュー用クローンの絶対パス。空なら自動検出 |
| `reviewlens.localWorktreeLimit` | number(min 0) | `5` | 保持する worktree 数。超過分を LRU で削除 |

- **設定済みの判定**：`orgUrl` と `project` の両方が非空であること。未設定で
  ADO 操作を行うとエラー（設定を促すメッセージ）になる。

---

## 8. ADO 連携仕様

すべての ADO REST アクセスは単一のクライアント（`AdoClient`、GitApi ラッパー）
を経由する。

| 操作 | ADO API |
|---|---|
| PR 一覧 | `getPullRequests`（repo 指定時）/ `getPullRequestsByProject` |
| イテレーション/変更 | `getPullRequestIterations` / `getPullRequestIterationChanges` |
| ファイル内容 | `getItem`（version=commit） |
| スレッド取得 | `getThreads`（削除分は除外） |
| コメント作成/返信 | `createThread` / `createComment` |
| スレッド状態更新 | `updateThread` |
| 投票 | `createPullRequestReviewer` |
| 完了/中止 | `updatePullRequest`（Completed / Abandoned） |
| ユーザー解決 | `connect`（authenticatedUser） |

- 認証は **PAT ハンドラ**。
- クライアントは **設定＋PAT をキーにキャッシュ** し、同条件の間は再利用する
  （初回接続の resource-area ルックアップ往復を毎操作で払わないため）。設定や
  トークンが変われば透過的に新しいクライアントを作る。
- `GitApi` の取得 promise はメモ化する。取得失敗時はメモを捨て、次回リトライ
  できるようにする。

### スレッド状態の対応

| ReviewLens | ADO CommentThreadStatus |
|---|---|
| `active` | Active |
| `fixed` | Fixed |
| `wontFix` | WontFix |
| `closed` | Closed |
| `pending` | Pending |
| `byDesign` | ByDesign |

---

## 9. データモデル（要点）

- `PullRequestSummary` — 一覧用の軽量 PR 情報（id, title, author, project,
  repository, repositoryId, remoteUrl, source/target ブランチ, url）。
- `ReviewData` — `repositoryId` と base/head コミット、`ChangedFile[]`。
- `ChangedFile` — `path`, `previousPath?`, `status`, `hunks`, `viewed`,
  `riskScore`（AI 用予約・現状 null）。
- `Thread` / `Comment` / `Anchor` — コメント表現。`Anchor` は head 側の
  キャラクタ範囲＋再アンカリング用のコンテキスト情報。
- `FileStatus` = `added | modified | deleted | renamed`。
- `PrVote` = `approve | approveWithSuggestions | waitForAuthor | reject | reset`。

---

## 10. 永続化

| 種別 | ストア | スコープ |
|---|---|---|
| PAT | SecretStorage（`reviewlens.pat`） | グローバル・暗号化 |
| 既読 | workspaceState | PR 単位 |
| アンカースナップショット | workspaceState（`pr:<id>:anchors`） | PR・スレッド単位 |
| worktree 本体 + manifest | `<globalStorage>/worktrees/` | グローバル |
| コメント・投票・PR 状態 | Azure DevOps | リモート（信頼できる正） |

チームで共有される正式な記録（コメント・投票・承認・完了）はすべて ADO 側に
保存する。ローカルの永続値は手元の体験のための補助情報に限る。

---

## 11. 非機能・制約

- **言語/ビルド**：TypeScript、esbuild で `dist/extension.js` に単一バンドル。
  `tsc --noEmit` で型検査。
- **依存**：実行時依存は `azure-devops-node-api` のみ。
- **コードインテリジェンス**：影響分析・ローカルレビューは VS Code の言語
  サーバーに依存する。対応する拡張が無い言語では結果が限定的になる。
- **ローカルレビュー前提**：対象リポジトリのローカルクローンが必要
  （自動検出または `localRepoPath`）。
- **冪等・非破壊**：worktree は detached で利用者の作業ツリー・ブランチを
  変更しない。head の実ファイルはセッション中 read-only。
- **不可逆操作**：PR の完了・中止は実行前に確認する。

---

## 12. エラー処理方針

- 未設定・未サインインは **型付きエラー**（NotConfigured / NotSignedIn）で
  検出し、設定・サインインを促すメッセージを出す。
- ADO 取得失敗、影響分析失敗、ローカルレビュー失敗は、ユーザー向けの
  エラーメッセージを表示し、関連 UI は安全な空状態に戻す。
- ファイル内容取得が失敗・不存在のときは空文字として扱い、表示を壊さない。
