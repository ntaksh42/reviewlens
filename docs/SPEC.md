# ReviewLens — 仕様・設計書

> ステータス: **Draft v0.1**
> ワーキング名: `ReviewLens`（製品名・フォルダ名は変更可）
> 対象: Azure DevOps Repos のプルリクエストを VS Code 内でレビューする拡張機能

---

## 0. 確定している前提（決定ログ）

| # | 決定 | 理由 |
|---|------|------|
| D1 | **VS Code 拡張**として実装する | Grep・定義ジャンプ・LSP・blame をエディタ既存機能で賄え、自作は PR/diff/コメント層のみで済む |
| D2 | プロバイダは **Azure DevOps Repos 専用**（GitHub 等への抽象化はしない） | チームが ADO を利用。早すぎる抽象化を避ける（YAGNI） |
| D3 | **チーム中心** — コメントは全て ADO へ往復させる | レビュー結果はチームの資産。手元のみの分岐は持たない |
| D4 | **AI は後付け** — まずナビゲーションを固める | 中核価値はコード探索。AI は差し込み口だけ予約 |
| D5 | 中核の差別化は **影響範囲解析 / 周辺コード探索 / diff外行コメント** | ADO 純正・GitHub 公式拡張のいずれも弱い領域 |
| D6 | 認証は **PAT 主経路**（SecretStorage 保存）。Microsoft 認証プロバイダは採用しない | チーム運用が PAT。経路を一本化して単純化（OQ-2 解決） |
| D7 | MVP の書き込みは **コメント投稿のみ**。承認・投票・マージ等は Out。ただし**拡張シーム**を設計に内包し後付けを容易にする（§7.4） | ユーザー要望。今は作らないが追加箇所を局所化（過剰設計回避と両立） |
| D8 | base 取得は **ローカル `git show`（merge-base）主**、ADO diffs API をフォールバック | 速度・正確性。shallow clone 時のみ API 退避（§13, OQ-3 解決） |
| D9 | **提案編集（suggestion）を In Scope に**（Phase 1）。作成者が適用できる形式で ADO へ | ユーザー要望。ankitbko/GitHub 公式と同等のパリティ機能（差別化ではない） |
| D10 | **キーボード主導のレビュー操作を In Scope に**。diff/スレッド/影響範囲を横断するジャンプとアクション | ユーザー要望。横断キーフローは既存ツールが弱く、差別化候補（§19.2） |
| D11 | 実装は **C（新規構築）** を選択。ankitbko はフォークせず、ADO 固有実装（threadContext マッピング・PAT handler・iteration changes 等）の**参照**としてのみ用いる | ユーザー判断。アーキ純度・完全な理解・所有権を優先（調査の B 推奨を覆す決定）。§7 クリーン 4 層は全面有効 |
| D12 | **M1 の diff は ADO content API（読み取り専用の仮想ドキュメント）で表示**。ローカル checkout は M2（影響範囲解析が実ファイルを要する時点）まで遅延 | 使用感を最速で得るため。clone/PAT-git/保存先の重い配管を後ろ倒し。D8（base=git show）は checkout 導入時に有効化 |

---

## 1. 背景と目的

### 1.1 課題
既存の PR レビュー UI（ADO Web / 各種拡張）は **diff が世界の全て**になりがちで、
- 変更行の周辺コードを読みづらい
- 「この関数はどこから呼ばれているか」を追えない
- リポジトリ全体を Grep しながらレビューできない

結果、レビューが「diff の表面読み」に留まり、**変更の波及範囲の見落とし**が生まれる。

### 1.2 目的
diff を *入口* とし、そこからリポジトリ全体へ**コードナビゲーションとして**レビューできる体験を VS Code 内で提供する。レビュアーが「読む」のではなく「辿る」ことを支援する。

### 1.3 成功の定義（プロダクト視点）
- 変更シンボルから**ワンアクションで**定義 / 参照 / 呼び出し元 / Grep に到達できる
- 変更関数の呼び出し元のうち**今回触られていない箇所**を自動で提示できる
- diff に現れない周辺行にもコメントでき、それが ADO スレッドへ往復する

---

## 2. スコープ

### 2.1 In Scope（Phase 1–2）
- ADO PR の一覧・詳細表示
- PR ブランチのローカル取得（実ファイル化）
- base↔head の diff 表示（VS Code DiffEditor）
- インラインコメント（スレッド）の表示・作成・返信・解決、ADO への往復
- diff 外行へのコメント
- 影響範囲解析（呼び出し元ツリー、未変更呼び出し元の炙り出し）
- viewed 進捗 / ファイル並び替え
- 提案編集（suggestion ブロック）の作成・送信
- キーボード主導のレビュー操作（差分/ファイル/スレッド/影響範囲の横断ジャンプ）

### 2.2 Out of Scope（当面）
- GitHub / GitLab / Bitbucket 対応
- PR の作成・承認・マージなどの**書き込み系ワークフロー**（コメント以外）
- パイプライン / ビルド結果の表示
- AI 機能（Phase 3 で後付け。本書では差し込み口のみ定義）
- Web 版・スタンドアロン版

### 2.3 非目標（やらないと明言）
- diff レンダリングの自作（`vscode.diff` を使う）
- Grep / 定義ジャンプ / blame の自作（エディタ機能を使う）

---

## 3. 用語

| 用語 | 定義 |
|------|------|
| PR | Azure DevOps Repos のプルリクエスト |
| Iteration | ADO PR の「版」。push のたびに増える。コメントの版追従に使う |
| Thread | ADO のコメントスレッド。`threadContext` でファイル・行にアンカーされる |
| Base / Head | diff の左（マージ先の基準）/ 右（PR の変更後） |
| Hunk | diff の連続変更ブロック |
| Enclosing Symbol | あるコード行を囲む関数・メソッド・クラス（DocumentSymbol で取得） |
| Impact / 影響範囲 | 変更シンボルの呼び出し元・参照元の集合 |

---

## 4. ペルソナとユースケース

### 4.1 ペルソナ
- **レビュアー（主役）**: チームメンバーの PR を VS Code で受け取り、コードを辿りながら確認しコメントする。
- （将来）作成者: 自分の PR に付いたコメントを VS Code 内で確認・返信する。

### 4.2 主要ユースケース
- **UC-1** 割り当てられた PR の一覧を見て 1 件を開く
- **UC-2** PR をローカルに取得し、変更ファイルを diff で確認する
- **UC-3** diff 内のシンボルから定義・参照・呼び出し元へ飛ぶ
- **UC-4** 変更関数の「未変更の呼び出し元」を確認し、波及漏れを検知する
- **UC-5** 変更行／周辺の未変更行にコメントを書き、まとめて ADO へ送る
- **UC-6** 既存スレッドに返信し、解決済みにする
- **UC-7** レビュー済みファイルに viewed を付け、残りを把握する
- **UC-8** 作成者が再 push（新 iteration）した後、続きからレビューする

---

## 5. 機能要件（FR）

> 凡例: `[P1]`=Phase1 / `[P2]`=Phase2 / `[P3]`=Phase3

### 5.1 PR 取得・表示
- **FR-01 [P1]** 自分がレビュアーの ADO PR を一覧表示（リポジトリ・状態でフィルタ）
- **FR-02 [P1]** PR を選ぶと概要（タイトル・説明・作成者・iteration 数）を表示
- **FR-03 [P1]** PR ブランチをローカル取得し、ワークスペースを PR 状態（head）にする
- **FR-04 [P1]** 変更ファイルを TreeView で一覧（status: 追加/変更/削除/リネーム）

### 5.2 Diff
- **FR-05 [P1]** ファイル選択で base↔head の diff を `vscode.diff` で開く
- **FR-06 [P1]** base 側は仮想ドキュメント（`reviewlens:` スキーム）で供給
- **FR-07 [P2]** hunk から上下へ無制限にコンテキスト展開／フルファイル閲覧

### 5.3 コメント / スレッド
- **FR-08 [P1]** ファイルの ADO スレッドをインライン（エディタ内）表示
- **FR-09 [P1]** 任意の行にコメントを作成できる（**diff 外行を含む**）
- **FR-10 [P1]** コメントはローカルにドラフト保存し、一括 publish で ADO スレッド化
- **FR-11 [P1]** スレッドへの返信、status 変更（active/fixed/closed 等）
- **FR-12 [P2]** スレッドの絞り込み（自分宛・未解決・ファイル別）
- **FR-23 [P1]** 提案編集（suggestion ブロック）を作成し、作成者が適用できる形式で ADO スレッドへ送信

### 5.4 ナビゲーション / 影響範囲
- **FR-13 [P1]** diff 上のシンボルからエディタ標準の定義ジャンプ・参照検索が効く（実ファイル化の副産物）
- **FR-14 [P1]** レビュー中にリポジトリ全体を Grep（検索ビュー）できる
- **FR-15 [P2]** 各変更 hunk の Enclosing Symbol を特定する
- **FR-16 [P2]** 変更シンボルの呼び出し元ツリーを "Impact" パネルに表示
- **FR-17 [P2]** 呼び出し元を「PR 内で変更済み」「PR 外＝未変更」で色分けし、未変更を強調
- **FR-18 [P2]** LSP 不在時は Grep ベースのシンボル名検索にフォールバック

### 5.5 レビュー進行
- **FR-19 [P2]** ファイル単位の viewed フラグ（永続化）
- **FR-20 [P2]** 新 iteration 検知時、再変更されたファイルの viewed のみリセット
- **FR-21 [P2]** ファイル並び替え（ADO 順／論理順=変更ファイル間の import 依存順）

### 5.6 AI（差し込み口のみ）
- **FR-22 [P3]** PR 要約・hunk 説明・riskScore 算出（後付け）

### 5.7 キーボードナビゲーション（差別化候補 / D10）
レビューを「マウスで読む」から「キーで辿る」へ。全て `contributes.keybindings` + コマンドで提供し、`when` 句でレビュー中のみ有効化する。既定バインドは衝突回避のため**プレフィックスキー**（例 `Alt+;` を起点としたチョード）を基本とし、ユーザーが再割当可能。

- **FR-24 [P1]** 次/前の**変更ハンク**へジャンプ（diff エディタ内）
- **FR-25 [P1]** 次/前の**変更ファイル**へジャンプ（viewed 済みはスキップするモードを持つ）
- **FR-26 [P2]** 次/前の**コメントスレッド**へジャンプ（未解決のみ等のフィルタと連動）
- **FR-27 [P2]** 次/前の**未変更呼び出し元（影響範囲）**へジャンプ（§15 と連動）
- **FR-28 [P1]** カーソル位置で**コメント追加 / スレッド解決 / viewed トグル**をキー一発で
- **FR-29 [P2]** **提案編集の作成**（選択範囲を suggestion 化）をキーで
- **NFR 連動**: 全アクションはコマンドパレットからも実行可能（キーバインドは薄いラッパ）。

> 設計方針: ジャンプ系は「現在のレビュー文脈（開いている PR の変更集合・スレッド集合・影響範囲）」を保持する単一の **NavigationCursor** を介す。各 FR-24〜27 はカーソルの move(next/prev, scope) を呼ぶだけにし、スコープ（hunk/file/thread/impact）を差し替え可能にする。

---

## 6. 非機能要件（NFR）

- **NFR-1 性能**: 変更 200 ファイル規模の PR でも一覧・diff 表示が体感即時。Impact 解析は対象シンボル単位で遅延実行（全件先行計算しない）。
- **NFR-2 信頼性**: ネットワーク断・LSP 未起動・認証失敗で**機能縮退**し、拡張全体は落とさない（§13）。
- **NFR-3 セキュリティ**: トークンは SecretStorage のみ。ログ・テレメトリに秘密情報を出さない（§14）。
- **NFR-4 オフライン耐性**: ドラフトコメント・viewed はローカル永続化し、再接続後に同期。
- **NFR-5 可観測性**: ADO API 呼び出しを OutputChannel にデバッグ出力（秘密情報マスク）。
- **NFR-6 互換性**: VS Code 安定版の直近 N バージョン。ADO REST は api-version を固定。

---

## 7. システムアーキテクチャ

### 7.1 レイヤー構成

```
┌──────────────────────────────────────────────────────────┐
│ UI 層 (VS Code contributes)                               │
│  PR一覧TreeView / 変更ファイルTreeView / DiffEditor       │
│  CommentController(インラインスレッド) / Impact TreeView  │
│  概要 WebView                                             │
├──────────────────────────────────────────────────────────┤
│ アプリケーション層 (ユースケース)                         │
│  ReviewSessionService / CommentService / ImpactService    │
│  NavigationService / ReviewProgressService                │
├──────────────────────────────────────────────────────────┤
│ ドメイン層 (モデル・状態遷移)                             │
│  ReviewSession / ChangedFile / Thread / Comment / Anchor  │
├──────────────────────────────────────────────────────────┤
│ インフラ層 (外部 I/O)                                     │
│  AdoClient(REST) / AuthProvider(PAT, SecretStorage)       │
│  GitGateway(vscode.git) / VirtualDocProvider             │
│  LspGateway(executeXxxProvider) / StateStore(workspaceState)│
└──────────────────────────────────────────────────────────┘
```

### 7.2 依存方向
UI → アプリ → ドメイン ← インフラ。ドメインは VS Code API / ADO API に依存しない（テスト可能性のため）。インフラがドメインのインターフェースを実装する。

### 7.3 主要コンポーネント責務
- **AdoClient**: ADO REST のラッパ。PR・iteration・changes・threads。api-version 固定、リトライ・レート制御。
- **AuthProvider**: PAT を SecretStorage に保存し Basic 認証ヘッダで使用。失効時は再入力を促す。
- **GitGateway**: `vscode.git` 経由で fetch / checkout / merge-base / `show`。
- **VirtualDocProvider**: `reviewlens:` スキームの base 版コンテンツを `git show` で供給。
- **LspGateway**: `executeDocumentSymbolProvider` / `prepareCallHierarchy` / `provideIncomingCalls` / `executeReferenceProvider` のラッパと縮退制御。
- **StateStore**: ドラフト・viewed・並び順を workspaceState に PR 番号キーで永続化。

### 7.4 拡張シーム（書き込み系の後付け / D7）

承認・投票・マージ等は **MVP では作らない**が、追加時に変更が 3 箇所に閉じるよう構造だけ用意する。新しい抽象レイヤは導入しない（必要になってから追加）。

| 追加要素 | 既存のどこに足すか | MVP 時点の状態 |
|----------|--------------------|----------------|
| ADO 書き込み呼び出し（vote/complete/abandon 等） | `AdoClient` にメソッド追加 | コメント POST/PATCH で**書き込み経路は実証済み**。同じ流儀で増やすだけ |
| ユースケース（承認する/マージする） | アプリ層に `PrActionService`（未作成）を新設 | プレースホルダのみ。`CommentService` と同列に並ぶ想定 |
| UI 起点（ボタン/コマンド） | PR 概要 WebView + コマンドパレット | コメント送信ボタンと同じ contributes 流儀で追加 |

- **やらないこと**: 「将来の承認フロー」を見越したインターフェース化や状態機械の先行実装。ドメインモデル（§8）は書き込み系を含めない。
- **守ること**: 書き込みは必ず `AdoClient` を通す（UI/サービスから直接 REST を叩かない）。これだけ守れば後付けが局所化される。

---

## 8. ドメインモデル

```
ReviewSession              // 1 PR のレビュー単位
  prId, repositoryId, projectId
  baseSha, headSha, currentIterationId
  files: ChangedFile[]
  threads: Thread[]        // ADO 由来 + ローカルドラフト
  progress: ReviewProgress

ChangedFile
  path, previousPath?      // リネーム対応
  status: Added|Modified|Deleted|Renamed
  hunks: Hunk[]
  viewed: boolean
  riskScore: number|null   // Phase3 まで null（予約）

Hunk
  baseRange: LineRange     // 左
  headRange: LineRange     // 右

Thread
  id: string|null          // null = 未publishのローカルドラフト
  anchor: Anchor|null      // null = ファイル/PR全体コメント
  status: active|fixed|wontFix|closed|pending|byDesign
  comments: Comment[]
  iterationId              // どの版に対するか
  isDraft: boolean

Comment
  id, author, content, publishedAt
  inReplyToId?

Anchor                     // ADO threadContext に対応
  filePath
  side: left|right
  start: { line, offset }
  end:   { line, offset }
  contextHash              // 再アンカリング補助（§9.3）

ReviewProgress
  viewedPaths: Set<path>
  fileOrder: ado|logical
  lastSeenIterationId
```

> ドラフト（`id=null, isDraft=true`）と公開済みを同一型で扱い、publish 時に ADO の thread id を採番。

---

## 9. 状態遷移

### 9.1 ReviewSession ライフサイクル
```
[未取得] --open--> [取得中] --checkout完了--> [レビュー中]
[レビュー中] --新iteration検知--> [再同期] --> [レビュー中]
[レビュー中] --close--> [終了]
```

### 9.2 Thread / Comment
```
ドラフト作成: (none) --add comment--> [Draft(id=null)]
publish:      [Draft] --POST threads--> [Active(id採番)]
返信:         [Active] --POST comment--> [Active]
解決:         [Active] --status=fixed/closed--> [Resolved]
再オープン:   [Resolved] --status=active--> [Active]
```

### 9.3 再アンカリング（新 iteration 時）
- 一次手段: ADO の **iteration 比較**（`iterationContext`）でコメント版追従に委ねる。
- 補助: アンカー行の `contextHash`（アンカー行＋前後数行のハッシュ）で近傍再探索。一致しなければ **outdated** 表示にしてインライン位置をファイル末尾近傍へ退避。
- viewed: 再変更ファイルのみ false に戻す（FR-20）。

---

## 10. 外部インターフェース

### 10.1 認証（PAT 主経路 / D6）
```
方式: Personal Access Token (PAT) を SecretStorage に保存
利用: Authorization: Basic base64(":" + PAT)
スコープ: Code (Read & Write) — コメント往復に必要な最小
保存: ExtensionContext.secrets（設定ファイル・state・ログには出さない）
```
- 初回はコマンドで PAT 入力を促し SecretStorage へ。
- 401/403 を検知したら失効とみなし、再入力フローへ誘導。
- Microsoft 認証プロバイダ（AAD）は採用しない。将来必要になれば AuthProvider 内で経路を追加できるが、現状はインターフェース化しない（YAGNI）。

### 10.2 Azure DevOps REST（api-version 固定予定）
| 操作 | エンドポイント（概形） |
|------|------------------------|
| PR 一覧 | `GET {org}/{project}/_apis/git/repositories/{repo}/pullRequests` |
| PR 詳細 | `GET .../pullRequests/{prId}` |
| iteration 一覧 | `GET .../pullRequests/{prId}/iterations` |
| 変更ファイル | `GET .../pullRequests/{prId}/iterations/{it}/changes` |
| base↔head diff | `GET .../diffs/commits?baseVersion=&targetVersion=` |
| スレッド取得/作成 | `GET/POST .../pullRequests/{prId}/threads` |
| コメント返信 | `POST .../threads/{threadId}/comments` |
| スレッド更新(status) | `PATCH .../threads/{threadId}` |

> ⚠ 実装着手時に各エンドポイントの request/response 実形と api-version を最新ドキュメントで確定する（§16 OQ-1）。

### 10.3 VS Code API
| 機能 | API |
|------|-----|
| PR/ファイル一覧 | `window.createTreeView` (TreeDataProvider) |
| diff | `commands.executeCommand('vscode.diff', baseUri, headUri, title)` |
| base 仮想ドキュメント | `workspace.registerTextDocumentContentProvider('reviewlens', …)` |
| インラインコメント | `comments.createCommentController` + `CommentingRangeProvider` |
| 概要 | `window.createWebviewPanel` |
| Git | `extensions.getExtension('vscode.git').exports.getAPI(1)` |
| シンボル | `commands.executeCommand('vscode.executeDocumentSymbolProvider', uri)` |
| 呼び出し階層 | `vscode.prepareCallHierarchy` → `vscode.provideIncomingCalls` |
| 参照 | `commands.executeCommand('vscode.executeReferenceProvider', uri, pos)` |
| 秘密保存 | `ExtensionContext.secrets` (SecretStorage) |

### 10.4 コメント可能範囲（diff 外行対応の肝）
`CommentingRangeProvider` でコメント可能行を**全行**返す。ADO `threadContext` は任意行アンカーを許すため、diff 外行コメントもそのまま往復できる（GitHub のような diff 行制約はない）。

---

## 11. 主要シナリオのシーケンス

### 11.1 PR を開いてレビュー開始（UC-1,2）
```
User → PR一覧TreeView: PR選択
TreeView → ReviewSessionService: open(prId)
Service → AdoClient: PR詳細 / iterations / changes 取得
Service → GitGateway: fetch + checkout(headSha)
Service → AdoClient: threads 取得
Service → StateStore: ドラフト/viewed 復元
Service → UI: 変更ファイルTreeView 構築
```

### 11.2 diff 外行にコメントして publish（UC-5）
```
User → DiffEditor: 未変更行で「コメント追加」
CommentController → CommentService: addDraft(anchor=その行, side=right)
CommentService → StateStore: ドラフト保存
…(複数追加)…
User → 「レビュー送信」
CommentService → AdoClient: POST threads(threadContext付き) を順次
AdoClient → CommentService: thread id 採番
CommentService → UI: ドラフト→公開表示へ更新
```

### 11.3 影響範囲解析（UC-4）
```
User → Impactパネル: 変更ファイルを展開
ImpactService → LspGateway: executeDocumentSymbolProvider(file)
ImpactService: 各hunk範囲を含む Enclosing Symbol を抽出
ImpactService → LspGateway: prepareCallHierarchy → provideIncomingCalls
ImpactService: 呼び出し元を PR内変更/PR外 で分類
ImpactService → UI: ツリー表示（PR外=強調）
(LSP不在時) → GitGateway/ripgrep: シンボル名テキスト検索にフォールバック
```

---

## 12. 永続化と状態管理

| データ | 保存先 | キー | 寿命 |
|--------|--------|------|------|
| ドラフトコメント | `workspaceState` | `pr:{prId}:drafts` | publish まで |
| viewed 進捗 | `workspaceState` | `pr:{prId}:viewed` | PR クローズまで |
| 並び順設定 | `workspaceState` | `pr:{prId}:order` | 〃 |
| 最終 iteration | `workspaceState` | `pr:{prId}:lastIteration` | 〃 |
| トークン/PAT | `SecretStorage` | `reviewlens.token` | 失効まで |

> ドラフトはチームへ出る前の手元データ。workspaceState によりエディタ再起動後も保持。

---

## 13. エラー処理と縮退

| 事象 | 振る舞い |
|------|----------|
| 認証失敗/失効 | サインインを促す。レビュー UI は読み取り専用で可能な範囲を表示 |
| ネットワーク断 | ドラフト・viewed はローカルで継続。送信はキュー化し再接続で再試行 |
| LSP 未起動/未対応言語 | Impact・定義ジャンプは Grep フォールバックに切替（FR-18） |
| base 取得失敗（shallow clone 等） | full fetch を促す。diff は ADO の diffs API 表示にフォールバック |
| 新 iteration 競合 | 再同期し、ずれたコメントを outdated 表示（§9.3） |
| publish 一部失敗 | 成功分を確定、失敗分はドラフトに戻し理由表示。冪等化（重複 thread を作らない） |

---

## 14. セキュリティ

- トークン/PAT は **SecretStorage のみ**。設定ファイル・workspaceState・ログに出さない。
- OutputChannel ログはトークン・Authorization ヘッダをマスク。
- ADO 組織/プロジェクト URL 以外の外部送信をしない（AI 導入時は別途同意フロー）。
- PAT スコープは最小（Code: Read & Write / PR: 読み書き）を案内。
- 仮想ドキュメント/checkout は対象リポジトリ内に限定。

---

## 15. 影響範囲解析 詳細設計（中核差別化）

### 15.1 目的
変更関数の**呼び出し元のうち今回手が入っていない箇所**を提示し、波及漏れを検知する。

### 15.2 アルゴリズム
```
入力: ChangedFile[]（PR の変更集合）
1. 各 file について executeDocumentSymbolProvider → DocumentSymbol ツリー
2. 各 hunk.headRange を含む **最も外側の名前付き callable**（関数/メソッド/コンストラクタ）= Enclosing Symbol を収集。callable に当たったら内側のクロージャには降りない（無名コールバックは呼び出し元 0 件で無意味 — スパイク §19.4 の学び）。class/namespace 等の非 callable コンテナは通過して内部の method へ降りる
3. 各 Enclosing Symbol の定義位置で:
     prepareCallHierarchy → provideIncomingCalls → 呼び出し元 Location[]
4. 呼び出し元を分類:
     - from.uri/range が PR の変更集合に含まれる → "変更済み"
     - 含まれない                              → "未変更"（強調対象）
5. 遅延展開: 呼び出し元のさらに上位はユーザー展開時に再帰取得
```

### 15.3 表示
- "Impact" TreeView: `変更シンボル ▸ 呼び出し元(未変更) / 呼び出し元(変更済み)`
- 未変更呼び出し元はアイコン/色で強調。クリックで該当箇所へジャンプ。

### 15.4 縮退
- LSP 不在: シンボル名を ripgrep 検索し候補を「未確定の呼び出し元候補」として表示（精度注記付き）。
- 巨大 PR: シンボル単位の遅延実行で先行全計算を避ける（NFR-1）。

### 15.5 限界（明記）
- 動的ディスパッチ・リフレクション・文字列経由呼び出しは LSP が追えない場合がある。
- あくまで**レビュー補助**であり網羅保証はしない旨を UI に明記。

---

## 16. 未決事項・オープンクエスチョン

| ID | 内容 | 影響 | 仮置き |
|----|------|------|--------|
| ~~OQ-1~~ | ADO REST 各 API の実形・api-version 固定値 | 実装直前に確定 | **解決**: 実拡張が PAT 認証で DashboardDemo の 7 PR を表示。getPullRequestsByProject とフィールドマッピングを実機確認 |
| OQ-9 | 組織 `aksh0402` は **MSA(個人 MS アカウント)backed** → AAD bearer は TF400813 で弾かれる | 認証 | **PAT 必須**（D6 を補強）。az AAD トークンでの検証は不可、PAT で実施 |
| ~~OQ-2~~ | **解決(D6)**: 認証は PAT 主経路に確定 | — | 済 |
| ~~OQ-3~~ | **解決(D8)**: base はローカル `git show`(merge-base) 主・ADO diffs API フォールバック | — | 済 |
| OQ-4 | 論理順（import 依存）算出の対象言語と精度 | FR-21 | Phase2 後半で実証 |
| OQ-5 | iteration 比較に寄せる vs 自前 contextHash の比率 | 再アンカリング | ADO 優先・補助で hash |
| OQ-6 | 大規模 PR（数百ファイル）の TreeView 仮想化要否 | 性能 | 計測後判断 |
| ~~OQ-7~~ | 進め方（差別化スパイク先行 / ankitbko フォーク / 新規構築） | プロジェクト全体 | **決定: C 新規構築（D11）**。A 検証成功・調査では B 推奨だったがユーザーは C を選択。ankitbko は参照のみ |
| OQ-8 | 提案編集の ADO 上での表現と「適用」経路（ADO は GitHub のネイティブ suggestion UI を持たない） | FR-23 | ankitbko 方式（拡張側で diff 化して適用、ADO Web には出ない）を要調査 |

---

## 17. リスク

- **R1** ADO REST の差異・権限まわりで実装が膨らむ → 早期に薄い AdoClient で疎通検証（スパイク）。
- **R2** LSP 依存機能の言語差 → フォールバックを最初から設計に内包済み（FR-18）。
- **R3** ADO 純正/既存拡張との重複価値が薄いと見られる → 中核を「影響範囲解析＋周辺探索」に明確化（§5.4, §15）。

---

## 18. マイルストーン

```
M0 骨組み＋疎通 : [完了] 拡張スケルトン(4層)・PAT認証・AdoClientでPR一覧
                   - [済] プロジェクト生成(TS+esbuild)、build/typecheck/audit クリーン、F5可能
                   - [済] domain/app/infra/ui の4層、PAT(SecretStorage)、PR一覧TreeView
                   - [済] @vscode/test-electron で起動検証: 実VS Code(1.124.2)でアクティベート・
                         コマンド/ビュー登録・refresh実行を自動アサート（5 passing, exit 0）
                   - [済] 実ADO疎通: org=aksh0402 / project=DashboardDemo で PR #61〜67 の7件を表示。
                         PAT認証・getPullRequestsByProject 確認 → OQ-1 解決
                   注: test専用依存(mocha→diff/serialize-javascript)に dev-only 脆弱性3件。
                       出荷バンドルには非混入のため据え置き。
M1 Phase1 MVP   : FR-01〜14,23 — 取得・diff・コメント往復（diff外含む）・suggest
   M1a [済] PRクリック→変更ファイル一覧(iteration changes)→ファイルクリックで diff
            (base↔head, ADO content API + 仮想ドキュメント / D12)。build/typecheck/test 通過
   M1b [次] コメント/スレッド（表示・作成・diff外・draft→publish）
   M1c [後] viewed・suggest
M2 Phase2       : FR-15〜21,24〜29 — 影響範囲解析・viewed・並び替え・キーボードナビ
M3 Phase3       : FR-22 — AI 後付け（要約・risk・hunk説明）
```

---

## 19. 関連実装と差別化

### 19.1 `ankitbko/vscode-pull-request-azdo`（2026-06 実地調査）
- 正体: GitHub 公式 PR 拡張の Azure DevOps 移植フォーク。README の「2020 サイドプロジェクト」表記は古く、**実態は活発に保守されている**。
- 保守状況: 既定ブランチ `master`、2040 commits、v1.0.2、87 stars / 28 forks、open issues 40。2025-03 に revamp(#105)、**最新コミット 2025-06**。
- 健全性（実測）: `engines.vscode ^1.97.0`、`azure-devops-node-api ^10.1.2`、webpack 5.97 + esbuild。Node 24 / npm 環境で **`yarn install` 成功、`yarn compile` 成功**（約10秒・エラー0・lint warning のみ）。
- 設計の一致: 認証は **PAT（`getPersonalAccessTokenHandler`）＋AAD bearer 両対応＝D6 と一致**。azdo 層がモジュール分離（`credentials` / `azdoRepository` / `pullRequestModel` / `prComment`）＝§10.2 と一致。`CommentController` + `CommentingRangeProvider` + `threadContext` 実装済み。**viewed・suggested edits・review checkout（実ファイル化）実装済み**＝影響範囲解析の前提を満たす。
- 欠けているもの＝そのまま我々の差別化スロット: 影響範囲解析（`prepareCallHierarchy` 無し）、キーボードナビ（keybindings 契約無し）、AI。コメント可能範囲は `getFileChanges()` で変更スコープに限定＝**diff 外行コメントは当該箇所を緩める局所改修で実現可**。

### 19.2 重複と差別化の正直な切り分け
- **Phase 1 全体（FR-01〜14）は ankitbko と実質重複。** リポジトリ全体 Grep・定義ジャンプも「checkout の副産物」であり、checkout する ankitbko でも同様に効く ⇒ **差別化ではない**。
- ReviewLens の固有価値は次の 4 点に集約される:
  1. **影響範囲解析**（FR-15〜18, §15）— 変更関数の*未変更の呼び出し元*の炙り出し。ankitbko/GitHub 公式ともに無い。
  2. **diff 外行コメントの一級 UX**（FR-09）— ADO `threadContext` の任意行アンカーを活かす。
  3. **キーボード主導のレビューフロー**（FR-24〜29, §5.7）— diff/ファイル/スレッド/影響範囲を横断するジャンプとアクション。既存ツールは断片的（候補）。
  4. **AI**（FR-22, Phase 3）。
- **パリティ（差別化ではないが揃える）**: 提案編集（FR-23）。ankitbko/GitHub 公式が持つ表機能で、無いと見劣りするため In Scope（D9）だが、ここで勝つわけではない。
- 含意: **Phase 1 に独自実装の労力を投じる価値は低い**。差別化（影響範囲解析）は PR 配管から独立して検証可能（変更ファイル集合 + LSP のみで動く）。

### 19.3 取り得る方針（§16 OQ-7）
- **A. 差別化先行スパイク** ← **選択（実装済み: `spike/`）**: 影響範囲解析を最小拡張で単体試作し価値検証 → その後に Phase 1 の作り方（B/C）を決める。
- **B. ankitbko をフォーク**: Phase 1 を再利用し Phase 2 を載せる。最速で統合形だが、GitHub 拡張由来の大型フォークの理解・保守コスト、AAD 前提との差を負う。
- **C. SPEC 通り新規構築**: クリーン 4 層・PAT・ADO 専用を貫く。理解とアーキは最良だが Phase 1 を再発明。

### 19.4 スパイク検証結果（方針A・成功）
- 対象: `reviewlens-sample`（TypeScript、`feature/tax` で `computeTotal` に税引数追加・`cart.ts` のみ更新）。
- 結果: Impact ツリーが意図通り出力。
  - `computeTotal` ▸ ⚠ `renderInvoice (invoice.ts)` / ⚠ `monthlyReport (report.ts)` / ✓ `checkout (cart.ts)`
  - `checkout` ▸ ⚠ `index.ts:11`
- **結論: 差別化（未変更呼び出し元の炙り出し）は実用価値あり。** diff に現れない波及を正確に指せた。PR 配管から独立して動くことも確認。
- スパイクで判明した設計上の学び:
  1. **Enclosing Symbol は「最も深い callable」ではなく「最も外側の名前付き callable」を取る**。無名クロージャ（reduce コールバック等）に降りると呼び出し元 0 件の無意味なノードになる（修正済み）。本実装（§15.2）に反映必要。
  2. 呼び出し元の「変更/未変更」判定は呼び出し*箇所行*の含有で近似。実装では呼び出し元*関数*単位の判定に精緻化余地（§15 限界に追記候補）。
  3. LSP（Call Hierarchy）依存は想定通り。TS 標準サーバーで良好に動作。

### 19.5 フォーク健全性調査の結論 → 推奨: B（ankitbko フォーク）
- ankitbko は「**健全・活発・我々と同一スタック（PAT + azure-devops-node-api）・Phase 1 を実装済み・現行ツールチェーンでビルド可**」と実測で確認。
- 我々の 4 差別化（影響範囲解析 / キーボードナビ / diff 外コメント / AI）は全て未実装＝衝突なく上載せできるクリーンなスロット。**実ファイル checkout 済み**のため、スパイクで実証した影響範囲解析がそのまま動く。
- トレードオフ: 本 SPEC §7 のクリーン 4 層は Phase 1 には適用されない。新規モジュール（影響範囲解析・NavigationCursor・diff 外コメント）にのみクリーン設計を適用し、Phase 1 は ankitbko の既存構造に従う。SPEC は「要件・差別化の定義書」として有効、§7–8 の一部は新規モジュール限定の指針に降格。
- C（新規）の利点（アーキ純度）は、スパイクで「差別化は配管から独立」と判明した今、**Phase 1 再実装コスト（認証/PR一覧/checkout/diff/コメント往復/viewed/suggest）に見合わない**。
- 調査用 clone: `repos/_eval-ankitbko`（depth 1・ビルド済み）。B 採用なら、正式フォークを作って full clone し直すか、これを土台に昇格。

### 19.6 最終決定: C（新規構築）— ankitbko は参照のみ
- ユーザーは調査の B 推奨を覆し **C を選択**（D11）。理由: アーキ純度・完全な理解・所有権。
- 帰結: §7 クリーン 4 層・§8 ドメインモデルは**全面有効**（B 想定の降格は取り消し）。Phase 1 も自前実装。
- ankitbko の使い方: フォークしない。ADO 固有の解き方を**読むための参照**に留める。特に有用な参照ポイント:
  - `src/azdo/credentials.ts` — PAT/Bearer ハンドラ、orgUrl/projectName/patToken 設定
  - `src/azdo/azdoRepository.ts` — azure-devops-node-api の呼び方
  - `src/azdo/pullRequestModel.ts` / `src/view/reviewCommentController.ts` — threadContext マッピング、コメント往復
  - `src/common/commentingRanges.ts` — コメント可能範囲（我々は全行許可に拡張する）
- ライセンス留意: 参照に留め、コードのコピーは行わない（必要時はライセンスを確認）。

---

## 付録 A: 決定が必要になった時点で見直す項目
- マルチプロバイダ化（GitHub 等）は D2 を覆す要望が出たら再検討（インフラ層の AdoClient をインターフェース化）。
- 書き込み系ワークフロー（承認・マージ）は Out of Scope を解除する判断が出たら追加。
