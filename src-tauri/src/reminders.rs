use crate::commands::StorageState;
use tauri::{Emitter, Manager};
use tauri_plugin_notification::NotificationExt;

pub fn start(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let mut last_error = None;
        loop {
            let result = check(&app);
            let error = result.err();
            if error != last_error {
                if let Some(message) = &error {
                    let _ = app.emit("pometodo-system-error", message);
                }
                last_error = error;
            }
            std::thread::sleep(std::time::Duration::from_secs(30));
        }
    });
}

fn check(app: &tauri::AppHandle) -> Result<(), String> {
    let (count, due_word) = {
        let state = app.state::<StorageState>();
        let mut guard = state.inner.lock().map_err(|_| "提醒未能读取任务")?;
        let storage = guard.as_mut().map_err(|error| error.clone())?;
        let due_word = match storage.repo.settings()?.customer_label.as_str() {
            "事项" | "科目" => "完成",
            _ => "交付",
        };
        (
            storage
                .repo
                .claim_daily_reminder(chrono::Local::now().fixed_offset())?,
            due_word,
        )
    };
    if let Some(count) = count {
        app.notification()
            .builder()
            .title("PomeTodo 每日提醒")
            .body(format!("今天有 {count} 个任务待{due_word}"))
            .show()
            .map_err(|_| "系统通知未能发送，请检查 Windows 通知设置".to_string())?;
    }
    Ok(())
}
