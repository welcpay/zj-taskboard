import { useCallback, useEffect, useState } from "react";
import {
  activateTeamProfile,
  createTeamProfile,
  deleteTeamProfile,
  getTeamSyncStatus,
  listTaskBranches,
  listTeamProfiles,
  loginTeamProfile,
  logoutTeamProfile,
  pauseTeamSync,
  resumeTeamSync,
  synchronizeTeamNow,
  testTeamProfile,
} from "../api";
import { useTaskboardI18n } from "../i18n";
import type { TaskBranch, TeamConnection, TeamServerConfig, TeamSyncStatus } from "../types";
import { LinearIcon } from "./LinearIcon";
import { TaskBranchResolver } from "./TaskBranchResolver";

interface TeamServerSettingsProps {
  open: boolean;
  onClose: () => void;
}

const EMPTY_CONFIG: TeamServerConfig = { activeProfileId: null, profiles: [] };

export function TeamServerSettings({ open, onClose }: TeamServerSettingsProps) {
  const { locale, text } = useTaskboardI18n();
  const [config, setConfig] = useState<TeamServerConfig>(EMPTY_CONFIG);
  const [sync, setSync] = useState<TeamSyncStatus>({ status: "local", profileId: null, pendingOperations: 0 });
  const [branches, setBranches] = useState<TaskBranch[]>([]);
  const [selectedBranchId, setSelectedBranchId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [organizationId, setOrganizationId] = useState("");
  const [updateMirror, setUpdateMirror] = useState(false);
  const [token, setToken] = useState("");
  const [connection, setConnection] = useState<TeamConnection | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [nextConfig, nextSync, nextBranches] = await Promise.all([
      listTeamProfiles(),
      getTeamSyncStatus(),
      listTaskBranches().catch(() => []),
    ]);
    setConfig(nextConfig);
    setSync(nextSync);
    setBranches(nextBranches);
  }, []);

  useEffect(() => {
    if (!open) return;
    setError(null);
    void refresh().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [open, refresh]);

  if (!open) return null;
  const active = config.profiles.find((profile) => profile.id === config.activeProfileId) ?? null;
  const selectedBranch = branches.find((branch) => branch.id === selectedBranchId) ?? null;
  const lastSync = sync.lastSuccessfulSyncAt
    ? new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }).format(new Date(sync.lastSuccessfulSyncAt))
    : text("尚未同步", "Not synced yet");

  async function run(operation: () => Promise<unknown>) {
    setPending(true);
    setError(null);
    try {
      await operation();
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  }

  return <div className="team-settings-backdrop" role="presentation" onMouseDown={(event) => {
    if (event.target === event.currentTarget) onClose();
  }}>
    <div className="team-settings-dialog" role="dialog" aria-modal="true" aria-label={text("Team Server 设置", "Team Server settings")}>
      <header className="team-settings-header">
        <div><span className="team-section-kicker">{text("本地优先同步", "Local-first sync")}</span><h2>Team Server</h2></div>
        <button className="icon-button" type="button" onClick={onClose} aria-label={text("关闭", "Close")}><LinearIcon name="close" /></button>
      </header>

      <div className="team-sync-strip">
        <span className={`team-sync-dot team-sync-${sync.status}`} />
        <strong>{active?.name ?? text("仅本地", "Local only")}</strong>
        <span>{sync.status}</span>
        <span>{text("待上传", "Pending")} {sync.pendingOperations}</span>
        <span>{text("分支", "Branches")} {sync.branchCount ?? branches.filter((branch) => branch.state === "open").length}</span>
        <span>{lastSync}</span>
        <div className="team-sync-actions">
          <button type="button" disabled={pending || !active} onClick={() => void run(sync.paused ? resumeTeamSync : pauseTeamSync)}>
            <LinearIcon name={sync.paused ? "play" : "pause"} />
          </button>
          <button type="button" disabled={pending || !active} onClick={() => void run(synchronizeTeamNow)} title={text("立即同步", "Sync now")}>
            <LinearIcon name="send" />
          </button>
        </div>
      </div>

      <div className="team-settings-body">
        <aside className="team-profile-list" aria-label={text("已保存服务器", "Saved servers")}>
          {config.profiles.map((profile) => <button
            type="button"
            className={profile.active ? "active" : ""}
            key={profile.id}
            onClick={() => void run(() => activateTeamProfile(profile.id))}
          >
            <span className="team-profile-name"><i className={profile.active ? "online" : ""} />{profile.name}</span>
            <small>{profile.url}</small>
            <span>{profile.hasToken ? text("已登录", "Signed in") : text("需要令牌", "Token required")}</span>
          </button>)}
          {config.profiles.length === 0 && <p>{text("尚未配置远程服务器。", "No remote server configured.")}</p>}
        </aside>

        <div className="team-settings-content">
          <section className="team-settings-section">
            <div className="team-section-heading"><div><span className="team-section-kicker">{text("配置", "Profiles")}</span><h3>{text("新增 Team Server", "Add Team Server")}</h3></div></div>
            <div className="team-form-grid">
              <label><span>{text("名称", "Name")}</span><input value={name} onChange={(event) => setName(event.target.value)} /></label>
              <label><span>{text("服务器地址", "Server URL")}</span><input type="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://team.example.com" /></label>
              <label><span>{text("组织", "Organization")}</span><input value={organizationId} onChange={(event) => setOrganizationId(event.target.value)} /></label>
              <label className="team-checkbox"><input type="checkbox" checked={updateMirror} onChange={(event) => setUpdateMirror(event.target.checked)} /><span>{text("优先使用服务器更新镜像", "Prefer Team Server update mirror")}</span></label>
            </div>
            <div className="team-section-actions"><button className="primary" type="button" disabled={pending || !name.trim() || !url.trim()} onClick={() => void run(async () => {
              await createTeamProfile({ name, url, organizationId: organizationId || undefined, updateMirror });
              setName(""); setUrl(""); setOrganizationId(""); setUpdateMirror(false);
            })}>{text("保存配置", "Save profile")}</button></div>
          </section>

          {active && <section className="team-settings-section">
            <div className="team-section-heading"><div><span className="team-section-kicker">{text("身份认证", "Authentication")}</span><h3>{active.name}</h3></div><button className="danger-text" type="button" disabled={pending} onClick={() => void run(() => deleteTeamProfile(active.id))}>{text("删除", "Delete")}</button></div>
            <div className="team-token-row"><input type="password" value={token} onChange={(event) => setToken(event.target.value)} placeholder={active.hasToken ? text("令牌已存入钥匙串", "Token stored in Keychain") : text("每用户访问令牌", "Per-user access token")} /><button type="button" disabled={pending || !token.trim()} onClick={() => void run(async () => { await loginTeamProfile(active.id, token); setToken(""); })}>{text("登录", "Sign in")}</button><button type="button" disabled={pending || !active.hasToken} onClick={() => void run(() => logoutTeamProfile(active.id))}>{text("退出", "Sign out")}</button><button type="button" disabled={pending || !active.hasToken} onClick={() => void run(async () => setConnection(await testTeamProfile(active.id)))}>{text("测试连接", "Test")}</button></div>
            {connection && <div className="team-connection-result"><LinearIcon name="check" /><span>{connection.user.name}</span><span>{connection.role}</span><span>Server {connection.serverVersion}</span></div>}
            <p className="team-update-source">{text("更新源", "Update source")}: {active.updateMirror ? text("Team Server，失败时回退 GitHub", "Team Server with GitHub fallback") : "GitHub Releases"}</p>
          </section>}

          <section className="team-settings-section team-branches-section">
            <div className="team-section-heading"><div><span className="team-section-kicker">{text("冲突处理", "Conflict review")}</span><h3>{text("任务分支", "Task branches")}</h3></div></div>
            <div className="team-branch-list">{branches.filter((branch) => branch.state === "open").map((branch) => <button type="button" key={branch.id} onClick={() => setSelectedBranchId(branch.id)}><LinearIcon name="branch" /><span>{branch.taskId}</span><small>{branch.authorId}</small></button>)}{branches.every((branch) => branch.state !== "open") && <p>{text("没有待处理分支。", "No branches need review.")}</p>}</div>
            {selectedBranch && <TaskBranchResolver branch={selectedBranch} onResolved={(resolved) => { setBranches((current) => current.map((branch) => branch.id === resolved.id ? resolved : branch)); setSelectedBranchId(null); }} />}
          </section>
          {error && <p className="team-form-error" role="alert">{error}</p>}
        </div>
      </div>
    </div>
  </div>;
}
