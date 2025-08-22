# 通勤トラッカー PWA（オフライン・無料）

- 中継地点を自由に設定
- 手動チェックイン（到着）で **生データ** を端末内へ永続保存（IndexedDB）
- **オフライン対応**（Service Worker）
- 期間選択で
  - 日別・区間時間の **積み上げ棒**
  - **7日ごとの平均（積み上げ）**
  - 合計通勤時間 + **7日移動平均（折れ線）**
- CSV/JSON エクスポート

## 使い方
1. このフォルダを GitHub リポジトリに push
2. GitHub Pages を有効化（Settings → Pages → Source: GitHub Actions）
3. 公開URLへアクセス → 「アプリとしてインストール」
4. ルートを作成 → 開始 → 各地点で **到着** → 終了
5. 分析タブで期間選択・グラフ表示

> 初回アクセス時に必要ファイルをキャッシュするため、インターネット接続が必要です。2回目以降はオフライン利用が可能です。

## 開発メモ
- 依存：Plotly（CDN）、Dexie（CDN）
- Service Worker が CDN のスクリプトもキャッシュします（オフラインで動作可）。
- データは IndexedDB。バックアップは CSV/JSON をエクスポートしてください。

## 構成
```
.
├─ index.html
├─ app.js
├─ sw.js
├─ manifest.webmanifest
├─ assets/
│  ├─ icon-192.png
│  └─ icon-512.png
└─ .github/workflows/pages.yml
```

## 注意
- iOS/Safari はバックグラウンド位置情報に制約があります。現状は **手動チェックイン** を基本UIにしています。
- 地図表示や自動検出を行いたい場合は、後から MapLibre・Geolocation API を追加してください。
