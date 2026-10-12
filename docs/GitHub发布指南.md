# 镜策上传 GitHub：先使用私有仓库

本文适用于 `jingce-ai-workbench` 仓库及从该仓库构建的干净发布包。仓库包含完整程序源码、中文首页说明、模型地址说明、现有测试和构建脚本；本机运行时创建的 `runtime/` 不进入 Git 或发布包。

## 推荐方式：GitHub Desktop

1. 注册或登录 [GitHub](https://github.com/)，安装并登录 [GitHub Desktop](https://desktop.github.com/)。
2. 选择 **File → Add local repository**，定位到已准备的 `jingce-ai-workbench` 文件夹。
3. 如果提示不是 Git 仓库，点击提示中的 **create a repository**，使用名称 `jingce-ai-workbench`，Local path 选择它的父文件夹，取消额外生成 README / Git ignore / License 的选项，然后创建。确认目录指向现有发布文件夹。
4. 在 **Changes** 中查看文件，确认包含 `.gitignore`、README、`server.mjs`、`lib/`、`public/` 和文档，且没有 `runtime/`、`*.private.json`、日志或个人媒体文件。填写提交说明，例如 `Initial Jingce workbench source`，点击 **Commit to main**。若创建仓库时已产生初始提交，以界面实际状态为准。
5. 点击 **Publish repository**，名称可用 `jingce-ai-workbench`，简介可写“镜策：本地 AI 图片、视频和文字创作工作台”。**保持勾选 Keep this code private**，再点击发布。
6. 发布完成后通过 **Repository → View on GitHub** 查看仓库。README 会作为首页显示，模型说明中的网站链接可以直接打开。

`.gitignore` 会随版本管理上传；原运行目录中的 API Key 和个人数据不进入发布目录。源码包本身无需上传为单个 ZIP；应上传解压后的代码文件，以便查看代码、更新和协作。

## 另一种方式：Git 命令

先在 [GitHub 新建仓库](https://github.com/new)，填写名称并选择 **Private**。为了便于推送已有文件，创建时不额外添加 README、`.gitignore` 或许可证。

在 `jingce-ai-workbench` 文件夹中打开 PowerShell，按顺序执行以下命令。准备目录已经初始化过 Git 时，第一行再次执行也可以；将最后两行中的地址替换为自己新建仓库的实际 HTTPS 地址。

```powershell
git init -b main
git status --short
git add .
git diff --cached --stat
git commit -m "Initial Jingce workbench source"
git remote add origin https://github.com/你的用户名/jingce-ai-workbench.git
git push -u origin main
```

第一次提交前，确认 Git 作者名称和邮箱是希望记录到提交中的身份。若 Git 提示缺少身份，在此仓库设置 `git config user.name "你的名字"` 和 `git config user.email "你的 GitHub 邮箱或 noreply 邮箱"`，再提交。HTTPS 推送可按 Git Credential Manager 的提示在浏览器登录。GitHub 账号密码不能直接作为 Git HTTPS 推送凭据。

若已存在 `origin`，用 `git remote -v` 查看后再决定是否使用 `git remote set-url origin 你的仓库地址`。不要为了上传而重置已有仓库或强制覆盖远端历史。

## 邀请别人查看和运行

私有仓库中，只有你和获授权的协作者能访问。仓库 **Settings → Collaborators** 中可邀请对方；受邀者接受后，可以查看代码或下载源码。

使用者安装 Node.js 后启动工作台，分别填写自己的图片、视频和文本 API Key。代码授权和模型平台授权是两件独立的事，获得仓库访问权不会附带你的模型余额。

如果仅希望公开模型服务商网址，而暂不公开源码，可另建公开说明仓库或介绍页，把 `docs/模型连接地址.md` 中的无密钥服务入口复制过去。此私有仓库的链接无法给未授权访问者展示文档。

## 提供 Windows 下载包

如果使用者希望双击使用且不另装 Node.js，可以在源码目录执行：

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\package-share.ps1 -ReleaseTag 20261011
```

脚本从白名单构建 Windows x64 分享包，下载并校验官方 Node.js。输出到 `deliveries/`，不会读取或复制已有 `runtime/`。如果该日期的包已存在，请改用新的日期或后缀，例如 `20261011-r2`。

仓库 **Releases → Draft a new release** 中创建版本标签、填写版本说明并上传生成的 ZIP 和 SHA-256 文件。私有仓库的 Release 附件仍需要仓库访问权。已经使用过的安装目录可能含有个人数据，应分发重新构建的干净包。

## 后续更新

日常开发与发布统一在已经关联 GitHub 的 `jingce-ai-workbench` 仓库进行。先通过启动记录中的数据目录和实例身份确认正在查看的工作台来自本仓库，再修改、运行测试和验证页面。机器上存在其他旧副本时，逐项核对其修改是否已合入当前仓库，避免在一套源码中修改、在另一套工作台中验收。

发布前检查 `git status` 与待提交差异，保留当前 `runtime/`。从同一仓库执行 `tools/package-github.ps1` 生成源码包，执行 `tools/package-share.ps1` 生成 Windows 包；两者都使用源码白名单，不会读取个人运行数据。源码包直接使用当前 README，并包括技能文档、浏览器验证脚本和公开工程示例。

例如：

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\package-github.ps1 -ReleaseTag 20261012
```

通过 GitHub Desktop 检查变更、提交并 **Push origin**；命令方式则只暂存已核对的程序、测试和公开文档，检查 `git diff --cached` 后再提交、推送。个人 `runtime/`、截图、输出日志、历史验证笔记和旧压缩包始终留在本地。不要用整个旧工作台目录覆盖当前仓库，也不要强制推送已有历史。

## 仓库与在线网站

GitHub 保存源码，GitHub Pages 提供静态网页。镜策完整功能依赖 `server.mjs` 后端；当前后端监听本机并限制 Host / Origin，不能只上传 `public/` 就获得完整在线工作台。

若后续要提供浏览器直接使用的服务，需要部署 Node.js 后端、配置域名和 HTTPS，并建立用户登录、权限、数据隔离、服务端密钥管理和任务运行机制。当前发布步骤不更改本机服务的访问范围。

官方参考：[创建和上传仓库](https://docs.github.com/en/get-started/start-your-journey/uploading-a-project-to-github) · [GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/about-github-pages)。
