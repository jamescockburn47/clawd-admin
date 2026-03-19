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
    /// Queue of voice events — each entry holds (event, text, response, audio, panel, message)
    pub voice_queue: Vec<(String, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>)>,
}

pub type SharedState = Arc<RwLock<AppState>>;

pub fn new_shared_state() -> SharedState {
    Arc::new(RwLock::new(AppState::default()))
}
