/**
 * The shell's own interface language, and every string it shows.
 *
 * Pure on purpose: no Electron import, so `node --test` can load this directly
 * and assert the whole inventory without a display. `main.js` owns the one
 * Electron-dependent step — appending Chromium's `--lang` switch — and reads it
 * from here.
 *
 * Three things about this module are deliberate and worth stating:
 *
 * - **The dictionary owns whole sentences, never fragments.** The harness name
 *   is spelled inside each message that needs it (`product.name` exists for the
 *   places that show the name alone), so a translation can never be assembled
 *   from pieces that reorder badly in Chinese.
 * - **`en` is the fallback and the reference.** A missing key renders the key
 *   itself, which is visible rather than silent.
 * - **A missing parameter throws.** Rendering `{path}` literally would look like
 *   a translated message and send a reader looking in the wrong place.
 *
 * The `auto` rule deliberately mirrors the web GUI's own resolver
 * (`@deepseek-ai/dsh-client-locale/lib/client.js:1344-1355`): walk the ordered
 * language list and take the first language whose primary subtag is one this
 * shell ships. A user asking for `['fr-FR', 'zh-CN']` therefore gets Chinese
 * here and in the GUI alike.
 *
 * @module dsh-desktop/i18n
 */

/** The product name. Never translated; it is a name. */
export const APP_NAME = 'DSH Desktop';

/** The three settings a user can choose. `auto` resolves against the system. */
export const LANGUAGES = Object.freeze(['auto', 'zh', 'en']);

/** Chromium's interface-language tag per resolved language. */
const CHROMIUM_LANGUAGE = Object.freeze({ zh: 'zh-CN', en: 'en-US' });

/** The language `auto` and every failure falls back to. */
export const FALLBACK_LANGUAGE = 'en';

/**
 * Every message id the shell can show. This tuple is the inventory and the
 * single source of truth: `MESSAGES` is typed against it, so a translation that
 * misses an id fails at module load rather than on the screen.
 */
export const MESSAGE_IDS = Object.freeze([
  // The window, the CLI text and the tray.
  'product.name',
  'window.title',
  'window.settings',
  'usage.body',
  'tray.tooltip',
  'tray.show',
  'tray.noWorkspace',
  'tray.openFolder',
  'tray.quit',
  'jump.openApp',
  'jump.openFolder',

  // Startup, restarts and failures.
  'status.starting',
  'status.restartingWorkspace',
  'status.restartingAttempt',
  'status.notRendered',
  'status.notLoaded',
  'status.interfaceStopped',
  'status.couldNotStart',
  'status.hint',
  'dialog.stopped',
  'dialog.restart',
  'dialog.showLogs',
  'dialog.dismiss',
  'harness.exited',
  'harness.gaveUp',
  'harness.bootTimeout',
  'harness.spawnFailed',
  'install.notFound',
  'install.noManifest',
  'install.badManifest',
  'install.noBin',
  'install.binMissing',
  'node.notFound',
  'node.dshNodeMissing',
  'version.bundled',
  'version.nodeNote',

  // Notes from `normalizeConfig`, rendered by `problemMessage`.
  'config.problem.notObject',
  'config.problem.integer',
  'config.problem.boolean',
  'config.problem.nonEmptyString',
  'config.problem.oneOf',

  // The File menu.
  'menu.file',
  'menu.openFolder',
  'menu.settings',
  'menu.copyUrl',
  'menu.openInBrowser',
  'menu.quit',

  // The View menu. Electron's `role:` items are labelled in English on Windows,
  // so each one is named here explicitly; the role still supplies the shortcut.
  'menu.view',
  'menu.reload',
  'menu.forceReload',
  'menu.toggleDevTools',
  'menu.actualSize',
  'menu.zoomIn',
  'menu.zoomOut',
  'menu.toggleFullScreen',

  // The Help menu.
  'menu.help',
  'menu.showLogFolder',
  'menu.exportDiagnostics',
  'menu.about',

  // Dialogs.
  'dialog.chooseWorkspace',
  'dialog.diagnosticsWritten',
  'dialog.diagnosticsDetail',
  'dialog.aboutTitle',
  'dialog.aboutDetail',
  'dialog.ok',

  // The pre-harness page.
  'page.starting',

  // Settings: section headings and the rows.
  'settings.title',
  'settings.section.workspace',
  'settings.section.harness',
  'settings.section.behaviour',
  'settings.section.about',
  'settings.workspace.current',
  'settings.workspace.choose',
  'settings.workspace.hint',
  'settings.port',
  'settings.port.hint',
  'settings.bootTimeout',
  'settings.bootTimeout.hint',
  'settings.restartLimit',
  'settings.restartLimit.hint',
  'settings.restartWindow',
  'settings.grace',
  'settings.grace.hint',
  'settings.maxWindows',
  'settings.maxWindows.hint',
  'settings.language',
  'settings.language.hint',
  'settings.language.auto',
  'settings.language.zh',
  'settings.language.en',
  'settings.closeToTray',
  'settings.hideToTray',
  'settings.hotkey',
  'settings.hotkey.placeholder',
  'settings.hotkey.hint',
  'settings.versions',
  'settings.dataFolder',
  'settings.open',
  'settings.logs',
  'settings.save',
  'settings.restartHarness',
  'settings.restoreDefaults',
  'settings.exportDiagnostics',

  // Settings: the footer's status line, set from script.
  'settings.saved',
  'settings.savedRefused',
  'settings.defaultsLoaded',
  'settings.choosingRestart',
  'settings.restarting',
  'settings.restarted',
  'settings.diagnosticsFailed',
  'settings.diagnosticsWritten',
  'settings.loadFailed',
  'settings.restartForLanguage',
]);

/**
 * The message tables. `en` is the reference; a key present only in `zh` would
 * render as the key itself whenever the fallback is active, which is why
 * `test/i18n.test.mjs` asserts the two key sets are identical.
 *
 * @type {Readonly<Record<'zh' | 'en', Readonly<Record<string, string>>>>}
 */
export const MESSAGES = Object.freeze({
  zh: Object.freeze({
    'product.name': 'DSH Desktop',
    'window.title': 'DSH Desktop',
    'window.settings': 'DSH Desktop — 设置',
    'usage.body': `DSH Desktop — DeepSeek Harness 的桌面外壳。

用法：
  DSH Desktop [文件夹]              以该文件夹作为 harness 工作区打开
  DSH Desktop --workspace <文件夹>  同上，写成显式开关
  DSH Desktop --settings            打开时显示设置窗口
  DSH Desktop --language <语言>     auto（跟随系统）、zh 或 en
  DSH Desktop --version             打印版本后退出
  DSH Desktop --help                打印本说明后退出

关闭窗口即退出，除非在
%APPDATA%\\DSH Desktop\\config.json 里设置了 closeToTray。
`,
    'tray.tooltip': 'DSH Desktop — {workspace}',
    'tray.show': '显示 DSH Desktop',
    'tray.noWorkspace': 'DSH Desktop',
    'tray.openFolder': '打开文件夹…',
    'tray.quit': '退出',
    'jump.openApp': '打开 DSH Desktop',
    'jump.openFolder': '打开 {folder}',

    'status.starting': '正在启动 DeepSeek Harness…',
    'status.restartingWorkspace': '正在 {workspace} 中重启 DeepSeek Harness…',
    'status.restartingAttempt': 'harness 已停止，正在重启（第 {attempt} 次尝试）…',
    'status.notRendered':
      'harness 正在运行，但它的界面没有渲染出来。详情见日志（帮助 → 显示日志文件夹）。',
    'status.notLoaded': 'harness 正在运行，但它的界面没有加载完成。见「帮助 → 显示日志文件夹」。',
    'status.interfaceStopped': '界面进程意外停止。详情见日志（帮助 → 显示日志文件夹）。',
    'status.couldNotStart': 'DSH Desktop 无法启动。\n\n{message}',
    'status.hint': '完整输出在日志里。见菜单「帮助 → 显示日志文件夹」。',
    'dialog.stopped': 'DeepSeek Harness 已停止',
    'dialog.restart': '重启 DSH',
    'dialog.showLogs': '显示日志',
    'dialog.dismiss': '关闭',
    'harness.exited': 'harness 退出了（退出码={code} 信号={signal}）。',
    'harness.gaveUp': '{reason} 它连续退出了 {count} 次，因此本外壳已停止重启它。',
    'harness.bootTimeout':
      'harness 在 {seconds} 秒内没有报告它的 URL。输出在日志里。' +
      '通常意味着 DSH 目录树加载失败，或者 PATH 上的 Node.js 版本对太旧。',
    'harness.spawnFailed': '无法启动 harness：{message}',
    'install.notFound':
      '在 {link} 没有找到 DSH 安装。请安装或重新安装 DeepSeek Harness（`dsh` 命令），' +
      '或者安装在其他位置时设置 DSH_HOME。',
    'install.noManifest': '{dir} 处的 DSH 安装没有 package.json（由 {link} 解析而来）。',
    'install.badManifest': '{dir} 处的 DSH 安装其 package.json 无法读取：{message}',
    'install.noBin': '{manifest} 处的 DSH 包没有声明 bin.dsh 入口。',
    'install.binMissing': 'DSH 命令行入口 {binPath}（来自 bin.dsh）不存在。',
    'node.notFound':
      '在 PATH 上没有找到 Node.js（在 {count} 个目录里查找 {executable}）。' +
      '请安装 Node.js，或用 DSH_NODE 指定它的完整路径。',
    'node.dshNodeMissing': 'DSH_NODE 指向 {override}，但该路径不存在。',
    'version.bundled': '内置：Electron {electron}（其 Node {node}，Chromium {chrome}）\n',
    'version.nodeNote': 'harness 运行在 PATH 上的 Node；用 --settings 查看解析到的路径\n',

    'config.problem.notObject': 'config 不是一个对象；改用默认值。',
    'config.problem.integer': 'config.{key} 必须是 {min}..{max} 之间的整数，实际是 {got}；改用 {using}。',
    'config.problem.boolean': 'config.{key} 必须是布尔值，实际是 {got}；改用 {using}。',
    'config.problem.nonEmptyString': 'config.{key} 必须是非空字符串或 null，实际是 {got}；改用 {using}。',
    'config.problem.oneOf': 'config.{key} 必须是 {allowed} 之一，实际是 {got}；改用 {using}。',

    'menu.file': '文件',
    'menu.openFolder': '打开文件夹…',
    'menu.settings': '设置…',
    'menu.copyUrl': '复制界面地址',
    'menu.openInBrowser': '在浏览器中打开',
    'menu.quit': '退出',
    'menu.view': '视图',
    'menu.reload': '重新载入',
    'menu.forceReload': '强制重新载入',
    'menu.toggleDevTools': '开发者工具',
    'menu.actualSize': '实际大小',
    'menu.zoomIn': '放大',
    'menu.zoomOut': '缩小',
    'menu.toggleFullScreen': '切换全屏',
    'menu.help': '帮助',
    'menu.showLogFolder': '显示日志文件夹',
    'menu.exportDiagnostics': '导出诊断…',
    'menu.about': '关于 DSH Desktop',

    'dialog.chooseWorkspace': '为 DSH Desktop 选择工作区',
    'dialog.diagnosticsWritten': '诊断已写出',
    'dialog.diagnosticsDetail':
      '{path}\n\n其中包含版本、设置、状态和最近三个日志，并且删除了任何令牌。',
    'dialog.aboutTitle': '关于 DSH Desktop',
    'dialog.aboutDetail':
      'DeepSeek Harness 的桌面外壳。\n\n' +
      'Harness 配置文件：web（你自己的配置文件，含你自己的插件）\n' +
      '工作区：{workspace}\n' +
      '设置：{configPath}\n' +
      '日志：{logDir}',
    'dialog.ok': '确定',

    'page.starting': '正在启动 DeepSeek Harness…',

    'settings.title': 'DSH Desktop — 设置',
    'settings.section.workspace': '工作区',
    'settings.section.harness': 'Harness',
    'settings.section.behaviour': '行为',
    'settings.section.about': '关于',
    'settings.workspace.current': '当前',
    'settings.workspace.choose': '选择文件夹…',
    'settings.workspace.hint': '立即生效，会重启 harness',
    'settings.port': '端口',
    'settings.port.hint': '0 表示让操作系统选一个空闲端口；固定端口可能与你自己运行的 `dsh web` 冲突',
    'settings.bootTimeout': '启动超时（毫秒）',
    'settings.bootTimeout.hint': '等待 harness 报告 URL 的时间上限',
    'settings.restartLimit': '重启次数上限',
    'settings.restartLimit.hint': '在本外壳放弃重启前容忍的意外退出次数',
    'settings.restartWindow': '重启计数窗口（毫秒）',
    'settings.grace': '退出宽限期（毫秒）',
    'settings.grace.hint': '退出时等待子进程结束再放弃确认的时间',
    'settings.maxWindows': '工作区窗口数',
    'settings.maxWindows.hint': '同时可打开的工作区数量；每个都是一个完整的 harness',
    'settings.language': '语言',
    'settings.language.hint': '「自动」跟随系统语言；界面语言在重启本应用后生效',
    'settings.language.auto': '自动（跟随系统）',
    'settings.language.zh': '中文',
    'settings.language.en': 'English',
    'settings.closeToTray': '关闭窗口时',
    'settings.hideToTray': '隐藏到托盘而不是退出',
    'settings.hotkey': '全局快捷键',
    'settings.hotkey.placeholder': 'Control+Alt+D',
    'settings.hotkey.hint': '在任何地方显示或隐藏窗口；留空即关闭该功能',
    'settings.versions': '版本',
    'settings.dataFolder': '数据文件夹',
    'settings.open': '打开',
    'settings.logs': '日志',
    'settings.save': '保存',
    'settings.restartHarness': '重启 harness',
    'settings.restoreDefaults': '恢复默认值',
    'settings.exportDiagnostics': '导出诊断',

    'settings.saved': '已保存。',
    'settings.savedRefused': '已保存，但以下取值被拒绝：{problems}',
    'settings.defaultsLoaded': '已载入默认值 —— 按「保存」保留它们。',
    'settings.choosingRestart': '正在 {workspace} 中重启…',
    'settings.restarting': '正在重启…',
    'settings.restarted': '已重启。',
    'settings.diagnosticsFailed': '无法写出诊断包 —— 见日志。',
    'settings.diagnosticsWritten': '已写出到 {path}',
    'settings.loadFailed': '无法载入设置：{message}',
    'settings.restartForLanguage': '已保存。重启本应用后界面语言生效。',
  }),

  en: Object.freeze({
    'product.name': APP_NAME,
    'window.title': APP_NAME,
    'window.settings': `${APP_NAME} — Settings`,
    'usage.body': `${APP_NAME} — a desktop shell for DeepSeek Harness.

Usage:
  DSH Desktop [folder]              open with that folder as the harness workspace
  DSH Desktop --workspace <folder>  the same, spelled out
  DSH Desktop --settings            open with the settings window showing
  DSH Desktop --language <lang>     auto (follow the system), zh, or en
  DSH Desktop --version             print versions and exit
  DSH Desktop --help                print this and exit

Closing the window quits unless closeToTray is set in
%APPDATA%\\DSH Desktop\\config.json.
`,
    'tray.tooltip': `${APP_NAME} — {workspace}`,
    'tray.show': `Show ${APP_NAME}`,
    'tray.noWorkspace': APP_NAME,
    'tray.openFolder': 'Open Folder…',
    'tray.quit': 'Quit',
    'jump.openApp': `Open ${APP_NAME}`,
    'jump.openFolder': 'Open {folder}',

    'status.starting': 'Starting DeepSeek Harness…',
    'status.restartingWorkspace': 'Restarting DeepSeek Harness in {workspace}…',
    'status.restartingAttempt': 'The harness stopped; restarting (attempt {attempt})…',
    'status.notRendered':
      'The harness is running, but its interface did not render. ' +
      'The log has the details (Help → Show Log Folder).',
    'status.notLoaded': 'The harness is running, but its interface did not load. See Help → Show Log Folder.',
    'status.interfaceStopped': 'The interface stopped unexpectedly. The log has the details (Help → Show Log Folder).',
    'status.couldNotStart': `${APP_NAME} could not start.\n\n{message}`,
    'status.hint': 'The log has the full output. See Help → Show Log Folder in the menu.',
    'dialog.stopped': 'DeepSeek Harness stopped',
    'dialog.restart': 'Restart DSH',
    'dialog.showLogs': 'Show Logs',
    'dialog.dismiss': 'Dismiss',
    'harness.exited': 'The harness exited (code={code} signal={signal}).',
    'harness.gaveUp': '{reason} It exited {count} times in a row, so this shell has stopped restarting it.',
    'harness.bootTimeout':
      'The harness did not report a URL within {seconds}s. Its output is in the log. ' +
      'This usually means the DSH tree failed to load, or that the Node.js on PATH is too old for it.',
    'harness.spawnFailed': 'Could not start the harness: {message}',
    'install.notFound':
      'DSH installation not found at {link}. Install or reinstall DeepSeek Harness ' +
      '(the `dsh` command), or set DSH_HOME if it lives elsewhere.',
    'install.noManifest': 'DSH installation at {dir} has no package.json (resolved from {link}).',
    'install.badManifest': 'DSH installation at {dir} has an unreadable package.json: {message}',
    'install.noBin': 'DSH package at {manifest} declares no bin.dsh entry.',
    'install.binMissing': 'DSH CLI entry {binPath} (from bin.dsh) does not exist.',
    'node.notFound':
      'Node.js was not found on PATH (looked for {executable} in {count} ' +
      'director{plural}). Install Node.js, or set DSH_NODE to its full path.',
    'node.dshNodeMissing': 'DSH_NODE is set to {override}, which does not exist.',
    'version.bundled': 'bundled with: Electron {electron} (its Node {node}, Chromium {chrome})\n',
    'version.nodeNote': 'harness runs on the Node found on PATH; see --settings for the resolved path\n',

    'config.problem.notObject': 'config is not an object; using defaults.',
    'config.problem.integer': 'config.{key} must be an integer in {min}..{max}, got {got}; using {using}.',
    'config.problem.boolean': 'config.{key} must be a boolean, got {got}; using {using}.',
    'config.problem.nonEmptyString': 'config.{key} must be a non-empty string or null, got {got}; using {using}.',
    'config.problem.oneOf': 'config.{key} must be one of {allowed}, got {got}; using {using}.',

    'menu.file': 'File',
    'menu.openFolder': 'Open Folder…',
    'menu.settings': 'Settings…',
    'menu.copyUrl': 'Copy GUI URL',
    'menu.openInBrowser': 'Open in Browser',
    'menu.quit': 'Quit',
    'menu.view': 'View',
    'menu.reload': 'Reload',
    'menu.forceReload': 'Force Reload',
    'menu.toggleDevTools': 'Toggle Developer Tools',
    'menu.actualSize': 'Actual Size',
    'menu.zoomIn': 'Zoom In',
    'menu.zoomOut': 'Zoom Out',
    'menu.toggleFullScreen': 'Toggle Full Screen',
    'menu.help': 'Help',
    'menu.showLogFolder': 'Show Log Folder',
    'menu.exportDiagnostics': 'Export Diagnostics…',
    'menu.about': `About ${APP_NAME}`,

    'dialog.chooseWorkspace': `Choose the workspace for ${APP_NAME}`,
    'dialog.diagnosticsWritten': 'Diagnostics written',
    'dialog.diagnosticsDetail':
      '{path}\n\nIt contains versions, settings, state and the last three logs, with any token removed.',
    'dialog.aboutTitle': `About ${APP_NAME}`,
    'dialog.aboutDetail':
      `A desktop shell for DeepSeek Harness.\n\n` +
      `Harness profile: web (your own profile, with your plugins)\n` +
      `Workspace: {workspace}\n` +
      `Settings: {configPath}\n` +
      `Logs: {logDir}`,
    'dialog.ok': 'OK',

    'page.starting': 'Starting DeepSeek Harness…',

    'settings.title': `${APP_NAME} — Settings`,
    'settings.section.workspace': 'Workspace',
    'settings.section.harness': 'Harness',
    'settings.section.behaviour': 'Behaviour',
    'settings.section.about': 'About',
    'settings.workspace.current': 'Current',
    'settings.workspace.choose': 'Choose folder…',
    'settings.workspace.hint': 'applies immediately, restarting the harness',
    'settings.port': 'Port',
    'settings.port.hint': '0 lets the OS choose a free one; a fixed port can collide with your own `dsh web`',
    'settings.bootTimeout': 'Boot timeout (ms)',
    'settings.bootTimeout.hint': 'how long to wait for the harness to report its URL',
    'settings.restartLimit': 'Restart limit',
    'settings.restartLimit.hint': 'unexpected exits tolerated before the shell stops restarting',
    'settings.restartWindow': 'Restart window (ms)',
    'settings.grace': 'Shutdown grace (ms)',
    'settings.grace.hint': 'how long a quit waits for the child to die before giving up on confirming it',
    'settings.maxWindows': 'Workspace windows',
    'settings.maxWindows.hint': 'how many workspaces may be open at once; each one is a whole harness',
    'settings.language': 'Language',
    'settings.language.hint': 'Auto follows the system language; the interface language takes effect after a restart',
    'settings.language.auto': 'Auto (follow the system)',
    'settings.language.zh': '中文',
    'settings.language.en': 'English',
    'settings.closeToTray': 'Closing the window',
    'settings.hideToTray': 'hide to the tray instead of quitting',
    'settings.hotkey': 'Global shortcut',
    'settings.hotkey.placeholder': 'Control+Alt+D',
    'settings.hotkey.hint': 'shows or hides the window from anywhere; leave empty to disable',
    'settings.versions': 'Versions',
    'settings.dataFolder': 'Data folder',
    'settings.open': 'Open',
    'settings.logs': 'Logs',
    'settings.save': 'Save',
    'settings.restartHarness': 'Restart harness',
    'settings.restoreDefaults': 'Restore defaults',
    'settings.exportDiagnostics': 'Export diagnostics',

    'settings.saved': 'Saved.',
    'settings.savedRefused': 'Saved, but these were refused: {problems}',
    'settings.defaultsLoaded': 'Defaults loaded — press Save to keep them.',
    'settings.choosingRestart': 'Restarting in {workspace}…',
    'settings.restarting': 'Restarting…',
    'settings.restarted': 'Restarted.',
    'settings.diagnosticsFailed': 'Could not write the bundle — see the log.',
    'settings.diagnosticsWritten': 'Written to {path}',
    'settings.loadFailed': 'Could not load settings: {message}',
    'settings.restartForLanguage': 'Saved. Restart the app for the interface language to take effect.',
  }),
});

/**
 * The language an explicit choice resolves to.
 * @param choice - `auto`, `zh`, `en`, or anything else (which falls back to `auto`).
 * @param systemLanguage - what `auto` resolves to.
 * @returns `zh` or `en`, never `auto`.
 */
export function languageOf(choice, systemLanguage) {
  return choice === 'zh' || choice === 'en' ? choice : systemLanguage;
}

/**
 * Pick the language this shell shows, from an ordered list of system languages.
 *
 * The rule matches the web GUI's browser resolver: the first language whose
 * primary subtag is one the shell ships wins, so `zh-Hans-CN` and `zh-TW` both
 * select Chinese and a list starting with an unsupported language keeps looking.
 *
 * @param preferred - languages in the user's own order, e.g. `['zh-Hans-CN']`.
 * @returns `zh` or `en`.
 */
export function detectSystemLanguage(preferred) {
  const list = Array.isArray(preferred) ? preferred : [];
  for (const tag of list) {
    if (typeof tag !== 'string' || tag === '') continue;
    const primary = tag.toLowerCase().split('-')[0];
    if (primary === 'zh' || primary === 'en') return primary;
  }
  return FALLBACK_LANGUAGE;
}

/**
 * The string table for one resolved language.
 * @param language - `zh` or `en`.
 * @returns the table, falling back to English for anything else.
 */
export function messagesFor(language) {
  return MESSAGES[language] ?? MESSAGES[FALLBACK_LANGUAGE];
}

/**
 * Chromium's interface-language tag, or null when the system should decide.
 *
 * Null is the answer for `auto` on purpose: appending a switch would override
 * the system, which is the opposite of what "follow the system" means.
 *
 * @param choice - the configured `language` value.
 * @param systemLanguage - what `auto` resolves to.
 * @returns e.g. `zh-CN`, or null to leave Chromium alone.
 */
export function chromiumLanguage(choice, systemLanguage) {
  if (choice !== 'zh' && choice !== 'en') return null;
  return CHROMIUM_LANGUAGE[choice] ?? null;
}

/**
 * The `<html lang>` value for a resolved language.
 * @param language - `zh` or `en`.
 * @returns a document language tag.
 */
export function htmlLanguage(language) {
  return language === 'zh' ? 'zh-CN' : 'en';
}

/**
 * Build a translator for one language.
 *
 * @param language - `zh` or `en`; anything else uses the English table.
 * @param override - a table to use instead, e.g. a harness-supplied test double.
 * @returns a `t(key, params)` function.
 * @throws when a message's placeholders are not all supplied — a half-rendered
 *   sentence reads like a translation and hides the real defect.
 */
export function createTranslator(language, override) {
  const table = override ?? messagesFor(language);
  const fallback = messagesFor(FALLBACK_LANGUAGE);
  return (key, params) => {
    const template = table[key] ?? fallback[key] ?? key;
    if (params === undefined || params === null) return template;
    return template.replace(/\{(\w+)\}/g, (match, name) => {
      if (!Object.hasOwn(params, name)) {
        throw new Error(`dsh-desktop: message "${key}" needs a value for ${match}`);
      }
      return String(params[name]);
    });
  };
}
