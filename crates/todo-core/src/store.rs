use crate::models::{TodoDraft, TodoStatus, TodoTask};
use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::{params, Connection, OptionalExtension, Row};
use std::path::Path;
use std::time::Duration;

pub struct TodoRepository {
    conn: Connection,
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackupRecord {
    pub task: TodoTask,
    pub created_at: String,
    pub deleted_at: Option<String>,
    pub version: i64,
}

pub fn validate_backup_records(records: &[BackupRecord]) -> Result<(), String> {
    let mut ids = std::collections::HashSet::new();
    if records.len() > 100_000 {
        return Err("备份任务数量超过限制".into());
    }
    for record in records {
        let task = &record.task;
        if uuid::Uuid::parse_str(&task.id).is_err() || !ids.insert(&task.id) || record.version < 1 {
            return Err("备份任务标识重复或无效".into());
        }
        validate(TodoDraft {
            customer_name: task.customer_name.clone(),
            title: task.title.clone(),
            note: task.note.clone(),
            received_at: task.received_at.clone(),
            due_at: task.due_at.clone(),
            attachment_paths: task.attachment_paths.clone(),
        })?;
        for date in [
            Some(&record.created_at),
            Some(&task.updated_at),
            record.deleted_at.as_ref(),
            task.completed_at.as_ref(),
            task.urgent_at.as_ref(),
        ]
        .into_iter()
        .flatten()
        {
            DateTime::parse_from_rfc3339(date).map_err(|_| "备份中包含无效日期")?;
        }
    }
    Ok(())
}

const SELECT_TASK: &str = "SELECT id, customer_name, title, note, status, received_at,
    due_at, urgent_at, completed_at, attachment_paths, updated_at FROM todo_tasks";

fn storage_error(error: rusqlite::Error) -> String {
    format!("本地数据操作失败，请检查磁盘空间和目录权限：{error}")
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn status_name(status: TodoStatus) -> &'static str {
    match status {
        TodoStatus::Pending => "pending",
        TodoStatus::InProgress => "in_progress",
        TodoStatus::Completed => "completed",
    }
}

fn read_task(row: &Row<'_>) -> rusqlite::Result<TodoTask> {
    let status: String = row.get(4)?;
    let status = match status.as_str() {
        "pending" => TodoStatus::Pending,
        "in_progress" => TodoStatus::InProgress,
        "completed" => TodoStatus::Completed,
        _ => return Err(rusqlite::Error::InvalidQuery),
    };
    let attachments: String = row.get(9)?;
    let attachment_paths = serde_json::from_str(&attachments).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(9, rusqlite::types::Type::Text, Box::new(error))
    })?;
    Ok(TodoTask {
        id: row.get(0)?,
        customer_name: row.get(1)?,
        title: row.get(2)?,
        note: row.get(3)?,
        status,
        received_at: row.get(5)?,
        due_at: row.get(6)?,
        urgent_at: row.get(7)?,
        completed_at: row.get(8)?,
        attachment_paths,
        updated_at: row.get(10)?,
    })
}

fn get_task(conn: &Connection, id: &str) -> Result<TodoTask, String> {
    conn.query_row(
        &format!("{SELECT_TASK} WHERE id = ?1 AND deleted_at IS NULL"),
        [id],
        read_task,
    )
    .optional()
    .map_err(storage_error)?
    .ok_or_else(|| "这条待办不存在或已删除".into())
}

fn validate(mut draft: TodoDraft) -> Result<TodoDraft, String> {
    draft.customer_name = draft.customer_name.trim().to_string();
    draft.title = draft.title.trim().to_string();
    draft.note = draft.note.trim().to_string();
    if draft.title.is_empty() {
        return Err("请填写任务内容".into());
    }
    DateTime::parse_from_rfc3339(&draft.received_at)
        .map_err(|_| "接收日期无效，请重新选择".to_string())?;
    if let Some(date) = &draft.due_at {
        DateTime::parse_from_rfc3339(date)
            .map_err(|_| "完成日期无效，请重新选择或清空".to_string())?;
    }
    Ok(draft)
}

impl TodoRepository {
    pub fn backup_records(&self) -> Result<Vec<BackupRecord>, String> {
        let columns = SELECT_TASK
            .strip_suffix(" FROM todo_tasks")
            .expect("task query has a fixed table");
        let mut statement = self
            .conn
            .prepare(&format!(
                "{columns}, created_at, deleted_at, version FROM todo_tasks"
            ))
            .map_err(storage_error)?;
        let result = statement
            .query_map([], |row| {
                Ok(BackupRecord {
                    task: read_task(row)?,
                    created_at: row.get(11)?,
                    deleted_at: row.get(12)?,
                    version: row.get(13)?,
                })
            })
            .map_err(storage_error)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(storage_error)?;
        validate_backup_records(&result)?;
        Ok(result)
    }

    pub fn replace_backup_records(
        &mut self,
        records: &[BackupRecord],
        images: &std::collections::BTreeMap<String, String>,
    ) -> Result<(), String> {
        validate_backup_records(records)?;
        let tx = self.conn.transaction().map_err(storage_error)?;
        tx.execute("DELETE FROM todo_tasks", [])
            .map_err(storage_error)?;
        for record in records {
            let t = &record.task;
            let attachments = t
                .attachment_paths
                .iter()
                .map(|id| {
                    images
                        .get(id)
                        .cloned()
                        .ok_or_else(|| "备份缺少任务截图".to_string())
                })
                .collect::<Result<Vec<_>, _>>()?;
            let attachments = serde_json::to_string(&attachments).map_err(|e| e.to_string())?;
            tx.execute("INSERT INTO todo_tasks(id,customer_name,title,note,status,received_at,due_at,urgent_at,completed_at,attachment_paths,created_at,updated_at,deleted_at,version) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)", params![t.id,t.customer_name,t.title,t.note,status_name(t.status),t.received_at,t.due_at,t.urgent_at,t.completed_at,attachments,record.created_at,t.updated_at,record.deleted_at,record.version]).map_err(storage_error)?;
        }
        tx.commit().map_err(storage_error)
    }

    /// 调用方持有存储锁；SQLite 在线备份包含 WAL 中已提交的事务。
    pub fn snapshot_to(&self, path: &Path) -> Result<(), String> {
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .map_err(|error| format!("无法创建备份文件（不会覆盖已有文件）：{error}"))?;
        self.conn
            .backup(rusqlite::DatabaseName::Main, path, None)
            .map_err(storage_error)
    }

    pub fn attachment_ids(&self) -> Result<std::collections::BTreeSet<String>, String> {
        let mut statement = self
            .conn
            .prepare("SELECT attachment_paths FROM todo_tasks")
            .map_err(storage_error)?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(storage_error)?;
        let mut ids = std::collections::BTreeSet::new();
        for row in rows {
            let values: Vec<String> = serde_json::from_str(&row.map_err(storage_error)?)
                .map_err(|_| "截图记录损坏，操作已停止")?;
            ids.extend(values);
        }
        Ok(ids)
    }

    pub fn open(path: &Path) -> Result<Self, String> {
        Self::from_connection(Connection::open(path).map_err(storage_error)?)
    }

    pub fn open_in_memory() -> Result<Self, String> {
        Self::from_connection(Connection::open_in_memory().map_err(storage_error)?)
    }

    fn from_connection(mut conn: Connection) -> Result<Self, String> {
        conn.busy_timeout(Duration::from_secs(3))
            .map_err(storage_error)?;
        let version: i64 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .map_err(storage_error)?;
        if version > 2 {
            return Err("这份数据来自较新的 PomeTodo，请更新软件后打开".into());
        }
        if version == 0 {
            let tables: i64 = conn.query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
                [], |row| row.get(0),
            ).map_err(storage_error)?;
            if tables != 0 {
                return Err("无法识别这份数据库，已保留原文件，请通过数据导入处理".into());
            }
            let tx = conn.transaction().map_err(storage_error)?;
            tx.execute_batch(
                "CREATE TABLE todo_tasks (
                    id TEXT PRIMARY KEY,
                    customer_name TEXT NOT NULL DEFAULT '',
                    title TEXT NOT NULL CHECK(length(trim(title)) > 0),
                    note TEXT NOT NULL DEFAULT '',
                    status TEXT NOT NULL CHECK(status IN ('pending','in_progress','completed')),
                    received_at TEXT NOT NULL, due_at TEXT, urgent_at TEXT, completed_at TEXT,
                    attachment_paths TEXT NOT NULL DEFAULT '[]',
                    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                    deleted_at TEXT, version INTEGER NOT NULL DEFAULT 1
                );
                CREATE INDEX idx_todo_visible ON todo_tasks(deleted_at, status, updated_at);
                CREATE TABLE app_preferences (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                PRAGMA user_version = 2;",
            )
            .map_err(storage_error)?;
            tx.commit().map_err(storage_error)?;
        }
        if version == 1 {
            // 客户改选填：重建任务表去掉客户非空约束，数据与列顺序原样保留。
            let tx = conn.transaction().map_err(storage_error)?;
            tx.execute_batch(
                "CREATE TABLE todo_tasks_v2 (
                    id TEXT PRIMARY KEY,
                    customer_name TEXT NOT NULL DEFAULT '',
                    title TEXT NOT NULL CHECK(length(trim(title)) > 0),
                    note TEXT NOT NULL DEFAULT '',
                    status TEXT NOT NULL CHECK(status IN ('pending','in_progress','completed')),
                    received_at TEXT NOT NULL, due_at TEXT, urgent_at TEXT, completed_at TEXT,
                    attachment_paths TEXT NOT NULL DEFAULT '[]',
                    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                    deleted_at TEXT, version INTEGER NOT NULL DEFAULT 1
                );
                INSERT INTO todo_tasks_v2 SELECT id, customer_name, title, note, status, received_at, due_at, urgent_at, completed_at, attachment_paths, created_at, updated_at, deleted_at, version FROM todo_tasks;
                DROP TABLE todo_tasks;
                ALTER TABLE todo_tasks_v2 RENAME TO todo_tasks;
                CREATE INDEX idx_todo_visible ON todo_tasks(deleted_at, status, updated_at);
                PRAGMA user_version = 2;",
            )
            .map_err(storage_error)?;
            tx.commit().map_err(storage_error)?;
        }
        conn.execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;",
        )
        .map_err(storage_error)?;
        // 启动时确认所需列可读；不能把损坏或不兼容结构当成空任务列表。
        conn.prepare(&format!("{SELECT_TASK} WHERE deleted_at IS NULL LIMIT 0"))
            .map_err(storage_error)?;
        Ok(Self { conn })
    }

    pub fn list(&self) -> Result<Vec<TodoTask>, String> {
        let mut stmt = self
            .conn
            .prepare(&format!(
                "{SELECT_TASK} WHERE deleted_at IS NULL ORDER BY updated_at DESC, id"
            ))
            .map_err(storage_error)?;
        let rows = stmt.query_map([], read_task).map_err(storage_error)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(storage_error)
    }

    pub fn create(&mut self, draft: TodoDraft) -> Result<TodoTask, String> {
        let draft = validate(draft)?;
        let attachments =
            serde_json::to_string(&draft.attachment_paths).map_err(|error| error.to_string())?;
        let id = uuid::Uuid::new_v4().to_string();
        let timestamp = now();
        let tx = self.conn.transaction().map_err(storage_error)?;
        tx.execute(
            "INSERT INTO todo_tasks (id, customer_name, title, note, status, received_at, due_at,
                attachment_paths, created_at, updated_at) VALUES (?1,?2,?3,?4,'pending',?5,?6,?7,?8,?8)",
            params![id, draft.customer_name, draft.title, draft.note, draft.received_at, draft.due_at, attachments, timestamp],
        ).map_err(storage_error)?;
        let result = get_task(&tx, &id)?;
        tx.commit().map_err(storage_error)?;
        Ok(result)
    }

    pub fn update(&mut self, id: &str, draft: TodoDraft) -> Result<TodoTask, String> {
        let draft = validate(draft)?;
        let attachments =
            serde_json::to_string(&draft.attachment_paths).map_err(|error| error.to_string())?;
        let tx = self.conn.transaction().map_err(storage_error)?;
        tx.execute(
            "UPDATE todo_tasks SET customer_name=?2, title=?3, note=?4, received_at=?5, due_at=?6,
                attachment_paths=?7, updated_at=?8, version=version+1 WHERE id=?1 AND deleted_at IS NULL",
            params![id, draft.customer_name, draft.title, draft.note, draft.received_at, draft.due_at, attachments, now()],
        ).map_err(storage_error)?;
        let result = get_task(&tx, id)?;
        tx.commit().map_err(storage_error)?;
        Ok(result)
    }

    pub fn set_status(&mut self, id: &str, status: TodoStatus) -> Result<TodoTask, String> {
        let tx = self.conn.transaction().map_err(storage_error)?;
        let existing = get_task(&tx, id)?;
        if existing.status == status {
            return Ok(existing);
        }
        let timestamp = now();
        let completed_at = (status == TodoStatus::Completed).then_some(timestamp.clone());
        tx.execute(
            "UPDATE todo_tasks SET status=?2, completed_at=?3,
                urgent_at=CASE WHEN ?2='completed' THEN NULL ELSE urgent_at END,
                updated_at=?4, version=version+1 WHERE id=?1 AND deleted_at IS NULL",
            params![id, status_name(status), completed_at, timestamp],
        )
        .map_err(storage_error)?;
        let result = get_task(&tx, id)?;
        tx.commit().map_err(storage_error)?;
        Ok(result)
    }

    pub fn set_urgent(&mut self, id: &str, urgent: bool) -> Result<TodoTask, String> {
        let tx = self.conn.transaction().map_err(storage_error)?;
        let task = get_task(&tx, id)?;
        if urgent && task.status == TodoStatus::Completed {
            return Err("已完成的待办无需加急".into());
        }
        let timestamp = now();
        let urgent_at = urgent.then_some(timestamp.clone());
        tx.execute(
            "UPDATE todo_tasks SET urgent_at=?2, updated_at=?3, version=version+1 WHERE id=?1 AND deleted_at IS NULL",
            params![id, urgent_at, timestamp],
        ).map_err(storage_error)?;
        let result = get_task(&tx, id)?;
        tx.commit().map_err(storage_error)?;
        Ok(result)
    }

    pub fn delete(&mut self, id: &str) -> Result<(), String> {
        self.conn.execute(
            "UPDATE todo_tasks SET deleted_at=?2, updated_at=?2, version=version+1 WHERE id=?1 AND deleted_at IS NULL",
            params![id, now()],
        ).map_err(storage_error)?;
        Ok(())
    }

    pub fn theme(&self) -> Result<String, String> {
        Ok(self
            .conn
            .query_row(
                "SELECT value FROM app_preferences WHERE key='theme'",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(storage_error)?
            .unwrap_or_else(|| "system".into()))
    }

    pub(crate) fn read_preference(&self, key: &str) -> Result<Option<String>, String> {
        self.conn
            .query_row(
                "SELECT value FROM app_preferences WHERE key=?1",
                [key],
                |row| row.get(0),
            )
            .optional()
            .map_err(storage_error)
    }

    pub(crate) fn save_preferences(&mut self, values: &[(&str, &str)]) -> Result<(), String> {
        let tx = self.conn.transaction().map_err(storage_error)?;
        for (key, value) in values {
            tx.execute("INSERT INTO app_preferences(key,value) VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                params![key,value]).map_err(storage_error)?;
        }
        tx.commit().map_err(storage_error)
    }

    pub fn set_theme(&mut self, theme: &str) -> Result<(), String> {
        if !matches!(theme, "light" | "dark" | "system") {
            return Err("不支持的主题选项".into());
        }
        self.conn.execute(
            "INSERT INTO app_preferences(key,value) VALUES ('theme',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            [theme],
        ).map_err(storage_error)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests;
