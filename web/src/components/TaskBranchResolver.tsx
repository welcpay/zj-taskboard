import { useMemo, useState } from "react";
import {
  keepMainTaskBranch,
  mergeTaskBranch,
  promoteTaskBranch,
} from "../api";
import { useTaskboardI18n } from "../i18n";
import type { TaskBranch } from "../types";
import { LinearIcon } from "./LinearIcon";

interface TaskBranchResolverProps {
  branch: TaskBranch;
  onResolved: (branch: TaskBranch) => void;
}

function displayValue(value: unknown) {
  if (value === undefined) return "-";
  if (typeof value === "string") return value || "-";
  return JSON.stringify(value, null, 2);
}

export function TaskBranchResolver({ branch, onResolved }: TaskBranchResolverProps) {
  const { text } = useTaskboardI18n();
  const [mergedJson, setMergedJson] = useState(() => JSON.stringify({
    ...branch.mainSnapshot,
    ...branch.branchSnapshot,
  }, null, 2));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fields = useMemo(() => [...new Set([
    ...Object.keys(branch.baseSnapshot),
    ...Object.keys(branch.mainSnapshot),
    ...Object.keys(branch.branchSnapshot),
  ])].filter((field) => !["activityKey", "participants", "conversationRefs"].includes(field)), [branch]);

  async function resolve(action: "keep" | "promote" | "merge") {
    setPending(true);
    setError(null);
    try {
      const resolved = action === "keep"
        ? await keepMainTaskBranch(branch.id)
        : action === "promote"
          ? await promoteTaskBranch(branch.id)
          : await mergeTaskBranch(branch.id, JSON.parse(mergedJson) as Record<string, unknown>);
      onResolved(resolved);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  }

  const canResolve = branch.canResolve;
  return (
    <section className="task-branch-resolver" aria-label={text("任务分支比较", "Task branch comparison")}>
      <header>
        <div>
          <span className="team-section-kicker">{text("并发变更", "Concurrent change")}</span>
          <h3>{branch.taskId}</h3>
        </div>
        <span className={`team-state team-state-${branch.state}`}>{branch.state}</span>
      </header>
      <div className="branch-field-grid branch-field-head" aria-hidden="true">
        <span>{text("字段", "Field")}</span>
        <span>{text("共同基础", "Base")}</span>
        <span>{text("主线", "Main")}</span>
        <span>{text("任务分支", "Branch")}</span>
      </div>
      <div className="branch-comparison">
        {fields.map((field) => <div className="branch-field-grid" key={field}>
          <strong>{field}</strong>
          <pre>{displayValue(branch.baseSnapshot[field])}</pre>
          <pre>{displayValue(branch.mainSnapshot[field])}</pre>
          <pre>{displayValue(branch.branchSnapshot[field])}</pre>
        </div>)}
      </div>
      {canResolve ? <>
        <label className="branch-merge-editor">
          <span>{text("三方合并结果", "Three-way merge result")}</span>
          <textarea value={mergedJson} onChange={(event) => setMergedJson(event.target.value)} spellCheck={false} />
        </label>
        {error && <p className="team-form-error" role="alert">{error}</p>}
        <div className="branch-actions">
          <button type="button" disabled={pending} onClick={() => void resolve("keep")}>
            {text("保留主线", "Keep main")}
          </button>
          <button type="button" disabled={pending} onClick={() => void resolve("promote")}>
            <LinearIcon name="branch" /> {text("提升任务分支", "Promote branch")}
          </button>
          <button className="primary" type="button" disabled={pending} onClick={() => void resolve("merge")}>
            <LinearIcon name="check" /> {text("合并", "Merge")}
          </button>
        </div>
      </> : <p className="team-permission-note">
        {text("仅任务负责人、创建者或项目管理员可以解决此分支。", "Only the assignee, creator, or project administrator can resolve this branch.")}
      </p>}
    </section>
  );
}
