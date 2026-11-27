# dsh-cognitive-model: リファレンス

振る舞い・ツール・保存・ポリシーの全体。導入・インストール・最初の手順は [README.ja.md](../README.ja.md)（英語: [README.md](../README.md)）を参照してください。

> English: [REFERENCE.md](REFERENCE.md)

認知モデルと世界モデルは**1つのグラフ**です。ノードと型付きの辺が、目的・タスク・主張・世界の実体を表します。読み手はグラフの関係をたどるか、`part_of` を通して所有と場所を推論できます。

状態は真実として保存されません。永続文書は追記専用の**イベントログ**を持ち、グラフは読み取りのたびにそこから投影されます。だからこそ、置き換え・撤回・有効期間が、何かを答える前に適用されます。そして、未解決の競合が黙って解決されず、見える形で返ります。

## そうではないもの

- **ゲートではない。** どのツールも作業を止めず、グラフが続行を拒否することもない。拒否された書き込みは報告され、作業は続く。
- **ドリフト検出器ではない。** 俯瞰の確認は、仕事が目的からずれたかどうかを判定しない。記録された予測誤差が目的・受入項目・優先度を問い直すとき、読み手に再確認を促すだけです。「続行」は普通の答えです。
- **グラフデータベースではない。** 有界のトラバーサルと1つの真偽フィルタ代数以上のクエリはなく、インデックスもバックグラウンド保守もない。文書はワークスペースの隣の JSON ファイル1つです。
- **証拠の代わりではない。** 書き込みには証拠が要る。読んだファイル、実行したコマンド、url、人間の言葉。推測は拒否され、`agent_inference` は決して永続化されない。
- **承認システムではない。** 承認は DSH が持つ。ここに第二の権威はない。
- **会話の第二の履歴ではない。** セッションで起きたことではなく、意図して書いた構造を記録する。

## グラフ

3つの語彙が1つのストアを共有します。「仕事は何のためか」「それについて何を信じてよいか」「それは何でできているか」は、一緒に問われるからです。

**ノード** — `objective` / `component` / `task` / `decision`（構造）、`constraint` / `risk` / `fact` / `preference`（認識の記録）、`heuristic`（予測誤差から蒸留した条件付きの規則）、`entity`（世界）。finding はノードではない。findings 台帳の後回しキューの項目で、`node` フィールドが属する目的か手段を指し返します。

制約は仕事の境界、リスクは未解決の危険、事実はリポジトリについての主張で `value` に保存され、選好は人間が物事をどう進めたいかです。これらは属性ではなくノードなので、読み手はクエリでき、想起ブロックは第二のストアなしでそれらをまとめられます。

**予測誤差** — 期待が実際と違ったこと、良い方向でも悪い方向でも — はノードでは*ない*。構造の中に場所がなく、何への辺も持ちません。イベント（`record_error`）として一度だけ追記され、決して置き換えられません。訂正はより新しい記録なので、違っていた期待は読めるまま残ります。`direction` は結果がどちらに違ったかを示し、`revisit` フィールドは種別とは別の「影響」——その誤差が何を問い直すのか——です。

**経験則（heuristic）** はノードです。1つ以上の誤差から蒸留した、条件付きで改訂可能な規則。`direction`（規則の向き）、`conditions`（いつ適用するか）、`errorIds`（元の誤差）を持ちます。仕える目的か手段に `node` 辺でリンクされます。意図して書かれるもので、書き手が「繰り返し・影響・説明力が規則を正当化する」と判断したときに書く——自動生成ではありません。

**辺** — `serves` / `requires` / `verifies` / `node` が認知側を、`part_of` / `owned_by` / `located_in` が世界側をつなぎます。

| 辺 | 関数的 | from → to | 意味 |
|---|---|---|---|
| `serves` | はい | objective / component / task → objective / component | タスクや手段が何のためか。目的は親の目的にだけ仕える |
| `requires` | いいえ | component / task / decision → component | 手段への依存 |
| `verifies` | いいえ | component → component | どの手段がどれを検査するか |
| `node` | はい | decision / fact / risk / constraint / preference / heuristic → objective / component | この記録が属するノード |
| `part_of` | はい | entity → entity | 構造上の親 |
| `owned_by` | はい | entity → entity | 実体の所有者 |
| `located_in` | はい | entity → entity | 実体の場所 |

語彙は閉じており、書き込み経路がそれを検査します。間違った種別同士の辺は `invalid_edge_endpoint` で拒否され、保存されてツリーに黙って無視されることはありません。

**関数的（functional）** な関係は `(from, type)` ごとに有効な対象を1つ持ちます。2つ目の対象を書くと1つ目を置き換え、1つ目は `graph_history` に残ります。非関数的な関係は蓄積します。

### 2つの推論

`infer` 付きの `graph_query` が、グラフの存在理由である問いに答えます:

- **owner** — 直接の `owned_by` が勝つ。なければ、`part_of` の連鎖で最も近い祖先が持つ所有者を継承し、結果はどちらを使ったかを示す。
- **location** — 直接の `located_in` と継承したものはどちらも候補。異なる場所を指すとき、答えは**候補つきの競合**であり、新しいほうを採るのではない。

`part_of` は厳密な半順序です。ノードは自分自身の一部ではない。連鎖は循環に安全で、永遠にたどるのではなく循環を報告します。

## 投影の規則

順序が重要で、コードもこの順序に従います:

1. イベントを集める
2. 投影キーで分割する
3. 置き換えを解決する — 明示的な置き換えは新しさに勝つ
4. 無効化を適用する — 撤回されたイベントは決して現在にならない
5. 有効期間を適用する — イベントがこの瞬間を覆わないことがある
6. ビューを組み立てる

1つのキーに2つのイベントがまだ有効で、どちらも他方を置き換えないとき、投影は**競合**を記録し、そのキーをビューから外します。競合はすべての `graph_query` 結果に返されます。

## ツール

### `graph_write`

| 引数 | 必須 | 意味 |
|---|---|---|
| `nodes` | いずれか1つ | `{ id, type, label, value?, direction?, conditions?, errorIds?, paths?, docs?, milestones? }`。`direction` / `conditions` / `errorIds` は heuristic 専用 |
| `edges` | いずれか1つ | `{ from, type, to }` |
| `errors` | いずれか1つ | `{ kind, direction, subject, predicted, observed, lesson?, factId?, revisit? }` |
| `evidence` | 実質必須 | ファイル、コマンド、url、人間の言葉 |
| `source` | いいえ | 省略時は evidence から導出 |
| `scope` | いいえ | 既定は `repo` |
| `validFrom` / `validTo` | いいえ | 主張が成り立ち始める/終わる時点 |

辺の両端は存在しなければなりません——この呼び出しの中か、以前の書き込みに。呼び出し全体が、何かを追記する前に検証されます。半分だけ適用されたバッチは、誰も推論できないグラフです。1回の呼び出しで2回名指しされたノードか辺は1つのイベントに畳まれます（後の項目が勝つ）ので、バッチが1つの投影キーに2つの有効なイベントを残すことはありません——投影はそれを解決不能な競合として報告し、ノードを隠してしまうからです。

同じ主張を同じ source と evidence でもう一度書くのは no-op です。source か evidence が変わった書き込みは以前のイベントを置き換えるので、最初に note から記録した主張を、テキストを変えずに後からコマンドで検証できます。以前の記録は `graph_history` に残ります。

予測誤差はノードより厳格です。証拠にコマンド・ファイル・url のいずれかを含まなければなりません。note だけでは報告であり、観察ではありません——「違った」は、報告者以外の何かが示したときだけ想起する価値があります。同じ記録を2回書くと重複として報告され、追記されません。経験則も厳格です。`direction`、`conditions`、1〜10個の有効な `errorIds` が必要です（先に誤差を記録してください。その id は書き込みが返します）。モデルが蒸留した経験則もコマンド・ファイル・url を必要とします。人間は note から述べてもよい。

`direction` は `better` か `worse`。結果が期待を上回った（うまくいった、速かった、小さかった）か、下回ったか。どちらも記録され想起されます。良い方向の誤差は境界を広げたり信頼を上げたりでき、悪い方向の誤差は境界を狭めたりチェックを足したりできます。

`revisit` は影響で、別の種別ではありません。現在の目的（`objective`）、受入項目（`acceptance`）、優先度（`priority`）を問い直すときだけ設定します。目的について何も変えない `scope` や `estimate` の外れは較正の記録で、設定しません。仮定を覆す `belief` や、受入項目が満たせない——あるいはすでに満たされている——ことを示す `outcome` は設定できます。

### `graph_retract`

`nodes?`、`edges?`、`reason`（必須）、`evidence`。ノードを撤回すると、それを指す辺も撤回されるので、宙に浮いた関係は残りません。何も消えません。撤回がイベントを置き換え、両方が履歴に残ります。

### `graph_query`

`start?`、`via?`、`direction?`、`depth?`、`predicate?`、`infer?`、`errors?`、`limit?`。

`errors: true` では、グラフのノードではなく、記録された予測誤差を新しい順に一覧します。

述語代数がクエリ言語の全体です:

```
{ type: 'owner',      owner,    mode? }
{ type: 'part_of',    parent,   mode? }
{ type: 'located_in', place,    mode? }
{ type: 'node_type',  nodeType, mode? }
{ type: 'and' | 'or', of: [ … ] }
{ type: 'not',        of: { … } }
{ type: 'true' } | { type: 'false' }
```

`mode` は `include`（既定）か `exclude`。`and`、`or`、`not` で述語を組み合わせます。

トラバーサルは、到達したノード間のすべての `via` 辺（誘導部分グラフ）を返し、BFS 木だけを返しません。循環は、歩行が実際に閉じたときだけ報告します——来た辺を無向に戻ることは循環ではありません。

### `graph_history`

`node?`、`edge?`、`limit?`。1つの対象の背後のすべての書き込み・置き換え・撤回を、新しい順に、source・evidence・まだ現在かどうかとともに返します。

## 想起ブロック

プラグインは短い指示を提供し、各ステップで投影から有界の想起ブロックを組み立てます。ドキュメントサイトの例:

```
Working memory for this workspace, projected from the event log — build on it instead of re-deriving it:
Objective: Publish a searchable documentation site [tasks: 1] (reported)
Path: objective → component/search
Now: Add a search index (reported, unverified)
Remaining: none recorded — this does not mean nothing else remains.
Map:
  - Search — Index published pages [tasks: 1]
  - Publishing — Build and deploy the site
Constraints:
- Search must work without sending queries to a third-party service
Preferences:
- Keep the site usable offline (reported)
Decisions:
- Build the search index at publish time
Facts: 12 recorded, none linked to the current path (graph_query with node_type=fact lists them).
Experience (rules distilled from earlier prediction errors; conditional and revisable, not a rule for this case):
- [better] use the incremental build (repo; when only a few source files changed): run the incremental build before a full rebuild — 2 observation(s) (pre_…, pre_…), observed [for component/search]
Before continuing: does the work in hand still serve the objective?
Why this check — a recorded prediction error puts the acceptance items in question:
- [outcome/worse] offline search (repo; revisit: acceptance): expected results offline — actually the index required a network request
Compare the objective, the current position, and the other unfinished parts
(if the block names none, they are unrecorded — not absent), then decide to continue, change, or hold.
Refining the objective or the approach is allowed, and earlier decisions can be re-examined;
this is a check, not a gate.
Prediction errors: 12 recorded (graph_query errors=true).
Labels say how each item was recorded, not that its content was re-checked; an unmarked item cites a file, command or url. (reported, unverified) was said, not checked: check one when a detail matters, then record the correction with evidence.
```

ブロックは、台帳全体を再現せずに次のセッションへ文脈を渡します。`Objective` はルートを説明します。`Path` は `task/current` に至る `serves` の連なりをたどり、`task/current` は `Now` の下に別に表示されます。`task/current` がない場合、`Now` は最も新しいタスクを示すのではなく `not recorded` と言います。`Remaining` は他のタスクと、記録された未達の受入項目を要約します。マップは現在のパスではより詳しく、パス外の子孫は名前に圧縮します。

各節には独自の予算があります。制約・リスク・選好は別々に並びます。現在のパスにリンクされた決定が先で、他の決定は新しさ順。事実は `node` 辺が現在のパスにリンクしたときだけ出ます（近い順、次に新しさ順）。リンクのない事実は、無関係なサンプルで置き換えられません。ブロックは記録件数と、それらをクエリする方法を述べます。誤差ログは索引——件数の1行——で、蒸留した規則は `Experience` に残り、1回だけの確認はその理由を保ちます。`contextLimit` はマップの行数を制限します。`recallLimit` は制約・リスク・選好・決定の節ごとの上限です。リンクされた事実と経験則には別の上限があります。

誤差が `revisit` を持つとき、ブロックは目の前の仕事から見直すための、拘束力のない要求を1つ足します。引き金は記録された**影響**で、誤差の種別や大きさではありません。目的について何も変えない `scope` や `estimate` の外れは較正の記録で、確認を求めません。仮定を覆す `belief` や、受入項目が満たせないことを示す `outcome` は求められます。要求は引き金になった誤差の subject と、predicted/observed の差を運びます。引き金は誤差の節とは独立だからです——ログは1行で、読み手がどの記録が求めたかを推測しなくて済むように。

確認は**セッションごと、誤差ごとに1回**で、プロセスやワークスペースごとに1回ではありません。同じワークスペースの別セッションはまだ求められ、再起動したセッションはすでに見た誤差について再び求められません。既読は `.dsh/cognitive-model/recall.json` に保たれます。確認であり、ゲートではありません。合意された目的の変更はドリフトではありません。

ブロックは任意（`required: false`）として登録されるので、デプロイのランタイムコンテキストのスイッチに従います。

## Host サービス

グラフは Cordis サービス `cognitiveGraph` として、隣接する Host プラグインに公開されます:

```js
const model = ctx.get('cognitiveGraph') // undefined when this plugin is absent
const snapshot = model.snapshot(root)   // { state: 'ready' | 'missing' | 'error', nodes, edges, … }
const recall = model.recall(root)       // { state, text } — the block a session starts from
```

`snapshot(root)` は同期的で、ワークスペースのルートを受け取ります。利用者は、このパッケージを import したりイベントログをもう一度投影したりせずに、ブラウザが読むのと同じ投影（受入項目つきの `nodes`、型付き `edges`、競合、2つの `part_of` 推論）を得ます。`@kioju/dsh-cognitive-dashboard` が最初の利用者です。目的ツリーはこのスナップショットから描かれるので、置き換えと競合検出の実装は1つに保たれます。

`recall(root)` は想起ブロックそのものを `text` として返し、このプラグインの設定された予算で組み立てます。UI はブロックを再構築せずに直接表示できます。読み取りはセッションごとの俯瞰チェックを消費しません——プロンプトが読み手ごとに一度だけ消費する——ので、返されるテキストに確認は含まれません。どちらの呼び出しも、ログの1つのキャッシュされた読み取りを共有します。

## 保存

```
<projectRoot>/.dsh/cognitive-model/graph.json    # 追記専用のイベントログ
<projectRoot>/.dsh/cognitive-model/recall.json   # 俯瞰チェックの既読管理
```

`<projectRoot>` は `.git` を含む最も近い祖先。なければ現在の作業ディレクトリ——DSH が `<projectRoot>/.dsh/skills` に使うのと同じ定義です。

グラフ文書は `events`、`stats`、`nextSeq` を持ちます。`nodes` 配列はありません。状態は投影され、決して保存されません。文書はスキーマ2で、ログは20,000イベントで上限、追記専用です。満杯になったときのサポートされるリセットは、領域の削除です（グラフは作業記憶で、アーカイブではない）。拒否された書き込みはイベントを追記しません。文書はそれを `stats.rejections` に記録します（最初の拒否が文書を作ります。カウンタがポリシーが走ったことの永続的な印だからです）。

`recall.json` は帳簿であり、台帳ではありません。どのセッションがどの俯瞰チェックをすでに見せられたかを覚えます。削除すると、1つの確認が再び表示されることがあるだけです。グラフが信じるものには決して影響しません。

**リセットは物理削除:**

```
rm -rf <projectRoot>/.dsh/cognitive-model
```

削除ツールはありません。`graph_retract` は投影されたグラフからノードを撤回しますが、それを作ったイベントを消すわけではありません。

読めない文書は、次の書き込みの前に `graph.json.corrupt-<timestamp>` として脇に退避されるので、手で編集した台帳は復旧できます。

## グラフをスキーマ2へ移行する

スキーマ2では、すべての予測誤差が方向を持ちます。これは一度きりの形式移行で、訂正ではありません。古い誤差は構造上すべて負だったので、`worse` になります。このバージョンを有効にする前に一度だけ実行してください:

```
npm run build
node scripts/migrate-peg.mjs <workspace> --dry-run   # レポートのみ
node scripts/migrate-peg.mjs <workspace>
```

グラフの隣にタイムスタンプ付きの `.bak-…` を書き、冪等で、ログの残りには触れません。新しいグラフはすでにスキーマ2なので、移行は不要です。

## 設定

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

## 保存カウンタ

グラフ文書は次のカウンタを記録します:

- `writes` — 追記されたイベント
- `retractions` — 記録を撤回するイベント
- `rejections` — ポリシー・検証・保存上限で拒否された書き込み
- `duplicates` — 同じ証拠の繰り返し主張。イベントは追記されない。

競合は投影時に導出され、すべてのクエリに返され、永続化されません。

## テスト

```
npm test                    # 先にビルド（pretest）してから1回実行
node scripts/run-tests.mjs  # 子プロセスの起動を拒否するサンドボックス向けの in-process ランナー
```

スイートは、投影の規則（置き換え、無効化、有効期間、競合）、2つの推論とトラバーサル、想起ブロックと符号付き予測誤差ポリシー（影響ベースの俯瞰チェック、セッションごとの既読、理由の行、較正の記録に留まる scope の外れを含む）、経験則（誤差から蒸留した heuristic、そのフィールドとポリシー、現在パス優先の想起節、予算、撤回）、スキーマ2移行、書き込みポリシー、辺の語彙、4つのツールのエンドツーエンドを、一時ワークスペースに対して確認します。

## ライセンス

MIT.
