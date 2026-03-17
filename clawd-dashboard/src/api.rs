use crate::models::*;
use crate::state::SharedState;
use reqwest::Client;

const BASE_URL: &str = "http://localhost:3000";
const TOKEN: &str = "VhPJmjOLM0A_t2idQrtfa3cHpSr_hBh0fgNxMr2TwUM";

fn auth_header() -> String {
    format!("Bearer {}", TOKEN)
}

pub async fn fetch_initial_data(state: SharedState) {
    let client = Client::new();

    let (widgets_res, todos_res, soul_res, usage_res, status_res) = tokio::join!(
        fetch_widgets(&client),
        fetch_todos(&client),
        fetch_soul(&client),
        fetch_usage(&client),
        fetch_status(&client),
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
    }

    log::info!("Initial data fetch complete");
}

async fn fetch_widgets(client: &Client) -> Result<WidgetsResponse, String> {
    client
        .get(format!("{}/api/widgets", BASE_URL))
        .header("Authorization", auth_header())
        .send()
        .await
        .map_err(|e| format!("widgets fetch: {}", e))?
        .json::<WidgetsResponse>()
        .await
        .map_err(|e| format!("widgets parse: {}", e))
}

async fn fetch_todos(client: &Client) -> Result<TodosResponse, String> {
    client
        .get(format!("{}/api/todos", BASE_URL))
        .header("Authorization", auth_header())
        .send()
        .await
        .map_err(|e| format!("todos fetch: {}", e))?
        .json::<TodosResponse>()
        .await
        .map_err(|e| format!("todos parse: {}", e))
}

async fn fetch_soul(client: &Client) -> Result<SoulData, String> {
    client
        .get(format!("{}/api/soul", BASE_URL))
        .header("Authorization", auth_header())
        .send()
        .await
        .map_err(|e| format!("soul fetch: {}", e))?
        .json::<SoulData>()
        .await
        .map_err(|e| format!("soul parse: {}", e))
}

async fn fetch_usage(client: &Client) -> Result<UsageResponse, String> {
    client
        .get(format!("{}/api/usage", BASE_URL))
        .header("Authorization", auth_header())
        .send()
        .await
        .map_err(|e| format!("usage fetch: {}", e))?
        .json::<UsageResponse>()
        .await
        .map_err(|e| format!("usage parse: {}", e))
}

async fn fetch_status(client: &Client) -> Result<StatusResponse, String> {
    client
        .get(format!("{}/api/status", BASE_URL))
        .header("Authorization", auth_header())
        .send()
        .await
        .map_err(|e| format!("status fetch: {}", e))?
        .json::<StatusResponse>()
        .await
        .map_err(|e| format!("status parse: {}", e))
}

pub async fn complete_todo(todo_id: &str) -> Result<(), String> {
    let client = Client::new();
    let body = serde_json::json!({ "id": todo_id });
    client
        .post(format!("{}/api/todos/complete", BASE_URL))
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
    let url = format!("{}/api/events?token={}", BASE_URL, TOKEN);

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

        // Process complete lines
        while let Some(newline_pos) = buffer.find('\n') {
            let line = buffer[..newline_pos].trim_end_matches('\r').to_string();
            buffer = buffer[newline_pos + 1..].to_string();

            if line.is_empty() {
                // Empty line = end of event
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
                // Comment, ignore
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
            // Message events have sender + text
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
                let evt = v.get("event").and_then(|e| e.as_str()).unwrap_or("");
                s.voice_event = Some(evt.to_string());
                // For "response": transcript=command, response=text. For "command": transcript=text
                if evt == "response" {
                    s.voice_text = v.get("command").and_then(|c| c.as_str()).map(String::from);
                    s.voice_response = v.get("text").or_else(|| v.get("message")).and_then(|m| m.as_str()).map(String::from);
                } else {
                    s.voice_text = v.get("text").or_else(|| v.get("command")).and_then(|t| t.as_str()).map(String::from);
                    s.voice_response = v.get("message").and_then(|m| m.as_str()).map(String::from);
                }
                s.voice_audio = v.get("audio").and_then(|a| a.as_str()).map(String::from);
                s.voice_panel = v.get("panel").and_then(|p| p.as_str()).map(String::from);
                s.voice_message = v.get("message").and_then(|m| m.as_str()).map(String::from);
                log::debug!("SSE: voice event {:?}", evt);
            }
        }
        _ => {
            log::debug!("SSE: unknown event type '{}'", event);
        }
    }
}
