export function renderReleaseNotes({ version, date, changes }) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Invalid release version: ${version}`);
  if (!Array.isArray(changes) || changes.length === 0) throw new Error("Release notes require changes");
  return [
    `# Codex Taskboard ${version}`,
    "",
    `发布日期：${date}`,
    "",
    "## 更新内容",
    "",
    ...changes.map((change) => `- ${String(change).replace(/^[-*]\s*/, "")}`),
    "",
    "## 数据兼容",
    "",
    "升级只替换应用程序，历史项目、议题、评论和自动化策略继续保存在 `~/Library/Application Support/Codex Taskboard/`。安装前会创建数据备份并核对项目与议题数量。",
    "",
  ].join("\n");
}
