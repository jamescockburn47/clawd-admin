use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use rodio::{Decoder, OutputStream, OutputStreamHandle, Sink, Source};
use std::io::Cursor;
use std::time::Duration;

pub struct AudioEngine {
    _stream: OutputStream,
    handle: OutputStreamHandle,
}

impl AudioEngine {
    pub fn new() -> Option<Self> {
        match OutputStream::try_default() {
            Ok((stream, handle)) => Some(Self {
                _stream: stream,
                handle,
            }),
            Err(e) => {
                log::warn!("No audio output: {}", e);
                None
            }
        }
    }

    /// Ascending two-note chime: D5 (587Hz) then A5 (880Hz).
    pub fn play_ack_tone(&self) {
        if let Ok(sink) = Sink::try_new(&self.handle) {
            let d5 = rodio::source::SineWave::new(587.33)
                .take_duration(Duration::from_millis(200))
                .amplify(0.3)
                .fade_in(Duration::from_millis(10));
            let a5 = rodio::source::SineWave::new(880.0)
                .take_duration(Duration::from_millis(250))
                .amplify(0.3)
                .fade_in(Duration::from_millis(10));
            sink.append(d5);
            sink.append(a5);
            sink.detach();
        }
    }

    /// Single A4 (440Hz) completion tone.
    pub fn play_done_tone(&self) {
        if let Ok(sink) = Sink::try_new(&self.handle) {
            let tone = rodio::source::SineWave::new(440.0)
                .take_duration(Duration::from_millis(300))
                .amplify(0.2)
                .fade_in(Duration::from_millis(10));
            sink.append(tone);
            sink.detach();
        }
    }

    /// Decode base64-encoded WAV data and play it.
    pub fn play_wav_base64(&self, b64: &str) {
        let bytes = match STANDARD.decode(b64) {
            Ok(b) => b,
            Err(e) => {
                log::warn!("Failed to decode base64 audio: {}", e);
                return;
            }
        };
        if let Ok(sink) = Sink::try_new(&self.handle) {
            let cursor = Cursor::new(bytes);
            match Decoder::new(cursor) {
                Ok(source) => {
                    sink.append(source);
                    sink.detach();
                }
                Err(e) => {
                    log::warn!("Failed to decode WAV audio: {}", e);
                }
            }
        }
    }
}
