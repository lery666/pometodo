import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import TodoDialog from "../todo/components/TodoDialog";
import TodoPage from "../todo/TodoPage";
import type { TodoServices } from "../../contracts/todo";

const noop = () => {};
const draft = { customerName: "虚构客户", title: "保留任务草稿", note: "保留备注", receivedAt: "2026-09-06", dueAt: "", attachmentPaths: ["fixture-one", "fixture-two"] };
const props = { editing: true, draft, customerError: false, titleError: false, recognitionView: { kind: "idle" as const }, quickDueOptions: [], customerSuggestions: [], attachmentThumbs: {}, saving: false, addingAttachment: false, onCustomerInput: noop, onTitleInput: noop, onNoteInput: noop, onReceivedInput: noop, onDueInput: noop, onClose: noop, onSave: noop, onDelete: noop, onRecognize: noop, onImportAttachments: noop, onRemoveAttachment: noop, onOpenAttachment: noop };

describe("待办卡片内账号视图", () => {
  it("扫码临时替换表单显示，非空字段和附件留在隐藏且不可交互的表单", () => {
    const html = renderToStaticMarkup(<TodoDialog {...props} accountView={<div>正在生成二维码</div>} />);
    expect(html).toContain("正在生成二维码");
    expect(html).toMatch(/class="todo-editor-form-view(?: [^"]*)?"[^>]*hidden=""[^>]*inert=""/);
    for (const text of [draft.customerName, draft.title, draft.note, "当前 2 张", "保存修改"]) expect(html).toContain(text);
    expect(html).not.toContain("dialog-overlay");
  });
  it("可用自带Key保持粘贴整理入口，未启用时透传服务端状态文案", () => {
    expect(renderToStaticMarkup(<TodoDialog {...props} smartArrangeAvailable />)).toContain('aria-label="粘贴并整理"');
    const html = renderToStaticMarkup(<TodoDialog {...props} smartArrangeLabel="暂不可用" smartArrangeTone="secondary" />);
    expect(html).toContain('aria-label="暂不可用"');
    expect(html).toContain("tone-secondary");
    expect(html).not.toContain("登录体验智能整理");
    expect(html).not.toContain("微信扫码，确认后即可体验");
  });
  it("不再有整页账号视图：标题、搜索、分类和底栏保持可交互，不读取剪贴板", () => {
    const services = { listTasks: vi.fn(async () => []), recognizeClipboard: vi.fn(), saveClipboardAttachment: vi.fn() } as unknown as TodoServices;
    const html = renderToStaticMarkup(<TodoPage services={services} loginPanel={<div>正在生成二维码</div>} />);
    expect(html).not.toContain("inert=\"\"");
    expect(html).toContain('aria-label="任务分类"');
    expect(html).toContain("todo-page-header");
    expect(html).toContain("pome-statusbar");
    expect(services.recognizeClipboard).not.toHaveBeenCalled();
    expect(services.saveClipboardAttachment).not.toHaveBeenCalled();
  });
  it("列表底栏右侧显示新增与智能整理引导，不提前泄露整理按钮文案", () => {
    const services = { listTasks: vi.fn(async () => []) } as unknown as TodoServices;
    const html = renderToStaticMarkup(<TodoPage services={services} />);
    expect(html).toContain("Ctrl+N 新增 · 试试智能整理");
    expect(html).not.toContain("粘贴并整理");
  });
});
