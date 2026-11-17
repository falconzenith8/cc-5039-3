# MSE 分片播放内核（浏览器缓冲调度）

一个真正基于 **Media Source Extensions** 的分片播放器内核：通过 `appendBuffer`
逐片追加音视频数据，自己维护下载队列、解码缓冲与播放状态，而不是把一个完整
媒体地址交给 `<video>` 标签。

## 界面怎样启动

前置：Node 18+、Python 3、ffmpeg（仓库已在 `tools/ffmpeg` 放好静态二进制）。

```bash
# 1. 生成 60s VP9/Opus 分片资产（public/media，约 3.5MB）
npm run media

# 2. 启动支持 Range / 延迟 / 故障注入的静态服务器
npm run serve
#  => http://127.0.0.1:8080/
```

浏览器打开后：

- **http://127.0.0.1:8080/** — 图形播放器。可拖动进度条 seek、注入网络延迟/失败/
  截断，时间线实时绘制浏览器报告的视频/音频/交集缓冲范围，右侧显示下载与追加队列、
  统计与事件日志。
- **http://127.0.0.1:8080/test.html** — 9 项端到端测试，点“运行全部用例”。
- **http://127.0.0.1:8080/quota-test.html** — 3 项配额回收专项测试（自动运行）。

> 测试资产使用 WebM/VP9/Opus，因为自动化所用的开源 Chromium 不含专有 H.264/AAC
> 解码。内核本身与容器无关，换成 fMP4 只需替换资产与 `manifest.json` 里的 mimeType。

## 内核如何满足关键约束

代码在 `public/js/kernel/`：

| 约束 | 实现 |
| --- | --- |
| SourceBuffer 异步更新串行协调 | `source-buffer-queue.js`：每个 buffer 一条 Promise 链，`appendBuffer`/`remove` 只在上一个 `updateend` 后发起；外部仍 busy 时直接拒绝而不是抢跑 |
| 追加与移除不竞争 | 所有变更走同一队列；`abort`/`close` 同步化，避免销毁时排在未完成 append 后死锁 |
| 异常回到可解释状态 | 下载层有界退避重试，耗尽后进入显式 `ERROR` 状态并保留失败分片在队首；解码/配额错误不重复盲调，`resume()` 可重新武装 |
| 可播放性以浏览器真实范围为准 | `buffered-ranges.js` 只读 `SourceBuffer.buffered` TimeRanges；下载成功但未解码的字节不计入，可播时长取音视频交集 |
| 容量不足按保留区间回收 | 高水位按总缓冲量触发，`evictablePrefix` 在 `currentTime - retentionSec` 处切割，绝不删除播放头所在区间；配额错误时双轨同步回收后**同片只重试一次** |
| 音视频双缓冲对应 | 下载按视频领头、音频配对规划，两轨游标与回收保持同步，测试断言数量偏差 ≤1 |
| seek 正确 | 需求锚点 `_demandAnchor` 在目标未缓冲时驱动取片；缓冲就绪后重新发起元素 seek，窗口外在途下载被 abort |

## 服务器注入能力（`server.py`）

- 完整 HTTP **Range** 支持（206 + Content-Range）。
- `POST /api/knobs`：`latencyBaseMs`、`latencyJitterMs`、`failRate`（503）、
  `truncateRate`（短字节投递）。
- 单条 URL 加 `?fail=1` / `?truncate=1` 做一次性注入。
- `GET /api/stats` 返回请求/失败/截断/Range 计数。

## 测试

```bash
bash scripts/setup_browser.sh   # 一次性：无 root 装配 headless Chromium 与本地依赖库
npm run test:unit   # 纯内核：范围数学、串行队列、下载重试/中止（Node）
npm run test:e2e    # 真实 headless Chromium 跑 MSE：12 项断言
```

端到端覆盖：短分片真实播放、重复追加去重、下载错误有界重试与 resume、截断解码
错误不重试风暴、高水位回收不碰播放头依赖、seek 中止旧下载并复用重叠缓冲、高延迟
卡顿与恢复连续性、dispose 资源释放、音视频双缓冲对应，以及配额回收三条分支。

`test/e2e/run-browser.mjs` 会自动使用 `vendor/chromelibs` 下解包的本地依赖库与
`~/.cache/ms-playwright` 里的 arm64 headless shell，无需 root。
