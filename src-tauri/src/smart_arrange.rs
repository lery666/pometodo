use crate::{commands::with_storage, secrets::KeyStore};
use pometodo_core::{
    local::LocalStorage,
    smart_arrange::{SmartArrangePreferences, SmartArrangeSource},
};
use serde::Serialize;

/// 自带 Key 模式下一次识别所需的全部信息。
///
/// 内置三家只需 provider + key；自定义服务商（custom）还需要用户填写的
/// 接口基地址与模型名，因此一起读出来，避免调用点再回头读设置。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UserAiSelection {
    pub provider: String,
    pub key: String,
    pub base_url: String,
    pub model: String,
}

impl UserAiSelection {
    /// 解析成本次请求的目标（端点、文本模型、视觉模型）。
    pub fn target(&self) -> Result<crate::ai_http::AiTarget, crate::ai_http::AiHttpError> {
        crate::ai_http::AiTarget::resolve(&self.provider, &self.base_url, &self.model)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SmartArrangeSnapshot {
    pub preferences: SmartArrangePreferences,
    pub available: bool,
    pub message: String,
}

pub fn require_enabled(preferences: &SmartArrangePreferences) -> Result<(), String> {
    if !preferences.enabled {
        return Err("智能整理尚未开启".into());
    }
    Ok(())
}

pub fn selected_user_key(storage: &LocalStorage) -> Result<UserAiSelection, String> {
    let preferences =
        crate::distribution::effective_preferences(storage.repo.smart_arrange_preferences()?);
    require_enabled(&preferences)?;
    if preferences.source != SmartArrangeSource::Byok {
        return Err("请先登录并开通官方智能整理".into());
    }
    let settings = storage.repo.settings()?;
    let provider = settings.ai_provider;
    let key = KeyStore::new(&storage.profile_directory.join("secrets"))
        .read(&provider)?
        .ok_or_else(|| "请在设置中保存所选服务商的 API Key".to_string())?;
    // 自定义服务商缺地址或模型名时先给出可读提示，不必等到请求失败。
    if provider == "custom" {
        if settings.ai_base_url.trim().is_empty() {
            return Err("请先在设置中填写接口地址".into());
        }
        if settings.ai_model.trim().is_empty() {
            return Err("请先在设置中填写模型名".into());
        }
    }
    Ok(UserAiSelection {
        provider,
        key,
        base_url: settings.ai_base_url,
        model: settings.ai_model,
    })
}

fn snapshot(storage: &LocalStorage) -> Result<SmartArrangeSnapshot, String> {
    let preferences =
        crate::distribution::effective_preferences(storage.repo.smart_arrange_preferences()?);
    let (available, message) = if !preferences.enabled {
        (false, "智能整理已关闭".into())
    } else {
        match selected_user_key(storage) {
            Ok(_) => (true, "使用自带 Key，消耗所选服务商账户额度".into()),
            Err(message) => (false, message),
        }
    };
    Ok(SmartArrangeSnapshot {
        preferences,
        available,
        message,
    })
}

#[tauri::command]
pub async fn pometodo_smart_arrange_state(
    app: tauri::AppHandle,
) -> Result<SmartArrangeSnapshot, String> {
    let (mut value, root) = with_storage(app, |storage| {
        Ok((snapshot(storage)?, storage.profile_directory.clone()))
    })
    .await?;
    if value.preferences.enabled && value.preferences.source == SmartArrangeSource::Official {
        let result = tauri::async_runtime::spawn_blocking(move || {
            crate::service_extension::available(&root)
        })
        .await
        .map_err(|_| "读取官方服务状态未完成")?;
        match result {
            Ok((available, message)) => {
                value.available = available;
                value.message = message;
            }
            Err(message) => {
                value.available = false;
                value.message = message;
            }
        }
    }
    Ok(value)
}

#[tauri::command]
pub async fn pometodo_set_smart_arrange(
    app: tauri::AppHandle,
    preferences: SmartArrangePreferences,
) -> Result<SmartArrangeSnapshot, String> {
    crate::distribution::validate_preferences(&preferences)?;
    with_storage(app.clone(), move |storage| {
        storage.repo.set_smart_arrange_preferences(preferences)?;
        Ok(())
    })
    .await?;
    pometodo_smart_arrange_state(app).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(not(feature = "official-services"))]
    fn fresh_install_and_saved_official_selection_are_byok_without_auto_enable() {
        let dir = tempfile::tempdir().unwrap();
        let mut storage = LocalStorage::open(dir.path()).unwrap();
        let value = snapshot(&storage).unwrap();
        assert_eq!(value.preferences.source, SmartArrangeSource::Byok);
        assert!(!value.preferences.enabled);
        let saved = SmartArrangePreferences {
            enabled: true,
            source: SmartArrangeSource::Official,
        };
        storage
            .repo
            .set_smart_arrange_preferences(saved.clone())
            .unwrap();
        let value = snapshot(&storage).unwrap();
        assert_eq!(value.preferences.source, SmartArrangeSource::Byok);
        assert!(!value.preferences.enabled);
        assert!(!value.available);
        assert_eq!(
            storage.repo.smart_arrange_preferences().unwrap(),
            saved,
            "读取不能改写旧设置"
        );
    }

    #[test]
    fn disabled_and_official_cannot_read_a_byok_key() {
        let dir = tempfile::tempdir().unwrap();
        let mut storage = LocalStorage::open(dir.path()).unwrap();
        assert_eq!(selected_user_key(&storage).unwrap_err(), "智能整理尚未开启");
        storage
            .repo
            .set_smart_arrange_preferences(SmartArrangePreferences {
                enabled: true,
                source: SmartArrangeSource::Official,
            })
            .unwrap();
        assert_eq!(
            selected_user_key(&storage).unwrap_err(),
            if crate::distribution::OFFICIAL_SERVICES {
                "请先登录并开通官方智能整理"
            } else {
                "智能整理尚未开启"
            }
        );
        storage
            .repo
            .set_smart_arrange_preferences(SmartArrangePreferences {
                enabled: true,
                source: SmartArrangeSource::Byok,
            })
            .unwrap();
        assert_eq!(
            selected_user_key(&storage).unwrap_err(),
            "请在设置中保存所选服务商的 API Key"
        );
    }

    #[test]
    fn custom_provider_requires_endpoint_and_model_before_calling_out() {
        let dir = tempfile::tempdir().unwrap();
        let mut storage = LocalStorage::open(dir.path()).unwrap();
        storage
            .repo
            .set_smart_arrange_preferences(SmartArrangePreferences {
                enabled: true,
                source: SmartArrangeSource::Byok,
            })
            .unwrap();
        crate::secrets::KeyStore::new(&storage.profile_directory.join("secrets"))
            .save("custom", "synthetic-only-key")
            .unwrap();
        storage
            .repo
            .update_settings(serde_json::json!({"aiProvider":"custom"}))
            .unwrap();
        // 地址与模型名缺失时给出可读提示，而不是把请求发到空地址。
        assert_eq!(
            selected_user_key(&storage).unwrap_err(),
            "请先在设置中填写接口地址"
        );
        storage
            .repo
            .update_settings(serde_json::json!({"aiBaseUrl":"http://127.0.0.1:11434/v1"}))
            .unwrap();
        assert_eq!(
            selected_user_key(&storage).unwrap_err(),
            "请先在设置中填写模型名"
        );
        storage
            .repo
            .update_settings(serde_json::json!({"aiModel":"qwen2.5"}))
            .unwrap();
        let selection = selected_user_key(&storage).unwrap();
        assert_eq!(selection.provider, "custom");
        assert_eq!(selection.model, "qwen2.5");
        // 本地 http 端点要能一路拼到 chat/completions。
        assert_eq!(
            selection.target().unwrap().endpoint,
            "http://127.0.0.1:11434/v1/chat/completions"
        );
    }
}
