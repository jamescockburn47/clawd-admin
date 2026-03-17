pub enum VoiceState {
    Hidden,
    Listening { start: f64 },
    Processing { transcript: String, start: f64 },
    Response { transcript: String, response: String, dismiss_at: f64 },
    Toast { message: String, dismiss_at: f64 },
}

impl Default for VoiceState {
    fn default() -> Self {
        Self::Hidden
    }
}

pub struct VoiceOverlay {
    pub state: VoiceState,
}

impl VoiceOverlay {
    pub fn new() -> Self {
        Self {
            state: VoiceState::Hidden,
        }
    }

    pub fn set_listening(&mut self, time: f64) {
        self.state = VoiceState::Listening { start: time };
    }

    pub fn set_processing(&mut self, transcript: String, time: f64) {
        self.state = VoiceState::Processing {
            transcript,
            start: time,
        };
    }

    pub fn set_response(&mut self, transcript: String, response: String, time: f64) {
        self.state = VoiceState::Response {
            transcript,
            response,
            dismiss_at: time + 8.0,
        };
    }

    pub fn set_toast(&mut self, message: String, time: f64) {
        self.state = VoiceState::Toast {
            message,
            dismiss_at: time + 3.0,
        };
    }

    pub fn dismiss(&mut self) {
        self.state = VoiceState::Hidden;
    }

    pub fn is_visible(&self) -> bool {
        !matches!(self.state, VoiceState::Hidden)
    }

    /// True if we're showing response or waiting for one — "listening" should not override.
    pub fn is_showing_response_or_processing(&self) -> bool {
        matches!(
            self.state,
            VoiceState::Response { .. } | VoiceState::Processing { .. }
        )
    }

    /// Auto-dismiss expired overlays. Also timeout Listening after 45s if stuck.
    pub fn tick(&mut self, time: f64) {
        match &self.state {
            VoiceState::Response { dismiss_at, .. } if time > *dismiss_at => {
                self.state = VoiceState::Hidden;
            }
            VoiceState::Toast { dismiss_at, .. } if time > *dismiss_at => {
                self.state = VoiceState::Hidden;
            }
            VoiceState::Listening { start } if time - start > 45.0 => {
                self.state = VoiceState::Hidden;
            }
            VoiceState::Processing { start, .. } if time - start > 60.0 => {
                self.state = VoiceState::Hidden;
            }
            _ => {}
        }
    }
}
