import { useEffect, useId, useMemo, useSyncExternalStore } from "react";
import type { Entitlement, OfficialServices } from "../../contracts/official";
import type { StatusMessage } from "../../components/StatusBar";
import { createOfficialController } from "./officialController";
import "./official.css";

function PersonIcon() {
  return <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="8" r="3.5"/><path d="M5 20v-1a7 7 0 0 1 14 0v1"/></svg>;
}

export interface OfficialLoginCardProps {
  services: OfficialServices;
  autoLogin?: boolean;
  onChanged?(): void;
  onActivated?(entitlement: Entitlement): Promise<void>;
  onSignedIn?(): void;
  /** 用户不想现在登录：收起二维码，回到之前的表单或卡片。 */
  onCancel?(): void;
  onMessage?(message: StatusMessage): void;
}

/** 原位微信扫码卡片：只在用户请求登录时出现，确认后由宿主收回并回到原表单。 */
export default function OfficialLoginCard({ services, autoLogin = false, onChanged, onActivated, onSignedIn, onCancel, onMessage }: OfficialLoginCardProps) {
  const titleId = useId();
  const core = useMemo(() => createOfficialController(services, {
    onBack: () => {},
    onActivated: async entitlement => { await onActivated?.(entitlement); },
    onChanged: () => onChanged?.(),
    onSignedIn: () => onSignedIn?.(),
    onMessage: message => onMessage?.(message),
  }), [services]);
  core.setCallbacks({ onBack: () => {}, onActivated: async entitlement => { await onActivated?.(entitlement); }, onChanged: () => onChanged?.(), onSignedIn: () => onSignedIn?.(), onMessage: message => onMessage?.(message) });
  const state = useSyncExternalStore(core.subscribe, core.getSnapshot, core.getSnapshot);
  useEffect(() => core.mount(autoLogin), [core, autoLogin]);
  const { login } = state;
  const generating = state.accountLoading || state.loginLoading;
  const loginTitle = state.loginLoading ? "正在生成二维码" : login?.status === "expired" ? "二维码已过期" : login?.status === "cancelled" ? "本次绑定已取消" : state.loginError ? "绑定未完成" : "扫码绑定微信";
  return <section className="official-panel official-login-card" aria-labelledby={titleId}>
    <div className="official-login">
      <div className="official-login-heading"><h3 id={titleId}>{loginTitle}</h3></div>
      <div className="official-qr-area" aria-live="polite">
        {login?.status === "pending" && login.qrCodeDataUrl && !state.loginLoading && <img className="official-qr-image" src={login.qrCodeDataUrl} alt="PomeTodo 微信登录二维码"/>}
        {generating ? <p className="official-qr-placeholder" role="status">正在生成二维码…</p>
          : login?.status !== "pending" && <div className="official-qr-placeholder"><PersonIcon/><span>{loginTitle}</span></div>}
      </div>
      {state.loginError && <p className="official-error" role="alert">{state.loginError}</p>}
      {!generating && (login?.status !== "pending" || state.loginError) && <button className="official-button official-primary" type="button" onClick={() => void core.begin()}>{login || state.loginError ? "重新获取" : "微信登录"}</button>}
      {onCancel && <button className="official-login-cancel" type="button" onClick={onCancel}>暂不绑定</button>}
    </div>
  </section>;
}
