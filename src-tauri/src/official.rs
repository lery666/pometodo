//! PomeTodo 官方 API 原生边界。无配置时关闭，不回退模拟或 BYOK。
use crate::{
    ai_extract::{ExtractionContext, ExtractionWarning, InputKind, ParsedExtraction},
    commands::StorageState,
    secrets::KeyStore,
};
use reqwest::{blocking::Client, Method, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    io::Read,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::Duration,
};
use tauri::Manager;

const SESSION_SLOT: &str = "official-session";
const MAX_RESPONSE: usize = 1_048_576;

#[derive(Debug)]
struct ApiError {
    code: String,
    message: String,
}
impl ApiError {
    fn new(code: &str, message: &str) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

fn validated_base(value: &str) -> Result<Url, ApiError> {
    let url =
        Url::parse(value).map_err(|_| ApiError::new("configuration", "官方服务地址配置无效"))?;
    let loopback = cfg!(debug_assertions)
        && matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"));
    if (url.scheme() != "https" && !(loopback && url.scheme() == "http"))
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err(ApiError::new("configuration", "官方服务地址配置无效"));
    }
    Ok(url)
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Credentials {
    account_id: String,
    device_credential_id: String,
    device_secret: String,
    access_token: String,
    access_token_expires_at: String,
}
#[derive(Serialize, Deserialize)]
struct StoredSession {
    base_url: String,
    credentials: Credentials,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Trial {
    pub claimed: bool,
    pub total: u32,
    pub remaining: u32,
    pub expires_at: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelledOrder {
    pub order_no: String,
    pub status: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entitlement {
    pub product: String,
    pub trial: Trial,
    pub paid_remaining: u32,
    #[serde(default)]
    pub paid_total: u32,
    pub remaining: u32,
    pub can_extract: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountSnapshot {
    configured: bool,
    logged_in: bool,
    account_id: Option<String>,
    entitlement: Option<Entitlement>,
    message: String,
}
pub struct OfficialAvailability {
    pub available: bool,
    pub message: String,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoginAttempt {
    login_id: String,
    poll_token: String,
    qr_code_data_url: String,
    expires_at: String,
    poll_interval_ms: u64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginView {
    status: String,
    qr_code_data_url: Option<String>,
    expires_at: Option<String>,
    poll_interval_ms: u64,
    account: Option<AccountSnapshot>,
}
#[derive(Serialize)]
pub struct LoginPollError {
    message: String,
    retryable: bool,
}
impl From<ApiError> for LoginPollError {
    fn from(error: ApiError) -> Self {
        Self {
            retryable: matches!(
                error.code.as_str(),
                "network" | "timeout" | "service_unavailable" | "rate_limited"
            ),
            message: error.message,
        }
    }
}

#[derive(Default)]
struct Runtime {
    attempt: Option<LoginAttempt>,
    pending_extraction: Option<PendingExtraction>,
}
struct PendingExtraction {
    base: String,
    account_id: String,
    request_id: String,
    text: String,
    context: ExtractionContext,
}
#[derive(Serialize, Deserialize)]
struct StoredExtraction {
    base: String,
    account_id: String,
    request_id: String,
    text: String,
    now: String,
    kind: String,
}
static RUNTIME: Mutex<Runtime> = Mutex::new(Runtime {
    attempt: None,
    pending_extraction: None,
});
static LOGIN_GENERATION: AtomicU64 = AtomicU64::new(0);

struct OfficialClient {
    base: Url,
    root: PathBuf,
    http: Client,
}
impl OfficialClient {
    fn new(base: &str, root: &Path) -> Result<Self, ApiError> {
        Ok(Self {
            base: validated_base(base)?,
            root: root.to_path_buf(),
            http: Client::builder()
                .connect_timeout(Duration::from_secs(8))
                .timeout(Duration::from_secs(40))
                .redirect(reqwest::redirect::Policy::none())
                .user_agent(concat!("PomeTodo/", env!("CARGO_PKG_VERSION")))
                .build()
                .map_err(|_| ApiError::new("configuration", "无法初始化官方服务"))?,
        })
    }
    fn configured(root: &Path) -> Result<Self, ApiError> {
        let base = std::env::var("POMETODO_API_BASE_URL")
            .ok()
            .or_else(|| option_env!("POMETODO_API_BASE_URL").map(str::to_string))
            .filter(|v| !v.trim().is_empty())
            .ok_or_else(|| {
                ApiError::new(
                    "not_configured",
                    "官方服务暂未配置，请使用自带 Key 或手动记录",
                )
            })?;
        Self::new(&base, root)
    }
    fn request<T: serde::de::DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
        token: Option<&str>,
    ) -> Result<T, ApiError> {
        let url = self
            .base
            .join(&format!("v1/pometodo/{path}"))
            .map_err(|_| ApiError::new("configuration", "官方服务地址配置无效"))?;
        let mut request = self.http.request(method, url);
        if let Some(body) = body {
            request = request.json(body);
        }
        if let Some(token) = token {
            let mut header = reqwest::header::HeaderValue::from_str(&format!("Bearer {token}"))
                .map_err(|_| ApiError::new("session_invalid", "登录凭据无效，请重新登录"))?;
            header.set_sensitive(true);
            request = request.header(reqwest::header::AUTHORIZATION, header);
        }
        let response = request.send().map_err(|e| {
            if e.is_timeout() {
                ApiError::new("timeout", "官方服务响应超时，请稍后重试")
            } else {
                ApiError::new("network", "无法连接官方服务，请检查网络")
            }
        })?;
        let status = response.status();
        if status.is_redirection() {
            return Err(ApiError::new(
                "redirect",
                "官方服务地址发生跳转，已停止请求",
            ));
        }
        let mut bytes = Vec::new();
        response
            .take((MAX_RESPONSE + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|_| ApiError::new("network", "官方服务响应未完成，请稍后重试"))?;
        if bytes.len() > MAX_RESPONSE {
            return Err(ApiError::new("response", "官方服务响应过大，请稍后重试"));
        }
        if !status.is_success() {
            let code = serde_json::from_slice::<Value>(&bytes)
                .ok()
                .and_then(|v| v.get("error")?.get("code")?.as_str().map(str::to_string))
                .unwrap_or_default();
            // 仅固定状态反馈，不把供应商/服务端错误正文交给 UI。
            let message = match status.as_u16() {
                400 => "请求未被接受，请核对后重试",
                401 => "登录已失效，请重新登录",
                403 => "当前账号无法使用此服务",
                404 => "请求不存在或不属于当前账号",
                409 => "请求状态已改变，请稍后重试",
                429 => "操作过于频繁，请稍后重试",
                422 => "未能整理出待办，请检查内容后重新发起",
                503 => "官方服务暂不可用或预算保护已生效，请稍后重试",
                _ => "官方服务未完成请求，请稍后重试",
            };
            return Err(ApiError::new(
                if status.as_u16() == 401 {
                    "session_invalid"
                } else {
                    &code
                },
                message,
            ));
        }
        serde_json::from_slice(&bytes)
            .map_err(|_| ApiError::new("response", "官方服务返回格式无效"))
    }
    fn read_session(&self) -> Result<Option<Credentials>, ApiError> {
        let Some(value) = KeyStore::new(&self.root.join("secrets"))
            .read(SESSION_SLOT)
            .map_err(|_| ApiError::new("storage", "登录凭据无法读取，请重新登录"))?
        else {
            return Ok(None);
        };
        let stored: StoredSession = serde_json::from_str(&value)
            .map_err(|_| ApiError::new("storage", "登录凭据损坏，请重新登录"))?;
        if stored.base_url != self.base.as_str() {
            return Err(ApiError::new(
                "configuration",
                "官方服务地址已变更，请重新登录",
            ));
        }
        Ok(Some(stored.credentials))
    }
    fn save_session(&self, credentials: Credentials) -> Result<(), ApiError> {
        if credentials.account_id.is_empty()
            || credentials.device_credential_id.is_empty()
            || !credentials.device_secret.starts_with("ptd_")
            || !credentials.access_token.starts_with("pts_")
            || chrono::DateTime::parse_from_rfc3339(&credentials.access_token_expires_at).is_err()
        {
            return Err(ApiError::new("response", "登录服务返回的凭据无效"));
        }
        let value = serde_json::to_string(&StoredSession {
            base_url: self.base.to_string(),
            credentials,
        })
        .map_err(|_| ApiError::new("storage", "登录凭据无法保存"))?;
        KeyStore::new(&self.root.join("secrets"))
            .save(SESSION_SLOT, &value)
            .map_err(|_| ApiError::new("storage", "登录凭据无法保存，请重试"))
    }
    fn session(&self) -> Result<Credentials, ApiError> {
        let mut session = self
            .read_session()?
            .ok_or_else(|| ApiError::new("session_invalid", "请先登录 PomeTodo"))?;
        let expires = chrono::DateTime::parse_from_rfc3339(&session.access_token_expires_at)
            .map_err(|_| ApiError::new("session_invalid", "登录凭据无效，请重新登录"))?;
        if expires.timestamp() <= chrono::Utc::now().timestamp() + 30 {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Refreshed {
                access_token: String,
                access_token_expires_at: String,
            }
            let refreshed: Refreshed = self.request(Method::POST, "auth/session", Some(&json!({"deviceCredentialId":session.device_credential_id,"deviceSecret":session.device_secret})), None)?;
            session.access_token = refreshed.access_token;
            session.access_token_expires_at = refreshed.access_token_expires_at;
            self.save_session(session.clone())?;
        }
        Ok(session)
    }
    fn authenticated<T: serde::de::DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
    ) -> Result<T, ApiError> {
        let session = self.session()?;
        self.request(method, path, body, Some(&session.access_token))
    }
    fn entitlement(&self) -> Result<Entitlement, ApiError> {
        let value: Entitlement = self.authenticated(Method::GET, "entitlement", None)?;
        if value.product != "pometodo" {
            return Err(ApiError::new("response", "官方服务返回了其他产品权益"));
        }
        Ok(value)
    }
    fn cancel_order(&self, order_no: &str) -> Result<CancelledOrder, ApiError> {
        if !valid_id(order_no) {
            return Err(ApiError::new("invalid_input", "订单编号无效"));
        }
        let result: CancelledOrder =
            self.authenticated(Method::POST, &format!("orders/{order_no}/cancel"), None)?;
        if result.order_no != order_no {
            return Err(ApiError::new("response", "订单状态校验失败"));
        }
        KeyStore::new(&self.root.join("secrets"))
            .clear("official-order")
            .map_err(|_| ApiError::new("storage", "取消订单记录未能更新"))?;
        Ok(result)
    }
    fn can_arrange(&self, runtime: &Runtime) -> Result<OfficialAvailability, ApiError> {
        let session = self.session()?;
        let entitlement = self.entitlement()?;
        let saved = self.load_extraction(&session.account_id)?;
        let can_recover = runtime
            .pending_extraction
            .as_ref()
            .or(saved.as_ref())
            .is_some_and(|p| p.base == self.base.as_str() && p.account_id == session.account_id);
        if entitlement.can_extract || can_recover {
            Ok(OfficialAvailability {
                available: true,
                message: "使用官方服务，按成功整理计次".into(),
            })
        } else {
            Ok(OfficialAvailability {
                available: false,
                message: entitlement_message(&entitlement),
            })
        }
    }
    fn load_extraction(&self, account_id: &str) -> Result<Option<PendingExtraction>, ApiError> {
        let Some(value) = KeyStore::new(&self.root.join("secrets"))
            .read("official-extraction")
            .map_err(|_| ApiError::new("storage", "待恢复的整理记录无法读取"))?
        else {
            return Ok(None);
        };
        let saved: StoredExtraction = serde_json::from_str(&value)
            .map_err(|_| ApiError::new("storage", "待恢复的整理记录无效"))?;
        if saved.base != self.base.as_str() || saved.account_id != account_id {
            return Ok(None);
        }
        let now = chrono::DateTime::parse_from_rfc3339(&saved.now)
            .map_err(|_| ApiError::new("storage", "待恢复的整理日期无效"))?;
        let kind = match saved.kind.as_str() {
            "text" => InputKind::Text,
            "ocr" => InputKind::Ocr,
            _ => return Err(ApiError::new("storage", "待恢复的整理来源无效")),
        };
        if uuid::Uuid::parse_str(&saved.request_id).is_err()
            || saved.text.chars().count() > crate::ai_extract::MAX_INPUT_CHARS
        {
            return Err(ApiError::new("storage", "待恢复的整理记录无效"));
        }
        Ok(Some(PendingExtraction {
            base: saved.base,
            account_id: saved.account_id,
            request_id: saved.request_id,
            text: saved.text,
            context: ExtractionContext { now, kind },
        }))
    }
    fn save_extraction(&self, pending: &PendingExtraction) -> Result<(), ApiError> {
        let saved = StoredExtraction {
            base: pending.base.clone(),
            account_id: pending.account_id.clone(),
            request_id: pending.request_id.clone(),
            text: pending.text.clone(),
            now: pending.context.now.to_rfc3339(),
            kind: if pending.context.kind == InputKind::Text {
                "text".into()
            } else {
                "ocr".into()
            },
        };
        let value = serde_json::to_string(&saved)
            .map_err(|_| ApiError::new("storage", "整理恢复记录无法保存"))?;
        KeyStore::new(&self.root.join("secrets"))
            .save("official-extraction", &value)
            .map_err(|_| ApiError::new("storage", "整理恢复记录无法保存，尚未发送请求"))
    }
    fn clear_extraction(&self) -> Result<(), ApiError> {
        KeyStore::new(&self.root.join("secrets"))
            .clear("official-extraction")
            .map_err(|_| ApiError::new("storage", "整理已结束，但本机恢复状态未能更新"))
    }
    fn account(&self) -> Result<AccountSnapshot, ApiError> {
        if self.read_session()?.is_none() {
            return Ok(AccountSnapshot {
                configured: true,
                logged_in: false,
                account_id: None,
                entitlement: None,
                message: "登录后可开通首次智能整理体验".into(),
            });
        }
        let session = match self.session() {
            Ok(session) => session,
            Err(error) if error.code == "session_invalid" => {
                return Ok(AccountSnapshot {
                    configured: true,
                    logged_in: false,
                    account_id: None,
                    entitlement: None,
                    message: error.message,
                })
            }
            Err(error) => return Err(error),
        };
        let entitlement = match self.entitlement() {
            Ok(value) => value,
            Err(error) if error.code == "session_invalid" => {
                return Ok(AccountSnapshot {
                    configured: true,
                    logged_in: false,
                    account_id: None,
                    entitlement: None,
                    message: error.message,
                })
            }
            Err(error) => return Err(error),
        };
        let message = entitlement_message(&entitlement);
        Ok(AccountSnapshot {
            configured: true,
            logged_in: true,
            account_id: Some(session.account_id),
            entitlement: Some(entitlement),
            message,
        })
    }
}

fn entitlement_message(entitlement: &Entitlement) -> String {
    if entitlement.can_extract {
        return "使用官方服务，按成功整理计次".into();
    }
    if entitlement.remaining > 0 || entitlement.paid_remaining > 0 {
        return "智能整理暂不可用".into();
    }
    if !entitlement.trial.claimed {
        return "请先启用官方智能整理".into();
    }
    match entitlement
        .trial
        .expires_at
        .as_deref()
        .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
    {
        Some(expires) if expires <= chrono::Utc::now() => "官方体验已结束".into(),
        Some(_) => "智能整理次数已用完".into(),
        None => "智能整理暂不可用".into(),
    }
}

fn neutralize_availability(result: Result<OfficialAvailability, ApiError>) -> OfficialAvailability {
    match result {
        Ok(status) => status,
        Err(error) if error.code == "session_invalid" => OfficialAvailability {
            available: false,
            message: "请先登录 PomeTodo".into(),
        },
        Err(_) => OfficialAvailability {
            available: false,
            message: "智能整理暂不可用".into(),
        },
    }
}

fn profile(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let state = app.state::<StorageState>();
    let guard = state.inner.lock().map_err(|_| "本地数据不可用")?;
    Ok(guard
        .as_ref()
        .map_err(Clone::clone)?
        .profile_directory
        .clone())
}

async fn with_official<T: Send + 'static>(
    app: tauri::AppHandle,
    run: impl FnOnce(&OfficialClient, &mut Runtime) -> Result<T, ApiError> + Send + 'static,
) -> Result<T, String> {
    let root = profile(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut runtime = RUNTIME.lock().map_err(|_| "官方服务状态不可用")?;
        let client = OfficialClient::configured(&root).map_err(|e| e.message)?;
        run(&client, &mut runtime).map_err(|e| e.message)
    })
    .await
    .map_err(|_| "官方服务操作未完成".to_string())?
}

#[tauri::command]
pub async fn pometodo_official_account(app: tauri::AppHandle) -> Result<AccountSnapshot, String> {
    let root = profile(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _runtime = RUNTIME.lock().map_err(|_| "官方服务状态不可用")?;
        match OfficialClient::configured(&root) {
            Ok(client) => client.account().map_err(|e| e.message),
            Err(error) => Ok(AccountSnapshot {
                configured: false,
                logged_in: false,
                account_id: None,
                entitlement: None,
                message: error.message,
            }),
        }
    })
    .await
    .map_err(|_| "读取账号状态未完成".to_string())?
}

#[tauri::command]
pub async fn pometodo_official_begin(app: tauri::AppHandle) -> Result<LoginView, String> {
    let generation = LOGIN_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    with_official(app, move |client, runtime| {
        begin_login(client, runtime, generation)
    })
    .await
}

fn begin_login(
    client: &OfficialClient,
    runtime: &mut Runtime,
    generation: u64,
) -> Result<LoginView, ApiError> {
    if let Some(previous) = runtime.attempt.take() {
        let _: Value = client.request(
            Method::POST,
            "auth/cancel",
            Some(&json!({"loginId":previous.login_id,"pollToken":previous.poll_token})),
            None,
        )?;
    }
    let attempt: LoginAttempt = client.request(
        Method::POST,
        "auth/begin",
        Some(&json!({"deviceLabel":"PomeTodo on Windows"})),
        None,
    )?;
    validate_qr(&attempt.qr_code_data_url)?;
    let view = LoginView {
        status: "pending".into(),
        qr_code_data_url: Some(attempt.qr_code_data_url.clone()),
        expires_at: Some(attempt.expires_at.clone()),
        poll_interval_ms: attempt.poll_interval_ms.clamp(1000, 10000),
        account: None,
    };
    runtime.attempt = Some(attempt);
    if LOGIN_GENERATION.load(Ordering::SeqCst) != generation {
        return Err(ApiError::new("cancelled", "本次登录已取消"));
    }
    Ok(view)
}

#[tauri::command]
pub async fn pometodo_official_poll(app: tauri::AppHandle) -> Result<LoginView, LoginPollError> {
    let generation = LOGIN_GENERATION.load(Ordering::SeqCst);
    let root = profile(&app).map_err(|message| LoginPollError {
        message,
        retryable: false,
    })?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut runtime = RUNTIME
            .lock()
            .map_err(|_| ApiError::new("storage", "官方服务状态不可用"))?;
        let client = OfficialClient::configured(&root)?;
        poll_login(&client, &mut runtime, generation)
    })
    .await
    .map_err(|_| LoginPollError {
        message: "读取登录状态未完成".into(),
        retryable: false,
    })?
    .map_err(LoginPollError::from)
}

fn poll_login(
    client: &OfficialClient,
    runtime: &mut Runtime,
    generation: u64,
) -> Result<LoginView, ApiError> {
    let attempt = runtime
        .attempt
        .as_ref()
        .ok_or_else(|| ApiError::new("login_missing", "请重新开始登录"))?;
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Poll {
        product: String,
        status: String,
        expires_at: String,
        credentials: Option<Credentials>,
    }
    let result: Poll = client.request(
        Method::POST,
        "auth/poll",
        Some(&json!({"loginId":attempt.login_id,"pollToken":attempt.poll_token})),
        None,
    )?;
    if LOGIN_GENERATION.load(Ordering::SeqCst) != generation {
        return Err(ApiError::new("cancelled", "本次登录已取消"));
    }
    if result.product != "pometodo"
        || !matches!(
            result.status.as_str(),
            "pending" | "confirmed" | "cancelled" | "expired"
        )
    {
        return Err(ApiError::new("response", "登录状态无效"));
    }
    let account = if result.status == "confirmed" {
        let credentials = result
            .credentials
            .ok_or_else(|| ApiError::new("response", "登录凭据缺失"))?;
        let entitlement: Entitlement = client.request(
            Method::GET,
            "entitlement",
            None,
            Some(&credentials.access_token),
        )?;
        if entitlement.product != "pometodo" {
            return Err(ApiError::new("response", "官方服务返回了其他产品权益"));
        }
        if LOGIN_GENERATION.load(Ordering::SeqCst) != generation {
            return Err(ApiError::new("cancelled", "本次登录已取消"));
        }
        let account_id = credentials.account_id.clone();
        client.save_session(credentials)?;
        Some(AccountSnapshot {
            configured: true,
            logged_in: true,
            account_id: Some(account_id),
            entitlement: Some(entitlement),
            message: "已登录 PomeTodo".into(),
        })
    } else {
        None
    };
    let view = LoginView {
        status: result.status.clone(),
        qr_code_data_url: None,
        expires_at: Some(result.expires_at),
        poll_interval_ms: attempt.poll_interval_ms.clamp(1000, 10000),
        account,
    };
    if result.status != "pending" {
        runtime.attempt = None;
    }
    Ok(view)
}

#[tauri::command]
pub async fn pometodo_official_cancel(app: tauri::AppHandle) -> Result<(), String> {
    LOGIN_GENERATION.fetch_add(1, Ordering::SeqCst);
    with_official(app, |client, runtime| {
        if let Some(attempt) = runtime.attempt.take() {
            let _: Value = client.request(
                Method::POST,
                "auth/cancel",
                Some(&json!({"loginId":attempt.login_id,"pollToken":attempt.poll_token})),
                None,
            )?;
        }
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn pometodo_official_trial(app: tauri::AppHandle) -> Result<Entitlement, String> {
    with_official(app.clone(), |client, _| {
        client.authenticated(Method::POST, "trial", Some(&json!({})))
    })
    .await
}

#[tauri::command]
pub async fn pometodo_official_logout(app: tauri::AppHandle) -> Result<(), String> {
    LOGIN_GENERATION.fetch_add(1, Ordering::SeqCst);
    with_official(app.clone(), |client, runtime| {
        match client.authenticated::<Value>(Method::POST, "auth/logout", Some(&json!({}))) {
            Ok(_) => {}
            Err(error) if error.code == "session_invalid" => {}
            Err(error) => return Err(error),
        }
        KeyStore::new(&client.root.join("secrets"))
            .clear(SESSION_SLOT)
            .map_err(|_| ApiError::new("storage", "本机登录凭据未能清除"))?;
        runtime.attempt = None;
        runtime.pending_extraction = None;
        Ok(())
    })
    .await?;
    crate::commands::with_repo(app, |repo| {
        let mut preferences = repo.smart_arrange_preferences()?;
        if preferences.source == pometodo_core::smart_arrange::SmartArrangeSource::Official {
            preferences.enabled = false;
            repo.set_smart_arrange_preferences(preferences)?;
        }
        Ok(())
    })
    .await
}

fn validate_qr(value: &str) -> Result<(), ApiError> {
    if value.len() > 900_000
        || !(value.starts_with("data:image/png;base64,")
            || value.starts_with("data:image/jpeg;base64,"))
    {
        return Err(ApiError::new("response", "二维码格式无效，请重新获取"));
    }
    Ok(())
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum Benefit {
    Period {
        months: u32,
        extraction_limit: u32,
    },
    Count {
        extractions: u32,
        validity_days: Option<u32>,
    },
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Offer {
    product: String,
    id: String,
    revision: u32,
    name: String,
    enabled: bool,
    amount_fen: u64,
    currency: String,
    benefit: Benefit,
    terms_version: String,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Offers {
    product: String,
    sales_enabled: bool,
    offers: Vec<Offer>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderSnapshot {
    product: String,
    offer_id: String,
    offer_revision: u32,
    name: String,
    amount_fen: u64,
    currency: String,
    benefit: Benefit,
    terms_version: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Order {
    product: String,
    order_no: String,
    status: String,
    amount_fen: u64,
    currency: String,
    snapshot: OrderSnapshot,
    expires_at: String,
    qr_code_data_url: String,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderStatus {
    order_no: String,
    status: String,
    paid: bool,
    entitlement_granted: bool,
    amount_fen: u64,
    currency: String,
    expires_at: String,
    paid_at: Option<String>,
}
#[derive(Serialize, Deserialize)]
struct PendingOrder {
    base_url: String,
    account_id: String,
    offer_id: String,
    request_id: String,
    order: Option<Order>,
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

impl OfficialClient {
    fn pending_order(&self) -> Result<Option<PendingOrder>, ApiError> {
        let value = KeyStore::new(&self.root.join("secrets"))
            .read("official-order")
            .map_err(|_| ApiError::new("storage", "待付款订单读取失败"))?;
        let Some(value) = value else {
            return Ok(None);
        };
        let pending: PendingOrder = serde_json::from_str(&value)
            .map_err(|_| ApiError::new("storage", "待付款订单记录无效"))?;
        let account = self.session()?.account_id;
        Ok(
            (pending.base_url == self.base.as_str() && pending.account_id == account)
                .then_some(pending),
        )
    }
    fn save_pending_order(&self, pending: &PendingOrder) -> Result<(), ApiError> {
        // 二维码不写入秘密文件，重启时按相同幂等请求从服务端找回。
        let saved = PendingOrder {
            base_url: pending.base_url.clone(),
            account_id: pending.account_id.clone(),
            offer_id: pending.offer_id.clone(),
            request_id: pending.request_id.clone(),
            order: None,
        };
        KeyStore::new(&self.root.join("secrets"))
            .save(
                "official-order",
                &serde_json::to_string(&saved)
                    .map_err(|_| ApiError::new("storage", "订单记录无法保存"))?,
            )
            .map_err(|_| ApiError::new("storage", "订单记录无法保存，尚未发起支付"))
    }
    fn order(&self, offer_id: &str) -> Result<Order, ApiError> {
        if !valid_id(offer_id) {
            return Err(ApiError::new("invalid_input", "商品编号无效"));
        }
        let account_id = self.session()?.account_id;
        let pending = self
            .pending_order()?
            .filter(|p| p.offer_id == offer_id)
            .unwrap_or_else(|| PendingOrder {
                base_url: self.base.to_string(),
                account_id,
                offer_id: offer_id.into(),
                request_id: uuid::Uuid::new_v4().to_string(),
                order: None,
            });
        self.save_pending_order(&pending)?;
        let order: Order = match self.authenticated(
            Method::POST,
            "orders",
            Some(&json!({"offerId":offer_id,"requestId":pending.request_id})),
        ) {
            Ok(order) => order,
            Err(error) => {
                if error.code == "order_expired" {
                    // 服务端拒绝复用已关闭/过期订单：换全新请求编号立即重试一次。
                    KeyStore::new(&self.root.join("secrets"))
                        .clear("official-order")
                        .map_err(|_| ApiError::new("storage", "过期订单记录未能更新"))?;
                    let retry = PendingOrder {
                        base_url: self.base.to_string(),
                        account_id: pending.account_id.clone(),
                        offer_id: offer_id.into(),
                        request_id: uuid::Uuid::new_v4().to_string(),
                        order: None,
                    };
                    self.save_pending_order(&retry)?;
                    self.authenticated(
                        Method::POST,
                        "orders",
                        Some(&json!({"offerId":offer_id,"requestId":retry.request_id})),
                    )?
                } else {
                    return Err(error);
                }
            }
        };
        validate_qr(&order.qr_code_data_url)?;
        if order.product != "pometodo"
            || order.snapshot.product != "pometodo"
            || order.snapshot.offer_id != offer_id
            || order.currency != "CNY"
            || order.snapshot.currency != "CNY"
            || order.amount_fen != order.snapshot.amount_fen
            || !valid_id(&order.order_no)
        {
            return Err(ApiError::new("response", "付款订单校验失败，请稍后重试"));
        }
        Ok(order)
    }
}

#[tauri::command]
pub async fn pometodo_official_offers(app: tauri::AppHandle) -> Result<Offers, String> {
    with_official(app, |client, _| {
        let offers: Offers = client.authenticated(Method::GET, "offers", None)?;
        if offers.product != "pometodo"
            || offers.offers.iter().any(|o| {
                o.product != "pometodo"
                    || o.currency != "CNY"
                    || !valid_id(&o.id)
                    || o.amount_fen == 0
            })
        {
            return Err(ApiError::new("response", "商品数据无效"));
        }
        Ok(offers)
    })
    .await
}
#[tauri::command]
pub async fn pometodo_official_order(
    app: tauri::AppHandle,
    offer_id: String,
) -> Result<Order, String> {
    with_official(app, move |client, _| client.order(&offer_id)).await
}
#[tauri::command]
pub async fn pometodo_official_pending_order(
    app: tauri::AppHandle,
) -> Result<Option<Order>, String> {
    with_official(app, |client, _| match client.pending_order()? {
        Some(pending) => match client.order(&pending.offer_id) {
            Ok(order) => Ok(Some(order)),
            Err(error) if error.code == "order_expired" => {
                // 订单已过期：清理本机待付款记录，避免每次打开设置白查一次。
                KeyStore::new(&client.root.join("secrets"))
                    .clear("official-order")
                    .map_err(|message| ApiError::new("storage", &message))?;
                Ok(None)
            }
            Err(error) => Err(error),
        },
        None => Ok(None),
    })
    .await
}
#[tauri::command]
pub async fn pometodo_official_cancel_order(
    app: tauri::AppHandle,
    order_no: String,
) -> Result<CancelledOrder, String> {
    with_official(app, move |client, _| client.cancel_order(&order_no)).await
}
#[tauri::command]
pub async fn pometodo_official_order_status(
    app: tauri::AppHandle,
    order_no: String,
) -> Result<OrderStatus, String> {
    with_official(app, move |client, _| {
        if !valid_id(&order_no) {
            return Err(ApiError::new("invalid_input", "订单编号无效"));
        }
        let result: OrderStatus =
            client.authenticated(Method::GET, &format!("orders/{order_no}/status"), None)?;
        if result.order_no != order_no || result.currency != "CNY" {
            return Err(ApiError::new("response", "订单状态校验失败"));
        }
        if result.entitlement_granted || matches!(result.status.as_str(), "closed" | "failed") {
            KeyStore::new(&client.root.join("secrets"))
                .clear("official-order")
                .map_err(|_| ApiError::new("storage", "待付款订单状态未能更新"))?;
        }
        Ok(result)
    })
    .await
}

pub fn available(root: &Path) -> Result<OfficialAvailability, String> {
    let runtime = RUNTIME.lock().map_err(|_| "官方服务状态不可用")?;
    let client = OfficialClient::configured(root).map_err(|e| e.message)?;
    // 最后一次已被服务端处理但回包丢失时，必须允许用原 ID 取回结果。
    // 新文本仍进入服务端正常额度校验，不能凭本机 pending 获得新次数。
    Ok(neutralize_availability(client.can_arrange(&runtime)))
}

pub fn extract(
    root: &Path,
    text: &str,
    context: &ExtractionContext,
    vision_images: Option<&[String]>,
) -> Result<Option<ParsedExtraction>, String> {
    // 图片直传时 text 为空是正常状态（内容在 vision_images 中）；只有既无图也无文字才拦截。
    let has_vision = vision_images.map_or(false, |images| !images.is_empty());
    if (text.trim().is_empty() && !has_vision) || text.chars().count() > crate::ai_extract::MAX_INPUT_CHARS {
        return Err("请提供不超过 12000 字的任务文字".into());
    }
    let mut runtime = RUNTIME.lock().map_err(|_| "官方服务状态不可用")?;
    let client = OfficialClient::configured(root).map_err(|e| e.message)?;
    extract_with_client(&client, &mut runtime, text, context, vision_images)
}

fn extract_with_client(
    client: &OfficialClient,
    runtime: &mut Runtime,
    text: &str,
    context: &ExtractionContext,
    vision_images: Option<&[String]>,
) -> Result<Option<ParsedExtraction>, String> {
    let account_id = client.session().map_err(|e| e.message)?.account_id;
    if !runtime
        .pending_extraction
        .as_ref()
        .is_some_and(|p| p.base == client.base.as_str() && p.account_id == account_id)
    {
        runtime.pending_extraction = client.load_extraction(&account_id).map_err(|e| e.message)?;
    }
    let same = runtime.pending_extraction.as_ref().is_some_and(|p| {
        p.base == client.base.as_str()
            && p.account_id == account_id
            && p.text == text
            && p.context.kind == context.kind
    });
    if !same {
        let pending = PendingExtraction {
            base: client.base.to_string(),
            account_id,
            request_id: uuid::Uuid::new_v4().to_string(),
            text: text.into(),
            context: context.clone(),
        };
        client.save_extraction(&pending).map_err(|e| e.message)?;
        runtime.pending_extraction = Some(pending);
    }
    let pending = runtime.pending_extraction.as_ref().unwrap();
    #[derive(Deserialize)]
    struct Extraction {
        task: Task,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Task {
        customer_name: Option<String>,
        title: Option<String>,
        note: Option<String>,
        received_at: Option<String>,
        due_at: Option<String>,
        warnings: Vec<String>,
    }
    let response: Extraction = match client.authenticated(Method::POST, "extract", Some(&(match vision_images {
        Some(images) => json!({"requestId":pending.request_id,"text":text,"imageBase64s":images,"context":{"now":pending.context.now.to_rfc3339(),"kind":if context.kind == InputKind::Text { "text" } else { "ocr" }}}),
        None => json!({"requestId":pending.request_id,"text":text,"context":{"now":pending.context.now.to_rfc3339(),"kind":if context.kind == InputKind::Text { "text" } else { "ocr" }}}),
    }))) {
        Ok(response) => response,
        Err(error) => {
            if !matches!(error.code.as_str(), "timeout" | "network" | "response" | "request_in_progress") { client.clear_extraction().map_err(|e| e.message)?; runtime.pending_extraction = None; }
            return Err(error.message);
        }
    };
    client.clear_extraction().map_err(|e| e.message)?;
    runtime.pending_extraction = None;
    let title = response
        .task
        .title
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty());
    let note = response
        .task
        .note
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty());
    // 无明确待办但对内容有益摘要时返回摘要（服务端不扣次）；两者都空按无任务处理。
    if title.is_none() && note.is_none() {
        return Err("没有识别到待办任务".into());
    }
    Ok(Some(ParsedExtraction {
        customer_name: if title.is_some() {
            response.task.customer_name
        } else {
            None
        },
        title,
        note,
        received_at: response.task.received_at,
        due_at: response.task.due_at,
        warnings: response
            .task
            .warnings
            .iter()
            .filter_map(|v| match v.as_str() {
                "invalid_received_date" => Some(ExtractionWarning::InvalidReceivedDate),
                "invalid_due_date" => Some(ExtractionWarning::InvalidDueDate),
                _ => None,
            })
            .collect(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    static LOGIN_TEST_MUTEX: Mutex<()> = Mutex::new(());

    #[test]
    fn vision_extract_with_empty_text_passes_length_gate() {
        use crate::ai_extract::{ExtractionContext, InputKind};
        let dir = tempfile::tempdir().unwrap();
        let ctx = ExtractionContext {
            now: chrono::DateTime::parse_from_rfc3339("2026-09-08T12:00:00+08:00").unwrap(),
            kind: InputKind::Ocr,
        };
        let err = extract(dir.path(), "", &ctx, Some(&["aGVsbG8=".to_string()])).unwrap_err();
        assert!(!err.contains("请提供"), "带图直传不应被空文本拦截: {err}");
    }

    fn http_sequence(responses: Vec<String>) -> (String, std::thread::JoinHandle<Vec<String>>) {
        http_sequence_hook(responses, |_| {})
    }
    fn http_sequence_hook(
        responses: Vec<String>,
        hook: impl Fn(usize) + Send + 'static,
    ) -> (String, std::thread::JoinHandle<Vec<String>>) {
        use std::io::Write;
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let handle = std::thread::spawn(move || {
            let mut requests = Vec::new();
            for response in responses {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                let mut bytes = Vec::new();
                loop {
                    let mut buffer = [0; 4096];
                    let count = stream.read(&mut buffer).unwrap();
                    if count == 0 {
                        break;
                    }
                    bytes.extend_from_slice(&buffer[..count]);
                    if let Some(end) = bytes.windows(4).position(|v| v == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&bytes[..end]).to_lowercase();
                        let length: usize = headers
                            .lines()
                            .find_map(|v| v.strip_prefix("content-length:"))
                            .map(str::trim)
                            .unwrap_or("0")
                            .parse()
                            .unwrap();
                        if bytes.len() >= end + 4 + length {
                            break;
                        }
                    }
                }
                requests.push(String::from_utf8(bytes).unwrap());
                hook(requests.len());
                stream.write_all(response.as_bytes()).unwrap();
            }
            requests
        });
        (base, handle)
    }
    fn ok_response(body: Value) -> String {
        let body = body.to_string();
        format!("HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: {}\r\nContent-Type: application/json\r\n\r\n{body}", body.len())
    }
    fn synthetic_session(client: &OfficialClient) {
        client
            .save_session(Credentials {
                account_id: "synthetic-account".into(),
                device_credential_id: "device".into(),
                device_secret: "ptd_synthetic_secret".into(),
                access_token: "pts_synthetic_token".into(),
                access_token_expires_at: "2099-01-01T00:00:00Z".into(),
            })
            .unwrap();
    }
    #[test]
    fn account_message_distinguishes_service_pause_exhaustion_expiry_and_activation() {
        let entitlement = |claimed: bool,
                           remaining: u32,
                           expires_at: Option<&str>,
                           can_extract: bool| {
            json!({
                "product":"pometodo",
                "trial":{"claimed":claimed,"total":100,"remaining":remaining,"expiresAt":expires_at},
                "paidRemaining":0,"remaining":remaining,"canExtract":can_extract
            })
        };
        let (base, server) = http_sequence(vec![
            ok_response(entitlement(true, 99, Some("2099-01-01T00:00:00Z"), false)),
            ok_response(entitlement(true, 0, Some("2099-01-01T00:00:00Z"), false)),
            ok_response(entitlement(true, 0, Some("2000-01-01T00:00:00Z"), false)),
            ok_response(entitlement(false, 0, None, false)),
            ok_response(entitlement(true, 99, Some("2099-01-01T00:00:00Z"), true)),
        ]);
        let dir = tempfile::tempdir().unwrap();
        let client = OfficialClient::new(&base, dir.path()).unwrap();
        synthetic_session(&client);
        assert_eq!(client.account().unwrap().message, "智能整理暂不可用");
        assert_eq!(client.account().unwrap().message, "智能整理次数已用完");
        assert_eq!(client.account().unwrap().message, "官方体验已结束");
        assert_eq!(client.account().unwrap().message, "请先启用官方智能整理");
        assert_eq!(
            client.account().unwrap().message,
            "使用官方服务，按成功整理计次"
        );
        assert_eq!(server.join().unwrap().len(), 5);
    }
    #[test]
    fn availability_keeps_login_and_network_failures_neutral() {
        let logged_out =
            neutralize_availability(Err(ApiError::new("session_invalid", "服务端原始登录错误")));
        assert!(!logged_out.available);
        assert_eq!(logged_out.message, "请先登录 PomeTodo");
        let network = neutralize_availability(Err(ApiError::new("network", "服务端原始网络错误")));
        assert!(!network.available);
        assert_eq!(network.message, "智能整理暂不可用");
    }
    #[test]
    fn expired_creation_recovery_switches_request_and_returns_the_new_order() {
        let error = |code: &str| {
            let body = json!({"error":{"code":code}}).to_string();
            format!(
                "HTTP/1.1 409 Conflict\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
        };
        let order = json!({"product":"pometodo","orderNo":"synthetic-order-new","status":"paying","amountFen":111,"currency":"CNY","snapshot":{"product":"pometodo","offerId":"synthetic-offer","offerRevision":1,"name":"虚构商品","amountFen":111,"currency":"CNY","benefit":{"kind":"count","extractions":5,"validityDays":null},"termsVersion":"fixture"},"expiresAt":"2099-01-01T00:00:00Z","qrCodeDataUrl":"data:image/png;base64,fixture"});
        let (base, server) = http_sequence(vec![
            error("payment_unavailable"),
            error("order_expired"),
            ok_response(order),
        ]);
        let dir = tempfile::tempdir().unwrap();
        let client = OfficialClient::new(&base, dir.path()).unwrap();
        synthetic_session(&client);
        assert!(
            client.order("synthetic-offer").is_err(),
            "未知失败保持原请求并返回错误"
        );
        let previous_id = client.pending_order().unwrap().unwrap().request_id;
        let renewed = client.order("synthetic-offer").unwrap();
        assert_eq!(
            renewed.order_no, "synthetic-order-new",
            "order_expired 后必须换新请求编号立即重试并返回新订单"
        );
        let current = client.pending_order().unwrap().unwrap();
        assert_ne!(current.request_id, previous_id, "过期后请求编号必须更换");
        let requests = server.join().unwrap();
        let bodies: Vec<Value> = requests
            .iter()
            .map(|r| serde_json::from_str(r.split_once("\r\n\r\n").unwrap().1).unwrap())
            .collect();
        assert_eq!(bodies[0], bodies[1], "未知失败保持原请求");
        assert_ne!(bodies[1]["requestId"], bodies[2]["requestId"]);
    }
    #[test]
    fn cancelling_during_entitlement_fetch_does_not_replace_existing_login() {
        let _guard = LOGIN_TEST_MUTEX.lock().unwrap();
        let generation = LOGIN_GENERATION.load(Ordering::SeqCst);
        let credentials = json!({"accountId":"new-synthetic-account","deviceCredentialId":"new-device","deviceSecret":"ptd_new_secret","accessToken":"pts_new_token","accessTokenExpiresAt":"2099-01-01T00:00:00Z"});
        let (base, server) = http_sequence_hook(
            vec![
                ok_response(
                    json!({"product":"pometodo","status":"confirmed","expiresAt":"2099-01-01T00:00:00Z","credentials":credentials}),
                ),
                ok_response(
                    json!({"product":"pometodo","trial":{"claimed":false,"total":100,"remaining":0,"expiresAt":null},"paidRemaining":0,"remaining":0,"canExtract":false}),
                ),
            ],
            |request| {
                if request == 2 {
                    LOGIN_GENERATION.fetch_add(1, Ordering::SeqCst);
                }
            },
        );
        let dir = tempfile::tempdir().unwrap();
        let client = OfficialClient::new(&base, dir.path()).unwrap();
        synthetic_session(&client);
        let mut runtime = Runtime {
            attempt: Some(LoginAttempt {
                login_id: "login".into(),
                poll_token: "poll-secret".into(),
                qr_code_data_url: String::new(),
                expires_at: "2099-01-01T00:00:00Z".into(),
                poll_interval_ms: 1500,
            }),
            pending_extraction: None,
        };
        assert!(
            matches!(poll_login(&client, &mut runtime, generation), Err(error) if error.code == "cancelled")
        );
        assert_eq!(
            client.read_session().unwrap().unwrap().account_id,
            "synthetic-account"
        );
        assert_eq!(server.join().unwrap().len(), 2);
    }
    #[test]
    fn temporary_poll_failure_preserves_ticket_and_resumes_confirmed_login() {
        let _guard = LOGIN_TEST_MUTEX.lock().unwrap();
        let generation = LOGIN_GENERATION.load(Ordering::SeqCst);
        let (base, server) = http_sequence(vec![
            "HTTP/1.1 200 OK\r\nContent-Length: 999\r\nConnection: close\r\n\r\n{".into(),
            ok_response(
                json!({"product":"pometodo","status":"confirmed","expiresAt":"2099-01-01T00:00:00Z","credentials":{"accountId":"confirmed-account","deviceCredentialId":"device","deviceSecret":"ptd_synthetic","accessToken":"pts_synthetic","accessTokenExpiresAt":"2099-01-01T00:00:00Z"}}),
            ),
            ok_response(
                json!({"product":"pometodo","trial":{"claimed":false,"total":100,"remaining":0,"expiresAt":null},"paidRemaining":0,"remaining":0,"canExtract":false}),
            ),
        ]);
        let dir = tempfile::tempdir().unwrap();
        let client = OfficialClient::new(&base, dir.path()).unwrap();
        let mut runtime = Runtime {
            attempt: Some(LoginAttempt {
                login_id: "original-login".into(),
                poll_token: "original-poll-secret".into(),
                qr_code_data_url: String::new(),
                expires_at: "2099-01-01T00:00:00Z".into(),
                poll_interval_ms: 1500,
            }),
            pending_extraction: None,
        };
        let error = match poll_login(&client, &mut runtime, generation) {
            Err(error) => LoginPollError::from(error),
            Ok(_) => panic!("first response must be interrupted"),
        };
        assert!(error.retryable);
        assert_eq!(runtime.attempt.as_ref().unwrap().login_id, "original-login");
        assert_eq!(
            poll_login(&client, &mut runtime, generation)
                .unwrap()
                .status,
            "confirmed"
        );
        assert_eq!(
            client.read_session().unwrap().unwrap().account_id,
            "confirmed-account"
        );
        let requests = server.join().unwrap();
        assert_eq!(
            requests[0].split_once("\r\n\r\n").unwrap().1,
            requests[1].split_once("\r\n\r\n").unwrap().1
        );
    }
    #[test]
    fn lost_last_result_survives_restart_with_same_id_and_context_without_new_quota() {
        let exhausted = json!({"product":"pometodo","trial":{"claimed":true,"total":100,"remaining":0,"expiresAt":"2099-01-01T00:00:00Z"},"paidRemaining":0,"remaining":0,"canExtract":false});
        let success = json!({"task":{"customerName":"虚构客户","title":"取回已完成的整理","note":null,"receivedAt":null,"dueAt":null,"warnings":[]}});
        let (base, server) = http_sequence(vec![
            "HTTP/1.1 200 OK\r\nContent-Length: 999\r\nConnection: close\r\n\r\n{".into(),
            ok_response(exhausted),
            ok_response(success),
        ]);
        let dir = tempfile::tempdir().unwrap();
        let client = OfficialClient::new(&base, dir.path()).unwrap();
        synthetic_session(&client);
        let mut runtime = Runtime::default();
        let mut context = ExtractionContext {
            now: chrono::DateTime::parse_from_rfc3339("2026-09-06T10:00:00+08:00").unwrap(),
            kind: InputKind::Text,
        };
        assert!(extract_with_client(
            &client,
            &mut runtime,
            "虚构客户的最后一次任务",
            &context,
            None
        )
        .is_err());
        let encrypted = std::fs::read(dir.path().join("secrets/official-extraction.key")).unwrap();
        assert!(!String::from_utf8_lossy(&encrypted).contains("虚构客户"));
        drop(runtime);
        drop(client);
        let client = OfficialClient::new(&base, dir.path()).unwrap();
        let mut runtime = Runtime::default();
        assert!(
            client.can_arrange(&runtime).unwrap().available,
            "已扣次结果恢复不能再要求新次数"
        );
        context.now += chrono::Duration::minutes(1);
        assert_eq!(
            extract_with_client(
                &client,
                &mut runtime,
                "虚构客户的最后一次任务",
                &context,
                None
            )
            .unwrap()
            .unwrap()
            .title
            .as_deref(),
            Some("取回已完成的整理")
        );
        let requests = server.join().unwrap();
        assert_eq!(
            requests[0].split_once("\r\n\r\n").unwrap().1,
            requests[2].split_once("\r\n\r\n").unwrap().1
        );
        assert!(runtime.pending_extraction.is_none());
    }
    #[test]
    fn addresses_do_not_allow_credentials_redirect_paths_or_external_plain_http() {
        for input in [
            "https://user:secret@example.com",
            "http://example.com",
            "https://example.com?",
            "https://example.com#",
            "https://example.com/other",
            "file:///tmp",
        ] {
            assert!(validated_base(input).is_err());
        }
        assert!(validated_base("https://example.com").is_ok());
        assert!(validated_base("http://127.0.0.1:12345").is_ok());
    }
    #[test]
    fn session_is_encrypted_bound_to_origin_and_not_in_account_payload() {
        let dir = tempfile::tempdir().unwrap();
        let client = OfficialClient::new("https://example.com", dir.path()).unwrap();
        client
            .save_session(Credentials {
                account_id: "synthetic-account".into(),
                device_credential_id: "device".into(),
                device_secret: "ptd_synthetic_secret".into(),
                access_token: "pts_synthetic_token".into(),
                access_token_expires_at: "2099-01-01T00:00:00Z".into(),
            })
            .unwrap();
        assert_eq!(client.session().unwrap().account_id, "synthetic-account");
        let bytes = std::fs::read(dir.path().join("secrets/official-session.key")).unwrap();
        assert!(!String::from_utf8_lossy(&bytes).contains("synthetic"));
        assert!(OfficialClient::new("https://elsewhere.example", dir.path())
            .unwrap()
            .read_session()
            .is_err());
    }

    #[test]
    #[ignore = "显式连接3317隔离PG/微信/支付/模型全合成服务，绝不访问线上"]
    fn local_backend_login_trial_extraction_payment_and_restart() {
        let base = "http://127.0.0.1:3317";
        let http = Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(10))
            .build()
            .unwrap();
        let status: Value = http
            .get(format!("{base}/__fixture__/status"))
            .send()
            .unwrap()
            .json()
            .unwrap();
        assert_eq!(status["syntheticOnly"], true, "只能运行全合成服务");
        let dir = tempfile::tempdir().unwrap();
        let client = OfficialClient::new(base, dir.path()).unwrap();
        let mut runtime = Runtime::default();
        let generation = LOGIN_GENERATION.load(Ordering::SeqCst);
        let view = begin_login(&client, &mut runtime, generation).unwrap();
        let serialized = serde_json::to_string(&view).unwrap();
        assert!(!serialized.contains("pollToken"));
        assert_eq!(
            poll_login(&client, &mut runtime, generation)
                .unwrap()
                .status,
            "pending"
        );
        let login_id = runtime.attempt.as_ref().unwrap().login_id.clone();
        let ticket: Value = http
            .get(format!("{base}/__fixture__/tickets/{login_id}"))
            .send()
            .unwrap()
            .json()
            .unwrap();
        let confirmed: Value = client.request(Method::POST, "auth/confirm", Some(&json!({"ticket":ticket["ticket"],"code":format!("fixture-{}",uuid::Uuid::new_v4())})), None).unwrap();
        assert_eq!(confirmed["status"], "confirmed");
        let view = poll_login(&client, &mut runtime, generation).unwrap();
        assert!(view.account.as_ref().unwrap().logged_in);
        let serialized = serde_json::to_string(&view).unwrap();
        for secret in ["accessToken", "deviceSecret", "pollToken", "pts_", "ptd_"] {
            assert!(!serialized.contains(secret));
        }
        let entitlement: Entitlement = client
            .authenticated(Method::POST, "trial", Some(&json!({})))
            .unwrap();
        assert_eq!(entitlement.remaining, 100);
        let repeated: Entitlement = client
            .authenticated(Method::POST, "trial", Some(&json!({})))
            .unwrap();
        assert_eq!(repeated.remaining, 100);
        let context = ExtractionContext {
            now: chrono::DateTime::parse_from_rfc3339("2026-09-06T10:00:00+08:00").unwrap(),
            kind: InputKind::Text,
        };
        let task = extract_with_client(
            &client,
            &mut runtime,
            "虚构客户：请明天核对测试初稿",
            &context,
            None,
        )
        .unwrap()
        .unwrap();
        assert!(task.title.as_deref().map_or(false, |v| !v.is_empty()));
        assert_eq!(client.entitlement().unwrap().remaining, 99);
        let mut credentials = client.read_session().unwrap().unwrap();
        credentials.access_token_expires_at = "2000-01-01T00:00:00Z".into();
        client.save_session(credentials).unwrap();
        drop(client);
        let reopened = OfficialClient::new(base, dir.path()).unwrap();
        assert!(reopened.account().unwrap().logged_in);
        let offers: Offers = reopened.authenticated(Method::GET, "offers", None).unwrap();
        assert!(offers.sales_enabled && !offers.offers.is_empty());
        let order = reopened.order(&offers.offers[0].id).unwrap();
        let pending = reopened.pending_order().unwrap().unwrap();
        let repeated_order = OfficialClient::new(base, dir.path())
            .unwrap()
            .order(&pending.offer_id)
            .unwrap();
        assert_eq!(
            order.order_no, repeated_order.order_no,
            "重启重试不创建第二张付款单"
        );
        let paid = http
            .post(format!("{base}/__fixture__/orders/{}/paid", order.order_no))
            .json(&json!({}))
            .send()
            .unwrap();
        assert!(paid.status().is_success());
        let status: OrderStatus = reopened
            .authenticated(
                Method::GET,
                &format!("orders/{}/status", order.order_no),
                None,
            )
            .unwrap();
        assert!(status.paid && status.entitlement_granted);
        assert_eq!(reopened.entitlement().unwrap().remaining, 299);
        let _: OrderStatus = reopened
            .authenticated(
                Method::GET,
                &format!("orders/{}/status", order.order_no),
                None,
            )
            .unwrap();
        assert_eq!(reopened.entitlement().unwrap().remaining, 299);
        let _: Value = reopened
            .authenticated(Method::POST, "auth/logout", Some(&json!({})))
            .unwrap();
        assert!(!reopened.account().unwrap().logged_in);
    }
}
