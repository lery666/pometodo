import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import AiKeySection from "./AiKeySection";
import type { AiProvider } from "../../../contracts/settings";

type SectionProps = Parameters<typeof AiKeySection>[0];

const noop = () => undefined;

function render(overrides: Partial<SectionProps> = {}) {
  const keyConfigured: Record<AiProvider, boolean> = {
    deepseek: false,
    qwen: false,
    glm: false,
    custom: false,
  };
  return renderToStaticMarkup(
    <AiKeySection
      provider="deepseek"
      keyConfigured={keyConfigured}
      busy={false}
      draft=""
      baseUrlDraft=""
      modelDraft=""
      onDraftChange={noop}
      onBaseUrlDraftChange={noop}
      onModelDraftChange={noop}
      onBlurCustomField={noop}
      onApplyAgnesPreset={noop}
      onProviderChange={noop}
      onSaveKey={noop}
      onRequestClearKey={noop}
      {...overrides}
    />,
  );
}

describe("AiKeySection 配置状态", () => {
  it("把已保存状态收进厂商按钮和输入框，不常驻重复标题或长说明", () => {
    const html = render({
      keyConfigured: { deepseek: true, qwen: false, glm: false, custom: false },
    });

    expect(html).toContain("DeepSeek Key 已保存");
    expect(html).toContain('aria-label="DeepSeek，Key 已保存"');
    expect(html).toContain("settings-key-provider-configured");
    expect(html).not.toContain("AI 识别服务");
    expect(html).not.toContain(">API Key<");
    expect(html).not.toContain("Key 加密保存在本机");
    expect(html).not.toContain("settings-key-state");
  });

  it("未配置的当前厂商提示用户粘贴对应 Key", () => {
    const html = render({ provider: "qwen" });

    expect(html).toContain('placeholder="粘贴 Qwen API Key"');
    expect(html).toContain('aria-label="Qwen API Key"');
    expect(html).not.toContain("Key 已保存");
  });

  it("来源切换未完成时禁用厂商、Key 输入和保存操作", () => {
    const html = render({
      keyConfigured: { deepseek: true, qwen: false, glm: false, custom: false },
      busy: true,
      draft: "new-key",
    });

    // 4 个厂商按钮 + Key 输入 + 保存 + 清除；内置厂商不渲染自定义字段。
    expect(html.match(/disabled=""/g)).toHaveLength(7);
    expect(html).not.toContain("接口地址");
  });

  it("选自定义时给出地址与模型名输入和 Agnes 预设入口", () => {
    const html = render({
      provider: "custom",
      baseUrlDraft: "https://apihub.agnes-ai.com/v1",
      modelDraft: "agnes-2.0-flash",
    });

    expect(html).toContain("自定义");
    expect(html).toContain("接口地址");
    expect(html).toContain("模型名");
    expect(html).toContain('placeholder="https://apihub.agnes-ai.com/v1"');
    expect(html).toContain('placeholder="agnes-2.0-flash"');
    expect(html).toContain('value="https://apihub.agnes-ai.com/v1"');
    expect(html).toContain('value="agnes-2.0-flash"');
    expect(html).toContain("填入 Agnes 预设");
    expect(html).toContain('placeholder="粘贴 自定义服务 API Key"');
  });
});
