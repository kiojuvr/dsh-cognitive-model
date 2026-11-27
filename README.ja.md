# dsh-cognitive-model

**目的・現在地・まだ開いている作業**をセッションをまたいで運ぶ、ワークスペース単位のグラフ。そして、セッションが始まるときに読む想起ブロック。エージェントが証拠つきで書き、次のセッションが作業を始める前に読む。同じグラフが「認知」タブに描かれる。

> English: [README.md](README.md)

## なぜ必要か

長いプロジェクトは1つのセッションを越えて続く——何十回ものセッションにまたがることもある。次のセッションは、目的も、すでに下された決定も、まだ開いている作業も知らないまま始まる。すでに決着したことを再導出し、同じ失敗を繰り返し、目の前のタスクに最適化して、本当のゴールを見失う。

モデルは、次の判断のための材料を会話の外に保ちます:

- **構造** — 目的 → 手段 → タスク。仕事が何のためで、どう分解されるか。
- **認識の記録** — 決定、制約、リスク、事実、選好。何が決着し、何を信じてよいか。
- **世界モデル** — 実体、`part_of` / `owned_by` / `located_in`。仕事が何でできていて、誰が持っているか。
- **経験** — 予測誤差と、そこから蒸留した条件付きの規則。

狙いは記憶を大きくすることではなく、次に決めることが目的を指したままであることです。

finding はノードではない。`@kioju/dsh-cognitive-findings` の後回しキューの項目で、属するノードを指し返します。

## 何が得られるか

- 次のセッションがゼロではなく、目的から始まる。
- 決定・制約・検証済みの事実が、それを支える証拠とともにセッションを越えて残る。推測は拒否される。
- エージェントは開始時だけでなく、毎ステップで目的 → パス → 現在 → 残りを見る。
- 同じ材料が「認知」タブであなたにも見える（dashboard を入れてください）。
- グラフは作業を止めない。拒否された書き込みは報告され、作業は続く。

効くのは、仕事がセッションをまたぎ、あなたかエージェントのどちらかが目的を再構成しなければならないときです。単発の短いタスクでは、グラフはオーバーヘッドです。次のセッションがゼロから始まってしまうほど長い仕事のときに導入してください。

## そうではないもの

- **ゲートではない。** どのツールも作業を止めず、グラフが続行を拒否することもない。拒否された書き込みは報告され、作業は続く。
- **ドリフト検出器ではない。** 俯瞰の確認は、仕事が目的からずれたかどうかを判定しない。記録された予測誤差が目的・受入項目・優先度を問い直すとき、読み手に再確認を促すだけです。「続行」は普通の答えです。
- **グラフデータベースではない。** 有界のトラバーサルと1つの真偽フィルタ代数以上のクエリはなく、インデックスもバックグラウンド保守もない。文書はワークスペースの隣の JSON ファイル1つです。
- **証拠の代わりではない。** 書き込みには証拠が要る。読んだファイル、実行したコマンド、url、人間の言葉。推測は拒否され、`agent_inference` は決して永続化されない。
- **承認システムではない。** 承認は DSH が持つ。ここに第二の権威はない。
- **会話の第二の履歴ではない。** セッションで起きたことではなく、意図して書いた構造を記録する。

## インストールすると何が起きるか

- 4つのツール: `graph_write`、`graph_retract`、`graph_query`、`graph_history`。
- セッションを越えて残すべきものと、記録してはいけないものを告げる常時指示。
- プロンプトごとに組み立てられる**想起ブロック**: 目的、現在のパス、現在、残り、マップ、制約、決定、リンクされた事実、経験則、そして記録された誤差が求めたときの1回だけの拘束力のない全体確認。
- ワークスペースごとに1つの追記専用イベントログ: `.dsh/cognitive-model/graph.json`。状態は保存されず、投影される。

## インストール

DSH で **Plugins** を開き、**Add plugin** を選び、`@kioju/dsh-cognitive-model` を入力します。シェルからなら:

```
dsh plugin add @kioju/dsh-cognitive-model
```

追加した時点で有効になります。**Plugins** でオフならオンにしてください。

パッケージはそれ自体が bundle（`dsh.bundle.patch`）で、`@kioju/dsh-cognitive-core` は通常の依存として入ります。チェックアウトもビルドも、パッケージの隣に何かを置く必要もありません。

このグラフを描く**「認知」タブ**は `@kioju/dsh-cognitive-dashboard` です。エージェントが見ているものを見るために、こちらも入れてください:

```
dsh plugin add @kioju/dsh-cognitive-dashboard
```

`@kioju/dsh-cognitive-findings` は任意で、範囲外の findings の後回しキューを追加します。各プラグインは独立しています。

## 最初の5分

グラフは空から始まります。何かが書かれるまで、想起ブロックは空で、「認知」タブは **No objective is recorded yet**（目的がまだ記録されていません）と表示します。これは設計された開始で、失敗ではありません。プラグインは会話から目的を推測しません。

目的はあなたの意図なので、あなた自身が述べてください。1文で十分です:

> この仕事の目的は「<1文>」です。認知グラフに `objective` として記録し、今の作業を `task/current`、他の残っている作業を `task/<key>` として記録してください。目的の根拠はこのメッセージで構いません。リポジトリは component と task を埋めるためだけに読んでください。何を書いたか1行で教えてください。

プラグインは `package.json` を作成も変更もしません。グラフを `.dsh/cognitive-model/graph.json` に保存するだけです。パッケージのマニフェストは component や task を見つける助けにはなりますが、目的を定義するものではありません。人間の言葉も証拠です。目的は `reported` として記録され、検証済みの事実としては記録されません。

書き込みのあと、次のプロンプトには、こんなブロックが載ります（抜粋）:

```
Working memory for this workspace, projected from the event log — build on it instead of re-deriving it:
Objective: Publish a searchable documentation site — offline search is the acceptance bar [tasks: 2] (reported)
Path: objective → component/search
Now: Add a search index (reported, unverified)
Remaining:
- [objective] Deploy the site
Map:
  - Search — Index published pages [tasks: 1]
  - Publishing — Build and deploy the site
Constraints:
- Search must work without sending queries to a third-party service
Decisions:
- Build the search index at publish time
Experience (rules distilled from earlier prediction errors; conditional and revisable, not a rule for this case):
- [better] use the incremental build (repo; when only a few source files changed): run the incremental build before a full rebuild — 2 observation(s) (pre_…, pre_…), observed [for component/search]
Prediction errors: 12 recorded (graph_query errors=true).
```

そしてタブがツリーを描きます。以降はエージェントが仕事の移動に合わせて現在地を更新します。あなたが毎セッション目的を言い直す必要はありません。

何も出ないなら:

1. **Plugins** でプラグインが有効か。
2. セッションは意図したリポジトリにあるか。グラフはプロジェクトルート単位——`.git` を持つ最も近い祖先——です。
3. 書き込みに証拠があったか。証拠（ファイル、コマンド、url、人間の言葉）のない書き込みは設計上拒否されます。
4. ランタイムコンテキストが抑制されていないか。想起ブロックは任意のコンテキスト節なので、ランタイムコンテキストをオフにしたプロファイルでは表示されません。

## エージェントはどう使うか

### 何を記録するか

| いつ | 何を書くか | なぜ |
|---|---|---|
| 仕事が始まる、または目的が合意された | `objective` と、`serves` を持つ `component` | 次のセッションに全体像が要る |
| 決定が下された | `decision` と `node` 辺 | 次のセッションが蒸し返さないように |
| 制約が見つかった | `constraint` | 越えてはいけない境界 |
| 事実が検証された | `fact` と `node` 辺 | リンクされた事実だけが想起ブロックに届く |
| 現在の作業が動いた | `task/current` | 「Now」の行 |
| 他の作業がまだ開いている | `task/<key>` | 「Remaining」の行 |
| 期待が現実と違った | `errors` と `direction`、証拠 | 1回だけの確認と較正 |
| 規則が蒸留された | `heuristic` と `errorIds` | 経験であり、一度きりのメモではない |

`label` は次の読み手が見る行で、`value` は名前だけでは足りない情報を足します。タスクでは、value は作業がどこまで進み、次に何が未確認かを示す——終わったことではない。

### 何を記録しないか

- 仕事そのもの——やる。
- 推測——証拠がないので拒否される。
- 会話——これはトランスクリプトではない。

### 最初の書き込み

```json
{
  "nodes": [
    { "id": "objective", "type": "objective", "label": "Publish a searchable documentation site", "value": "Offline search is the acceptance bar" },
    { "id": "component/search", "type": "component", "label": "Search", "value": "Index published pages and answer queries" },
    { "id": "task/current", "type": "task", "label": "Add a search index", "value": "Build the index at publish time; offline search is unconfirmed" },
    { "id": "task/deploy", "type": "task", "label": "Deploy the site" }
  ],
  "edges": [
    { "from": "component/search", "type": "serves", "to": "objective" },
    { "from": "task/current", "type": "serves", "to": "component/search" },
    { "from": "task/deploy", "type": "serves", "to": "objective" }
  ],
  "evidence": [{ "kind": "file", "ref": "README.md" }]
}
```

例は意図的に小さい。目的1つ、手段1つ、現在のタスク、他の開いているタスク1つ。証拠は、エージェントが実際に見たものでなければなりません。

### 想起ブロック

ブロックはプロンプトごとに新しく組み立てられるので、古い要約ではなくグラフに追随します。セッションが再導出してしまう問いに答えます:

- `Objective` — ルート、タスク数、まだ満たされていない受入。
- `Path` — `task/current` に至る `serves` の連なり。
- `Now` — 現在のタスク1つ。新しいタスクがこの位置を奪うことはない。`task/current` がそうする。
- `Remaining` — 他の開いているタスク。`none recorded` は「残りがない」ではない。
- `Map` — 目的ツリーを圧縮したもの。現在のパスはより詳しく。
- `Constraints` / `Risks` / `Preferences` / `Decisions` / `Facts` — 何を信じてよく、何が決着しているか。事実は `node` 辺が現在のパスにリンクしたときだけ出る。
- `Experience` — 以前の予測誤差から蒸留した規則と、その条件。
- 1回だけの確認 — 記録された誤差が目的・受入項目・優先度を問い直すときだけ足される、拘束力のない見直しの促し。セッションごと、誤差ごとに1回。

### よくある質問

- **目的が変わった。** 同じノードを新しい値で書き直す。以前の値は `graph_history` に残る。目的の変更は許される——それ自体はドリフトではない。
- **同じノードを2回書いた。** 後の書き込みが前のものを置き換える。`graph_history` は両方を保つ。
- **記録が間違っている。** 理由と証拠をつけて `graph_retract`。何も消えない。撤回がそれを上書きする。
- **1つのキーに2つの記録が有効。** 投影は競合を報告し、そのキーをビューから外す。競合はすべてのクエリ結果に返され、黙って解決されることはない。
- **事実が想起ブロックに出ない。** 次のセッションに見せるべきなら、`node` 辺で現在のパスにリンクする。
- **想起ブロックが空。** 何も記録されていないか、ランタイムコンテキストが抑制されているか、セッションがプロジェクトルートの外にある。

## 「認知」タブ

`@kioju/dsh-cognitive-dashboard` を入れると、同じグラフがツリーとして見えます。現在のタスク、他に残っていること、findings、想起ブロックそのものも並びます。読み方は dashboard の README にあります。

## リファレンス

振る舞い・ツール・保存・ポリシーの全体: [docs/REFERENCE.ja.md](docs/REFERENCE.ja.md)（英語: [docs/REFERENCE.md](docs/REFERENCE.md)）。

### ツール

| ツール | 用途 |
|---|---|
| `graph_write` | ノード・辺・予測誤差を証拠つきで書く |
| `graph_retract` | 理由をつけてノードか辺を撤回する |
| `graph_query` | トラバース、フィルタ、owner/location の推論、誤差の一覧 |
| `graph_history` | ノードか辺の背後のイベント列を読む |

### 設定

```yaml
- insert:
    - id: cognitive-model
      name: '@kioju/dsh-cognitive-model'
      config:
        contextLimit: 12    # 想起ブロックが表示する目的ツリーの行数
        recallLimit: 12     # 制約・リスク・選好・決定の節ごとの上限
        queryLimit: 50      # 1回の graph_query 結果の上限
        maxDepth: 6         # 呼び出し側が何を要求しても、トラバースの深さ上限
        writeTypes: []      # 空 = すべてのノード種別
        writeScopes: []     # 空 = すべてのスコープ
```

### 保存

```
<projectRoot>/.dsh/cognitive-model/graph.json    # 追記専用のイベントログ
<projectRoot>/.dsh/cognitive-model/recall.json   # 俯瞰チェックの既読管理
```

`<projectRoot>` は `.git` を含む最も近い祖先。なければ現在の作業ディレクトリ——DSH が `<projectRoot>/.dsh/skills` に使うのと同じ定義です。

グラフはアーカイブではなく作業記憶です。ログは20,000イベントで上限。リセットは物理削除:

```
rm -rf <projectRoot>/.dsh/cognitive-model
```

削除ツールはありません。`graph_retract` は投影されたグラフからノードを撤回しますが、それを作ったイベントを消すわけではありません。

### アップグレード

スキーマ2では、すべての予測誤差が方向を持ちます。ワークスペースにスキーマ1のグラフがある場合、このバージョンを有効にする前に一度だけ移行を実行してください:

```
npm run build
node scripts/migrate-peg.mjs <workspace> --dry-run   # レポートのみ
node scripts/migrate-peg.mjs <workspace>
```

グラフの隣にタイムスタンプ付きの `.bak-…` を書き、冪等で、ログの残りには触れません。新しいグラフはすでにスキーマ2です。

### テスト

```
npm test                    # 先にビルド（pretest）してから1回実行
node scripts/run-tests.mjs  # 子プロセスの起動を拒否するサンドボックス向けの in-process ランナー
```

## 家族（dsh-cognitive-*）

`dsh-cognitive-*` は、次の判断のための材料を会話の外に保ちます。目的と仕事の分解、決めたことと制約、まだ開いていること、気づいたが後回しにしたことです。

| パッケージ | 役割 | 欠けたとき |
|---|---|---|
| `@kioju/dsh-cognitive-model` | グラフと想起ブロック | ツリーも想起ブロックも出ない。findings は動く |
| `@kioju/dsh-cognitive-dashboard` | 「認知」タブ | エージェントは記録を続けるが、あなたに見える画面がない |
| `@kioju/dsh-cognitive-findings` | 後回しキュー | 範囲外の発見の行き先がなくなる |
| `@kioju/dsh-cognitive-core` | 共有ライブラリ | 自動で入る |

各プラグインは独立しています。全体像には model + dashboard、後回しのループには findings を追加してください。

## ライセンス

MIT.
