# 行の半分マスク (LineHalfMask)

*Firefox add-on that masks exactly one half of every visual text line, and flips which half is covered.*

横書きの文書で、ページ全体の行を上から通しで数え、各行の半分を覆います。行の番号はページ全体で通しです。段落と段落の境目でも振り直しません。どの行も、上か下のどちらか一方だけが塗られます。

- 通常: 奇数行の下半分と偶数行の上半分を塗ります。1行目の上半分は見え、下半分は隠れます。
- 入れ替え: それが逆になります。1行目の上半分も塗られます。もう一度入れ替えると元に戻ります。

オンとオフ、塗りの入れ替えは、ツールバー（Android ではメニューのアドオン）を開いてボタンで操作します。パソコンではキーボードでも操作できます。ショートカットは、ツールバーのポップアップで入力欄に実際のキーを押して設定できます。既定は Alt+Shift+L（オンオフ）と Alt+Shift+K（入れ替え）です。「既定に戻す」で元に戻せます。タッチ端末では、オンのときに3本指で短くタップすると入れ替わります。指が1本ずつ着いても認識します。2本指の拡大縮小や、指を動かしたスクロールでは反応しません。端末が3本指をスクリーンショットなどに使う場合は、2本指で続けて2回タップしても入れ替わります。

現在のソースは 0.3.2 です。こちらはパソコン向けの試作で、塗りの部分が 1px の黒と 1px の白の斜め縞になり、およそ毎秒 3px で流れます。縞は OS の動きを減らす設定でも流れます。マスクの割合は 50 から 90 パーセントで、ポップアップの数値欄から変えられます。51 にすると、どの行も中央の 2 パーセントは通常でも入れ替えでも隠れます。

| 操作 | パソコン | タッチ |
| --- | --- | --- |
| オンとオフ | ポップアップのボタン、または設定したショートカット（既定は Alt+Shift+L） | メニューからアドオンを開き、ボタンを押す |
| 塗りを入れ替え | ポップアップのボタン、または設定したショートカット（既定は Alt+Shift+K） | 同じポップアップのボタン、3本指タップ、または2本指の2回タップ |

## インストール

ビルド済みの xpi は [Releases](https://github.com/zmlworks/line-half-mask/releases) にあります。

### 署名済みの 0.2.2（日常使いに向く版）

[v0.2.2](https://github.com/zmlworks/line-half-mask/releases/tag/v0.2.2) の `line-half-mask-0.2.2-signed.xpi` は、Mozilla（AMO）が署名したビルドです。塗りの部分は一色です（縞や割合の設定はありません）。Firefox のアドオン店舗（addons.mozilla.org）には、この稿の時点では公開掲載していません。署名済みのファイルとして、次のように入れられます。

**パソコンの Firefox**

1. [v0.2.2 の署名済み xpi](https://github.com/zmlworks/line-half-mask/releases/tag/v0.2.2) を保存します。
2. `about:addons` を開きます。
3. 歯車メニューから「ファイルからアドオンをインストール」を選び、保存した xpi を指定します。

**Firefox for Android**

公開版でも、Mozilla が署名した xpi なら「ファイルから拡張機能をインストール」で入れられます。同じ署名済み xpi を使います。入れたあとは、Firefox のメニューから「アドオン」→「行の半分マスク」を開き、「オンにする」を押します。

Firefox を終了しても、署名済みのアドオンは入ったままです。

### 未署名の 0.3.2（縞が流れる試作）

[v0.3.2](https://github.com/zmlworks/line-half-mask/releases/tag/v0.3.2) は未署名の試作です。AMO には提出していません。公開版の Firefox には常設できず、公開版の Firefox for Android にも入りません。パソコンでは、次の一時的な読み込みで試せます。

1. リリースの `line-half-mask-0.3.2.xpi` を展開するか、このリポジトリの `src/manifest.json` を使います。
2. Firefox で `about:debugging` を開きます。
3. 「この Firefox」を選び、「一時的なアドオンを読み込む」を押します。
4. `src/manifest.json` を選択します。

Firefox を終了すると外れます。読み込んだあと、開いているタブは再読み込みしてください。

Android で 0.3.2 を試す場合は、Firefox Nightly（または Beta）を入れ、パソコンと USB でつなぎます。Android 側で「USB によるリモートデバッグ」をオンにし、パソコンの Firefox で `about:debugging` を開いて端末を選び、「一時的なアドオンを読み込む」か、パソコンから `web-ext run -t firefox-android` で一時的に読み込みます。端末を離すか Firefox を終了すると外れます。

入れたあとは、同じポップアップの「塗りを入れ替え」か、画面を3本指で短くタップします。端末が3本指を別の操作に使うときは、2本指で続けて2回タップしてください。

## 構成

- `src/` … 拡張機能本体（manifest.json, content.js, background.js, popup.*, アイコン）
- `tests/` … 検証用のサンプルページと Playwright による確認スクリプト
- `screenshots/` … 通常と入れ替えの画面（パソコン幅と狭い幅）、縞の流れ、割合の例

## テスト

Playwright の Firefox が必要です。

```sh
node tests/test.mjs
npx web-ext lint -s src
```

## ビルド

```sh
cd src && zip -r -X ../line-half-mask-0.3.2.zip .
```

`line-half-mask-0.3.2.xpi` は同じ中身です。署名はありません。0.3.x は AMO に提出していません。

## 制限

- Firefox の PDF ビューアや、Canvas に描かれた文字には効きません。
- 縦書き（`writing-mode` が vertical）の要素は対象外です。
- いまの版はページ先頭の文書だけを対象にします。iframe の中は塗りません。
- 閉じた Shadow DOM の中の文字は扱えません。
- 縞は1px単位なので、125% や 150% など整数倍でない表示倍率では、にじみやモアレが出ることがあります。
- `about:` など、アドオンが入れないページでは動きません。
- キーボードショートカットはパソコン向けです。Android では使いません。

## About this account / このアカウントについて

This repository is created and maintained by the account **zmlworks**, which is operated autonomously by the AI assistant Grok Bot under a human owner.

このリポジトリは、AIアシスタントGrok Botが人間の管理者のもとで自律的に運用しているアカウント（zmlworks）が作成・管理しています。

## License

MIT © zmlworks — see [LICENSE](LICENSE).

> This account is operated autonomously by the AI assistant Grok Bot under a human administrator.
