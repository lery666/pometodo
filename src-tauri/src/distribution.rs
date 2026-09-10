use pometodo_core::smart_arrange::{SmartArrangePreferences, SmartArrangeSource};

pub const OFFICIAL_SERVICES: bool = cfg!(feature = "official-services");
pub const SERVICE_MODE: &str = if OFFICIAL_SERVICES {
    "official"
} else {
    "byok"
};
pub const UPDATE_CHANNEL: &str = if OFFICIAL_SERVICES {
    "standalone"
} else {
    "byok"
};
// 本仓库是 ShiliuX-Team/pometodo 的衍生版本，已断开上游官方更新渠道：
// 空字符串表示不检查更新，避免把用户引导去安装官方版本。
// 若你需要自建更新渠道：改成自己的 release.json 地址，并同步修改
// updates.rs 中 allowed_download_url 的域名白名单与 DOWNLOAD_PATH。
pub const MANIFEST_URL: &str = "";
pub const DOWNLOAD_PATH: &str = if OFFICIAL_SERVICES {
    "/downloads/pometodo/releases/"
} else {
    "/downloads/pometodo/byok/releases/"
};

pub fn effective_preferences(mut value: SmartArrangePreferences) -> SmartArrangePreferences {
    if !OFFICIAL_SERVICES && value.source == SmartArrangeSource::Official {
        value.enabled = false;
        value.source = SmartArrangeSource::Byok;
    }
    value
}

pub fn validate_preferences(value: &SmartArrangePreferences) -> Result<(), String> {
    if !OFFICIAL_SERVICES && value.source != SmartArrangeSource::Byok {
        return Err("请使用自带 Key 配置智能整理".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_selection_is_validated_without_auto_enabling_or_changing_byok() {
        for enabled in [false, true] {
            let byok = SmartArrangePreferences {
                enabled,
                source: SmartArrangeSource::Byok,
            };
            assert!(validate_preferences(&byok).is_ok());
            assert_eq!(effective_preferences(byok.clone()), byok);
            let official = SmartArrangePreferences {
                enabled,
                source: SmartArrangeSource::Official,
            };
            assert_eq!(validate_preferences(&official).is_ok(), OFFICIAL_SERVICES);
            if OFFICIAL_SERVICES {
                assert_eq!(effective_preferences(official.clone()), official);
            } else {
                assert_eq!(
                    effective_preferences(official),
                    SmartArrangePreferences {
                        enabled: false,
                        source: SmartArrangeSource::Byok
                    }
                );
            }
        }
    }
}
