use serde::Deserialize;

#[derive(Deserialize, Clone, Default)]
pub struct HenryWeekend {
    pub summary: String,
    #[serde(rename = "startDate")]
    pub start_date: String,
    #[serde(rename = "endDate")]
    pub end_date: String,
    pub pattern: Option<String>,
    #[serde(rename = "needsTravel")]
    pub needs_travel: Option<bool>,
    #[serde(rename = "travelBooked")]
    pub travel_booked: Option<bool>,
    #[serde(rename = "travelPrice")]
    pub travel_price: Option<String>,
    #[serde(rename = "needsAccommodation")]
    pub needs_accommodation: Option<bool>,
    #[serde(rename = "accommodationBooked")]
    pub accommodation_booked: Option<bool>,
    #[serde(rename = "accommodationName")]
    pub accommodation_name: Option<String>,
    #[serde(rename = "accommodationPrice")]
    pub accommodation_price: Option<String>,
    pub description: Option<String>,
}

#[derive(Deserialize, Clone, Default)]
pub struct Todo {
    pub id: String,
    pub text: String,
    #[serde(default)]
    pub done: bool,
    #[serde(default)]
    pub priority: String,
    #[serde(rename = "createdAt")]
    pub created_at: Option<String>,
    #[serde(rename = "completedAt")]
    pub completed_at: Option<String>,
    #[serde(rename = "dueDate")]
    pub due_date: Option<String>,
    pub reminder: Option<String>,
}

#[derive(Deserialize, Clone, Default)]
pub struct CalendarEvent {
    pub summary: String,
    #[serde(default)]
    pub start: serde_json::Value,
    #[serde(default)]
    pub end: serde_json::Value,
    pub location: Option<String>,
    pub description: Option<String>,
}

#[derive(Deserialize, Clone, Default)]
pub struct Email {
    pub id: String,
    pub from: String,
    pub subject: String,
    pub date: Option<String>,
    pub snippet: Option<String>,
    #[serde(default)]
    pub unread: bool,
    #[serde(rename = "needsReply")]
    #[serde(default)]
    pub needs_reply: bool,
}

#[derive(Deserialize, Clone, Default)]
pub struct EmailData {
    #[serde(rename = "unreadCount")]
    #[serde(default)]
    pub unread_count: u32,
    #[serde(default)]
    pub recent: Vec<Email>,
}

#[derive(Deserialize, Clone, Default)]
pub struct SideGigMeeting {
    pub summary: String,
    #[serde(default)]
    pub start: serde_json::Value,
    #[serde(default)]
    pub end: serde_json::Value,
    pub location: Option<String>,
    pub tags: Option<Vec<String>>,
}

#[derive(Deserialize, Clone, Default)]
pub struct WeatherData {
    pub location: String,
    pub temp: Option<f64>,
    pub feels_like: Option<f64>,
    pub description: Option<String>,
    pub condition: Option<String>,
    pub humidity: Option<u32>,
    pub wind_mph: Option<f64>,
    /// Legacy field for backward compat
    pub current: Option<serde_json::Value>,
}

#[derive(Deserialize, Clone, Default)]
pub struct SoulData {
    pub soul: Option<SoulSections>,
    pub pending: Option<serde_json::Value>,
    pub history: Option<Vec<serde_json::Value>>,
}

#[derive(Deserialize, Clone, Default)]
pub struct SoulSections {
    pub personality: Option<String>,
    pub preferences: Option<String>,
    pub context: Option<String>,
    pub custom: Option<String>,
}

#[derive(Deserialize, Clone, Default)]
pub struct WidgetsResponse {
    #[serde(rename = "henryWeekends")]
    pub henry_weekends: Option<Vec<HenryWeekend>>,
    #[serde(rename = "sideGig")]
    pub side_gig: Option<Vec<SideGigMeeting>>,
    pub calendar: Option<Vec<CalendarEvent>>,
    pub email: Option<EmailData>,
    pub weather: Option<Vec<WeatherData>>,
}

#[derive(Deserialize, Clone, Default)]
pub struct TodosResponse {
    pub todos: Vec<Todo>,
}

#[derive(Deserialize, Clone, Default)]
pub struct UsagePeriod {
    pub calls: Option<u32>,
    pub cost: Option<f64>,
}

#[derive(Deserialize, Clone, Default)]
pub struct UsageResponse {
    pub today: Option<UsagePeriod>,
    pub total: Option<UsagePeriod>,
}

#[derive(Deserialize, Clone, Default)]
pub struct StatusResponse {
    #[serde(default)]
    pub connected: bool,
    pub name: Option<String>,
    pub uptime: Option<f64>,
    #[serde(rename = "memoryMB")]
    pub memory_mb: Option<f64>,
}
