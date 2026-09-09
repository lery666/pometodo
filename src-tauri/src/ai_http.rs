use crate::ai_extract::PromptMessages;
use reqwest::blocking::{Client, ClientBuilder};
use serde::Deserialize;
use serde_json::{json, Value};
use std::io::Read;
use std::time::Duration;

const MAX_HTTP_RESPONSE_BYTES: usize = 131_072;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AiHttpError {
    UnknownProvider,
    Credentials,
    InvalidRequest,
    Timeout,
    Network,
    Redirect,
    RateLimited,
    Balance,
    Unavailable,
    Rejected,
    TooLarge,
    InvalidResponse,
    Truncated,
}

impl std::fmt::Display for AiHttpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::UnknownProvider => "不支持的 AI 服务商",
            Self::Credentials => "API Key 无效或没有该模型的使用权限，请检查设置",
            Self::InvalidRequest => "AI 请求配置无效，请检查服务设置",
            Self::Timeout => "AI 请求超时，请稍后手动重试",
            Self::Network => "无法连接 AI 服务，请检查网络",
            Self::Redirect => "AI 服务返回了地址跳转，已停止请求",
            Self::RateLimited => "AI 服务请求过于频繁或额度不足，请稍后重试",
            Self::Balance => "AI 服务商账户余额不足",
            Self::Unavailable => "AI 服务暂时不可用，请稍后重试",
            Self::Rejected => "AI 服务未接受本次请求",
            Self::TooLarge => "AI 返回内容过长，请缩小输入后重试",
            Self::InvalidResponse => "AI 没有返回有效的整理结果",
            Self::Truncated => "AI 回答未完整生成，请缩小输入后重试",
        })
    }
}
impl std::error::Error for AiHttpError {}

fn provider_endpoint(provider: &str) -> Result<&'static str, AiHttpError> {
    match provider {
        "deepseek" => Ok("https://api.deepseek.com/chat/completions"),
        "qwen" => Ok("https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"),
        "glm" => Ok("https://open.bigmodel.cn/api/paas/v4/chat/completions"),
        _ => Err(AiHttpError::UnknownProvider),
    }
}

// 参数沿用 2026-09-05 本地虚构样例已测组合，不能把一种服务商的思考开关套给另一家。
fn request_body(provider: &str, messages: &PromptMessages) -> Result<Value, AiHttpError> {
    let (model, limit) = match provider {
        "deepseek" => ("deepseek-v4-flash", 1024),
        "qwen" => ("qwen3.8-flash", 1024),
        "glm" => ("glm-5.3-flash", 4096),
        _ => return Err(AiHttpError::UnknownProvider),
    };
    let mut value = json!({
        "model":model, "stream":false, "max_tokens":limit,
        "response_format":{"type":"json_object"},
        "messages":[{"role":"system","content":messages.system},{"role":"user","content":messages.user}]
    });
    match provider {
        "deepseek" => value["thinking"] = json!({"type":"disabled"}),
        "qwen" => value["enable_thinking"] = json!(false),
        "glm" => value["reasoning_effort"] = json!("low"),
        _ => unreachable!(),
    }
    Ok(value)
}

fn client_builder(timeout: Duration) -> ClientBuilder {
    Client::builder()
        .connect_timeout(Duration::from_secs(8))
        .timeout(timeout)
        .redirect(reqwest::redirect::Policy::none())
        .user_agent(concat!("PomeTodo/", env!("CARGO_PKG_VERSION")))
}

pub struct AiHttp {
    client: Client,
}

impl AiHttp {
    #[cfg(test)]
    pub(crate) fn complete_loopback(
        endpoint: &str,
        provider: &str,
        key: &str,
        messages: &PromptMessages,
    ) -> Result<String, AiHttpError> {
        assert!(endpoint.starts_with("http://127.0.0.1:"));
        Self {
            client: client_builder(Duration::from_secs(3))
                .no_proxy()
                .build()
                .unwrap(),
        }
        .send(endpoint, key, &request_body(provider, messages)?)
    }
    pub fn new() -> Result<Self, AiHttpError> {
        Ok(Self {
            client: client_builder(Duration::from_secs(30))
                .https_only(true)
                .build()
                .map_err(|_| AiHttpError::InvalidRequest)?,
        })
    }

    pub fn complete(
        &self,
        provider: &str,
        key: &str,
        messages: &PromptMessages,
    ) -> Result<String, AiHttpError> {
        self.send(
            provider_endpoint(provider)?,
            key,
            &request_body(provider, messages)?,
        )
    }

    // 端点由 complete 中的固定映射提供，不向前端开放任意 URL。
    fn send(&self, endpoint: &str, key: &str, body: &Value) -> Result<String, AiHttpError> {
        let key = key.trim();
        if key.is_empty()
            || key.len() > 8192
            || !key.is_ascii()
            || key.chars().any(char::is_control)
        {
            return Err(AiHttpError::Credentials);
        }
        let mut authorization = reqwest::header::HeaderValue::from_str(&format!("Bearer {key}"))
            .map_err(|_| AiHttpError::Credentials)?;
        authorization.set_sensitive(true);
        let response = self
            .client
            .post(endpoint)
            .header(reqwest::header::AUTHORIZATION, authorization)
            .json(body)
            .send()
            .map_err(|error| {
                if error.is_timeout() {
                    AiHttpError::Timeout
                } else if error.is_builder() {
                    AiHttpError::InvalidRequest
                } else {
                    AiHttpError::Network
                }
            })?;
        match response.status().as_u16() {
            200..=299 => {}
            300..=399 => return Err(AiHttpError::Redirect),
            401 | 403 => return Err(AiHttpError::Credentials),
            402 => return Err(AiHttpError::Balance),
            429 => return Err(AiHttpError::RateLimited),
            500..=599 => return Err(AiHttpError::Unavailable),
            _ => return Err(AiHttpError::Rejected),
        }
        if response
            .content_length()
            .is_some_and(|len| len > MAX_HTTP_RESPONSE_BYTES as u64)
        {
            return Err(AiHttpError::TooLarge);
        }
        let mut bytes = Vec::new();
        response
            .take((MAX_HTTP_RESPONSE_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|error| {
                let request_timeout = error
                    .get_ref()
                    .and_then(|source| source.downcast_ref::<reqwest::Error>())
                    .is_some_and(reqwest::Error::is_timeout);
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
                ) || request_timeout
                {
                    AiHttpError::Timeout
                } else {
                    AiHttpError::Network
                }
            })?;
        if bytes.len() > MAX_HTTP_RESPONSE_BYTES {
            return Err(AiHttpError::TooLarge);
        }
        response_content(&bytes)
    }
}

#[derive(Deserialize)]
struct Response {
    choices: [Choice; 1],
}
#[derive(Deserialize)]
struct Choice {
    message: Message,
    finish_reason: String,
}
#[derive(Deserialize)]
struct Message {
    role: String,
    content: Option<String>,
}

fn response_content(bytes: &[u8]) -> Result<String, AiHttpError> {
    let response: Response =
        serde_json::from_slice(bytes).map_err(|_| AiHttpError::InvalidResponse)?;
    let [choice] = response.choices;
    if choice.finish_reason == "length" {
        return Err(AiHttpError::Truncated);
    }
    if choice.finish_reason != "stop" || choice.message.role != "assistant" {
        return Err(AiHttpError::InvalidResponse);
    }
    choice
        .message
        .content
        .filter(|content| !content.trim().is_empty())
        .ok_or(AiHttpError::InvalidResponse)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use serde_json::json;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;
    use std::time::Duration;

    fn messages() -> crate::ai_extract::PromptMessages {
        crate::ai_extract::PromptMessages {
            system: "固定规则".into(),
            user: "虚构客户：明天交初稿".into(),
        }
    }

    pub(crate) fn server(
        status: &str,
        extra: &str,
        body: String,
        delay: Duration,
    ) -> (String, thread::JoinHandle<String>) {
        let response = format!(
            "HTTP/1.1 {status}\r\nConnection: close\r\nContent-Length: {}\r\n{extra}\r\n{body}",
            body.len()
        );
        raw_server(response, delay, false)
    }

    fn raw_server(
        response: String,
        delay: Duration,
        headers_first: bool,
    ) -> (String, thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/chat", listener.local_addr().unwrap());
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut bytes = Vec::new();
            loop {
                let mut buffer = [0; 2048];
                let n = stream.read(&mut buffer).unwrap();
                if n == 0 {
                    break;
                }
                bytes.extend_from_slice(&buffer[..n]);
                if let Some(end) = bytes.windows(4).position(|v| v == b"\r\n\r\n") {
                    let header = String::from_utf8_lossy(&bytes[..end]).to_lowercase();
                    let length: usize = header
                        .lines()
                        .find_map(|l| l.strip_prefix("content-length:"))
                        .unwrap()
                        .trim()
                        .parse()
                        .unwrap();
                    if bytes.len() >= end + 4 + length {
                        break;
                    }
                }
            }
            if headers_first {
                let (headers, body) = response.split_once("\r\n\r\n").unwrap();
                stream
                    .write_all(format!("{headers}\r\n\r\n").as_bytes())
                    .unwrap();
                thread::sleep(delay);
                let _ = stream.write_all(body.as_bytes());
            } else {
                thread::sleep(delay);
                let _ = stream.write_all(response.as_bytes());
            }
            String::from_utf8(bytes).unwrap()
        });
        (url, handle)
    }

    fn local_client(timeout: Duration) -> AiHttp {
        AiHttp {
            client: client_builder(timeout).no_proxy().build().unwrap(),
        }
    }

    fn envelope(content: serde_json::Value, finish: &str) -> String {
        json!({"choices":[{"message":{"role":"assistant","content":content}, "finish_reason":finish}]}).to_string()
    }

    #[test]
    fn providers_use_tested_flash_models_and_independent_parameters() {
        for (id, model, limit) in [
            ("deepseek", "deepseek-v4-flash", 1024),
            ("qwen", "qwen3.8-flash", 1024),
            ("glm", "glm-5.3-flash", 4096),
        ] {
            let value = request_body(id, &messages()).unwrap();
            assert_eq!(value["model"], model);
            assert_eq!(value["max_tokens"], limit);
            assert_eq!(value["stream"], false);
            assert_eq!(value["response_format"]["type"], "json_object");
            assert_eq!(value["messages"][0]["role"], "system");
            assert_eq!(value["messages"][1]["content"], messages().user);
            assert!(provider_endpoint(id).unwrap().starts_with("https://"));
        }
        assert_eq!(
            request_body("deepseek", &messages()).unwrap()["thinking"]["type"],
            "disabled"
        );
        assert_eq!(
            request_body("qwen", &messages()).unwrap()["enable_thinking"],
            false
        );
        let glm = request_body("glm", &messages()).unwrap();
        assert_eq!(glm["reasoning_effort"], "low");
        assert!(glm.get("thinking").is_none());
        assert_eq!(
            provider_endpoint("unknown"),
            Err(AiHttpError::UnknownProvider)
        );
    }

    #[test]
    fn reads_only_the_final_complete_assistant_message() {
        assert_eq!(
            response_content(&envelope(json!("{\"title\":\"初稿\"}"), "stop").into_bytes())
                .unwrap(),
            "{\"title\":\"初稿\"}"
        );
        assert_eq!(
            response_content(&envelope(json!("{}"), "length").into_bytes()),
            Err(AiHttpError::Truncated)
        );
        for content in [json!(null), json!(" "), json!([{"text":"ignored"}])] {
            assert!(response_content(&envelope(content, "stop").into_bytes()).is_err());
        }
        for body in [
            r#"{"choices":[]}"#,
            r#"{"choices":[{},{}]}"#,
            r#"{"error":{"message":"private"}}"#,
        ] {
            assert!(response_content(body.as_bytes()).is_err());
        }
    }

    #[test]
    fn sends_json_and_authorization_to_the_selected_service() {
        let (url, server) = server(
            "200 OK",
            "",
            envelope(json!("{\"title\":\"虚构初稿\"}"), "stop"),
            Duration::ZERO,
        );
        let result = local_client(Duration::from_secs(2))
            .send(
                &url,
                "synthetic-key",
                &request_body("deepseek", &messages()).unwrap(),
            )
            .unwrap();
        assert_eq!(result, "{\"title\":\"虚构初稿\"}");
        let request = server.join().unwrap();
        assert!(request
            .to_lowercase()
            .contains("authorization: bearer synthetic-key"));
        let body: serde_json::Value =
            serde_json::from_str(request.split_once("\r\n\r\n").unwrap().1).unwrap();
        assert_eq!(body["model"], "deepseek-v4-flash");
        assert!(!body.to_string().contains("synthetic-key"));
    }

    #[test]
    fn redirects_and_service_errors_do_not_retry_or_expose_body() {
        for (status, expected) in [
            ("307 Temporary Redirect", AiHttpError::Redirect),
            ("401 Unauthorized", AiHttpError::Credentials),
            ("429 Too Many Requests", AiHttpError::RateLimited),
            ("503 Unavailable", AiHttpError::Unavailable),
        ] {
            let (url, server) = server(
                status,
                "Location: http://127.0.0.1:1/private\r\n",
                "private body synthetic-key".into(),
                Duration::ZERO,
            );
            let error = local_client(Duration::from_secs(2))
                .send(&url, "synthetic-key", &json!({}))
                .unwrap_err();
            assert_eq!(error, expected);
            assert!(!error.to_string().contains("synthetic-key"));
            assert!(!error.to_string().contains("private"));
            server.join().unwrap();
        }
    }

    #[test]
    fn oversized_response_is_refused_before_parsing() {
        let (url, server) = server(
            "200 OK",
            "",
            "x".repeat(MAX_HTTP_RESPONSE_BYTES + 1),
            Duration::ZERO,
        );
        assert_eq!(
            local_client(Duration::from_secs(2)).send(&url, "synthetic-key", &json!({})),
            Err(AiHttpError::TooLarge)
        );
        server.join().unwrap();
    }

    #[test]
    fn request_times_out_instead_of_waiting_indefinitely() {
        let (url, server) = server("200 OK", "", "{}".into(), Duration::from_millis(150));
        assert_eq!(
            local_client(Duration::from_millis(30)).send(&url, "synthetic-key", &json!({})),
            Err(AiHttpError::Timeout)
        );
        server.join().unwrap();
    }

    #[test]
    fn invalid_keys_and_plain_http_are_rejected_without_sending() {
        let client = AiHttp::new().unwrap();
        assert_eq!(
            client.send("http://127.0.0.1:1", "", &json!({})),
            Err(AiHttpError::Credentials)
        );
        assert_eq!(
            client.send("http://127.0.0.1:1", "bad\nkey", &json!({})),
            Err(AiHttpError::Credentials)
        );
        assert_eq!(
            client.send("http://127.0.0.1:1", "synthetic-key", &json!({})),
            Err(AiHttpError::InvalidRequest)
        );
    }

    #[test]
    fn timeout_while_reading_the_body_is_reported_as_timeout() {
        let (url, server) = raw_server(
            "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}".into(),
            Duration::from_millis(180),
            true,
        );
        let result =
            local_client(Duration::from_millis(50)).send(&url, "synthetic-key", &json!({}));
        server.join().unwrap();
        assert_eq!(result, Err(AiHttpError::Timeout));
    }

    #[test]
    fn response_without_content_length_is_still_bounded() {
        let (url, server) = raw_server(
            format!(
                "HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n{}",
                "x".repeat(MAX_HTTP_RESPONSE_BYTES + 1)
            ),
            Duration::ZERO,
            false,
        );
        let result = local_client(Duration::from_secs(2)).send(&url, "synthetic-key", &json!({}));
        server.join().unwrap();
        assert_eq!(result, Err(AiHttpError::TooLarge));
    }
}
