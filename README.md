# 桌宠

一个 Windows 桌面宠物应用。当前正在从 Electron 迁移到 Tauri，以减少安装包体积。

## 构建

```powershell
npm install
npm run tauri:build
```

Tauri 构建前会自动把 `assets/pet` 复制到 `src/assets`，用于打包前端资源。

## 发布给其他人使用

推荐把构建产物上传到 GitHub Releases，而不是直接提交到仓库。

Tauri Windows 构建默认产物在：

```text
src-tauri/target/release/bundle/nsis/
```

普通 Windows 10/11 用户下载 NSIS 安装包后可以直接安装使用。

### WebView2 说明

Tauri 不像 Electron 那样内置 Chromium，而是使用系统 WebView2，所以安装包会小很多。

大多数 Windows 10/11 电脑已经自带 WebView2 Runtime。少数没有 WebView2 的电脑，在安装时会根据 Tauri 配置触发 WebView2 Runtime 下载/安装提示；如果用户网络不可用，也可以手动安装 Microsoft Edge WebView2 Runtime 后再运行桌宠。

当前配置写在 `src-tauri/tauri.conf.json`：

```json
"webviewInstallMode": {
  "type": "downloadBootstrapper",
  "silent": false
}
```

这表示安装包会在需要时下载 WebView2 bootstrapper，并显示安装过程。

## 素材

桌宠素材放在：

```text
assets/pet/
```

构建生成的 `src/assets/` 是临时复制目录，已加入 `.gitignore`，不要手动维护。

## 旧版 Electron

旧 Electron 入口仍保留在 `src/main.js`，但体积较大。当前 Electron portable exe 大约 96MB，Tauri 版目标是显著降低体积。
