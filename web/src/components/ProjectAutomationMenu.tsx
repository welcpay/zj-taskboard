import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  AUTOMATION_MODELS,
  getAutomationModel,
  withAutomationModel,
  type AutomationModel,
  type AutomationReasoningEffort,
} from "../../../shared/taskboard-automation-options.mjs";
import { AutomationSelect } from "./AutomationSelect";
import { TaskboardIcon } from "./TaskboardIcon";
import { useTaskboardI18n } from "../i18n";

type AutomationStatus = "ACTIVE" | "PAUSED";
type AutomationQuotaState = "available" | "blocked" | "unknown" | "unavailable";
type IntervalMinutes = number;
type OpenSelect = "model" | "effort" | null;

interface AutomationOptions {
  enabledByUser: boolean;
  quotaAware: boolean;
  intervalMinutes: IntervalMinutes;
  model: AutomationModel;
  reasoningEffort: AutomationReasoningEffort;
}

interface AutomationState extends AutomationOptions {
  status: AutomationStatus;
  quota?: {
    state: AutomationQuotaState;
    checkedAt: number;
    resetsAt?: number;
    reason?: "api-key";
  };
}

interface ProjectAutomationMenuProps {
  automation?: Partial<AutomationState>;
  pending: boolean;
  error: string | null;
  unavailableReason: string | null;
  onOpen: () => void;
  onChange: (options: AutomationOptions) => void;
}

const DEFAULT_OPTIONS: AutomationOptions = {
  enabledByUser: false,
  quotaAware: false,
  intervalMinutes: 60,
  model: "gpt-5.5",
  reasoningEffort: "high",
};

const INTERVAL_PRESETS = [5, 10, 15, 30, 60] as const;

const EFFORT_LABELS: Record<AutomationReasoningEffort, readonly [string, string]> = {
  low: ["轻度", "Low"],
  medium: ["中", "Medium"],
  high: ["高", "High"],
  xhigh: ["极高 (xhigh)", "Extra high (xhigh)"],
  max: ["最高", "Maximum"],
  ultra: ["极高 (ultra)", "Ultra"],
};

export function ProjectAutomationMenu({
  automation,
  pending,
  error,
  unavailableReason,
  onOpen,
  onChange,
}: ProjectAutomationMenuProps) {
  const { locale, text } = useTaskboardI18n();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const wasPendingRef = useRef(pending);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0, ready: false });
  const [draft, setDraft] = useState<AutomationOptions>(DEFAULT_OPTIONS);
  const [customInterval, setCustomInterval] = useState("60");
  const [customIntervalSelected, setCustomIntervalSelected] = useState(false);
  const [intervalError, setIntervalError] = useState<string | null>(null);
  const [openSelect, setOpenSelect] = useState<OpenSelect>(null);
  const status = automation?.status ?? "PAUSED";
  const quota = automation?.quota;
  const stateLabel = !automation?.enabledByUser
    ? text("已暂停", "Paused")
    : automation.quotaAware && quota?.state === "blocked"
      ? text("额度暂停", "Paused by quota")
      : automation.quotaAware && quota?.state === "unavailable"
        ? text("额度不可用", "Quota unavailable")
        : automation.quotaAware && (!quota || quota.state === "unknown")
          ? text("额度未知", "Quota unknown")
          : status === "ACTIVE"
            ? text("运行中", "Running")
            : text("已暂停", "Paused");
  const disabled = pending || Boolean(unavailableReason);

  useEffect(() => {
    if (!open) return;
    setDraft({ ...DEFAULT_OPTIONS, ...automation });
    setCustomInterval(String(automation?.intervalMinutes ?? DEFAULT_OPTIONS.intervalMinutes));
    setCustomIntervalSelected(!INTERVAL_PRESETS.includes(
      (automation?.intervalMinutes ?? DEFAULT_OPTIONS.intervalMinutes) as never,
    ));
    setIntervalError(null);
    setOpenSelect(null);
  }, [open]);

  useEffect(() => {
    if (wasPendingRef.current && !pending) {
      setDraft({ ...DEFAULT_OPTIONS, ...automation });
    }
    wasPendingRef.current = pending;
  }, [automation, pending]);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current || !menuRef.current) return;
    const trigger = triggerRef.current.getBoundingClientRect();
    const menu = menuRef.current.getBoundingClientRect();
    const left = Math.max(8, Math.min(trigger.right - menu.width, window.innerWidth - menu.width - 8));
    const top = trigger.bottom + 8 + menu.height <= window.innerHeight
      ? trigger.bottom + 8
      : Math.max(8, trigger.top - menu.height - 8);
    setPosition({ left, top, ready: true });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function closeFromOutside(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node) && !triggerRef.current?.contains(event.target as Node)) {
        setOpenSelect(null);
        setOpen(false);
      }
    }
    function closeFromViewportChange() {
      setOpenSelect(null);
      setOpen(false);
    }
    function closeFromEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        if (openSelect) {
          setOpenSelect(null);
          return;
        }
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener("pointerdown", closeFromOutside);
    document.addEventListener("keydown", closeFromEscape);
    window.addEventListener("resize", closeFromViewportChange);
    window.addEventListener("scroll", closeFromViewportChange, true);
    return () => {
      document.removeEventListener("pointerdown", closeFromOutside);
      document.removeEventListener("keydown", closeFromEscape);
      window.removeEventListener("resize", closeFromViewportChange);
      window.removeEventListener("scroll", closeFromViewportChange, true);
    };
  }, [open, openSelect]);

  const submitChange = (next: AutomationOptions) => {
    if (disabled) return;
    setDraft(next);
    onChange(next);
  };

  const submitCustomInterval = () => {
    const intervalMinutes = Number(customInterval);
    if (!Number.isInteger(intervalMinutes) || intervalMinutes < 0 || intervalMinutes > 60) {
      setIntervalError(text("请输入 0–60 的整数，0 表示暂停", "Enter an integer from 0 to 60; 0 pauses it."));
      return;
    }
    setIntervalError(null);
    submitChange({
      ...draft,
      enabledByUser: intervalMinutes === 0 ? false : draft.enabledByUser,
      intervalMinutes,
    });
  };

  const menu = open ? createPortal(
    <div
      ref={menuRef}
      className="project-automation-menu no-drag"
      role="dialog"
      aria-label={text("自动认领待办设置", "Auto-claim settings")}
      style={{ left: position.left, top: position.top, visibility: position.ready ? "visible" : "hidden" }}
    >
      <div className="project-automation-summary">
        <div className="project-automation-menu-heading">
          <div><strong>{text("自动认领待办", "Auto-claim tasks")}</strong><small>{text("周期检查等待认领的任务", "Check periodically for unclaimed tasks")}</small></div>
          <span className={status === "ACTIVE" ? "is-active" : "is-paused"}>{stateLabel}</span>
        </div>
        <div className="project-automation-switch">
          <span>{text("自动认领", "Auto-claim")}</span>
          <button type="button" className={`board-setting-switch${draft.enabledByUser ? " is-on" : ""}`}
            role="switch" aria-checked={draft.enabledByUser} disabled={disabled}
            onClick={() => submitChange({ ...draft, enabledByUser: !draft.enabledByUser })}>
            <span aria-hidden="true" />
          </button>
        </div>
      </div>
      <div className="project-automation-field">
        <span>{text("检查间隔", "Check interval")}</span>
        <div className="automation-interval-segments" role="group" aria-label={text("自动认领间隔", "Auto-claim interval")}>
          {INTERVAL_PRESETS.map((minutes) => (
            <button key={minutes} type="button" disabled={disabled}
              className={!customIntervalSelected && draft.intervalMinutes === minutes ? "is-selected" : ""}
              onClick={() => {
                setCustomIntervalSelected(false);
                setCustomInterval(String(minutes));
                submitChange({ ...draft, intervalMinutes: minutes });
              }}>{minutes}</button>
          ))}
          <button type="button" disabled={disabled} className={customIntervalSelected ? "is-selected" : ""}
            onClick={() => setCustomIntervalSelected(true)}>{text("其他", "Custom")}</button>
        </div>
        {customIntervalSelected && <div className="automation-custom-interval">
          <input
            aria-label={text("其他自动认领间隔", "Custom auto-claim interval")}
            type="number"
            min={0}
            max={60}
            step={1}
            value={customInterval}
            disabled={disabled}
            onChange={(event) => setCustomInterval(event.target.value)}
            onBlur={submitCustomInterval}
            onKeyDown={(event) => {
              if (event.key === "Enter") submitCustomInterval();
            }}
          />
          <span>{text("分钟", "min")}</span>
        </div>}
        {customIntervalSelected && <small>{text("输入 0–60，0 表示暂停", "Enter 0–60; 0 pauses it")}</small>}
        {intervalError && <p className="automation-interval-error" role="alert">{intervalError}</p>}
      </div>
      <div className="automation-model-grid">
      <div className="project-automation-field">
        <span>{text("模型", "Model")}</span>
        <AutomationSelect
          ariaLabel={text("自动认领模型", "Auto-claim model")}
          value={draft.model}
          options={AUTOMATION_MODELS.map((model) => ({ value: model.slug, label: model.label }))}
          disabled={disabled}
          open={openSelect === "model"}
          onOpenChange={(nextOpen) => setOpenSelect(nextOpen ? "model" : null)}
          onChange={(model) => submitChange(withAutomationModel(draft, model as AutomationModel))}
        />
      </div>
      <div className="project-automation-field">
        <span>{text("推理强度", "Reasoning effort")}</span>
        <AutomationSelect
          ariaLabel={text("自动认领推理强度", "Auto-claim reasoning effort")}
          value={draft.reasoningEffort}
          options={getAutomationModel(draft.model).efforts.map((effort) => ({
            value: effort,
            label: text(...EFFORT_LABELS[effort]),
          }))}
          disabled={disabled}
          open={openSelect === "effort"}
          onOpenChange={(nextOpen) => setOpenSelect(nextOpen ? "effort" : null)}
          onChange={(reasoningEffort) => submitChange({
            ...draft,
            reasoningEffort: reasoningEffort as AutomationReasoningEffort,
          })}
        />
      </div>
      </div>
      <div className="project-automation-secondary">
        <div className="project-automation-switch">
          <span>{text("根据额度启用/关闭", "Use quota limits")}</span>
          <button type="button" className={`board-setting-switch${draft.quotaAware ? " is-on" : ""}`}
            role="switch" aria-checked={draft.quotaAware} disabled={disabled}
            onClick={() => submitChange({ ...draft, quotaAware: !draft.quotaAware })}>
            <span aria-hidden="true" />
          </button>
        </div>
        {draft.quotaAware && <div className={`project-automation-quota is-${quota?.state ?? "unknown"}`}>
          {quota?.state === "available" && text("当前额度可用", "Quota is available")}
          {quota?.state === "blocked" && (quota.resetsAt ? text(`额度已用尽，预计 ${formatResetTime(quota.resetsAt, locale)} 恢复`, `Quota is exhausted. Expected reset: ${formatResetTime(quota.resetsAt, locale)}.`) : text("额度已用尽，自动认领已暂停", "Quota is exhausted. Auto-claim is paused."))}
          {quota?.state === "unavailable" && (quota.reason === "api-key" ? text("API Key 模式不支持读取 Codex App 额度", "API key mode cannot read the Codex app quota.") : text("当前账户无法读取额度", "This account cannot read quota information."))}
          {(!quota || quota.state === "unknown") && text("额度状态未知，自动认领已暂停", "Quota status is unknown. Auto-claim is paused.")}
        </div>}
      </div>
      {unavailableReason && <p className="project-automation-note">{unavailableReason}</p>}
      {error && error !== unavailableReason && <p className="project-automation-error" role="alert">{error}</p>}
    </div>,
    document.body,
  ) : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`project-automation-trigger no-drag ${status === "ACTIVE" ? "is-active" : "is-paused"}`}
        aria-label={status === "ACTIVE" ? text("自动认领中", "Auto-claiming") : text("自动化", "Automation")}
        aria-busy={pending}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={status === "ACTIVE" ? text("自动认领中", "Auto-claiming") : text("自动化", "Automation")}
        onClick={() => {
          if (!open) {
            setPosition((current) => ({ ...current, ready: false }));
            onOpen();
          }
          setOpen((current) => !current);
        }}
      >
        <TaskboardIcon name={status === "ACTIVE" ? "automationPause" : "automationPlay"} />
        <span>{status === "ACTIVE" ? text("自动认领中", "Auto-claiming") : text("自动化", "Automation")}</span>
      </button>
      {menu}
    </>
  );
}

function formatResetTime(value: number, locale: string) {
  return new Intl.DateTimeFormat(locale, {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value * 1_000));
}
