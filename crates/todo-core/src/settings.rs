use crate::store::TodoRepository;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QuickDueSetting {
    pub label: String,
    pub days: i32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppSettings {
    pub theme: String,
    pub start_with_windows: bool,
    pub start_minimized: bool,
    pub floating_ball_enabled: bool,
    pub close_action: String,
    pub daily_reminder_enabled: bool,
    pub daily_reminder_time: String,
    pub quick_due_options: Vec<QuickDueSetting>,
    pub ai_provider: String,
    /// 自定义服务商的接口基地址，仅 ai_provider == "custom" 时参与请求。
    /// 默认空串并允许缺省，保证升级前保存的配置仍能读取。
    #[serde(default)]
    pub ai_base_url: String,
    /// 自定义服务商的模型名，仅 ai_provider == "custom" 时参与请求。
    #[serde(default)]
    pub ai_model: String,
    /// “客户”字段的显示名（如“甲方”“项目”），默认“客户”；仅影响界面文案。
    #[serde(default = "default_customer_label")]
    pub customer_label: String,
}

fn default_customer_label() -> String {
    "客户".into()
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            theme: "system".into(),
            start_with_windows: false,
            start_minimized: false,
            floating_ball_enabled: true,
            close_action: "tray".into(),
            daily_reminder_enabled: false,
            daily_reminder_time: "09:00".into(),
            quick_due_options: [
                ("今天", 0),
                ("明天", 1),
                ("后天", 2),
                ("+3天", 3),
                ("+7天", 7),
            ]
            .into_iter()
            .map(|(label, days)| QuickDueSetting {
                label: label.into(),
                days,
            })
            .collect(),
            ai_provider: "deepseek".into(),
            ai_base_url: String::new(),
            ai_model: String::new(),
            customer_label: "客户".into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomerSetting {
    pub original_name: String,
    pub display_name: String,
    pub active_count: usize,
}

impl TodoRepository {
    pub fn claim_daily_reminder(
        &mut self,
        now: chrono::DateTime<chrono::FixedOffset>,
    ) -> Result<Option<usize>, String> {
        let settings = self.settings()?;
        if !settings.daily_reminder_enabled
            || now.format("%H:%M").to_string() < settings.daily_reminder_time
        {
            return Ok(None);
        }
        let date = now.date_naive();
        let date_text = date.to_string();
        if self.read_preference("daily_reminder_last_date")?.as_deref() == Some(date_text.as_str())
        {
            return Ok(None);
        }
        let count = self
            .list()?
            .iter()
            .filter(|task| {
                task.status != crate::models::TodoStatus::Completed
                    && task
                        .due_at
                        .as_ref()
                        .and_then(|due| chrono::DateTime::parse_from_rfc3339(due).ok())
                        .is_some_and(|due| due.with_timezone(now.offset()).date_naive() == date)
            })
            .count();
        // 先记录本日投递尝试，保证重启不会在同一天反复打扰。
        self.save_preferences(&[("daily_reminder_last_date", &date_text)])?;
        Ok((count > 0).then_some(count))
    }
    fn preference_json<T: serde::de::DeserializeOwned + Default>(
        &self,
        key: &str,
    ) -> Result<T, String> {
        match self.read_preference(key)? {
            Some(value) => serde_json::from_str(&value)
                .map_err(|_| format!("本地设置 {key} 无法读取，请保留文件并检查")),
            None => Ok(T::default()),
        }
    }

    pub fn settings(&self) -> Result<AppSettings, String> {
        let mut settings: AppSettings = self.preference_json("app_settings")?;
        settings.theme = self.theme()?;
        settings.validate()?;
        Ok(settings)
    }

    pub fn update_settings(&mut self, patch: serde_json::Value) -> Result<AppSettings, String> {
        let settings = self.settings()?.patched(patch)?;
        let serialized = serde_json::to_string(&settings).map_err(|e| e.to_string())?;
        self.save_preferences(&[("app_settings", &serialized), ("theme", &settings.theme)])?;
        Ok(settings)
    }

    pub fn customers(&self) -> Result<Vec<CustomerSetting>, String> {
        let aliases: BTreeMap<String, String> = self.preference_json("customer_aliases")?;
        let hidden: HashSet<String> = self.preference_json("hidden_customers")?;
        let mut rows = BTreeMap::<String, CustomerSetting>::new();
        for task in self.list()? {
            let name = task.customer_name.trim();
            // 空客户名不参与联想，避免生成空白选项。
            if name.is_empty() {
                continue;
            }
            let key = name.to_lowercase();
            if hidden.contains(&key) {
                continue;
            }
            let row = rows.entry(key.clone()).or_insert_with(|| CustomerSetting {
                display_name: aliases
                    .get(&key)
                    .cloned()
                    .unwrap_or_else(|| name.to_string()),
                original_name: name.to_string(),
                active_count: 0,
            });
            if task.status != crate::models::TodoStatus::Completed {
                row.active_count += 1;
            }
        }
        let mut result: Vec<_> = rows.into_values().collect();
        result.sort_by_key(|row| row.display_name.to_lowercase());
        Ok(result)
    }

    pub fn rename_customer(&mut self, original: &str, display: &str) -> Result<(), String> {
        let display = display.trim();
        if display.is_empty() || display.chars().count() > 100 {
            return Err("客户显示名需为 1–100 个字".into());
        }
        if !self
            .list()?
            .iter()
            .any(|t| t.customer_name.to_lowercase() == original.to_lowercase())
        {
            return Err("客户已不存在，请刷新后重试".into());
        }
        let mut aliases: BTreeMap<String, String> = self.preference_json("customer_aliases")?;
        aliases.insert(original.to_lowercase(), display.into());
        let serialized = serde_json::to_string(&aliases).map_err(|e| e.to_string())?;
        self.save_preferences(&[("customer_aliases", &serialized)])
    }

    pub fn hide_customer(&mut self, original: &str) -> Result<(), String> {
        let mut hidden: HashSet<String> = self.preference_json("hidden_customers")?;
        hidden.insert(original.to_lowercase());
        let serialized = serde_json::to_string(&hidden).map_err(|e| e.to_string())?;
        self.save_preferences(&[("hidden_customers", &serialized)])
    }
}

impl AppSettings {
    pub fn patched(&self, patch: serde_json::Value) -> Result<Self, String> {
        let patch = patch.as_object().ok_or("设置格式不正确")?;
        let mut merged = serde_json::to_value(self).map_err(|e| e.to_string())?;
        let object = merged.as_object_mut().ok_or("设置格式不正确")?;
        for (key, value) in patch {
            object.insert(key.clone(), value.clone());
        }
        let mut settings: Self =
            serde_json::from_value(merged).map_err(|_| "设置字段或值不正确".to_string())?;
        for option in &mut settings.quick_due_options {
            option.label = option.label.trim().into();
        }
        settings.customer_label = settings.customer_label.trim().into();
        settings.ai_base_url = settings.ai_base_url.trim().into();
        settings.ai_model = settings.ai_model.trim().into();
        settings.validate()?;
        Ok(settings)
    }

    pub fn validate(&self) -> Result<(), String> {
        if !matches!(self.theme.as_str(), "system" | "light" | "dark") {
            return Err("主题无效".into());
        }
        if !matches!(self.close_action.as_str(), "tray" | "exit") {
            return Err("关闭行为无效".into());
        }
        if !matches!(
            self.ai_provider.as_str(),
            "deepseek" | "qwen" | "glm" | "custom"
        ) {
            return Err("AI 服务商无效".into());
        }
        validate_ai_base_url(&self.ai_base_url)?;
        // 模型名允许留空（未填完时不阻断设置保存），只约束能安全放进请求体的字符。
        if self.ai_model.chars().count() > 200 || self.ai_model.chars().any(char::is_control) {
            return Err("模型名不能超过 200 个字且不能包含控制字符".into());
        }
        let customer_label = self.customer_label.trim();
        if customer_label.is_empty() || customer_label.chars().count() > 12 {
            return Err("客户字段名称无效".into());
        }
        let time = self.daily_reminder_time.as_bytes();
        if time.len() != 5
            || time[2] != b':'
            || ![time[0], time[1], time[3], time[4]]
                .iter()
                .all(u8::is_ascii_digit)
            || (time[0] - b'0') * 10 + time[1] - b'0' > 23
            || (time[3] - b'0') * 10 + time[4] - b'0' > 59
        {
            return Err("提醒时间请使用有效的 HH:mm（如 09:00）".into());
        }
        if self.quick_due_options.is_empty() || self.quick_due_options.len() > 12 {
            return Err("请保留 1–12 个完成日期标签".into());
        }
        let mut names = HashSet::new();
        for option in &self.quick_due_options {
            let label = option.label.trim();
            if label.is_empty() || label.chars().count() > 12 || !(0..=365).contains(&option.days) {
                return Err("标签名需为 1–12 个字，天数需为 0–365 的整数".into());
            }
            if !names.insert(label.to_lowercase()) {
                return Err("完成日期标签名不能重复".into());
            }
        }
        Ok(())
    }
}

/// 校验自定义服务商的接口基地址。
///
/// 允许留空（未填完时不阻断设置保存），只做保守的形状检查：
/// 必须显式写出 http:// 或 https:// 前缀、带主机名、不含空白与控制字符。
/// 这里不限定域名，本地与内网中转都需要能填；真正的连接由请求层负责。
fn validate_ai_base_url(value: &str) -> Result<(), String> {
    let text = value.trim();
    if text.is_empty() {
        return Ok(());
    }
    if text.chars().count() > 2048 {
        return Err("接口地址过长，请检查".into());
    }
    if text.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err("接口地址不能包含空格、换行或控制字符".into());
    }
    let after_scheme = strip_prefix_ignore_ascii_case(text, "https://")
        .or_else(|| strip_prefix_ignore_ascii_case(text, "http://"))
        .ok_or("接口地址需以 http:// 或 https:// 开头")?;
    // 取 authority 部分，再看主机名；用户信息（user:pass@host）不计入主机名。
    let authority = after_scheme.split(['/', '?', '#']).next().unwrap_or("");
    let host = authority.rsplit('@').next().unwrap_or("");
    if host.split(':').next().unwrap_or("").is_empty() {
        return Err("接口地址缺少主机名".into());
    }
    Ok(())
}

/// 按 ASCII 忽略大小写去掉前缀；用 get 取切片，避免在多字节字符边界上 panic。
fn strip_prefix_ignore_ascii_case<'a>(text: &'a str, prefix: &str) -> Option<&'a str> {
    let head = text.get(..prefix.len())?;
    if head.eq_ignore_ascii_case(prefix) {
        text.get(prefix.len()..)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{TodoDraft, TodoStatus};
    use serde_json::json;

    #[test]
    fn daily_reminder_is_disabled_for_new_users() {
        let repo = TodoRepository::open_in_memory().unwrap();

        assert!(!repo.settings().unwrap().daily_reminder_enabled);
    }

    #[test]
    fn daily_reminder_uses_local_due_date_and_survives_restart() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("tasks.sqlite");
        let mut repo = TodoRepository::open(&path).unwrap();
        repo.update_settings(json!({"dailyReminderEnabled":true,"dailyReminderTime":"09:00"}))
            .unwrap();
        for due in [
            Some("2026-09-05T16:00:00Z"),
            Some("2026-09-04T16:00:00Z"),
            None,
        ] {
            repo.create(TodoDraft {
                customer_name: "测试".into(),
                title: "任务".into(),
                note: String::new(),
                received_at: "2026-09-05T16:00:00Z".into(),
                due_at: due.map(str::to_string),
                attachment_paths: vec![],
            })
            .unwrap();
        }
        let early = chrono::DateTime::parse_from_rfc3339("2026-09-06T08:59:00+08:00").unwrap();
        let due = chrono::DateTime::parse_from_rfc3339("2026-09-06T09:00:00+08:00").unwrap();
        assert_eq!(repo.claim_daily_reminder(early).unwrap(), None);
        assert_eq!(repo.claim_daily_reminder(due).unwrap(), Some(1));
        drop(repo);
        let mut repo = TodoRepository::open(&path).unwrap();
        assert_eq!(repo.claim_daily_reminder(due).unwrap(), None);
    }

    #[test]
    fn customer_suggestions_skip_blank_names_and_use_named_tasks() {
        let mut repo = TodoRepository::open_in_memory().unwrap();
        for name in ["测试", "", "  ", "测试"] {
            repo.create(TodoDraft {
                customer_name: name.into(),
                title: "任务".into(),
                note: String::new(),
                received_at: "2026-09-05T16:00:00Z".into(),
                due_at: None,
                attachment_paths: vec![],
            })
            .unwrap();
        }
        let customers = repo.customers().unwrap();
        let names: Vec<_> = customers
            .iter()
            .map(|row| row.display_name.as_str())
            .collect();
        assert_eq!(names, vec!["测试"]);
    }

    #[test]
    fn settings_persist_and_keep_other_fields_and_toolbar_theme() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("tasks.sqlite");
        let mut repo = TodoRepository::open(&path).unwrap();
        repo.update_settings(json!({"startMinimized":true,"dailyReminderTime":"12:30"}))
            .unwrap();
        repo.update_settings(json!({"floatingBallEnabled":true,"theme":"dark"}))
            .unwrap();
        drop(repo);
        let mut repo = TodoRepository::open(&path).unwrap();
        let settings = repo.settings().unwrap();
        assert!(settings.start_minimized && settings.floating_ball_enabled);
        assert_eq!(settings.daily_reminder_time, "12:30");
        assert_eq!(repo.theme().unwrap(), "dark");
        repo.set_theme("light").unwrap();
        assert_eq!(repo.settings().unwrap().theme, "light");
    }

    #[test]
    fn invalid_patches_never_change_saved_settings() {
        let mut repo = TodoRepository::open_in_memory().unwrap();
        let initial = repo.settings().unwrap();
        for patch in [
            json!({"dailyReminderTime":"24:00"}),
            json!({"dailyReminderTime":"9:00"}),
            json!({"dailyReminderTime":"12:60"}),
            json!({"theme":"unknown"}),
            json!({"closeAction":"close-all"}),
            json!({"aiProvider":"unknown"}),
            json!({"startMinimized":"true"}),
            json!({"cloudSyncEnabled":true}),
            json!({"quickDueOptions":[]}),
            json!({"quickDueOptions":[{"label":"  ","days":1}]}),
            json!({"quickDueOptions":[{"label":"下周","days":1.5}]}),
            json!({"quickDueOptions":[{"label":"下周","days":366}]}),
            json!({"quickDueOptions":[{"label":"A","days":1},{"label":"a","days":2}]}),
        ] {
            assert!(repo.update_settings(patch).is_err());
            assert_eq!(repo.settings().unwrap(), initial);
        }
    }

    #[test]
    fn customer_alias_and_hide_only_change_suggestions() {
        let mut repo = TodoRepository::open_in_memory().unwrap();
        let draft = TodoDraft {
            customer_name: "示例客户".into(),
            title: "示例任务".into(),
            note: String::new(),
            received_at: "2026-09-06T00:00:00Z".into(),
            due_at: None,
            attachment_paths: vec![],
        };
        let task = repo.create(draft.clone()).unwrap();
        let done = repo.create(draft).unwrap();
        repo.set_status(&done.id, TodoStatus::Completed).unwrap();
        repo.rename_customer("示例客户", "新显示名").unwrap();
        assert_eq!(
            repo.customers().unwrap(),
            vec![CustomerSetting {
                original_name: "示例客户".into(),
                display_name: "新显示名".into(),
                active_count: 1
            }]
        );
        assert!(repo.rename_customer("示例客户", " ").is_err());
        repo.hide_customer("示例客户").unwrap();
        assert!(repo.customers().unwrap().is_empty());
        assert_eq!(
            repo.list()
                .unwrap()
                .iter()
                .find(|t| t.id == task.id)
                .unwrap()
                .customer_name,
            "示例客户"
        );
        assert_eq!(repo.list().unwrap().len(), 2);
    }

    #[test]
    fn settings_saved_before_custom_endpoint_fields_still_load() {
        let mut repo = TodoRepository::open_in_memory().unwrap();
        // 模拟升级前的配置：完全没有 aiBaseUrl / aiModel 两个字段。
        let legacy = concat!(
            r#"{"theme":"system","startWithWindows":false,"startMinimized":false,"#,
            r#""floatingBallEnabled":true,"closeAction":"tray","dailyReminderEnabled":false,"#,
            r#""dailyReminderTime":"09:00","quickDueOptions":[{"label":"今天","days":0}],"#,
            r#""aiProvider":"deepseek","customerLabel":"客户"}"#
        );
        repo.save_preferences(&[("app_settings", legacy)]).unwrap();
        let settings = repo.settings().unwrap();
        assert_eq!(settings.ai_provider, "deepseek");
        assert!(settings.ai_base_url.is_empty() && settings.ai_model.is_empty());
    }

    #[test]
    fn custom_provider_accepts_blank_fields_and_rejects_malformed_addresses() {
        let mut repo = TodoRepository::open_in_memory().unwrap();
        // 先切到自定义服务商、地址留空：不阻断保存，避免设置页在填完之前卡死。
        let saved = repo
            .update_settings(json!({"aiProvider":"custom"}))
            .unwrap();
        assert_eq!(saved.ai_provider, "custom");
        assert!(saved.ai_base_url.is_empty() && saved.ai_model.is_empty());
        // 本地回环 http 与带凭据的 https 都要能存，前端才能连自建或内网中转。
        for url in [
            "https://apihub.agnes-ai.com/v1",
            "http://127.0.0.1:11434/v1",
            "http://192.168.1.8:3000/v1",
        ] {
            let saved = repo
                .update_settings(json!({"aiBaseUrl": url, "aiModel": "agnes-2.0-flash"}))
                .unwrap();
            assert_eq!(saved.ai_base_url, url);
            assert_eq!(saved.ai_model, "agnes-2.0-flash");
        }
        let initial = repo.settings().unwrap();
        for patch in [
            json!({"aiBaseUrl":"apihub.agnes-ai.com/v1"}),
            json!({"aiBaseUrl":"https://"}),
            json!({"aiBaseUrl":"https://a b.c/v1"}),
            json!({"aiBaseUrl":"ftp://example.com/v1"}),
            json!({"aiModel":"bad\nmodel"}),
        ] {
            assert!(repo.update_settings(patch).is_err());
            assert_eq!(repo.settings().unwrap(), initial);
        }
    }
}
