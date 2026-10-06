# 校正フィードバックツール（フロントエンド）

Webページのキャプチャや画像に対して、修正箇所を範囲指定してコメントを付け、複数ページをまとめて作業者と共有するためのツールです。

## 機能

- 画像アップロード / URL入力（PC・スマホ切替、Basic認証入力欄）
- 範囲指定と自動採番
- 右側コメント欄（ファイル添付可）
- コメント欄 ⇔ 指定範囲 の相互ハイライト・移動
- 左側サムネイルでのページ切替・複数ページ管理
- ページタイトル入力、元ページへ移動ボタン
- 一括タイトルの設定と共有URL作成（閲覧専用表示）

## ファイル構成

```
index.html   # 本体（HTML/CSS/JS を1ファイルに同梱）
README.md
.gitignore
```

## 使い方

ビルド不要です。`index.html` をブラウザで開くか、任意の静的ホスティング（GitHub Pages など）に置いてください。

## バックエンド連携

`index.html` 内の `API_BASE` にバックエンドのURLを設定すると、以下が有効になります。
空のままの場合はデモ動作（自動キャプチャ不可・共有はJSON保存）です。

```js
const API_BASE = "https://your-server.example.com";
```

### 必要なAPI

| メソッド | パス | リクエスト | レスポンス |
|---|---|---|---|
| POST | `/api/capture` | `{ url, device: "pc" \| "sp", basicAuth: { user, pass } \| null }` | `{ title, image }`（imageはdataURL） |
| POST | `/api/projects` | プロジェクトJSON（下記） | `{ id }` |
| GET | `/api/projects/:id` | - | プロジェクトJSON |

CORS を許可してください。キャプチャ取得は Playwright / Puppeteer などでの実装を想定しています
（Basic認証は `httpCredentials` で対応可能）。

### プロジェクトJSON

```json
{
  "title": "一括修正のタイトル",
  "pages": [
    {
      "id": "abc123",
      "title": "ページタイトル",
      "url": "https://example.com",
      "img": "data:image/png;base64,...",
      "n": 2,
      "regions": [
        { "id": "r1", "n": 1, "x": 0.1, "y": 0.2, "w": 0.3, "h": 0.1,
          "comment": "修正内容",
          "files": [ { "name": "ref.pdf", "data": "data:..." } ] }
      ]
    }
  ]
}
```

`x, y, w, h` は画像サイズに対する割合（0〜1）です。

### 共有URL

`?view=<projectId>` を付けて開くと、閲覧専用で表示されます。

## 注意

- 現状、編集中のデータはリロードで消えます（保存はバックエンド側が前提）。
- 画像・添付ファイルはdataURLで扱うため、大容量の場合はバックエンドでストレージ保存＋URL参照への変更を推奨します。
