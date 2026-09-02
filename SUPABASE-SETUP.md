# AIパーク 設定ガイド（Supabase ＋ GitHub Pages）

この構成では、
- **Supabase** … 投稿と合言葉を保存する共有データベース（全員共通）
- **GitHub Pages** … サイトを公開して、どのPC・スマホからでも開けるようにする

の2つを使います。どちらも**無料**です。全体で20〜30分ほど。

---

# パート1｜Supabase（共有データベース）

## STEP 1：プロジェクトを作る
1. https://supabase.com/ を開き「Start your project」→ GitHubアカウント等でサインイン
2. 「New project」をクリック
3. 入力する項目：
   - **Name**：`aipark`（何でもOK）
   - **Database Password**：適当に強いパスワードを決める（**メモしておく**）
   - **Region**：`Northeast Asia (Tokyo)` を選ぶ
4. 「Create new project」→ 1〜2分待つ

## STEP 2：テーブルを作る（SQLを貼るだけ）
1. 左メニューの **「SQL Editor」** を開く
2. 「New query」に、下を**まるごと貼り付けて「Run」**：

```sql
-- 投稿テーブル
create table if not exists public.sites (
  id uuid primary key default gen_random_uuid(),
  created_at bigint default (extract(epoch from now())*1000)::bigint,
  name text not null,
  url text not null,
  description text default '',
  author text default '',
  pass text default '',
  thumb text default ''
);

-- 合言葉テーブル
create table if not exists public.settings (
  key text primary key,
  hash text
);

-- 行レベルセキュリティを有効化
alter table public.sites enable row level security;
alter table public.settings enable row level security;

-- 誰でも読み書きOK（仲間内向けの設定）
create policy "public sites"    on public.sites    for all using (true) with check (true);
create policy "public settings" on public.settings for all using (true) with check (true);

-- リアルタイム同期を有効化
alter publication supabase_realtime add table public.sites;
alter publication supabase_realtime add table public.settings;
```

> ※このSQLは**最初の1回だけ**実行してください（2回目は「already exists」エラーになります）。

## STEP 3：接続情報を取得
1. 左下 **⚙️「Project Settings」→「API」** を開く
2. 次の2つをコピー：
   - **Project URL**（例：`https://xxxx.supabase.co`）
   - **Project API keys** の **`anon` `public`** キー（`eyJ...` と長い文字列）

## STEP 4：`supabase-config.js` に貼る
1. `作業場` の **`supabase-config.js`** をメモ帳などで開く
2. こう書き換えて保存：

```js
window.AIPARK_SUPABASE_CONFIG = {
  url: "https://xxxx.supabase.co",
  anonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9......"
};
```

3. `index.html` を開き直し、左上バッジが **🌐 みんなで共有中** になれば成功🎉
   - 最初に決める合言葉が、**全員共通の合言葉**になります

> `anon public` キーは公開しても大丈夫な種類のキーです（GitHubに置いてもOK）。
> ただし `service_role` キーは**絶対に公開しない**でください（今回は使いません）。

---

# パート2｜GitHub Pages（サイトを公開）

みんなが同じURLで開けるように、サイト本体をネットに置きます。

## STEP 1：リポジトリを作る
1. https://github.com/ にログイン（無ければ無料登録）
2. 右上「＋」→「New repository」
3. **Repository name**：`aipark`（何でもOK）
4. **Public** を選ぶ → 「Create repository」

## STEP 2：ファイルをアップロード
1. 作ったリポジトリ画面の「**uploading an existing file**」リンクをクリック
2. `作業場` の中の**ファイルを全部**ドラッグ＆ドロップ：
   - `index.html` / `style.css` / `app.js`
   - `supabase-config.js` / `firebase-config.js`
   - （`*.md` は無くてもOK）
3. 下の「Commit changes」をクリック

## STEP 3：Pages を有効化
1. リポジトリの **「Settings」→ 左メニュー「Pages」**
2. 「Build and deployment」の **Source** を **「Deploy from a branch」**
3. Branch を **`main`** ／フォルダ **`/ (root)`** にして **Save**
4. 数十秒〜数分で、上部に公開URL（`https://ユーザー名.github.io/aipark/`）が表示される

このURLを仲間に配れば、**どの端末からでも同じ一覧＋同じ合言葉**で使えます。

---

# 補足・注意

- **合言葉について**：合言葉は全員共通で、ハッシュ化して保存されます。ただしこのロックは「UIから知らない人が入るのを防ぐソフトなロック」です。上のポリシーは「誰でも読み書きOK」なので、技術に詳しい人がデータベースへ直接アクセスすれば中身は見られます。**仲間内なら十分**ですが、厳密に守るならログイン制（Supabase Auth）への拡張が必要です。
- **サムネ画像**：自動で圧縮して保存します。大きすぎる場合は「大きすぎます」と出るので小さめの画像を選んでください。
- **更新したいとき**：`作業場` のファイルを直したら、GitHub の同じ場所に上げ直せば公開サイトも更新されます。
- **困ったら**：`index.html` を開いて **F12キー →「Console」** に赤いエラーが出ていたら、その文字を教えてください。原因を特定できます。
