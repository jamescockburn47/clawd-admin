use std::sync::{Arc, RwLock};
use crate::models::*;

#[derive(Default, Clone)]
pub struct AppState {
    pub henry_weekends: Vec<HenryWeekend>,
    pub todos: Vec<Todo>,
    pub calendar: Vec<CalendarEvent>,
    pub email: EmailData,
    pub side_gig: Vec<SideGigMeeting>,
    pub soul: SoulData,
    pub weather: Vec<WeatherData>,
    pub usage: UsageResponse,
    pub status: StatusResponse,
    pub connected: bool,
    pub last_message_sender: String,
    pub last_message_text: String,
    pub voice_event: Option<String>,
    pub voice_text: Option<String>,
    pub voice_response: Option<String>,
    pub voice_audio: Option<String>,
    pub voice_panel: Option<String>,
    pub voice_message: Option<String>,
}

pub type SharedState = Arc<RwLock<AppState>>;

pub fn new_shared_state() -> SharedState {
    Arc::new(RwLock::new(AppState::default()))
}
