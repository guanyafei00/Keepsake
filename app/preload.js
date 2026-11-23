const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('keepsake', {
  probe: () => ipcRenderer.invoke('engine:probe'),
  checkUpdate: () => ipcRenderer.invoke('engine:checkUpdate'),
  applyUpdate: (engine, url, sha256) => ipcRenderer.invoke('engine:applyUpdate', { engine, url, sha256 }),
  pickLocalEngine: (engine) => ipcRenderer.invoke('engine:pickLocal', { engine }),
  strategySnapshot: () => ipcRenderer.invoke('strategy:snapshot'),
  strategyRefresh: () => ipcRenderer.invoke('strategy:refresh'),
  strategyVersion: () => ipcRenderer.invoke('strategy:version'),
  identify: (url, timeoutMs) => ipcRenderer.invoke('link:identify', url, timeoutMs),
  confirmCard: (url, meta) => ipcRenderer.invoke('link:confirmCard', { url, meta }),   // #41 确认卡片数据组装（主进程纯函数 + 封面转 dataURL）
  markClipboardSelf: (url) => ipcRenderer.invoke('clipboard:markSelf', { url }),       // app 自己复制进剪贴板的 URL 标记（监听不提示）
  addTasks: (urls, opts) => ipcRenderer.invoke('queue:add', { urls, opts }),
  cancel: (id) => ipcRenderer.invoke('queue:cancel', { id }),
  retry: (id) => ipcRenderer.invoke('queue:retry', { id }),
  removeTask: (id) => ipcRenderer.invoke('queue:remove', { id }),
  clearFinished: () => ipcRenderer.invoke('queue:clearFinished'),
  snapshot: () => ipcRenderer.invoke('queue:snapshot'),
  resumeInterrupted: () => ipcRenderer.invoke('queue:resumeInterrupted'),     // #39 一键恢复中断任务
  dismissInterrupted: () => ipcRenderer.invoke('queue:dismissInterrupted'),   // #39 忽略中断提示（清除标记）
  outDir: () => ipcRenderer.invoke('app:outDir'),
  subsList: () => ipcRenderer.invoke('subs:list'),
  subsGetStatus: () => ipcRenderer.invoke('subs:getStatus'),
  storageGetDownloadCapacity: () => ipcRenderer.invoke('storage:getDownloadCapacity'),
  subsAdd: (url, name, maxBackfill) => ipcRenderer.invoke('subs:add', { url, name, maxBackfill }),
  subsRemove: (id) => ipcRenderer.invoke('subs:remove', { id }),
  subsCheck: (id) => ipcRenderer.invoke('subs:check', { id }),
  openSubUrl: (id) => ipcRenderer.invoke('subs:openUrl', { id }),
  openLibSource: (filePath) => ipcRenderer.invoke('lib:openSource', { filePath }),
  subsResume: (id) => ipcRenderer.invoke('subs:resume', { id }),
  subsBackfill: (id) => ipcRenderer.invoke('subs:backfill', { id }),
  subsOpenFolder: (id) => ipcRenderer.invoke('subs:openFolder', { id }),
  subsGoneFiles: (id) => ipcRenderer.invoke('subs:goneFiles', { id }),
  subsExportGone: () => ipcRenderer.invoke('subs:exportGone'),
  subsSetKw: (id, kw) => ipcRenderer.invoke('subs:setKw', { id, kw }),
  subsUpdate: (id, patch) => ipcRenderer.invoke('subs:update', { id, patch }),
  textSearch: (q, limit) => ipcRenderer.invoke('text:search', { q, limit }),
  libSummarize: (key, paths) => ipcRenderer.invoke('lib:summarize', { key, paths: Array.isArray(paths) ? paths : [] }),
  settingsExport: () => ipcRenderer.invoke('settings:export'),
  settingsImport: () => ipcRenderer.invoke('settings:import'),
  settingsSetMinFree: (mb) => ipcRenderer.invoke('settings:setMinFree', { mb }),
  settingsSetQueue: (max, rate) => ipcRenderer.invoke('settings:setQueue', { max, rate }),
  settingsSetBackfillParallel: (n) => ipcRenderer.invoke('settings:setBackfillParallel', { n }),
  libTrash: (filePath) => ipcRenderer.invoke('lib:trash', { filePath }),
  libraryScan: () => ipcRenderer.invoke('library:scan'),
  libraryMakeCbz: (p) => ipcRenderer.invoke('library:makeCbz', { p }),   // #37 媒体库一键成册（散图目录 → .cbz 漫画册）
  articleOpen: (filePath) => ipcRenderer.invoke('article:open', { filePath }),     // 文章引擎：浏览器打开本地存档
  articleRecheck: (filePath) => ipcRenderer.invoke('article:recheck', { filePath }), // 文章引擎：重新检查原文（删帖/编辑检测）
  openFolder: (p) => ipcRenderer.invoke('app:openFolder', p),
  openFileLocal: (p) => ipcRenderer.invoke('app:openFile', p),   // 直接打开本地文件（媒体库点卡即看）
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  aiGetConfig: () => ipcRenderer.invoke('ai:getConfig'),
  aiSaveConfig: (cfg) => ipcRenderer.invoke('ai:saveConfig', cfg),
  aiRun: (p, task) => ipcRenderer.invoke('ai:run', { p, task }),
  aiFetchModels: () => ipcRenderer.invoke('ai:fetchModels'),
  settingsGet: () => ipcRenderer.invoke('settings:get'),
  settingsPickDir: () => ipcRenderer.invoke('settings:pickDir'),
  settingsSetProxy: (proxy) => ipcRenderer.invoke('settings:setProxy', { proxy }),
  settingsSetCookieBrowser: (b) => ipcRenderer.invoke('settings:setCookieBrowser', { b }),
  settingsSetBiliLine: (l) => ipcRenderer.invoke('settings:setBiliLine', { line: l }),
  settingsSetCbz: (on) => ipcRenderer.invoke('settings:setCbz', { on }),
  settingsSetAutoSubtitle: (on) => ipcRenderer.invoke('settings:setAutoSubtitle', { on }),   // 自动字幕总开关（S2）
  settingsSetUi: (ui) => ipcRenderer.invoke('settings:setUi', ui),   // U6 外观（theme/accent/layout）
  appVersion: () => ipcRenderer.invoke('app:version'),
  appCheckUpdate: () => ipcRenderer.invoke('app:checkUpdate'),
  appApplyUpdate: (url, sha256) => ipcRenderer.invoke('app:applyUpdate', { url, sha256 }),
  setUpdateUrl: (url) => ipcRenderer.invoke('settings:setUpdateUrl', { url }),
  setEngineAuto: (on) => ipcRenderer.invoke('settings:setEngineAuto', { on }),
  setAutoStart: (on) => ipcRenderer.invoke('settings:setAutoStart', { on }),
  setNotify: (o) => ipcRenderer.invoke('settings:setNotify', o),
  setClipboardWatch: (on) => ipcRenderer.invoke('settings:setClipboard', { on }),
  settingsSetClipboardWatch: (on) => ipcRenderer.invoke('settings:setClipboard', { on }),   // 别名：与 settingsSetXxx 命名族一致（index.html 调用名），两写法等价
  onClipboardUrl: (cb) => ipcRenderer.on('clipboard:url', (e, d) => cb(d)),
  onToast: (cb) => ipcRenderer.on('toast:event', (e, d) => cb(d)),
  cookieInfo: () => ipcRenderer.invoke('cookie:info'),
  cookieImport: () => ipcRenderer.invoke('cookie:import'),
  cookieOpenDir: () => ipcRenderer.invoke('cookie:openDir'),
  cookieState: () => ipcRenderer.invoke('cookie:state'),
  cookieReadBrowser: () => ipcRenderer.invoke('cookie:readBrowser'),
  pixivLogin: () => ipcRenderer.invoke('pixiv:login'),
  pixivState: () => ipcRenderer.invoke('pixiv:state'),
  asrModels: () => ipcRenderer.invoke('asr:models'),
  asrSetMirror: (id) => ipcRenderer.invoke('asr:setMirror', { id }),
  asrDownload: (id) => ipcRenderer.invoke('asr:download', { id }),
  asrCancelDownload: (id) => ipcRenderer.invoke('asr:cancelDownload', { id }),
  asrSetModel: (id) => ipcRenderer.invoke('asr:setModel', { id }),
  asrDeleteModel: (id) => ipcRenderer.invoke('asr:deleteModel', { id }),
  asrTranscribe: (filePath) => ipcRenderer.invoke('asr:transcribe', { filePath }),
  asrBatch: (paths) => ipcRenderer.invoke('asr:batch', { paths }),
  srtTranslate: (filePath) => ipcRenderer.invoke('srt:translate', { filePath }),
  srtBurn: (filePath) => ipcRenderer.invoke('srt:burn', { filePath }),
  onLibJob: (cb) => ipcRenderer.on('lib:job', (e, d) => cb(d)),
  onAsrProgress: (cb) => ipcRenderer.on('asr:progress', (e, d) => cb(d)),
  onAsrPhase: (cb) => ipcRenderer.on('asr:phase', (e, d) => cb(d)),
  onAsrDownloadProgress: (cb) => ipcRenderer.on('asr:downloadProgress', (e, d) => cb(d)),
  onAsrDone: (cb) => ipcRenderer.on('asr:done', (e, d) => cb(d)),
  onAsrError: (cb) => ipcRenderer.on('asr:error', (e, d) => cb(d)),
  openLogin: () => ipcRenderer.invoke('login:open'),
  loginState: () => ipcRenderer.invoke('login:state'),
  logout: () => ipcRenderer.invoke('login:logout'),
  // ===== #32 本土平台受控浏览器（视频号 / 小红书）=====
  openChannels: (url) => ipcRenderer.invoke('channels:open', { url }),            // 打开视频号持久化受控窗口（可带分享页初始 URL）
  channelsState: () => ipcRenderer.invoke('channels:state'),
  clearChannelsSession: () => ipcRenderer.invoke('channels:clearSession'),
  openXhs: (url) => ipcRenderer.invoke('xhs:open', { url }),          // 打开小红书持久化受控窗口（可带初始页面）
  xhsState: () => ipcRenderer.invoke('xhs:state'),
  clearXhsSession: () => ipcRenderer.invoke('xhs:clearSession'),
  clearNativeSession: (site) => ipcRenderer.invoke('nativeSession:clear', { site }),  // 统一会话清理入口
  addDirect: (payload) => ipcRenderer.invoke('queue:addDirect', { payload }),         // 归档载荷免嗅探直落入队
  // ===== M-A5 公众号追更 =====
  wereadLogin: () => ipcRenderer.invoke('weread:login'),               // 打开扫码登录窗口（阻塞至成功/关闭/超时）
  wereadState: () => ipcRenderer.invoke('weread:state'),               // 登录状态探针（loggedIn/nickname/expired/lastRenewalAt）
  wereadLogout: () => ipcRenderer.invoke('weread:logout'),             // 清除会话（分区 storage + state 文件）
  wereadSearch: (keyword) => ipcRenderer.invoke('weread:search', { keyword }),   // 搜索公众号候选 [{mpId,title}]
  wereadAdd: (p) => ipcRenderer.invoke('weread:add', p || {}),         // 添加公众号订阅（{mpId,url,name} 二选一路径）
  wereadClearExpired: () => ipcRenderer.invoke('weread:clearExpired'), // 手动确认已重新登录：清失效标记并立即补检
  onChannelsEvent: (cb) => ipcRenderer.on('channels:event', (e, d) => cb(d)),
  onXhsEvent: (cb) => ipcRenderer.on('xhs:event', (e, d) => cb(d)),
  onLibraryRefresh: (cb) => ipcRenderer.on('library:changed', () => cb()),
  onInterrupted: (cb) => ipcRenderer.on('queue:interrupted', (e, d) => cb(d)),   // #39 异常退出中断提示
  onQueue: (cb) => ipcRenderer.on('queue:snapshot', (e, snap) => cb(snap)),
  onSubs: (cb) => ipcRenderer.on('subs:changed', (e, subs) => cb(subs)),
  onEngineProgress: (cb) => ipcRenderer.on('engine:progress', (e, d) => cb(d))
});
