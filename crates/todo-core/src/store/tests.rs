use super::*;

#[test]
fn failed_restore_rolls_back_the_delete_and_keeps_preferences() {
    let mut current = TodoRepository::open_in_memory().unwrap();
    let saved = current.create(sample()).unwrap();
    current.set_theme("dark").unwrap();
    let mut source = TodoRepository::open_in_memory().unwrap();
    source.create(sample()).unwrap();
    let records = source.backup_records().unwrap();
    current.conn.execute_batch("CREATE TRIGGER fail_restore BEFORE INSERT ON todo_tasks BEGIN SELECT RAISE(ABORT, 'simulated disk failure'); END;").unwrap();
    assert!(current
        .replace_backup_records(&records, &std::collections::BTreeMap::new())
        .is_err());
    assert_eq!(current.list().unwrap()[0].id, saved.id);
    assert_eq!(current.theme().unwrap(), "dark");
}

fn sample() -> TodoDraft {
    TodoDraft {
        customer_name: "示例客户".into(),
        title: "准备示例文档".into(),
        note: "虚构测试内容".into(),
        received_at: "2026-09-06T09:00:00+08:00".into(),
        due_at: None,
        attachment_paths: vec![],
    }
}

#[test]
fn tasks_survive_reopen_with_nullable_due_date() {
    let temp = tempfile::tempdir().unwrap();
    let db = temp.path().join("todo.sqlite");
    let created = {
        let mut repo = TodoRepository::open(&db).unwrap();
        repo.create(sample()).unwrap()
    };
    let repo = TodoRepository::open(&db).unwrap();
    let tasks = repo.list().unwrap();
    assert_eq!(tasks.len(), 1);
    assert_eq!(tasks[0].id, created.id);
    assert_eq!(tasks[0].customer_name, "示例客户");
    assert_eq!(tasks[0].due_at, None);
    assert_eq!(tasks[0].status, TodoStatus::Pending);
}

#[test]
fn required_fields_and_invalid_dates_do_not_create_rows() {
    let mut repo = TodoRepository::open_in_memory().unwrap();
    // 客户为选填：空白客户会保留为空字符串并正常建任务。
    let mut draft = sample();
    draft.customer_name = "  ".into();
    let created_without_customer = repo.create(draft).unwrap();
    assert_eq!(created_without_customer.customer_name, "");
    let mut draft = sample();
    draft.title = "\n".into();
    assert!(repo.create(draft).is_err());
    let mut draft = sample();
    draft.due_at = Some("明天".into());
    assert!(repo.create(draft).is_err());
    // 仅空客户任务入库。
    assert_eq!(repo.list().unwrap().len(), 1);
}

#[test]
fn edits_keep_identity_and_completion_can_be_reversed() {
    let mut repo = TodoRepository::open_in_memory().unwrap();
    let created = repo.create(sample()).unwrap();
    let urgent = repo.set_urgent(&created.id, true).unwrap();
    assert!(urgent.urgent_at.is_some());
    let done = repo.set_status(&created.id, TodoStatus::Completed).unwrap();
    assert!(done.completed_at.is_some());
    assert!(done.urgent_at.is_none());
    let restored = repo
        .set_status(&created.id, TodoStatus::InProgress)
        .unwrap();
    assert!(restored.completed_at.is_none());
    let mut draft = sample();
    draft.title = "修改后的示例".into();
    draft.due_at = Some("2026-09-07T00:00:00+08:00".into());
    let edited = repo.update(&created.id, draft).unwrap();
    assert_eq!(edited.id, created.id);
    assert_eq!(edited.status, TodoStatus::InProgress);
    assert_eq!(edited.title, "修改后的示例");
    assert!(edited.due_at.is_some());
    let without_due = repo.update(&created.id, sample()).unwrap();
    assert!(without_due.due_at.is_none());
    assert!(repo.update("missing", sample()).is_err());
}

#[test]
fn deleted_tasks_are_hidden_but_keep_sync_metadata() {
    let mut repo = TodoRepository::open_in_memory().unwrap();
    let task = repo.create(sample()).unwrap();
    repo.delete(&task.id).unwrap();
    assert!(repo.list().unwrap().is_empty());
    let metadata: (Option<String>, i64) = repo
        .conn
        .query_row(
            "SELECT deleted_at, version FROM todo_tasks WHERE id = ?1",
            [&task.id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert!(metadata.0.is_some());
    assert_eq!(metadata.1, 2);
    assert!(repo.update(&task.id, sample()).is_err());
    assert!(repo.set_status(&task.id, TodoStatus::Pending).is_err());
    // 删除重试是幂等的，不复活或重复写入。
    repo.delete(&task.id).unwrap();
}

#[test]
fn storage_write_failures_reach_the_caller() {
    let mut repo = TodoRepository::open_in_memory().unwrap();
    let task = repo.create(sample()).unwrap();
    repo.conn.execute_batch("PRAGMA query_only = ON").unwrap();
    assert!(repo.create(sample()).is_err());
    assert!(repo.update(&task.id, sample()).is_err());
    assert!(repo.delete(&task.id).is_err());
    assert_eq!(repo.list().unwrap()[0].title, task.title);
}

#[test]
fn corrupt_or_newer_databases_are_never_replaced() {
    let temp = tempfile::tempdir().unwrap();
    let corrupt = temp.path().join("corrupt.sqlite");
    std::fs::write(&corrupt, b"not a database").unwrap();
    assert!(TodoRepository::open(&corrupt).is_err());
    assert_eq!(std::fs::read(&corrupt).unwrap(), b"not a database");
    let future = temp.path().join("future.sqlite");
    let conn = rusqlite::Connection::open(&future).unwrap();
    conn.execute_batch("PRAGMA user_version = 999").unwrap();
    drop(conn);
    assert!(TodoRepository::open(&future).is_err());
}

#[test]
fn theme_preference_survives_reopen() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("settings.sqlite");
    let mut repo = TodoRepository::open(&path).unwrap();
    assert_eq!(repo.theme().unwrap(), "system");
    repo.set_theme("dark").unwrap();
    assert!(repo.set_theme("arbitrary").is_err());
    drop(repo);
    let repo = TodoRepository::open(&path).unwrap();
    assert_eq!(repo.theme().unwrap(), "dark");
}
