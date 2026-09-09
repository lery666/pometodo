use crate::{commands::with_storage, secrets::KeyStore};
use pometodo_core::{
    local::LocalStorage,
    smart_arrange::{SmartArrangePreferences, SmartArrangeSource},
};
use serde::Serialize;

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

pub fn selected_user_key(storage: &LocalStorage) -> Result<(String, String), String> {
    let preferences = storage.repo.smart_arrange_preferences()?;
    require_enabled(&preferences)?;
    if preferences.source != SmartArrangeSource::Byok {
        return Err("请先登录并开通官方智能整理".into());
    }
    let provider = storage.repo.settings()?.ai_provider;
    let key = KeyStore::new(&storage.profile_directory.join("secrets"))
        .read(&provider)?
        .ok_or_else(|| "请在设置中保存所选服务商的 API Key".to_string())?;
    Ok((provider, key))
}

fn snapshot(storage: &LocalStorage) -> Result<SmartArrangeSnapshot, String> {
    let preferences = storage.repo.smart_arrange_preferences()?;
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
        let result =
            tauri::async_runtime::spawn_blocking(move || crate::official::available(&root))
                .await
                .map_err(|_| "读取官方服务状态未完成")?;
        match result {
            Ok(status) => {
                value.available = status.available;
                value.message = status.message;
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
            "请先登录并开通官方智能整理"
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
}
