use crate::models::*;
use crate::state::SharedState;
use reqwest::Client;

fn base_url() -> String {
    std::env::var("CLAWDBOT_URL").unwrap_or_else(|_| "http://localhost:3000".to_string())
}

fn dashboard_token() -> String {
    std::env::var("DASHBOARD_TOKEN").unwrap_or_else(|_| {
        "VhPJmjOLM0A_t2idQrtfa3cHpSr_hBh0fgNxMr2TwUM".to_string()
    })
}

fn auth_header() -> String {
    format!("Bearer {}", dashboard_token())
}

/// For in-app refresh calls (e.g. after todo complete) — matches `CLAWDBOT_URL` / `DASHBOARD_TOKEN` env.
pub fn api_base_url() -> String {
    base_url()
}

pub fn api_auth_header() -> String {
    auth_header()
}

/// Map Pi panel hints to dashboard swipe targets (egui).
fn map_panel_hint(raw: &str) -> Option<String> {
    match raw {
        "travel" => Some("sidegig".into()),
        "weather" => None, // no dedicated column; header shows weather
        "side_gig" | "side-gig" => Some("sidegig".into()),
        other => Some(other.into()),
    }
}

pub async fn fetch_initial_data(state: SharedState) {
    let client = Client::new();
    let base = base_url();

    let (widgets_res, todos_res, soul_res, usage_res, status_res, health_res) = tokio::join!(
        fetch_widgets(&client, &base),
        fetch_todos(&client, &base),
        fetch_soul(&client, &base),
        fetch_usage(&client, &base),
        fetch_status(&client, &base),
        fetch_system_health(&client, &base),
    );

    if let Ok(mut s) = state.write() {
        if let Ok(w) = widgets_res {
            s.henry_weekends = w.henry_weekends.unwrap_or_default();
            s.side_gig = w.side_gig.unwrap_or_default();
            s.calendar = w.calendar.unwrap_or_default();
            s.email = w.email.unwrap_or_default();
            s.weather = w.weather.unwrap_or_default();
        }
        if let Ok(t) = todos_res {
            s.todos = t.todos;
        }
        if let Ok(soul) = soul_res {
            s.soul = soul;
        }
        if let Ok(u) = usage_res {
            s.usage = u;
        }
        if let Ok(st) = status_res {
            s.connected = st.connected;
            s.status = st;
        }
        if let Ok(h) = health_res {
            s.system_health = h;
        }
    }

    log::info!("Initial data fetch complete");
}

async fn fetch_widgets(client: &Client, base: &str) -> Result<WidgetsResponse, String> {
    client
        .get(format!("{}/api/widgets", base))
        .header("Authorization", auth_header())
        .send()
        .await
        .map_err(|e| format!("widgets fetch: {}", e))?
        .json::<WidgetsResponse>()
        .await
        .map_err(|e| format!("widgets parse: {}", e))
}

async fn fetch_todos(client: &Client, base: &str) -> Result<TodosResponse, String> {
    client
        .get(format!("{}/api/todos", base))
        .header("Authorization", auth_header())
        .send()
        .await
        .map_err(|e| format!("todos fetch: {}", e))?
        .json::<TodosResponse>()
        .await
        .map_err(|e| format!("todos parse: {}", e))
}

async fn fetch_soul(client: &Client, base: &str) -> Result<SoulData, String> {
    client
        .get(format!("{}/api/soul", base))
        .header("Authorization", auth_header())
        .send()
        .await
        .map_err(|e| format!("soul fetch: {}", e))?
        .json::<SoulData>()
        .await
        .map_err(|e| format!("soul parse: {}", e))
}

async fn fetch_usage(client: &Client, base: &str) -> Result<UsageResponse, String> {
    client
        .get(format!("{}/api/usage", base))
        .header("Authorization", auth_header())
        .send()
        .await
        .map_err(|e| format!("usage fetch: {}", e))?
        .json::<UsageResponse>()
        .await
        .map_err(|e| format!("usage parse: {}", e))
}

async fn fetch_status(client: &Client, base: &str) -> Result<StatusResponse, String> {
    client
        .get(format!("{}/api/status", base))
        .send()
        .await
        .map_err(|e| format!("status fetch: {}", e))?
        .json::<StatusResponse>()
        .await
        .map_err(|e| format!("status parse: {}", e))
}

async fn fetch_system_health(client: &Client, base: &str) -> Result<SystemHealthResponse, String> {
    client
        .get(format!("{}/api/system-health", base))
        .header("Authorization", auth_header())
        .send()
        .await
        .map_err(|e| format!("system-health fetch: {}", e))?
        .json::<SystemHealthResponse>()
        .await
        .map_err(|e| format!("system-health parse: {}", e))
}

pub async fn complete_todo(todo_id: &str) -> Result<(), String> {
    let client = Client::new();
    let base = base_url();
    let body = serde_json::json!({ "id": todo_id });
    client
        .post(format!("{}/api/todos/complete", base))
        .header("Authorization", auth_header())
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("complete todo: {}", e))?;
    Ok(())
}

pub async fn listen_sse(state: SharedState) {
    loop {
        match connect_and_listen(&state).await {
            Ok(()) => log::info!("SSE stream ended cleanly"),
            Err(e) => log::error!("SSE error: {}", e),
        }
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
    }
}

async fn connect_and_listen(state: &SharedState) -> Result<(), String> {
    let client = Client::new();
    let base = base_url();
    let tok = dashboard_token();
    let url = format!("{}/api/events?token={}", base, tok);

    let response = client
        .get(&url)
        .header("Accept", "text/event-stream")
        .send()
        .await
        .map_err(|e| format!("SSE connect: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("SSE status: {}", response.status()));
    }

    log::info!("SSE connected");

    let mut stream = response.bytes_stream();
    let mut buffer = String::new();
    let mut current_event = String::new();
    let mut current_data = String::new();

    use futures_util::StreamExt;

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("SSE read: {}", e))?;
        let text = String::from_utf8_lossy(&chunk);
        buffer.push_str(&text);

        while let Some(newline_pos) = buffer.find('\n') {
            let line = buffer[..newline_pos].trim_end_matches('\r').to_string();
            buffer = buffer[newline_pos + 1..].to_string();

            if line.is_empty() {
                if !current_data.is_empty() {
                    process_sse_event(state, &current_event, &current_data);
                }
                current_event.clear();
                current_data.clear();
            } else if let Some(rest) = line.strip_prefix("event: ") {
                current_event = rest.to_string();
            } else if let Some(rest) = line.strip_prefix("data: ") {
                if !current_data.is_empty() {
                    current_data.push('\n');
                }
                current_data.push_str(rest);
            } else if line.starts_with(':') {
                // Comment
            }
        }
    }

    Ok(())
}

fn process_sse_event(state: &SharedState, event: &str, data: &str) {
    let mut s = match state.write() {
        Ok(s) => s,
        Err(_) => return,
    };

    match event {
        "connected" => {
            s.connected = true;
            log::info!("SSE: connected event");
        }
        "widgets" => {
            if let Ok(w) = serde_json::from_str::<WidgetsResponse>(data) {
                s.henry_weekends = w.henry_weekends.unwrap_or_default();
                s.side_gig = w.side_gig.unwrap_or_default();
                s.calendar = w.calendar.unwrap_or_default();
                s.email = w.email.unwrap_or_default();
                s.weather = w.weather.unwrap_or_default();
                log::debug!("SSE: widgets updated");
            } else {
                log::warn!("SSE: failed to parse widgets data");
            }
        }
        "todos" => {
            if let Ok(t) = serde_json::from_str::<TodosResponse>(data) {
                s.todos = t.todos;
                log::debug!("SSE: todos updated");
            } else {
                log::warn!("SSE: failed to parse todos data");
            }
        }
        "soul" => {
            if let Ok(soul) = serde_json::from_str::<SoulData>(data) {
                s.soul = soul;
                log::debug!("SSE: soul updated");
            } else {
                log::warn!("SSE: failed to parse soul data");
            }
        }
        "message" => {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(data) {
                s.last_message_sender = v
                    .get("sender")
                    .and_then(|s| s.as_str())
                    .unwrap_or("")
                    .to_string();
                s.last_message_text = v
                    .get("text")
                    .and_then(|s| s.as_str())
                    .unwrap_or("")
                    .to_string();
                log::debug!("SSE: message from {}", s.last_message_sender);
            }
        }
        "voice" => {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(data) {
                let evt = v.get("event").and_then(|e| e.as_str()).unwrap_or("").to_string();

                // Multi-panel navigation from voice responses (Pi sends `panels` array)
                if evt == "response" {
                    // Navigate to the first relevant column only (avoid rapid multi-swipe)
                    if let Some(arr) = v.get("panels").and_then(|p| p.as_array()) {
                        'nav: for p in arr {
                            if let Some(name) = p.as_str() {
                                if let Some(mapped) = map_panel_hint(name) {
                                    s.voice_queue.push((
                                        "navigate".to_string(),
                                        None,
                                        None,
                                        None,
                                        Some(mapped),
                                        None,
                                    ));
                                    break 'nav;
                                }
                            }
                        }
                    } else if let Some(single) = v.get("panel").and_then(|p| p.as_str()) {
                        if let Some(mapped) = map_panel_hint(single) {
                            s.voice_queue.push((
                                "navigate".to_string(),
                                None,
                                None,
                                None,
                                Some(mapped),
                                None,
                            ));
                        }
                    }
                }

                let (text, response) = if evt == "response" {
                    (
                        v.get("command").and_then(|c| c.as_str()).map(String::from),
                        v.get("text").or_else(|| v.get("message")).and_then(|m| m.as_str()).map(String::from),
                    )
                } else {
                    (
                        v.get("text").or_else(|| v.get("command")).and_then(|t| t.as_str()).map(String::from),
                        v.get("message").and_then(|m| m.as_str()).map(String::from),
                    )
                };
                let audio = v.get("audio").and_then(|a| a.as_str()).map(String::from);
                let panel = v.get("panel").and_then(|p| p.as_str()).map(String::from);
                let message = v.get("message").and_then(|m| m.as_str()).map(String::from);
                log::debug!("SSE: voice event {:?}", evt);

                // EVO ack after HTTP returns — no UI change needed
                if evt == "result" {
                    return;
                }

                s.voice_queue.push((evt, text, response, audio, panel, message));
            }
        }
        _ => {
            log::debug!("SSE: unknown event type '{}'", event);
        }
    }
}
