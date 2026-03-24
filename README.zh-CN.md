# hier-viewer

[English](README.md)

一个面向大型 RTL 设计的静态 hierarchy viewer。

`hier-viewer` 用 Rust 生成前端 bundle，用内置的 `slang-hier-exporter` 从 RTL 或预构建 sqlite hierarchy DB 中提取层级、模块统计、源码位置和分析数据，最后输出一个可以直接挂到静态文件服务器上的目录。

生成后的 viewer 支持：

- Treemap、2D Pie、3D 三种主视图
- hierarchy drill-down、tree panel、matches panel
- source reader，支持打开 instance 位置和 module 定义
- filter、analysis pattern、LOC、weighted signal bits
- 本地持久化 UI 配置、bookmark、折叠状态

## 功能展示

下面这些图片不是单纯的截图堆砌，而是在 README 里按功能点展示 `hier-viewer` 的主要能力，从顶层 hierarchy 浏览一直到源码级调试。

### 经典 Treemap 总览

![Classic treemap overview](docs/screenshots/treemap-classic-overview.png)

这是最适合先看整个 chip hierarchy 的视图，能先把顶层大模块的分布看清楚，再继续往下 drill down。

### 按面积重定尺寸的 Accurate Treemap

![Weighted accurate treemap](docs/screenshots/treemap-weighted-accurate.png)

这个视图更强调模块“面积贡献”，而不只是层级分组，所以 SRAM、cache 之类的大块会马上凸显出来。

### 可交互的 2D Pie 图

![2D pie chart](docs/screenshots/chart-2d-pie.png)

它把当前 hierarchy root / level 下的面积组成换一种方式展示，适合比较谁占比最大。

### 3D 加权统计图

![3D weighted chart](docs/screenshots/chart-3d-weighted-bits.png)

同一套 sizing 数据会被渲染成可拖动的 3D 柱状视图，方便从另一种视觉角度比较深层模块分布。

### Instance Wildcard 过滤

![Instance wildcard filter](docs/screenshots/filter-instance-wildcard.png)

这里筛的是 `sram_*`，匹配到的节点被突出显示，其他不相关节点会被弱化，适合快速定位某类实例。

### 高级控制面板与主题切换

![Advanced controls and theme switching](docs/screenshots/advanced-theme-controls.png)

这里可以调 layout、decomp、weighted bit 系数、analysis overlay，以及内置主题，例如 Tokyo Night。

### Zen 模式

![Zen mode treemap](docs/screenshots/zen-mode-treemap.png)

这个模式会尽量去掉界面上的干扰元素，只保留主要图形区域，适合专注查看或者做展示。

### 带 Bookmark 的源码阅读器

![Source reader with bookmarks](docs/screenshots/source-reader-bookmarks.png)

可以直接看 module 源码，做书签、搜索当前文件、打开 raw 文件，以及切到 fullscreen 阅读。

如果你第一次使用，优先看下面的“快速开始”和“常见命令”。

下面大部分命令示例默认都假设 `hier-viewer` 已经在你的 `PATH` 里。
如果你是在源码目录里直接运行，可以把 `hier-viewer` 替换成 `./target/release/hier-viewer`。

## 示例

- [`examples/ibex-example`](examples/ibex-example) 是最推荐先看的示例。它使用固定版本的 `lowRISC/ibex` submodule、静态 filelist，以及两个很短的包装脚本来打开 `ibex_top` 和 `ibex_simple_system`。
- [`examples/openpiton-example`](examples/openpiton-example) 是更高级、更贴近真实项目的示例，演示如何把固定 2x2 的 OpenPiton chip design 展开成生成式 filelist，并且只依赖开源工具链用 `hier-viewer` 打开它。

## 快速开始

### 1. 构建

```bash
cargo build --release
```

第一次构建会比较慢，这是正常的。`build.rs` 会自动：

1. 配置并编译一个尽量静态链接第三方依赖的内置 `slang-hier-exporter`
2. 把 exporter 嵌入 Rust 可执行文件

默认会通过 CMake `FetchContent` 拉取并编译 `slang`。

### 2. 运行

```bash
./target/release/hier-viewer --output out --preview
```

如果当前是交互式终端，并且你没有传 RTL 输入、filelist 或 `--db`，工具会自动打开内置的 TUI wizard。wizard 可以让你：

- 添加 RTL 路径
- 选择 path match mode：`Literal`、`Wildcard`、`Regex`
- 添加 filelist
- 追加额外编译参数，例如 `-I`、`-D`、`+incdir+`、`--top`

### 3. 打开生成结果

这会启动内置本地 preview server，打印最终 viewer URL，并且在本机桌面环境下默认尝试自动打开浏览器。

如果你使用 VSCode Remote 或 Live Server，直接对输出目录起服务仍然是一个可用的兜底方案。

## 依赖要求

### 构建和运行 `hier-viewer`

- Rust toolchain
- `cmake`
- `ninja`
- 支持 C++20 的编译器

### 第一次构建内置 exporter 时

默认会从 GitHub 拉取：

- [MikePopoloski/slang](https://github.com/MikePopoloski/slang)

如果你的环境不能联网，或者你想强制使用本地 `slang` checkout，可以在构建前设置：

```bash
export HIER_VIEWER_EXPORTER_SLANG_SOURCE_DIR=/path/to/slang
```

默认开启 `HIER_VIEWER_EXPORTER_FULLY_STATIC=1`。在 Linux 上它会生成 fully static 的 exporter，在 Windows 上会额外切到静态 MSVC runtime，而在 macOS 上则会保持 `slang` 静态链接，但仍然依赖系统动态链接器，因为 Apple 平台不支持真正的 fully static executable。

如果要关闭这项静态链接偏好：

```bash
export HIER_VIEWER_EXPORTER_FULLY_STATIC=0
```

## 输入模式

viewer 主要有两种输入方式。

### 1. 从 RTL 构建

你可以直接把 RTL 文件、wildcard 模式和 filelist 交给 viewer。它会先内部调用：

```text
slang-hier-exporter --sqlite
```

生成或复用 sqlite cache，再输出 HTML bundle。

补充说明：

- 命令行位置参数 `[rtl ...]` 当前按 `Wildcard` 语义解析，同时也支持精确文件路径
- 如果你想用 `Regex` 模式选择 RTL，推荐用内置 TUI wizard

### 2. 直接读取已有 sqlite DB

如果你已经有预构建好的 hierarchy sqlite DB：

```bash
hier-viewer --db path/to/hiers.db --output out --preview
```

这种模式下不会重新解析 RTL。

## 常见命令

### 例 1：最推荐的第一次使用方式，直接打开 wizard

```bash
hier-viewer --output out --preview
```

尤其适合 RTL 路径、filelist、`+incdir+`、`-D` 很多的时候。

### 例 2：直接传 RTL 文件

```bash
hier-viewer \
  rtl/top.sv \
  rtl/core.sv \
  --output out \
  --preview
```

### 例 3：使用 wildcard RTL 输入

这里要加引号，让模式由 viewer 自己解析，而不是先被 shell 展开。

```bash
hier-viewer \
  'rtl/**/*.sv' \
  'tb/**/*.v' \
  --output out \
  --preview
```

### 例 4：RTL 加额外 slang 参数

`--` 后面的参数会原样透传给 `slang-hier-exporter` / slang driver。

```bash
hier-viewer \
  'rtl/**/*.sv' \
  --output out \
  -- \
  --top Top \
  -I rtl/include \
  -D SYNTHESIS=1 \
  +incdir+third_party/include
```

### 例 5：使用 filelist

```bash
hier-viewer \
  -f rtl/files.f \
  -f tb/files.f \
  --output out \
  -- \
  --top SimTop
```

### 例 6：混合 filelist 和位置参数 RTL 输入

```bash
hier-viewer \
  -f rtl/files.f \
  'rtl/generated/**/*.sv' \
  --output out \
  -- \
  +incdir+rtl/include
```

### 例 7：强制重建 sqlite cache

当你明确知道 RTL、filelist、额外 flags 有变化，或者只是想全量重跑时：

```bash
hier-viewer \
  -r \
  'rtl/**/*.sv' \
  --output out \
  -- \
  --top Top
```

### 例 8：直接读取已有 sqlite

```bash
hier-viewer \
  --db path/to/hiers.db \
  --output out
```

### 例 9：禁用 wizard，只允许命令行显式输入

```bash
hier-viewer \
  --no-wizard \
  'rtl/**/*.sv' \
  --output out \
  -- \
  --top Top
```

### 例 10：打开 debug overlay

```bash
hier-viewer \
  --db path/to/hiers.db \
  --output out \
  --debug
```

`--debug` 会打开额外的调试 overlay，例如 UI label。

### 例 11：使用 release 二进制

```bash
./target/release/hier-viewer \
  --db path/to/hiers.db \
  --output out \
  --preview
```

### 例 12：指定偏好的 preview 端口

```bash
hier-viewer \
  --db path/to/hiers.db \
  --output out \
  --preview \
  --preview-port 9000
```

### 例 13：让 preview 监听所有网卡

```bash
hier-viewer \
  --db path/to/hiers.db \
  --output out \
  --preview \
  --preview-host 0.0.0.0
```

## CLI 速查

```text
hier-viewer [OPTIONS] [rtl ...]
```

常用参数：

- `[rtl ...]`
  RTL 文件路径，或由 viewer 解析的 wildcard 模式
- `--db <file>`
  直接读取预构建 sqlite DB
- `-f, --filelist <file>`
  添加 filelist，可重复
- `-o, --output <dir>`
  输出目录，必填
- `-r, --rebuild-sqlite`
  忽略输出目录下的 sqlite cache 并强制重建
- `--preview`
  在 bundle 生成完成后启动内置本地 preview server
- `--preview-host <h>`
  `--preview` 的绑定地址；默认 `127.0.0.1`；远程访问或端口转发场景可用 `0.0.0.0`
- `--preview-port <n>`
  `--preview` 的偏好起始端口；默认 `8000`，如果被占用会自动顺延
- `--no-wizard`
  不打开 TUI wizard
- `-t, --title <text>`
  自定义页面标题
- `--debug`
  打开 viewer debug overlay
- `-- <args...>`
  把剩余参数透传给 slang / exporter，例如 `-I`、`-D`、`+incdir+`、`--top`

## sqlite Cache 机制

当输入来自 RTL 而不是 `--db` 时，viewer 会在下面维护 cache：

```text
<output>/.hier-viewer-cache/
```

cache key 会综合这些因素：

- RTL 源文件内容和时间戳
- filelist
- 额外 slang 参数
- `slang-hier-exporter` 的 fingerprint

因此：

- 没变化时，会直接复用 sqlite cache
- 输入变化时，会自动重建 sqlite
- 如果你显式传了 `-r` / `--rebuild-sqlite`，一定会强制重建

命令行日志里也会说明这次为什么复用或重建了 cache。

## 输出目录结构

这个工具输出的是一个目录，不是单个 HTML 文件。典型结构如下：

```text
out/
├── index.html
├── viewer-meta.json
├── viewer-core.bin
├── viewer-analysis.bin        # 只有存在分析数据时才会生成
├── viewer-chart.js
├── viewer-three.module.js
├── three.core.js
├── .hier-viewer-sources/      # source reader 用到的相对源码副本
└── .hier-viewer-cache/        # 只有从 RTL 构建 sqlite 时才会出现
```

这也是为什么推荐“输出目录 + 静态文件服务器”的方式，而不是单个独立 HTML。

## 预览建议

### 推荐：内置 preview 模式

```bash
hier-viewer --output out --preview
```

这个模式会一直前台运行，直到你按 `Ctrl-C`。

### 兜底方案：本地或远程静态文件服务

```bash
cd out
python3 -m http.server 8000
```

### 兜底方案：VSCode Live Server

- 适合直接预览 `index.html`
- 适合通过 VSCode Remote 连接远程开发机后使用

### 不推荐：直接 `file://` 打开

某些浏览器会限制：

- 二进制资源加载
- 相对源码文件加载
- `Open Raw` 和 source reader 的行为

## 使用建议

### 1. 让 viewer 自己解析 wildcard

建议这样写：

```bash
'rtl/**/*.sv'
```

不要省略引号，否则 shell 可能会先展开模式，导致 viewer 看不到原始 wildcard。

### 2. `--` 后面只放透传给 slang 的参数

例如：

```bash
-- --top Top -I rtl/include -D FOO=1 +incdir+rtl/include
```

而 `--output`、`--db`、`--debug` 这些 viewer 自己的参数必须放在 `--` 前面。

### 3. 如果想要快的增量运行，尽量复用同一个输出目录

sqlite cache 就放在输出目录下面。如果你每次都换一个新输出目录，也就相当于每次都新建一个 cache 目录。

## 开发者说明

如果你是在这个仓库里迭代开发，仍然可以继续用 Cargo 直接运行：

```bash
cargo run -- --output out --preview
```

但这属于仓库内开发者工作流，所以前面的示例都改成了最终用户更容易直接套用的形式。

### 4. preview 模式默认绑定到 `127.0.0.1`

这是有意为之。对于远程服务器场景，你可以：

- 保持默认值，然后走 SSH 或编辑器的端口转发
- 或者显式传 `--preview-host 0.0.0.0`

## FAQ

### 1. 为什么第一次 `cargo build` 很慢？

因为它同时还要构建 C++ 的 `slang-hier-exporter`，而且第一次构建时可能还需要先拉取 `slang` 源码。

### 2. 为什么我已经有 `hiers.db` 了，还必须传 `--output`？

因为这个工具不会直接显示 sqlite DB，而是会把 sqlite 渲染成一整套静态 viewer bundle。

### 3. 为什么不能同时传 `--db` 和 RTL 输入？

因为这两种模式本来就是互斥的：

- `--db` 表示“直接消费已有 sqlite DB”
- RTL 输入和 `--filelist` 表示“先生成 sqlite，再渲染 viewer”

### 4. 为什么 source reader 或 `Open Raw` 在某些环境下行为怪异？

通常是因为页面通过 `file://` 打开，或者静态服务器没有完整暴露整个输出目录。改成通过 HTTP 服务这个 bundle，一般就正常了。

## 相关文档

- [面积策略说明](docs/area-sizing-strategy.md)

## AI Development

这个项目完全由 AI 协助开发，使用的是 GPT-5.4。
我负责提出 feature、补充相关细节的技术实现方案，并持续指导 AI 完成整个项目的实现。

## Credits

这个项目依赖 [slang](https://github.com/MikePopoloski/slang) 来完成 hierarchy 解析、语义分析和 elaboration。

特别感谢 `slang` 的作者和贡献者，提供了高质量、可扩展、工程可用的 SystemVerilog 前端与 elaboration 基础设施。当前项目内置的 `slang-hier-exporter` 就是直接建立在 `slang` 的 C++ API 之上的。
