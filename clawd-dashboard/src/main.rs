mod api;
mod audio;
mod models;
mod state;
mod voice_overlay;

use eframe::egui;
use egui::{Color32, RichText, Stroke, Vec2};
use std::time::Instant;

use audio::AudioEngine;
use state::{AppState, SharedState};
use voice_overlay::{VoiceOverlay, VoiceState};

// ── Swipe detection ─────────────────────────────────────────────────
const SWIPE_THRESHOLD: f32 = 38.0; // min px — slightly easier on 10" touchscreen
const SWIPE_MAX_Y: f32 = 110.0; // allow a bit more diagonal drift

// ── Theme colors ────────────────────────────────────────────────────
const BG: Color32 = Color32::from_rgb(10, 10, 15);
const SURFACE: Color32 = Color32::from_rgb(20, 20, 31);
const SURFACE2: Color32 = Color32::from_rgb(28, 28, 46);
const BORDER: Color32 = Color32::from_rgb(42, 42, 64);
const BORDER_LIGHT: Color32 = Color32::from_rgb(65, 65, 90);  // brighter border for disabled elements
const TEXT: Color32 = Color32::from_rgb(232, 232, 240);
const TEXT_DIM: Color32 = Color32::from_rgb(136, 136, 160);
const TEXT_BTN: Color32 = Color32::from_rgb(190, 190, 210);  // legible on dark button backgrounds
const ACCENT: Color32 = Color32::from_rgb(108, 92, 231);
const ACCENT_LIGHT: Color32 = Color32::from_rgb(140, 126, 245);  // brighter accent for button text
const ACCENT2: Color32 = Color32::from_rgb(0, 206, 201);
const RED: Color32 = Color32::from_rgb(255, 107, 107);
const GREEN: Color32 = Color32::from_rgb(81, 207, 102);
const ORANGE: Color32 = Color32::from_rgb(255, 169, 77);
const BLUE: Color32 = Color32::from_rgb(77, 171, 247);

// ── Font sizes ───────────────────────────────────────────────────────
const FONT_HEADER: f32 = 17.0;
const FONT_TITLE: f32 = 14.0;
const FONT_BODY: f32 = 13.0;
const FONT_SM: f32 = 11.5;
const FONT_XS: f32 = 10.5;

// ── Layout constants ───────────────────────────────────────────────
const HEADER_H: f32 = 44.0;
const LAST_MSG_H: f32 = 40.0;
const CHAT_BAR_H: f32 = 56.0; // ~48dp+ comfort for bottom nav on kiosk
const NAV_ARROW_MIN: f32 = 48.0; // touch target
const PANEL_DOT_HIT: f32 = 14.0; // tappable dot cell

// ── Panel labels ───────────────────────────────────────────────────
const LEFT_PANELS: &[&str] = &["Calendar", "AI Chat"];
const RIGHT_PANELS: &[&str] = &["Admin", "Soul", "Email", "Side Gig", "Help"];

// ───────────────────────────────────────────────────────────────────

/// Tracks an in-progress touch/drag gesture for swipe detection.
#[derive(Default)]
struct SwipeTracker {
    active: bool,
    start_x: f32,
    start_y: f32,
    current_x: f32,
}

impl SwipeTracker {
    fn begin(&mut self, pos: egui::Pos2) {
        self.active = true;
        self.start_x = pos.x;
        self.start_y = pos.y;
        self.current_x = pos.x;
    }

    fn update(&mut self, pos: egui::Pos2) {
        if self.active {
            self.current_x = pos.x;
            // Invalidate if vertical drift is too large
            if (pos.y - self.start_y).abs() > SWIPE_MAX_Y {
                self.active = false;
            }
        }
    }

    /// Returns Some(delta_x) if a valid swipe ended, None otherwise.
    fn end(&mut self) -> Option<f32> {
        if !self.active {
            self.active = false;
            return None;
        }
        self.active = false;
        let dx = self.current_x - self.start_x;
        if dx.abs() >= SWIPE_THRESHOLD {
            Some(dx)
        } else {
            None
        }
    }

    /// Horizontal offset for visual swipe feedback (clamped).
    fn offset(&self) -> f32 {
        if self.active {
            (self.current_x - self.start_x).clamp(-200.0, 200.0)
        } else {
            0.0
        }
    }
}

struct ClawdApp {
    state: SharedState,
    runtime: tokio::runtime::Runtime,
    audio: Option<AudioEngine>,
    voice: VoiceOverlay,
    start_time: Instant,
    left_panel: usize,
    right_panel: usize,
    last_activated_at: Option<f64>,
    pending_complete: Option<String>,
    left_swipe: SwipeTracker,
    right_swipe: SwipeTracker,
}

impl ClawdApp {
    fn new(cc: &eframe::CreationContext<'_>) -> Self {
        Self::setup_theme(&cc.egui_ctx);

        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("failed to create tokio runtime");

        let shared_state = state::new_shared_state();

        // Spawn async data fetching
        let s = shared_state.clone();
        runtime.spawn(async move { api::fetch_initial_data(s).await });

        let s = shared_state.clone();
        runtime.spawn(async move { api::listen_sse(s).await });

        let audio = AudioEngine::new();
        if audio.is_some() {
            log::info!("Audio engine initialised");
        }

        Self {
            state: shared_state,
            runtime,
            audio,
            voice: VoiceOverlay::new(),
            start_time: Instant::now(),
            left_panel: 0,
            right_panel: 0,
            last_activated_at: None,
            pending_complete: None,
            left_swipe: SwipeTracker::default(),
            right_swipe: SwipeTracker::default(),
        }
    }

    fn time(&self) -> f64 {
        self.start_time.elapsed().as_secs_f64()
    }

    fn setup_theme(ctx: &egui::Context) {
        let mut visuals = egui::Visuals::dark();
        visuals.panel_fill = BG;
        visuals.window_fill = SURFACE;
        visuals.extreme_bg_color = SURFACE2;
        visuals.faint_bg_color = SURFACE2;

        // Widget styles — button text must be clearly legible on dark backgrounds
        visuals.widgets.noninteractive.bg_fill = SURFACE2;
        visuals.widgets.noninteractive.fg_stroke = Stroke::new(1.0, TEXT);
        visuals.widgets.noninteractive.bg_stroke = Stroke::new(1.0, BORDER);
        visuals.widgets.noninteractive.rounding = egui::Rounding::same(4.0);

        visuals.widgets.inactive.bg_fill = Color32::from_rgb(32, 32, 52);
        visuals.widgets.inactive.fg_stroke = Stroke::new(1.0, TEXT_BTN);
        visuals.widgets.inactive.bg_stroke = Stroke::new(1.0, BORDER_LIGHT);

        visuals.widgets.hovered.bg_fill = Color32::from_rgb(45, 42, 72);
        visuals.widgets.hovered.fg_stroke = Stroke::new(1.0, TEXT);
        visuals.widgets.hovered.bg_stroke = Stroke::new(1.0, ACCENT_LIGHT);

        visuals.widgets.active.bg_fill = ACCENT;
        visuals.widgets.active.fg_stroke = Stroke::new(1.0, Color32::WHITE);

        visuals.selection.bg_fill = Color32::from_rgba_premultiplied(108, 92, 231, 60);
        visuals.selection.stroke = Stroke::new(1.0, ACCENT);

        visuals.window_rounding = egui::Rounding::same(8.0);
        visuals.window_stroke = Stroke::new(1.0, BORDER);

        ctx.set_visuals(visuals);

        // Increase spacing slightly for touch
        let mut style = (*ctx.style()).clone();
        style.spacing.item_spacing = Vec2::new(6.0, 4.0);
        style.spacing.button_padding = Vec2::new(8.0, 4.0);
        ctx.set_style(style);
    }

    // ── Voice event processing ─────────────────────────────────────

    fn process_voice_events(&mut self) {
        let time = self.time();

        let events = {
            let mut s = match self.state.write() {
                Ok(s) => s,
                Err(_) => return,
            };
            std::mem::take(&mut s.voice_queue)
        };

        if events.is_empty() {
            return;
        }

        for (event, text, response, audio_data, panel, message) in events {

        match event.as_str() {
            "activated" => {
                if let Some(ref audio) = self.audio {
                    audio.play_ack_tone();
                }
                self.last_activated_at = Some(time);
                self.voice.set_listening(time);
            }
            "listening" => {
                // EVO idle mic — hide overlay unless user is mid-response or just woke (grace)
                let grace_ok = self.last_activated_at.map_or(true, |t| time - t > 2.5);
                let showing = self.voice.is_showing_response_or_processing()
                    || matches!(self.voice.state, VoiceState::Listening { .. });
                if !showing && grace_ok {
                    self.voice.dismiss();
                }
            }
            "command" => {
                let transcript = text.unwrap_or_default();
                self.voice.set_processing(transcript, time);
            }
            "response" => {
                let transcript = text.unwrap_or_default();
                let resp = response.unwrap_or_else(|| message.unwrap_or_default());
                if let Some(ref audio) = self.audio {
                    audio.play_done_tone();
                }
                self.voice.set_response(transcript, resp, time);
            }
            "speak" => {
                if let Some(b64) = audio_data {
                    if let Some(ref audio) = self.audio {
                        audio.play_wav_base64(&b64);
                    }
                }
            }
            "navigate" => {
                if let Some(panel_name) = panel {
                    match panel_name.as_str() {
                        "henry" | "calendar" => self.left_panel = 0,
                        "ai_chat" | "chat" | "messages" => self.left_panel = 1,
                        "admin" => self.right_panel = 0,
                        "soul" => self.right_panel = 1,
                        "email" => self.right_panel = 2,
                        "sidegig" | "side_gig" | "side-gig" => self.right_panel = 3,
                        "help" | "commands" => self.right_panel = 4,
                        _ => log::debug!("Unknown navigate panel: {}", panel_name),
                    }
                }
            }
            "toast" => {
                let msg = message.unwrap_or_else(|| text.unwrap_or_default());
                self.voice.set_toast(msg, time);
            }
            "heartbeat" => {
                self.voice.record_heartbeat(time);
            }
            "stopped" => {
                self.voice.dismiss();
                // Clear heartbeat so status goes offline
                self.voice.last_heartbeat = None;
            }
            _ => {
                log::debug!("Unknown voice event: {}", event);
            }
        }
        } // end for each event
    }

    /// Detect horizontal swipe gestures within a panel rect.
    /// `is_left` = true for left column, false for right column.
    fn detect_swipe_in_rect(&mut self, ctx: &egui::Context, rect: egui::Rect, is_left: bool) {
        let pointer = ctx.input(|i| {
            (
                i.pointer.primary_pressed(),
                i.pointer.primary_down(),
                i.pointer.any_released(),
                i.pointer.interact_pos(),
            )
        });
        let (pressed, down, released, pos) = pointer;
        let pos = match pos {
            Some(p) => p,
            None => return,
        };

        if !rect.contains(pos) && !down {
            return;
        }

        let tracker = if is_left { &mut self.left_swipe } else { &mut self.right_swipe };

        if pressed && rect.contains(pos) {
            tracker.begin(pos);
        } else if down {
            tracker.update(pos);
        } else if released {
            if let Some(dx) = tracker.end() {
                if is_left {
                    if dx < 0.0 && self.left_panel < LEFT_PANELS.len() - 1 {
                        self.left_panel += 1;
                    } else if dx > 0.0 && self.left_panel > 0 {
                        self.left_panel -= 1;
                    }
                } else {
                    if dx < 0.0 && self.right_panel < RIGHT_PANELS.len() - 1 {
                        self.right_panel += 1;
                    } else if dx > 0.0 && self.right_panel > 0 {
                        self.right_panel -= 1;
                    }
                }
            }
        }
    }

    fn process_pending_complete(&mut self) {
        if let Some(todo_id) = self.pending_complete.take() {
            let state = self.state.clone();
            let id = todo_id.clone();
            self.runtime.spawn(async move {
                match api::complete_todo(&id).await {
                    Ok(()) => {
                        log::info!("Completed todo: {}", id);
                        let client = reqwest::Client::new();
                        let url = format!("{}/api/todos", api::api_base_url());
                        let auth = api::api_auth_header();
                        if let Ok(resp) = client.get(url).header("Authorization", auth).send().await
                        {
                            if let Ok(todos) = resp.json::<models::TodosResponse>().await {
                                if let Ok(mut s) = state.write() {
                                    s.todos = todos.todos;
                                }
                            }
                        }
                    }
                    Err(e) => log::error!("Failed to complete todo: {}", e),
                }
            });
        }
    }

    // ── Header ─────────────────────────────────────────────────────

    fn draw_header(&self, ui: &mut egui::Ui, state: &AppState) {
        ui.horizontal_centered(|ui| {
            ui.set_min_height(HEADER_H);

            // Status dot
            let dot_color = if state.connected { GREEN } else { RED };
            let (dot_rect, _) = ui.allocate_exact_size(Vec2::new(8.0, 8.0), egui::Sense::hover());
            ui.painter().circle_filled(dot_rect.center(), 4.0, dot_color);

            ui.add_space(4.0);

            // Title
            ui.label(RichText::new("CLAWD").size(FONT_HEADER).color(ACCENT).strong());

            ui.add_space(8.0);

            // Weather
            for (i, w) in state.weather.iter().enumerate() {
                if i > 0 {
                    ui.label(RichText::new("|").size(FONT_SM).color(BORDER));
                }
                let mut parts = w.location.clone();
                if let Some(temp) = w.temp {
                    parts.push_str(&format!(" {:.0}C", temp));
                }
                if let Some(ref desc) = w.description {
                    parts.push_str(&format!(" {}", desc));
                }
                ui.label(RichText::new(&parts).size(FONT_SM).color(TEXT_DIM));
            }

            // Push right-side items to the right
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                // Clock
                let now = chrono::Local::now();
                let clock = now.format("%H:%M").to_string();
                ui.label(RichText::new(&clock).size(FONT_HEADER).color(TEXT).strong());

                ui.add_space(12.0);

                // API usage badge
                let daily_cost = state.usage.today.as_ref().and_then(|t| t.cost);
                let daily_calls = state.usage.today.as_ref().and_then(|t| t.calls).unwrap_or(0);
                let cost_text = if let Some(cost) = daily_cost {
                    if cost > 0.0 {
                        format!("${:.2}", cost)
                    } else {
                        format!("{} calls", daily_calls)
                    }
                } else {
                    format!("{} calls", daily_calls)
                };
                let is_critical = daily_cost.map_or(false, |c| c > 5.0);
                let badge_color = if is_critical { RED } else { TEXT_DIM };
                let badge_bg = if is_critical {
                    Color32::from_rgba_premultiplied(255, 107, 107, 50)
                } else {
                    SURFACE2
                };

                egui::Frame::none()
                    .fill(badge_bg)
                    .stroke(Stroke::new(1.0, if is_critical { RED } else { BORDER }))
                    .rounding(egui::Rounding::same(10.0))
                    .inner_margin(egui::Margin::symmetric(8.0, 2.0))
                    .show(ui, |ui| {
                        ui.label(RichText::new(&cost_text).size(FONT_SM).color(badge_color));
                    });
            });
        });

        // Bottom border
        let rect = ui.max_rect();
        ui.painter().hline(
            rect.x_range(),
            rect.bottom(),
            Stroke::new(1.0, BORDER),
        );
    }

    // ── Last message bar ───────────────────────────────────────────

    fn draw_last_message(&self, ui: &mut egui::Ui, state: &AppState) {
        // Top border
        let rect = ui.max_rect();
        ui.painter().hline(rect.x_range(), rect.top(), Stroke::new(1.0, BORDER));

        ui.horizontal_centered(|ui| {
            ui.set_min_height(LAST_MSG_H);
            ui.add_space(8.0);

            if !state.last_message_text.is_empty() {
                if !state.last_message_sender.is_empty() {
                    ui.label(
                        RichText::new(format!("{}:", state.last_message_sender))
                            .size(FONT_BODY)
                            .color(ACCENT2),
                    );
                }
                let msg = if state.last_message_text.len() > 100 {
                    format!("{}..", &state.last_message_text[..98])
                } else {
                    state.last_message_text.clone()
                };
                ui.label(RichText::new(&msg).size(FONT_BODY).color(TEXT_DIM));
            }
        });
    }

    // ── Chat bar (panel navigation) ────────────────────────────────

    fn draw_chat_bar(&mut self, ui: &mut egui::Ui) {
        ui.horizontal_centered(|ui| {
            ui.set_min_height(CHAT_BAR_H);

            let total_w = ui.available_width();
            let left_w = total_w * 0.5;
            let center_w = total_w * 0.25;

            let arrow = |s: &'static str| {
                RichText::new(s).size(FONT_TITLE).color(ACCENT_LIGHT)
            };
            let arrow_dim = |s: &'static str| RichText::new(s).size(FONT_TITLE).color(BORDER_LIGHT);

            // Left navigation
            ui.allocate_ui(Vec2::new(left_w, CHAT_BAR_H), |ui| {
                ui.horizontal_centered(|ui| {
                    if self.left_panel > 0 {
                        if ui
                            .add_sized(
                                Vec2::new(NAV_ARROW_MIN, NAV_ARROW_MIN),
                                egui::Button::new(arrow("◀")).frame(false),
                            )
                            .clicked()
                        {
                            self.left_panel -= 1;
                        }
                    } else {
                        ui.add_sized(
                            Vec2::new(NAV_ARROW_MIN, NAV_ARROW_MIN),
                            egui::Label::new(arrow_dim("◀")),
                        );
                    }

                    ui.with_layout(egui::Layout::centered_and_justified(egui::Direction::TopDown), |ui| {
                        ui.vertical_centered(|ui| {
                            ui.label(
                                RichText::new(LEFT_PANELS[self.left_panel])
                                    .size(FONT_BODY)
                                    .color(TEXT)
                                    .strong(),
                            );
                            ui.add_space(2.0);
                            // Tappable dots — jump to panel
                            ui.horizontal(|ui| {
                                let stride = PANEL_DOT_HIT * LEFT_PANELS.len() as f32;
                                ui.add_space((ui.available_width() - stride).max(0.0) * 0.5);
                                for i in 0..LEFT_PANELS.len() {
                                    let active = i == self.left_panel;
                                    let (_, resp) =
                                        ui.allocate_exact_size(Vec2::splat(PANEL_DOT_HIT), egui::Sense::click());
                                    let r = resp.rect;
                                    ui.painter().circle_filled(
                                        r.center(),
                                        if active { 4.0 } else { 2.5 },
                                        if active { ACCENT } else { BORDER },
                                    );
                                    if resp.clicked() {
                                        self.left_panel = i;
                                    }
                                }
                            });
                        });
                    });

                    if self.left_panel < LEFT_PANELS.len() - 1 {
                        if ui
                            .add_sized(
                                Vec2::new(NAV_ARROW_MIN, NAV_ARROW_MIN),
                                egui::Button::new(arrow("▶")).frame(false),
                            )
                            .clicked()
                        {
                            self.left_panel += 1;
                        }
                    } else {
                        ui.add_sized(
                            Vec2::new(NAV_ARROW_MIN, NAV_ARROW_MIN),
                            egui::Label::new(arrow_dim("▶")),
                        );
                    }
                });
            });

            // Center — todos + hint
            ui.allocate_ui(Vec2::new(center_w, CHAT_BAR_H), |ui| {
                ui.vertical_centered(|ui| {
                    ui.add_space(4.0);
                    ui.label(RichText::new("TODOS").size(FONT_BODY).color(ACCENT2).strong());
                    ui.label(
                        RichText::new("Tap ☐ to complete · swipe columns for more")
                            .size(FONT_XS)
                            .color(TEXT_DIM),
                    );
                });
            });

            // Right navigation
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                if self.right_panel < RIGHT_PANELS.len() - 1 {
                    if ui
                        .add_sized(
                            Vec2::new(NAV_ARROW_MIN, NAV_ARROW_MIN),
                            egui::Button::new(arrow("▶")).frame(false),
                        )
                        .clicked()
                    {
                        self.right_panel += 1;
                    }
                } else {
                    ui.add_sized(
                        Vec2::new(NAV_ARROW_MIN, NAV_ARROW_MIN),
                        egui::Label::new(arrow_dim("▶")),
                    );
                }

                ui.with_layout(egui::Layout::top_down(egui::Align::Center), |ui| {
                    ui.add_space(4.0);
                    ui.label(
                        RichText::new(RIGHT_PANELS[self.right_panel])
                            .size(FONT_BODY)
                            .color(TEXT)
                            .strong(),
                    );
                    ui.add_space(2.0);
                    ui.horizontal(|ui| {
                        let stride = PANEL_DOT_HIT * RIGHT_PANELS.len() as f32;
                        ui.add_space((ui.available_width() - stride).max(0.0) * 0.5);
                        for i in 0..RIGHT_PANELS.len() {
                            let active = i == self.right_panel;
                            let (_, resp) =
                                ui.allocate_exact_size(Vec2::splat(PANEL_DOT_HIT), egui::Sense::click());
                            let r = resp.rect;
                            ui.painter().circle_filled(
                                r.center(),
                                if active { 4.0 } else { 2.5 },
                                if active { ACCENT } else { BORDER },
                            );
                            if resp.clicked() {
                                self.right_panel = i;
                            }
                        }
                    });
                });

                if self.right_panel > 0 {
                    if ui
                        .add_sized(
                            Vec2::new(NAV_ARROW_MIN, NAV_ARROW_MIN),
                            egui::Button::new(arrow("◀")).frame(false),
                        )
                        .clicked()
                    {
                        self.right_panel -= 1;
                    }
                } else {
                    ui.add_sized(
                        Vec2::new(NAV_ARROW_MIN, NAV_ARROW_MIN),
                        egui::Label::new(arrow_dim("◀")),
                    );
                }
            });
        });
    }

    // ── Calendar + Henry panel (merged) ──────────────────────────────

    fn draw_calendar_panel(&self, ui: &mut egui::Ui, state: &AppState) {
        section_title(ui, "CALENDAR");

        // Today's events first
        if state.calendar.is_empty() {
            ui.label(RichText::new("No upcoming events").size(FONT_BODY).color(TEXT_DIM));
        } else {
            let mut last_date = String::new();

            for event in &state.calendar {
                let event_date = extract_date(&event.start);

                // Date header
                if event_date != last_date && !event_date.is_empty() {
                    ui.add_space(4.0);
                    ui.label(
                        RichText::new(&event_date)
                            .size(FONT_TITLE)
                            .color(TEXT)
                            .strong(),
                    );
                    last_date = event_date;
                }

                ui.horizontal(|ui| {
                    // Time
                    let time_str = extract_time(&event.start);
                    ui.label(
                        RichText::new(&time_str)
                            .size(FONT_BODY)
                            .color(ACCENT2),
                    );

                    ui.add_space(4.0);

                    // Summary + location
                    ui.vertical(|ui| {
                        ui.label(RichText::new(&event.summary).size(FONT_BODY).color(TEXT));
                        if let Some(ref loc) = event.location {
                            if !loc.is_empty() {
                                ui.label(RichText::new(loc).size(FONT_SM).color(TEXT_DIM));
                            }
                        }
                    });
                });

                ui.separator();
            }
        }

        // Henry weekends section (collapsible)
        if !state.henry_weekends.is_empty() {
            ui.add_space(12.0);
            ui.label(RichText::new("HENRY WEEKENDS").size(FONT_SM).color(ORANGE).strong());
            ui.add_space(4.0);

            for weekend in &state.henry_weekends {
                let avail = ui.available_width();
                egui::Frame::none()
                    .fill(SURFACE2)
                    .stroke(Stroke::new(1.0, BORDER))
                    .rounding(egui::Rounding::same(8.0))
                    .inner_margin(egui::Margin::same(10.0))
                    .show(ui, |ui| {
                        ui.set_width(avail - 22.0);
                        // Date range
                        ui.label(
                            RichText::new(format!("{} -- {}", weekend.start_date, weekend.end_date))
                                .size(FONT_TITLE)
                                .color(TEXT)
                                .strong(),
                        );

                        // Pattern
                        if let Some(ref pattern) = weekend.pattern {
                            ui.label(RichText::new(pattern).size(FONT_BODY).color(TEXT_DIM));
                        }

                        ui.add_space(4.0);

                        // Status badges
                        ui.horizontal(|ui| {
                            if weekend.needs_travel.unwrap_or(false) {
                                let booked = weekend.travel_booked.unwrap_or(false);
                                draw_status_badge(ui, "TRAVEL", booked);
                            } else {
                                draw_na_badge(ui, "TRAVEL");
                            }

                            ui.add_space(4.0);

                            if weekend.needs_accommodation.unwrap_or(false) {
                                let booked = weekend.accommodation_booked.unwrap_or(false);
                                draw_status_badge(ui, "ACCOM", booked);
                            } else {
                                draw_na_badge(ui, "ACCOM");
                            }
                        });
                    });

                ui.add_space(6.0);
            }

            // Side gig meetings (AI/LQ chat section)
            if !state.side_gig.is_empty() {
                ui.add_space(8.0);
                ui.label(RichText::new("AI / LEGALTECH").size(FONT_SM).color(BLUE).strong());
                ui.add_space(4.0);

                for meeting in &state.side_gig {
                    ui.horizontal(|ui| {
                        let time_str = extract_time(&meeting.start);
                        if !time_str.is_empty() {
                            ui.label(RichText::new(&time_str).size(FONT_SM).color(ACCENT2));
                            ui.add_space(4.0);
                        }
                        ui.label(RichText::new(&meeting.summary).size(FONT_BODY).color(TEXT));
                        if let Some(ref tags) = meeting.tags {
                            for tag in tags {
                                let (bg, fg) = match tag.to_uppercase().as_str() {
                                    "AI" => (Color32::from_rgb(18, 40, 65), BLUE),
                                    "LQ" => (Color32::from_rgb(18, 50, 28), GREEN),
                                    _ => (SURFACE2, TEXT_DIM),
                                };
                                egui::Frame::none()
                                    .fill(bg)
                                    .stroke(Stroke::new(1.0, fg))
                                    .rounding(egui::Rounding::same(4.0))
                                    .inner_margin(egui::Margin::symmetric(4.0, 1.0))
                                    .show(ui, |ui| {
                                        ui.label(RichText::new(&tag.to_uppercase()).size(FONT_XS).color(fg).strong());
                                    });
                            }
                        }
                    });
                    ui.separator();
                }
            }
        }
    }

    // ── AI Chat panel (recent messages) ────────────────────────────

    fn draw_chat_panel(&self, ui: &mut egui::Ui, state: &AppState) {
        section_title(ui, "AI CHAT");

        if state.last_message_text.is_empty() {
            ui.label(RichText::new("No recent messages").size(FONT_BODY).color(TEXT_DIM));
        } else {
            egui::Frame::none()
                .fill(SURFACE2)
                .stroke(Stroke::new(1.0, BORDER))
                .rounding(egui::Rounding::same(8.0))
                .inner_margin(egui::Margin::same(10.0))
                .show(ui, |ui| {
                    if !state.last_message_sender.is_empty() {
                        ui.label(
                            RichText::new(format!("{}:", state.last_message_sender))
                                .size(FONT_SM)
                                .color(ACCENT2)
                                .strong(),
                        );
                    }
                    ui.label(RichText::new(&state.last_message_text).size(FONT_BODY).color(TEXT));
                });
        }

        // API usage summary
        ui.add_space(12.0);
        let today_calls = state.usage.today.as_ref().and_then(|t| t.calls).unwrap_or(0);
        let today_cost = state.usage.today.as_ref().and_then(|t| t.cost).unwrap_or(0.0);
        ui.label(RichText::new(format!("Today: {} calls · ${:.2}", today_calls, today_cost)).size(FONT_SM).color(TEXT_DIM));
    }

    // ── Todos panel ────────────────────────────────────────────────

    fn draw_todos_panel(&mut self, ui: &mut egui::Ui, state: &AppState) {
        section_title(ui, "TODOS & REMINDERS");

        // Sort active todos: high > normal > low, then by due date
        let mut active: Vec<&models::Todo> = state.todos.iter().filter(|t| !t.done).collect();
        active.sort_by(|a, b| {
            let pri = |p: &str| match p {
                "high" => 0,
                "normal" => 1,
                "low" => 2,
                _ => 1,
            };
            pri(&a.priority).cmp(&pri(&b.priority)).then_with(|| a.due_date.cmp(&b.due_date))
        });

        let done: Vec<&models::Todo> = state.todos.iter().filter(|t| t.done).rev().take(5).collect();

        if active.is_empty() && done.is_empty() {
            ui.label(RichText::new("No todos").size(FONT_BODY).color(TEXT_DIM));
            return;
        }

        // Active todos
        for todo in &active {
            let is_high = todo.priority == "high";
            let is_low = todo.priority == "low";

            ui.horizontal(|ui| {
                // High priority red bar
                if is_high {
                    let (bar_rect, _) = ui.allocate_exact_size(Vec2::new(3.0, 28.0), egui::Sense::hover());
                    ui.painter().rect_filled(bar_rect, 0.0, RED);
                }

                // Checkbox button — 44px touch target for Pi touchscreen
                let cb_response = ui.add(
                    egui::Button::new(RichText::new("  ").size(FONT_BODY))
                        .fill(Color32::from_rgb(32, 32, 52))
                        .stroke(Stroke::new(1.0, BORDER_LIGHT))
                        .rounding(egui::Rounding::same(6.0))
                        .min_size(Vec2::new(44.0, 44.0)),
                );
                if cb_response.clicked() {
                    self.pending_complete = Some(todo.id.clone());
                }

                ui.add_space(2.0);

                // Todo text
                let text_color = if is_low {
                    Color32::from_rgba_premultiplied(232, 232, 240, 180)
                } else {
                    TEXT
                };
                ui.vertical(|ui| {
                    ui.label(RichText::new(&todo.text).size(FONT_BODY).color(text_color));

                    // Due date + reminder badges
                    ui.horizontal(|ui| {
                        if let Some(ref due) = todo.due_date {
                            let short_due = if due.len() >= 10 { &due[..10] } else { due };
                            let today = chrono::Local::now().format("%Y-%m-%d").to_string();
                            let is_overdue = today.as_str() > short_due;
                            let due_color = if is_overdue { RED } else { ORANGE };
                            ui.label(RichText::new(short_due).size(FONT_XS).color(due_color));
                        }
                        if todo.reminder.is_some() {
                            egui::Frame::none()
                                .fill(Color32::from_rgba_premultiplied(108, 92, 231, 40))
                                .rounding(egui::Rounding::same(3.0))
                                .inner_margin(egui::Margin::symmetric(4.0, 1.0))
                                .show(ui, |ui| {
                                    ui.label(RichText::new("R").size(FONT_XS).color(ACCENT));
                                });
                        }
                    });
                });
            });

            // Separator
            let rect = ui.max_rect();
            ui.painter().hline(
                rect.left()..=rect.right(),
                ui.cursor().top(),
                Stroke::new(1.0, BORDER),
            );
            ui.add_space(2.0);
        }

        // Completed section
        if !done.is_empty() {
            ui.add_space(6.0);
            ui.label(RichText::new("COMPLETED").size(FONT_SM).color(TEXT_DIM));
            ui.add_space(4.0);

            for todo in &done {
                ui.horizontal(|ui| {
                    // Filled green checkbox
                    let (cb_rect, _) = ui.allocate_exact_size(Vec2::new(14.0, 14.0), egui::Sense::hover());
                    ui.painter().rect_filled(cb_rect, 3.0, GREEN);
                    ui.painter().text(
                        cb_rect.center(),
                        egui::Align2::CENTER_CENTER,
                        "x",
                        egui::FontId::proportional(FONT_XS),
                        Color32::from_rgb(0, 0, 0),
                    );

                    ui.add_space(4.0);
                    ui.label(RichText::new(&todo.text).size(FONT_SM).color(TEXT_DIM));
                });
            }
        }
    }

    // ── Side Gig panel ─────────────────────────────────────────────

    fn draw_sidegig_panel(&self, ui: &mut egui::Ui, state: &AppState) {
        section_title(ui, "SIDE GIG");

        if state.side_gig.is_empty() {
            ui.label(RichText::new("No upcoming meetings").size(FONT_BODY).color(TEXT_DIM));
            return;
        }

        for meeting in &state.side_gig {
            ui.horizontal(|ui| {
                // Date column
                let (day, month) = extract_day(&meeting.start);
                if !day.is_empty() {
                    ui.vertical(|ui| {
                        ui.label(RichText::new(&day).size(FONT_TITLE).color(TEXT).strong());
                        ui.label(RichText::new(&month).size(FONT_SM).color(TEXT_DIM));
                    });
                    ui.add_space(6.0);
                }

                // Meeting details
                ui.vertical(|ui| {
                    ui.label(RichText::new(&meeting.summary).size(FONT_BODY).color(TEXT));

                    ui.horizontal(|ui| {
                        let time_str = extract_time(&meeting.start);
                        if !time_str.is_empty() {
                            ui.label(RichText::new(&time_str).size(FONT_SM).color(ACCENT2));
                        }
                        if let Some(ref loc) = meeting.location {
                            if !loc.is_empty() {
                                ui.label(RichText::new(loc).size(FONT_SM).color(TEXT_DIM));
                            }
                        }
                    });

                    // Tag badges
                    if let Some(ref tags) = meeting.tags {
                        if !tags.is_empty() {
                            ui.horizontal(|ui| {
                                for tag in tags {
                                    let (bg, fg) = match tag.to_uppercase().as_str() {
                                        "AI" => (Color32::from_rgb(18, 40, 65), BLUE),
                                        "LQ" => (Color32::from_rgb(18, 50, 28), GREEN),
                                        _ => (SURFACE2, TEXT_DIM),
                                    };
                                    let tag_text = tag.to_uppercase();
                                    egui::Frame::none()
                                        .fill(bg)
                                        .stroke(Stroke::new(1.0, fg))
                                        .rounding(egui::Rounding::same(4.0))
                                        .inner_margin(egui::Margin::symmetric(6.0, 2.0))
                                        .show(ui, |ui| {
                                            ui.label(RichText::new(&tag_text).size(FONT_SM).color(fg).strong());
                                        });
                                }
                            });
                        }
                    }
                });
            });

            ui.separator();
        }
    }

    // ── Email panel ────────────────────────────────────────────────

    fn draw_email_panel(&self, ui: &mut egui::Ui, state: &AppState) {
        ui.horizontal(|ui| {
            ui.label(RichText::new("EMAIL").size(FONT_SM).color(TEXT_DIM));

            // Unread badge
            if state.email.unread_count > 0 {
                egui::Frame::none()
                    .fill(RED)
                    .rounding(egui::Rounding::same(8.0))
                    .inner_margin(egui::Margin::symmetric(6.0, 1.0))
                    .show(ui, |ui| {
                        ui.label(
                            RichText::new(format!("{}", state.email.unread_count))
                                .size(FONT_SM)
                                .color(Color32::WHITE)
                                .strong(),
                        );
                    });
            }

            // Needs-reply badge
            let needs_reply_count = state.email.recent.iter().filter(|e| e.needs_reply).count();
            if needs_reply_count > 0 {
                egui::Frame::none()
                    .fill(ORANGE)
                    .rounding(egui::Rounding::same(8.0))
                    .inner_margin(egui::Margin::symmetric(6.0, 1.0))
                    .show(ui, |ui| {
                        ui.label(
                            RichText::new(format!("{}", needs_reply_count))
                                .size(FONT_SM)
                                .color(Color32::BLACK)
                                .strong(),
                        );
                    });
            }
        });

        ui.add_space(4.0);

        if state.email.recent.is_empty() {
            ui.label(RichText::new("No recent emails").size(FONT_BODY).color(TEXT_DIM));
            return;
        }

        for email in &state.email.recent {
            ui.horizontal(|ui| {
                // Status dots column
                ui.vertical(|ui| {
                    if email.unread {
                        let (r, _) = ui.allocate_exact_size(Vec2::new(8.0, 8.0), egui::Sense::hover());
                        ui.painter().circle_filled(r.center(), 4.0, BLUE);
                    }
                    if email.needs_reply {
                        let (r, _) = ui.allocate_exact_size(Vec2::new(8.0, 8.0), egui::Sense::hover());
                        ui.painter().circle_filled(r.center(), 4.0, ORANGE);
                    }
                    if !email.unread && !email.needs_reply {
                        ui.allocate_exact_size(Vec2::new(8.0, 8.0), egui::Sense::hover());
                    }
                });

                ui.add_space(4.0);

                ui.vertical(|ui| {
                    // From
                    let from_display = if email.from.len() > 30 {
                        format!("{}..", &email.from[..28])
                    } else {
                        email.from.clone()
                    };
                    let from_color = if email.unread {
                        BLUE
                    } else if email.needs_reply {
                        ORANGE
                    } else {
                        TEXT
                    };
                    ui.label(RichText::new(&from_display).size(FONT_SM).color(from_color));

                    // Subject
                    let subj_color = if email.unread { TEXT } else { TEXT_DIM };
                    ui.label(RichText::new(&email.subject).size(FONT_BODY).color(subj_color));

                    // Snippet
                    if let Some(ref snippet) = email.snippet {
                        if !snippet.is_empty() {
                            let short = if snippet.len() > 60 {
                                format!("{}..", &snippet[..58])
                            } else {
                                snippet.clone()
                            };
                            ui.label(
                                RichText::new(&short)
                                    .size(FONT_SM)
                                    .color(Color32::from_rgba_premultiplied(136, 136, 160, 150)),
                            );
                        }
                    }
                });
            });

            ui.separator();
        }
    }

    // ── Soul panel (array-based) ────────────────────────────────────

    fn draw_soul_panel(&self, ui: &mut egui::Ui, state: &AppState) {
        section_title(ui, "SOUL");

        let sections = match state.soul.soul {
            Some(ref s) => s,
            None => {
                ui.label(RichText::new("No soul data").size(FONT_BODY).color(TEXT_DIM));
                return;
            }
        };

        let categories: &[(&str, &Vec<crate::models::SoulEntry>, Color32)] = &[
            ("PEOPLE", &sections.people, ACCENT2),
            ("PATTERNS", &sections.patterns, BLUE),
            ("LESSONS", &sections.lessons, GREEN),
            ("BOUNDARIES", &sections.boundaries, RED),
        ];

        for (label, entries, color) in categories {
            if entries.is_empty() {
                continue;
            }
            ui.label(RichText::new(*label).size(FONT_SM).color(*color).strong());
            ui.add_space(2.0);
            for entry in *entries {
                ui.horizontal(|ui| {
                    let (dot_rect, _) = ui.allocate_exact_size(Vec2::new(6.0, 6.0), egui::Sense::hover());
                    ui.painter().circle_filled(dot_rect.center(), 3.0, *color);
                    ui.add_space(2.0);
                    ui.label(RichText::new(&entry.text).size(FONT_BODY).color(TEXT_DIM));
                });
            }
            ui.add_space(6.0);
        }
    }

    // ── Admin panel (full system health) ───────────────────────────

    fn draw_admin_panel(&self, ui: &mut egui::Ui, state: &AppState) {
        section_title(ui, "ADMIN");

        // SYSTEMS section — all subsystem statuses
        ui.label(RichText::new("SYSTEMS").size(FONT_SM).color(ACCENT));
        ui.add_space(2.0);

        let evo_online = self.voice.evo_online(self.time());
        let h = &state.system_health;

        // Helper closure for status rows
        let draw_row = |ui: &mut egui::Ui, name: &str, online: bool, detail: &str| {
            ui.horizontal(|ui| {
                let dot_color = if online { GREEN } else { RED };
                let (dot_rect, _) = ui.allocate_exact_size(Vec2::new(8.0, 8.0), egui::Sense::hover());
                ui.painter().circle_filled(dot_rect.center(), 4.0, dot_color);
                ui.add_space(4.0);
                ui.label(RichText::new(name).size(FONT_BODY).color(TEXT_BTN));
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    let val_color = if online { GREEN } else { TEXT_DIM };
                    ui.label(RichText::new(detail).size(FONT_SM).color(val_color));
                });
            });
        };

        draw_row(ui, "Pi", true, "Online");
        draw_row(ui, "WhatsApp", state.connected, if state.connected { "Connected" } else { "Disconnected" });
        draw_row(ui, "EVO X2", evo_online, if evo_online { "Reachable" } else { "No Signal" });
        draw_row(ui, "Voice", evo_online, if evo_online { "Active" } else { "Inactive" });

        // Overnight subsystems
        let diary_ok = h.diary.as_ref().and_then(|d| d.last_run.as_deref()).is_some();
        let diary_detail = h.diary.as_ref()
            .and_then(|d| d.last_run.as_deref())
            .unwrap_or("never");
        draw_row(ui, "Diary", diary_ok, diary_detail);

        let si_ok = h.self_improve.as_ref().and_then(|s| s.last_run.as_deref()).is_some();
        let si_detail = h.self_improve.as_ref()
            .and_then(|s| s.last_run.as_deref())
            .unwrap_or("never");
        draw_row(ui, "Self-Improve", si_ok, si_detail);

        let kr_ok = h.knowledge_refresh.as_ref().and_then(|k| k.last_run.as_deref()).is_some();
        let kr_detail = h.knowledge_refresh.as_ref()
            .and_then(|k| k.last_run.as_deref())
            .unwrap_or("never");
        draw_row(ui, "Knowledge", kr_ok, kr_detail);

        let bk_detail = h.backup.as_ref()
            .and_then(|b| b.last_run.as_deref())
            .unwrap_or("never");
        draw_row(ui, "Backup", bk_detail != "never", bk_detail);

        // Memory stats
        let total_mems = h.memory.as_ref().map(|m| m.total).unwrap_or(0);
        if total_mems > 0 {
            draw_row(ui, "Memories", true, &format!("{} total", total_mems));
        }

        ui.add_space(8.0);

        // STATS section — compact 2x2 cards
        ui.label(RichText::new("STATS").size(FONT_SM).color(ACCENT));
        ui.add_space(4.0);

        ui.horizontal(|ui| {
            let card_w = (ui.available_width() - 6.0) / 2.0;
            stat_card(
                ui,
                card_w,
                &state.status.memory_mb.map_or("--".to_string(), |m| format!("{:.0}", m)),
                "MB RSS",
            );
            ui.add_space(6.0);
            stat_card(
                ui,
                card_w,
                &state.status.uptime.map_or("--".to_string(), |u| {
                    let hours = (u / 3600.0).floor() as u64;
                    let mins = ((u % 3600.0) / 60.0).floor() as u64;
                    format!("{}h{}m", hours, mins)
                }),
                "UPTIME",
            );
        });

        ui.add_space(6.0);

        let today_cost = state.usage.today.as_ref().and_then(|t| t.cost).unwrap_or(0.0);
        let total_cost = state.usage.total.as_ref().and_then(|t| t.cost).unwrap_or(0.0);
        ui.horizontal(|ui| {
            let card_w = (ui.available_width() - 6.0) / 2.0;
            stat_card(ui, card_w, &format!("${:.2}", today_cost), "DAY COST");
            ui.add_space(6.0);
            stat_card(ui, card_w, &format!("${:.2}", total_cost), "ALL COST");
        });
    }

    // ── Help / commands panel ─────────────────────────────────────

    fn draw_help_panel(ui: &mut egui::Ui) {
        section_title(ui, "HELP");

        let sections: &[(&str, &[&str])] = &[
            ("VOICE — say “Clawd” / “Claude”", &[
                "Show my emails / calendar / todos",
                "Add a todo … / Remind me to …",
                "Complete [todo words]",
                "What's on my calendar",
                "Remember [note] · Refresh",
                "How are you running? (system status)",
            ]),
            ("AFTER CLAWD SPEAKS", &[
                "Short follow-up without wake word",
                "(listen window on EVO after each reply)",
            ]),
            ("WHATSAPP", &[
                "Same ideas + photos for vision",
                "Email: draft first, then confirm send",
                "07:00 briefing · todo reminders",
            ]),
            ("THIS SCREEN (1024×600)", &[
                "Bottom bar: ◀ ▶ = pages · dots = jump",
                "Swipe left/right column to change page",
                "Centre: tap checkbox to complete todo",
                "Weather + clock in header",
            ]),
        ];

        egui::ScrollArea::vertical()
            .id_salt("help_scroll")
            .auto_shrink([false, false])
            .show(ui, |ui| {
                for (title, commands) in sections {
                    ui.add_space(6.0);
                    ui.label(RichText::new(*title).size(FONT_SM).color(ACCENT2).strong());
                    ui.add_space(4.0);
                    for cmd in *commands {
                        ui.label(RichText::new(*cmd).size(FONT_BODY).color(TEXT_DIM));
                        ui.add_space(2.0);
                    }
                }
            });
    }

    // ── Voice overlay ──────────────────────────────────────────────

    fn draw_voice_overlay(&self, ctx: &egui::Context) {
        let time = self.time();
        let screen_w = ctx.screen_rect().width();
        let card_w = (screen_w * 0.88).clamp(280.0, 560.0);

        match &self.voice.state {
            VoiceState::Hidden => {}

            VoiceState::Listening { start } => {
                let elapsed = time - start;
                let pulse = (elapsed * 3.0).sin().abs() as f32;
                egui::Window::new("voice_listening")
                    .title_bar(false)
                    .resizable(false)
                    .collapsible(false)
                    .anchor(egui::Align2::CENTER_BOTTOM, Vec2::new(0.0, -96.0))
                    .fixed_size(Vec2::new(card_w * 0.55, 42.0))
                    .frame(egui::Frame::none()
                        .fill(SURFACE)
                        .stroke(Stroke::new(1.0, ACCENT))
                        .rounding(egui::Rounding::same(16.0))
                        .inner_margin(egui::Margin::symmetric(14.0, 8.0)))
                    .show(ctx, |ui| {
                        ui.horizontal(|ui| {
                            // Pulsing dot
                            let dot_r = 5.0 + pulse * 2.5;
                            let (dot_rect, _) = ui.allocate_exact_size(Vec2::splat(18.0), egui::Sense::hover());
                            ui.painter().circle_filled(
                                dot_rect.center(),
                                dot_r,
                                Color32::from_rgba_premultiplied(108, 92, 231, (180.0 + pulse * 75.0) as u8),
                            );
                            ui.label(
                                RichText::new("Listening — speak now")
                                    .size(FONT_BODY)
                                    .color(ACCENT_LIGHT),
                            );
                        });
                    });
            }

            VoiceState::Processing { transcript, start } => {
                let elapsed = time - start;
                let display_text: String = if transcript.len() > 72 {
                    format!("“{}…”", &transcript[..69])
                } else {
                    format!("“{}”", transcript)
                };
                egui::Window::new("voice_processing")
                    .title_bar(false)
                    .resizable(false)
                    .collapsible(false)
                    .anchor(egui::Align2::CENTER_BOTTOM, Vec2::new(0.0, -96.0))
                    .fixed_size(Vec2::new(card_w, 52.0))
                    .frame(egui::Frame::none()
                        .fill(SURFACE)
                        .stroke(Stroke::new(1.0, ACCENT))
                        .rounding(egui::Rounding::same(8.0))
                        .inner_margin(egui::Margin::symmetric(14.0, 8.0)))
                    .show(ctx, |ui| {
                        ui.label(RichText::new(&display_text).size(FONT_BODY).color(TEXT));
                        ui.horizontal(|ui| {
                            for i in 0..3 {
                                let bounce = ((elapsed * 3.0 + i as f64 * 0.3).sin() * 3.0).max(0.0) as f32;
                                let (r, _) = ui.allocate_exact_size(Vec2::new(8.0, 12.0), egui::Sense::hover());
                                ui.painter().circle_filled(
                                    egui::pos2(r.center().x, r.max.y - bounce),
                                    3.0, ACCENT,
                                );
                            }
                            ui.label(RichText::new("Working…").size(FONT_SM).color(TEXT_DIM));
                        });
                    });
            }

            VoiceState::Response { transcript, response, .. } => {
                let tx = transcript.clone();
                let rx = response.clone();
                egui::Window::new("voice_response")
                    .title_bar(false)
                    .resizable(false)
                    .collapsible(false)
                    .anchor(egui::Align2::CENTER_BOTTOM, Vec2::new(0.0, -96.0))
                    .min_width(card_w * 0.85)
                    .max_width(card_w)
                    .max_height((ctx.screen_rect().height() * 0.38).clamp(160.0, 240.0))
                    .frame(egui::Frame::none()
                        .fill(SURFACE)
                        .stroke(Stroke::new(1.5, ACCENT))
                        .rounding(egui::Rounding::same(8.0))
                        .inner_margin(egui::Margin::symmetric(16.0, 12.0)))
                    .show(ctx, |ui| {
                        ui.label(
                            RichText::new("Tap outside to dismiss")
                                .size(FONT_XS)
                                .color(TEXT_DIM),
                        );
                        ui.add_space(4.0);
                        if !tx.is_empty() {
                            ui.label(RichText::new(format!("You: “{}”", tx)).size(FONT_SM).color(ACCENT2));
                            ui.add_space(6.0);
                        }
                        egui::ScrollArea::vertical()
                            .max_height((ctx.screen_rect().height() * 0.28).clamp(120.0, 200.0))
                            .show(ui, |ui| {
                                ui.label(RichText::new(rx).size(FONT_BODY).color(TEXT));
                            });
                    });
            }

            VoiceState::Toast { message, .. } => {
                let msg = message.clone();
                egui::Window::new("voice_toast")
                    .title_bar(false)
                    .resizable(false)
                    .collapsible(false)
                    .anchor(egui::Align2::CENTER_BOTTOM, Vec2::new(0.0, -96.0))
                    .max_width(card_w * 0.9)
                    .auto_sized()
                    .frame(egui::Frame::none()
                        .fill(SURFACE2)
                        .stroke(Stroke::new(1.0, BORDER))
                        .rounding(egui::Rounding::same(16.0))
                        .inner_margin(egui::Margin::symmetric(18.0, 10.0)))
                    .show(ctx, |ui| {
                        ui.label(RichText::new(msg).size(FONT_BODY).color(TEXT));
                    });
            }
        }
    }
}

impl eframe::App for ClawdApp {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        // Process background events
        self.process_voice_events();
        self.voice.tick(self.time());
        self.process_pending_complete();

        // Request repaint: 60fps during voice/swipe, 250ms otherwise for smooth clock
        if self.voice.is_visible() || self.left_swipe.active || self.right_swipe.active {
            ctx.request_repaint();
        } else {
            ctx.request_repaint_after(std::time::Duration::from_millis(250));
        }

        // Take a snapshot of shared state
        let state = match self.state.read() {
            Ok(s) => s.clone(),
            Err(_) => return,
        };

        // ── Header ─────────────────────────────────────────────
        egui::TopBottomPanel::top("header")
            .exact_height(HEADER_H)
            .frame(egui::Frame::none().fill(SURFACE).inner_margin(egui::Margin::symmetric(16.0, 0.0)))
            .show(ctx, |ui| {
                self.draw_header(ui, &state);
            });

        // ── Chat bar (bottom-most) ─────────────────────────────
        egui::TopBottomPanel::bottom("chatbar")
            .exact_height(CHAT_BAR_H)
            .frame(egui::Frame::none().fill(SURFACE))
            .show(ctx, |ui| {
                self.draw_chat_bar(ui);
            });

        // ── Last message bar ───────────────────────────────────
        egui::TopBottomPanel::bottom("lastmsg")
            .exact_height(LAST_MSG_H)
            .frame(egui::Frame::none().fill(SURFACE))
            .show(ctx, |ui| {
                self.draw_last_message(ui, &state);
            });

        // ── Body: 3 columns ────────────────────────────────────
        let available = ctx.available_rect();
        let left_w = (available.width() * 0.42).floor();
        let right_w = (available.width() * 0.28).floor();

        // Left column (50%) — with swipe gesture detection
        let left_resp = egui::SidePanel::left("left_col")
            .exact_width(left_w)
            .resizable(false)
            .frame(
                egui::Frame::none()
                    .fill(BG)
                    .inner_margin(egui::Margin::same(8.0))
                    .stroke(Stroke::new(0.0, Color32::TRANSPARENT)),
            )
            .show(ctx, |ui| {
                egui::ScrollArea::vertical()
                    .id_salt("left_scroll")
                    .show(ui, |ui| {
                        match self.left_panel {
                            0 => self.draw_calendar_panel(ui, &state),
                            1 => self.draw_chat_panel(ui, &state),
                            _ => {}
                        }
                    });
            });

        // Detect swipe on left panel
        let left_rect = left_resp.response.rect;
        self.detect_swipe_in_rect(ctx, left_rect, true);

        // Right column (25%) — with swipe gesture detection
        let right_resp = egui::SidePanel::right("right_col")
            .exact_width(right_w)
            .resizable(false)
            .frame(
                egui::Frame::none()
                    .fill(BG)
                    .inner_margin(egui::Margin::same(8.0))
                    .stroke(Stroke::new(0.0, Color32::TRANSPARENT)),
            )
            .show(ctx, |ui| {
                egui::ScrollArea::vertical()
                    .id_salt("right_scroll")
                    .show(ui, |ui| {
                        match self.right_panel {
                            0 => self.draw_admin_panel(ui, &state),
                            1 => self.draw_soul_panel(ui, &state),
                            2 => self.draw_email_panel(ui, &state),
                            3 => self.draw_sidegig_panel(ui, &state),
                            4 => Self::draw_help_panel(ui),
                            _ => {}
                        }
                    });
            });

        // Detect swipe on right panel
        let right_rect = right_resp.response.rect;
        self.detect_swipe_in_rect(ctx, right_rect, false);

        // Center column (remaining ~25%)
        egui::CentralPanel::default()
            .frame(
                egui::Frame::none()
                    .fill(BG)
                    .inner_margin(egui::Margin::same(8.0)),
            )
            .show(ctx, |ui| {
                // Draw column dividers
                let rect = ui.max_rect();
                ui.painter().vline(rect.left(), rect.y_range(), Stroke::new(1.0, BORDER));
                ui.painter().vline(rect.right(), rect.y_range(), Stroke::new(1.0, BORDER));

                egui::ScrollArea::vertical()
                    .id_salt("center_scroll")
                    .show(ui, |ui| {
                        self.draw_todos_panel(ui, &state);
                    });
            });

        // ── Voice overlay (on top of everything) ───────────────
        if self.voice.is_visible() {
            self.draw_voice_overlay(ctx);

            // Tap overlay area to dismiss (Response and Toast only — Listening/Processing
            // should persist until the voice pipeline finishes)
            if matches!(self.voice.state, VoiceState::Response { .. } | VoiceState::Toast { .. }) {
                let screen = ctx.screen_rect();
                let resp = egui::Area::new(egui::Id::new("voice_overlay_dismiss"))
                    .order(egui::Order::Foreground)
                    .fixed_pos(screen.min)
                    .interactable(true)
                    .show(ctx, |ui| ui.allocate_rect(screen, egui::Sense::click()));
                if resp.inner.clicked() {
                    self.voice.dismiss();
                }
            }
        }
    }
}

// ── Helper functions ───────────────────────────────────────────────

fn section_title(ui: &mut egui::Ui, title: &str) {
    ui.label(
        RichText::new(title)
            .size(FONT_TITLE)
            .color(ACCENT)
            .strong(),
    );
    ui.add_space(8.0);
}

fn draw_status_badge(ui: &mut egui::Ui, label: &str, booked: bool) {
    let (bg, prefix) = if booked {
        (Color32::from_rgb(81, 207, 102), "Y ")
    } else {
        (Color32::from_rgb(255, 107, 107), "! ")
    };

    egui::Frame::none()
        .fill(bg)
        .rounding(egui::Rounding::same(8.0))
        .inner_margin(egui::Margin::symmetric(6.0, 2.0))
        .show(ui, |ui| {
            ui.label(RichText::new(format!("{}{}", prefix, label)).size(FONT_SM).color(Color32::BLACK).strong());
        });
}

fn draw_na_badge(ui: &mut egui::Ui, label: &str) {
    egui::Frame::none()
        .fill(Color32::from_rgb(80, 80, 100))
        .rounding(egui::Rounding::same(8.0))
        .inner_margin(egui::Margin::symmetric(6.0, 2.0))
        .show(ui, |ui| {
            ui.label(RichText::new(format!("- {}", label)).size(FONT_SM).color(Color32::from_rgb(200, 200, 210)));
        });
}

fn stat_card(ui: &mut egui::Ui, width: f32, value: &str, label: &str) {
    ui.allocate_ui(Vec2::new(width, 52.0), |ui| {
        egui::Frame::none()
            .fill(SURFACE2)
            .stroke(Stroke::new(1.0, BORDER))
            .rounding(egui::Rounding::same(8.0))
            .inner_margin(egui::Margin::symmetric(8.0, 6.0))
            .show(ui, |ui| {
                ui.set_min_width(width - 18.0);
                ui.vertical_centered(|ui| {
                    ui.label(RichText::new(value).size(18.0).color(ACCENT2).strong());
                    ui.label(RichText::new(label).size(FONT_SM).color(TEXT_DIM));
                });
            });
    });
}

// ── Calendar/time helpers ──────────────────────────────────────────

fn extract_time(val: &serde_json::Value) -> String {
    if let Some(s) = val.as_str() {
        return format_time_from_str(s);
    }
    if let Some(obj) = val.as_object() {
        if let Some(dt) = obj.get("dateTime").and_then(|v| v.as_str()) {
            return format_time_from_str(dt);
        }
        if obj.get("date").is_some() {
            return "All day".to_string();
        }
    }
    String::new()
}

fn extract_date(val: &serde_json::Value) -> String {
    if let Some(s) = val.as_str() {
        return extract_date_part(s);
    }
    if let Some(obj) = val.as_object() {
        if let Some(dt) = obj.get("dateTime").and_then(|v| v.as_str()) {
            return extract_date_part(dt);
        }
        if let Some(d) = obj.get("date").and_then(|v| v.as_str()) {
            return d.to_string();
        }
    }
    String::new()
}

fn extract_date_part(s: &str) -> String {
    if s.len() >= 10 { s[..10].to_string() } else { s.to_string() }
}

fn format_time_from_str(s: &str) -> String {
    if let Some(t_pos) = s.find('T') {
        let time_part = &s[t_pos + 1..];
        if time_part.len() >= 5 {
            return time_part[..5].to_string();
        }
    }
    if s.len() == 10 {
        return "All day".to_string();
    }
    s.to_string()
}

fn extract_day(val: &serde_json::Value) -> (String, String) {
    let date_str = if let Some(s) = val.as_str() {
        s.to_string()
    } else if let Some(obj) = val.as_object() {
        if let Some(dt) = obj.get("dateTime").and_then(|v| v.as_str()) {
            dt.to_string()
        } else if let Some(d) = obj.get("date").and_then(|v| v.as_str()) {
            d.to_string()
        } else {
            return (String::new(), String::new());
        }
    } else {
        return (String::new(), String::new());
    };

    if date_str.len() >= 10 {
        let day = &date_str[8..10];
        let month = match &date_str[5..7] {
            "01" => "Jan", "02" => "Feb", "03" => "Mar", "04" => "Apr",
            "05" => "May", "06" => "Jun", "07" => "Jul", "08" => "Aug",
            "09" => "Sep", "10" => "Oct", "11" => "Nov", "12" => "Dec",
            _ => "",
        };
        (day.to_string(), month.to_string())
    } else {
        (String::new(), String::new())
    }
}

// ── Entry point ────────────────────────────────────────────────────

fn main() -> eframe::Result {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    log::info!("Clawd Dashboard starting (egui)");

    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_inner_size([1024.0, 600.0])
            .with_fullscreen(true)
            .with_decorations(false),
        ..Default::default()
    };

    eframe::run_native(
        "Clawd Dashboard",
        options,
        Box::new(|cc| Ok(Box::new(ClawdApp::new(cc)))),
    )
}
