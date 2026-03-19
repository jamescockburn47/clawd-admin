# Clawd Dashboard Native — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace Chromium kiosk with a from-scratch Rust GPU app for the Pi 5 touchscreen dashboard.

**Architecture:** wgpu renders to Vulkan on Pi 5's V3D GPU. winit provides Wayland window + touch events. cosmic-text handles Unicode text shaping with GPU glyph atlas. tokio runs async HTTP/SSE in background, sends updates to render thread via channels. Widget trait system — each widget is a struct that produces draw commands (quads + text), handles touch regions, and subscribes to data slices.

**Tech Stack:** Rust, wgpu 24+, winit 0.30+, cosmic-text, tokio, reqwest, rodio, serde/serde_json

**Build Strategy:** Cross-compile on EVO X2 (fast AMD CPU) targeting `aarch64-unknown-linux-gnu`, SCP binary to Pi. Avoids slow on-Pi compilation. Install `aarch64-linux-gnu-gcc` on EVO as linker.

**Pi Display:** 1024x600, Wayland (labwc), Vulkan 1.3 (V3D), touch input

---

## Phase 1: Foundation — Window, GPU, Rectangles, Text

### Task 1: Project scaffold + cross-compile toolchain

**Files:**
- Create: `clawd-dashboard/Cargo.toml`
- Create: `clawd-dashboard/src/main.rs`
- Create: `clawd-dashboard/.cargo/config.toml`

**Step 1: Install cross-compile toolchain on EVO**

```bash
ssh james@192.168.1.230
sudo apt install -y gcc-aarch64-linux-gnu
rustup target add aarch64-unknown-linux-gnu
```

**Step 2: Install Rust on Pi (for running, and fallback local builds)**

```bash
ssh pi@192.168.1.211
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
source ~/.cargo/env
sudo apt install -y pkg-config libasound2-dev libwayland-dev libxkbcommon-dev
```

**Step 3: Create project**

On local Windows machine:
```
clawd-dashboard/
  Cargo.toml
  .cargo/config.toml
  src/
    main.rs
```

`Cargo.toml`:
```toml
[package]
name = "clawd-dashboard"
version = "0.1.0"
edition = "2021"

[dependencies]
wgpu = "24"
winit = "0.30"
pollster = "0.4"
bytemuck = { version = "1", features = ["derive"] }
log = "0.4"
env_logger = "0.11"
tokio = { version = "1", features = ["rt-multi-thread", "macros", "sync", "time"] }

[profile.release]
opt-level = 3
lto = "thin"
strip = true
```

`.cargo/config.toml`:
```toml
[target.aarch64-unknown-linux-gnu]
linker = "aarch64-linux-gnu-gcc"
```

**Step 4: Write minimal main.rs — open window, clear to dark background**

```rust
use winit::application::ApplicationHandler;
use winit::event::WindowEvent;
use winit::event_loop::{ActiveEventLoop, EventLoop};
use winit::window::{Window, WindowId};

struct App {
    window: Option<Window>,
}

impl ApplicationHandler for App {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if self.window.is_none() {
            let attrs = Window::default_attributes()
                .with_title("Clawd Dashboard")
                .with_inner_size(winit::dpi::PhysicalSize::new(1024, 600));
            self.window = Some(event_loop.create_window(attrs).unwrap());
        }
    }

    fn window_event(&mut self, event_loop: &ActiveEventLoop, _id: WindowId, event: WindowEvent) {
        match event {
            WindowEvent::CloseRequested => event_loop.exit(),
            WindowEvent::RedrawRequested => {
                // TODO: wgpu render
            }
            _ => {}
        }
    }
}

fn main() {
    env_logger::init();
    let event_loop = EventLoop::new().unwrap();
    let mut app = App { window: None };
    event_loop.run_app(&mut app).unwrap();
}
```

**Step 5: Cross-compile and deploy**

```bash
# On EVO:
cd ~/clawd-dashboard
cargo build --release --target aarch64-unknown-linux-gnu
scp target/aarch64-unknown-linux-gnu/release/clawd-dashboard pi@192.168.1.211:~/clawd-dashboard

# On Pi:
export WAYLAND_DISPLAY=wayland-0 XDG_RUNTIME_DIR=/run/user/1000
~/clawd-dashboard
```

Expected: Window appears on Pi touchscreen with default background.

**Step 6: Commit**
```bash
git add clawd-dashboard/
git commit -m "feat: scaffold Rust dashboard with winit window"
```

---

### Task 2: wgpu initialization — GPU surface + clear color

**Files:**
- Modify: `clawd-dashboard/src/main.rs`
- Create: `clawd-dashboard/src/gpu.rs`

**Step 1: Create gpu.rs with wgpu setup**

```rust
// gpu.rs — GPU context: instance, adapter, device, surface, pipeline
use wgpu::*;
use winit::window::Window;

pub struct Gpu {
    pub surface: Surface<'static>,
    pub device: Device,
    pub queue: Queue,
    pub config: SurfaceConfiguration,
}

impl Gpu {
    pub async fn new(window: &'static Window) -> Self {
        let instance = Instance::new(&InstanceDescriptor {
            backends: Backends::VULKAN,
            ..Default::default()
        });

        let surface = instance.create_surface(window).unwrap();

        let adapter = instance
            .request_adapter(&RequestAdapterOptions {
                power_preference: PowerPreference::LowPower,
                compatible_surface: Some(&surface),
                force_fallback_adapter: false,
            })
            .await
            .expect("No suitable GPU adapter");

        let (device, queue) = adapter
            .request_device(&DeviceDescriptor::default(), None)
            .await
            .unwrap();

        let size = window.inner_size();
        let caps = surface.get_capabilities(&adapter);
        let format = caps.formats[0];

        let config = SurfaceConfiguration {
            usage: TextureUsages::RENDER_ATTACHMENT,
            format,
            width: size.width,
            height: size.height,
            present_mode: PresentMode::Fifo,
            alpha_mode: caps.alpha_modes[0],
            view_formats: vec![],
            desired_maximum_frame_latency: 2,
        };
        surface.configure(&device, &config);

        Self { surface, device, queue, config }
    }

    pub fn resize(&mut self, width: u32, height: u32) {
        if width > 0 && height > 0 {
            self.config.width = width;
            self.config.height = height;
            self.surface.configure(&self.device, &self.config);
        }
    }

    pub fn render_frame(&self) {
        let output = match self.surface.get_current_texture() {
            Ok(t) => t,
            Err(_) => return,
        };
        let view = output.texture.create_view(&TextureViewDescriptor::default());
        let mut encoder = self.device.create_command_encoder(&CommandEncoderDescriptor::default());

        encoder.begin_render_pass(&RenderPassDescriptor {
            label: None,
            color_attachments: &[Some(RenderPassColorAttachment {
                view: &view,
                resolve_target: None,
                ops: Operations {
                    load: LoadOp::Clear(Color {
                        r: 0.039, g: 0.039, b: 0.059, a: 1.0, // #0a0a0f
                    }),
                    store: StoreOp::Store,
                },
            })],
            depth_stencil_attachment: None,
            ..Default::default()
        });

        self.queue.submit(std::iter::once(encoder.finish()));
        output.present();
    }
}
```

**Step 2: Integrate into main.rs**

Update `App` to hold `Gpu`, init on resumed, render on redraw, request continuous redraws.

**Step 3: Cross-compile, deploy, verify dark background renders**

Expected: Pi shows solid dark (#0a0a0f) fullscreen window.

**Step 4: Commit**
```bash
git commit -m "feat: wgpu GPU init with Vulkan, clear to dark bg"
```

---

### Task 3: Quad renderer — colored rectangles with rounded corners

**Files:**
- Create: `clawd-dashboard/src/renderer.rs`
- Create: `clawd-dashboard/src/shaders/quad.wgsl`

**Step 1: Write WGSL shader for rounded-rect quads**

```wgsl
// quad.wgsl
struct Globals {
    screen_size: vec2<f32>,
};
@group(0) @binding(0) var<uniform> globals: Globals;

struct QuadInstance {
    @location(0) pos: vec2<f32>,      // top-left px
    @location(1) size: vec2<f32>,     // width, height px
    @location(2) color: vec4<f32>,    // RGBA
    @location(3) radius: f32,         // corner radius px
    @location(4) border_width: f32,
    @location(5) border_color: vec4<f32>,
};

struct VsOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) uv: vec2<f32>,
    @location(1) color: vec4<f32>,
    @location(2) size_px: vec2<f32>,
    @location(3) radius: f32,
    @location(4) border_width: f32,
    @location(5) border_color: vec4<f32>,
};

// 6 vertices for a quad (2 triangles)
var<private> VERTS: array<vec2<f32>, 6> = array(
    vec2(0.0, 0.0), vec2(1.0, 0.0), vec2(0.0, 1.0),
    vec2(1.0, 0.0), vec2(1.0, 1.0), vec2(0.0, 1.0),
);

@vertex
fn vs_main(@builtin(vertex_index) vi: u32, inst: QuadInstance) -> VsOut {
    let v = VERTS[vi];
    let pixel = inst.pos + v * inst.size;
    let ndc = vec2(
        pixel.x / globals.screen_size.x * 2.0 - 1.0,
        1.0 - pixel.y / globals.screen_size.y * 2.0,
    );
    var out: VsOut;
    out.pos = vec4(ndc, 0.0, 1.0);
    out.uv = v;
    out.color = inst.color;
    out.size_px = inst.size;
    out.radius = inst.radius;
    out.border_width = inst.border_width;
    out.border_color = inst.border_color;
    return out;
}

fn rounded_rect_sdf(p: vec2<f32>, half_size: vec2<f32>, r: f32) -> f32 {
    let q = abs(p) - half_size + vec2(r);
    return min(max(q.x, q.y), 0.0) + length(max(q, vec2(0.0))) - r;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
    let center = in.size_px * 0.5;
    let p = in.uv * in.size_px - center;
    let d = rounded_rect_sdf(p, center, in.radius);

    // Anti-aliased edge
    let aa = 1.0;
    let alpha = 1.0 - smoothstep(-aa, aa, d);

    var col = in.color;

    // Border
    if in.border_width > 0.0 {
        let inner_d = rounded_rect_sdf(p, center - vec2(in.border_width), max(in.radius - in.border_width, 0.0));
        let border_alpha = 1.0 - smoothstep(-aa, aa, inner_d);
        col = mix(in.border_color, in.color, border_alpha);
    }

    return vec4(col.rgb, col.a * alpha);
}
```

**Step 2: Write renderer.rs with quad batching**

Renderer collects `QuadInstance` structs, uploads to instance buffer, draws in one call.

```rust
// Key types
#[repr(C)]
#[derive(Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
pub struct QuadInstance {
    pub pos: [f32; 2],
    pub size: [f32; 2],
    pub color: [f32; 4],
    pub radius: f32,
    pub border_width: f32,
    pub border_color: [f32; 4],
}

pub struct QuadRenderer {
    pipeline: wgpu::RenderPipeline,
    globals_buffer: wgpu::Buffer,
    globals_bind_group: wgpu::BindGroup,
    instance_buffer: wgpu::Buffer,
    max_quads: usize,
}

impl QuadRenderer {
    pub fn draw(&self, encoder: &mut CommandEncoder, view: &TextureView, quads: &[QuadInstance]) {
        // Upload instances, draw 6 verts * N instances
    }
}
```

**Step 3: Test — render 3 column backgrounds + header bar**

Draw: dark header (1024x52), 3 column rects with --surface color, border dividers.

**Step 4: Deploy, verify colored rectangles on Pi**

Expected: 3 dark columns with subtle borders, header bar at top.

**Step 5: Commit**
```bash
git commit -m "feat: GPU quad renderer with rounded corners + SDF AA"
```

---

### Task 4: Text rendering — cosmic-text + GPU glyph atlas

**Files:**
- Create: `clawd-dashboard/src/text.rs`
- Create: `clawd-dashboard/src/shaders/text.wgsl`
- Add to Cargo.toml: `cosmic-text = "0.12"`

**Step 1: Write text.wgsl glyph shader**

Textured quad shader — samples from glyph atlas texture, applies color tint.

```wgsl
// text.wgsl
struct Globals { screen_size: vec2<f32> };
@group(0) @binding(0) var<uniform> globals: Globals;
@group(1) @binding(0) var atlas_tex: texture_2d<f32>;
@group(1) @binding(1) var atlas_sampler: sampler;

struct GlyphInstance {
    @location(0) pos: vec2<f32>,
    @location(1) size: vec2<f32>,
    @location(2) uv_pos: vec2<f32>,
    @location(3) uv_size: vec2<f32>,
    @location(4) color: vec4<f32>,
};

// ... vertex + fragment shaders that sample atlas and apply color
```

**Step 2: Write text.rs — cosmic-text shaping + atlas management**

```rust
use cosmic_text::{FontSystem, SwashCache, Buffer, Metrics, Attrs};

pub struct TextRenderer {
    font_system: FontSystem,
    swash_cache: SwashCache,
    atlas: GlyphAtlas,       // GPU texture + rect packer
    pipeline: wgpu::RenderPipeline,
}

impl TextRenderer {
    pub fn new(device: &Device, queue: &Queue, format: TextureFormat) -> Self { ... }

    /// Shape text, rasterize new glyphs to atlas, return glyph instances
    pub fn prepare(&mut self, device: &Device, queue: &Queue, sections: &[TextSection]) -> Vec<GlyphInstance> { ... }

    pub fn draw(&self, encoder: &mut CommandEncoder, view: &TextureView, glyphs: &[GlyphInstance]) { ... }
}

pub struct TextSection {
    pub text: String,
    pub x: f32,
    pub y: f32,
    pub size: f32,
    pub color: [f32; 4],
    pub max_width: Option<f32>,
    pub weight: cosmic_text::Weight,
}
```

**Step 3: Bundle fonts — Noto Sans + Noto Color Emoji**

Download to `clawd-dashboard/assets/fonts/`:
- `NotoSans-Regular.ttf`
- `NotoSans-Bold.ttf`
- `NotoSans-SemiBold.ttf`
- `NotoColorEmoji-Regular.ttf` (optional — Pi Chromium couldn't do this, we can)

Load in `FontSystem::new()` with `db.load_font_file(...)`.

**Step 4: Test — render header text "Clawd Dashboard" + clock**

Expected: Crisp anti-aliased text on dark background.

**Step 5: Commit**
```bash
git commit -m "feat: GPU text renderer with cosmic-text shaping + glyph atlas"
```

---

## Phase 2: Layout, Widgets, Scrolling

### Task 5: Layout engine — flexbox-lite

**Files:**
- Create: `clawd-dashboard/src/layout.rs`

**Step 1: Define layout primitives**

```rust
pub struct Rect {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

pub enum Direction { Row, Column }
pub enum Sizing { Fixed(f32), Flex(f32), Shrink }

pub struct LayoutNode {
    pub direction: Direction,
    pub sizing: (Sizing, Sizing), // width, height
    pub padding: f32,
    pub gap: f32,
    pub children: Vec<LayoutNode>,
    pub computed: Option<Rect>,
}
```

**Step 2: Implement layout solver**

Simple single-pass flexbox: compute fixed sizes, distribute remaining space by flex weights, recurse into children.

**Step 3: Define the 3-column dashboard layout**

```
Root (Row, 1024x600)
  Header (Row, Fixed 52px height, full width)
  Body (Row, Flex 1)
    LeftColumn (Column, Flex 2)
      PanelTrack (Row, overflow hidden, swipeable)
        HenryPanel
        CalendarPanel
    Divider (Fixed 1px)
    CenterColumn (Column, Flex 2)
      TodoPanel
    Divider (Fixed 1px)
    RightColumn (Column, Flex 1)
      PanelTrack (Row, overflow hidden, swipeable)
        SideGigPanel
        EmailPanel
        SoulPanel
        AdminPanel
  Footer (Column, Fixed ~156px)
    LastMessage (Fixed 56px)
    ChatBar (Fixed 100px)
```

**Step 4: Test — draw layout rects colored by depth**

Each layout node draws a slightly different shade. Verify structure matches 1024x600.

**Step 5: Commit**
```bash
git commit -m "feat: flexbox-lite layout engine with 3-column structure"
```

---

### Task 6: Widget trait + draw command system

**Files:**
- Create: `clawd-dashboard/src/widget.rs`
- Create: `clawd-dashboard/src/theme.rs`
- Create: `clawd-dashboard/src/draw.rs`

**Step 1: Define theme constants**

```rust
// theme.rs
pub mod color {
    pub const BG: [f32; 4]       = [0.039, 0.039, 0.059, 1.0]; // #0a0a0f
    pub const SURFACE: [f32; 4]  = [0.078, 0.078, 0.122, 1.0]; // #14141f
    pub const SURFACE2: [f32; 4] = [0.110, 0.110, 0.180, 1.0]; // #1c1c2e
    pub const BORDER: [f32; 4]   = [0.165, 0.165, 0.251, 1.0]; // #2a2a40
    pub const TEXT: [f32; 4]     = [0.910, 0.910, 0.941, 1.0]; // #e8e8f0
    pub const TEXT_DIM: [f32; 4] = [0.533, 0.533, 0.627, 1.0]; // #8888a0
    pub const ACCENT: [f32; 4]   = [0.424, 0.361, 0.906, 1.0]; // #6c5ce7
    pub const ACCENT2: [f32; 4]  = [0.000, 0.808, 0.788, 1.0]; // #00cec9
    pub const RED: [f32; 4]      = [1.000, 0.420, 0.420, 1.0]; // #ff6b6b
    pub const GREEN: [f32; 4]    = [0.318, 0.812, 0.400, 1.0]; // #51cf66
    pub const ORANGE: [f32; 4]   = [1.000, 0.663, 0.302, 1.0]; // #ffa94d
    pub const BLUE: [f32; 4]     = [0.302, 0.671, 0.969, 1.0]; // #4dabf7
}

pub const FONT_SIZE_SMALL: f32 = 11.0;
pub const FONT_SIZE_BODY: f32 = 13.0;
pub const FONT_SIZE_TITLE: f32 = 15.0;
pub const FONT_SIZE_HEADER: f32 = 18.0;
pub const RADIUS_SMALL: f32 = 6.0;
pub const RADIUS_MEDIUM: f32 = 12.0;
pub const RADIUS_LARGE: f32 = 24.0;
```

**Step 2: Define draw command buffer**

```rust
// draw.rs
pub enum DrawCmd {
    Quad { rect: Rect, color: [f32; 4], radius: f32, border: Option<(f32, [f32; 4])> },
    Text { text: String, x: f32, y: f32, size: f32, color: [f32; 4], max_width: Option<f32>, weight: FontWeight },
    Clip { rect: Rect }, // scissor rect for scrollable regions
    UnClip,
}

pub enum FontWeight { Regular, SemiBold, Bold }

pub struct DrawList {
    pub commands: Vec<DrawCmd>,
}
```

**Step 3: Define Widget trait**

```rust
// widget.rs
pub trait Widget {
    fn draw(&self, rect: Rect, draw: &mut DrawList, time: f64);
    fn handle_touch(&mut self, rect: Rect, pos: (f32, f32), phase: TouchPhase) -> bool;
    fn update(&mut self, data: &AppState);
}
```

**Step 4: Commit**
```bash
git commit -m "feat: widget trait, draw commands, theme constants"
```

---

### Task 7: Scrollable container + swipe panel track

**Files:**
- Create: `clawd-dashboard/src/scroll.rs`
- Create: `clawd-dashboard/src/swipe_track.rs`

**Step 1: Scrollable — vertical scroll with momentum**

```rust
pub struct Scrollable {
    offset: f32,
    velocity: f32,
    content_height: f32,
    touch_start_y: Option<f32>,
    last_y: f32,
}

impl Scrollable {
    pub fn handle_touch(&mut self, phase: TouchPhase, y: f32) { ... }
    pub fn tick(&mut self, dt: f64) { /* momentum decay */ }
    pub fn transform_rect(&self, rect: Rect) -> Rect { /* offset by scroll */ }
}
```

**Step 2: SwipeTrack — horizontal panel switching with spring animation**

```rust
pub struct SwipeTrack {
    panel_count: usize,
    current: usize,
    offset_px: f32,        // animated offset
    target_px: f32,
    touch_start_x: Option<f32>,
    dragging: bool,
}

impl SwipeTrack {
    pub fn handle_touch(&mut self, phase: TouchPhase, x: f32, y: f32) -> bool { ... }
    pub fn tick(&mut self, dt: f64, panel_width: f32) { ... }
    pub fn current_offset(&self) -> f32 { ... }
    pub fn go_to(&mut self, index: usize, panel_width: f32) { ... }
}
```

**Step 3: Test — 2 colored panels in left column, swipe between them**

**Step 4: Commit**
```bash
git commit -m "feat: scrollable container + swipe panel track"
```

---

### Task 8: Header widget

**Files:**
- Create: `clawd-dashboard/src/widgets/header.rs`
- Create: `clawd-dashboard/src/widgets/mod.rs`

**Step 1: Header draws**

- Status dot (green circle when connected)
- "Clawd" title
- Weather summary (temperature + description)
- API cost display (today/total toggle on touch)
- Clock (HH:MM, updates every second)

```rust
pub struct HeaderWidget {
    connected: bool,
    weather: Option<WeatherSummary>,
    cost_today: f64,
    cost_total: f64,
    show_total: bool,
}

impl Widget for HeaderWidget { ... }
```

**Step 2: Test — render header with mock data**

**Step 3: Commit**
```bash
git commit -m "feat: header widget with status, weather, cost, clock"
```

---

### Task 9: Todo widget

**Files:**
- Create: `clawd-dashboard/src/widgets/todos.rs`

Renders active todos sorted by priority + due, completed todos (last 5). Touch checkbox to complete. Overdue highlighting. Reminder badges.

**Commit after working.**

---

### Task 10: Henry weekends widget

**Files:**
- Create: `clawd-dashboard/src/widgets/henry.rs`

Cards with date range, pattern badge, travel/accommodation status (booked/not-booked with color), forecast. Touch to expand. Touch "Plan" to trigger chat.

**Commit after working.**

---

### Task 11: Calendar widget

**Files:**
- Create: `clawd-dashboard/src/widgets/calendar.rs`

14-day event list. Date headers. Time + summary + location. Touch to expand (shows description). All-day events handle exclusive end dates (subtract 1 day).

**Commit after working.**

---

### Task 12: Email widget

**Files:**
- Create: `clawd-dashboard/src/widgets/email.rs`

Unread count badge. Recent emails with sender, subject, snippet. Unread/needs-reply indicators. Touch to expand (full metadata).

**Commit after working.**

---

### Task 13: Side gig widget

**Files:**
- Create: `clawd-dashboard/src/widgets/sidegig.rs`

Upcoming AI/LQ meetings. Duration, location, tag badges. Touch to expand.

**Commit after working.**

---

### Task 14: Soul widget

**Files:**
- Create: `clawd-dashboard/src/widgets/soul.rs`

Personality/preferences/context/custom sections as labeled text blocks. Pending changes with approve/reject buttons. Recent history timeline.

**Commit after working.**

---

### Task 15: Admin widget

**Files:**
- Create: `clawd-dashboard/src/widgets/admin.rs`

System status grid (Pi, EVO, Ollama, Whisper with online/offline badges). Memory stats (2x2 grid). Quick note input. Memory browser with search, pagination, edit/delete.

**Commit after working.**

---

## Phase 3: Data Layer — HTTP, SSE, State

### Task 16: App state + data models

**Files:**
- Create: `clawd-dashboard/src/state.rs`
- Create: `clawd-dashboard/src/models.rs`

**Step 1: Define data models matching API JSON**

```rust
// models.rs
#[derive(Deserialize, Clone)]
pub struct HenryWeekend {
    pub summary: String,
    pub start_date: String,
    pub end_date: String,
    pub pattern: String,
    pub needs_travel: bool,
    pub travel_booked: bool,
    pub travel_price: Option<String>,
    pub needs_accommodation: bool,
    pub accommodation_booked: bool,
    pub accommodation_name: Option<String>,
    pub accommodation_price: Option<String>,
    pub description: String,
}

#[derive(Deserialize, Clone)]
pub struct Todo {
    pub id: String,
    pub text: String,
    pub done: bool,
    pub priority: String,
    pub created_at: String,
    pub completed_at: Option<String>,
    pub due_date: Option<String>,
    pub reminder: Option<String>,
}

#[derive(Deserialize, Clone)]
pub struct CalendarEvent { ... }

#[derive(Deserialize, Clone)]
pub struct Email { ... }

#[derive(Deserialize, Clone)]
pub struct SideGigMeeting { ... }

#[derive(Deserialize, Clone)]
pub struct Soul { ... }

// ... etc for all API types
```

**Step 2: Central AppState**

```rust
// state.rs
use std::sync::Arc;
use tokio::sync::watch;

pub struct AppState {
    pub henry_weekends: Vec<HenryWeekend>,
    pub todos: Vec<Todo>,
    pub calendar: Vec<CalendarEvent>,
    pub emails: EmailData,
    pub sidegig: Vec<SideGigMeeting>,
    pub soul: SoulData,
    pub weather: Vec<WeatherData>,
    pub status: SystemStatus,
    pub memory: MemoryData,
    pub usage: UsageData,
    pub connected: bool,
    pub last_message: Option<(String, String)>,
    pub voice: VoiceState,
}

// watch::Sender<Arc<AppState>> in async task
// watch::Receiver<Arc<AppState>> in render loop
```

**Step 3: Commit**
```bash
git commit -m "feat: data models + AppState with watch channel"
```

---

### Task 17: HTTP client — initial data fetch

**Files:**
- Create: `clawd-dashboard/src/api.rs`

**Step 1: reqwest client with auth token**

```rust
pub struct ApiClient {
    client: reqwest::Client,
    base_url: String,
    token: String,
}

impl ApiClient {
    pub async fn fetch_widgets(&self) -> Result<WidgetsResponse> { ... }
    pub async fn fetch_todos(&self) -> Result<TodosResponse> { ... }
    pub async fn fetch_soul(&self) -> Result<SoulResponse> { ... }
    pub async fn fetch_usage(&self) -> Result<UsageResponse> { ... }
    pub async fn fetch_status(&self) -> Result<StatusResponse> { ... }
    pub async fn fetch_memory_status(&self) -> Result<MemoryStatusResponse> { ... }
    pub async fn complete_todo(&self, id: &str) -> Result<()> { ... }
    pub async fn send_chat(&self, message: &str) -> Result<String> { ... }
    pub async fn save_note(&self, text: &str) -> Result<()> { ... }
    pub async fn search_memory(&self, query: &str) -> Result<Vec<MemoryResult>> { ... }
}
```

**Step 2: On startup, fetch all data, populate AppState**

**Step 3: Commit**
```bash
git commit -m "feat: HTTP API client with all endpoint methods"
```

---

### Task 18: SSE client — real-time updates

**Files:**
- Create: `clawd-dashboard/src/sse.rs`

**Step 1: SSE listener using reqwest streaming**

```rust
pub async fn listen_sse(
    base_url: &str,
    token: &str,
    tx: tokio::sync::mpsc::UnboundedSender<SseEvent>,
) {
    loop {
        match connect_sse(base_url, token, &tx).await {
            Ok(()) => log::info!("SSE stream ended, reconnecting..."),
            Err(e) => log::error!("SSE error: {e}, reconnecting in 5s..."),
        }
        tokio::time::sleep(Duration::from_secs(5)).await;
    }
}

// Parse "event: xxx\ndata: {...}\n\n" format manually from byte stream
```

**Step 2: Map SSE events to AppState mutations**

```rust
pub enum SseEvent {
    Connected,
    Widgets(WidgetsResponse),
    Todos(TodosResponse),
    Soul(SoulResponse),
    Message { sender: String, text: String },
    Voice(VoiceEvent),
}
```

**Step 3: Wire into main loop — async task updates AppState via watch channel, render loop reads latest**

**Step 4: Commit**
```bash
git commit -m "feat: SSE client with auto-reconnect + state updates"
```

---

## Phase 4: Interactivity

### Task 19: Touch input routing

**Files:**
- Create: `clawd-dashboard/src/input.rs`
- Modify: `clawd-dashboard/src/main.rs`

**Step 1: Map winit touch/mouse events to unified touch model**

```rust
pub enum TouchPhase { Start, Move, End, Cancel }

pub struct TouchEvent {
    pub id: u64,
    pub x: f32,
    pub y: f32,
    pub phase: TouchPhase,
}
```

**Step 2: Hit-test through widget tree — top-down, first responder wins**

**Step 3: Distinguish tap vs swipe (threshold 10px movement)**

**Step 4: Commit**
```bash
git commit -m "feat: touch input routing with hit testing"
```

---

### Task 20: On-screen keyboard

**Files:**
- Create: `clawd-dashboard/src/widgets/keyboard.rs`

**Step 1: 4-row keyboard layout matching current dashboard**

Layouts: lower, upper, symbols. Special keys: SHIFT, 123/ABC, SPACE, BKSP, SEND, HIDE.

**Step 2: Slide-up animation when chat input focused**

**Step 3: Touch handlers for key press — visual feedback (flash color), emit character to focused input**

**Step 4: Commit**
```bash
git commit -m "feat: on-screen keyboard with 3 layouts"
```

---

### Task 21: Chat bar + last message

**Files:**
- Create: `clawd-dashboard/src/widgets/chatbar.rs`

**Step 1: Text input field with cursor**

Track cursor position, handle keyboard input, text selection later if needed.

**Step 2: Send button — POST /api/chat**

**Step 3: Mic button — trigger push-to-talk (POST /api/voice-status)**

**Step 4: Last message bar — shows "Clawd: <text>" from SSE message events**

**Step 5: Commit**
```bash
git commit -m "feat: chat bar with text input, send, mic button"
```

---

## Phase 5: Voice & Audio

### Task 22: Audio engine — tones + WAV playback

**Files:**
- Create: `clawd-dashboard/src/audio.rs`
- Add to Cargo.toml: `rodio = "0.19"`

**Step 1: Ack tone — synthesize ascending two-note chime (D5 -> A5)**

```rust
pub struct AudioEngine {
    _stream: rodio::OutputStream,
    sink: rodio::Sink,
}

impl AudioEngine {
    pub fn play_ack_tone(&self) {
        // Generate D5 (587Hz) 0.25s then A5 (880Hz) 0.25s
        // Sine wave with exponential decay envelope
    }

    pub fn play_done_tone(&self) {
        // A4 (440Hz) 0.4s with decay
    }

    pub fn play_wav_base64(&self, b64: &str) {
        // Decode base64, parse WAV, play through sink
    }
}
```

**Step 2: Test tones on Pi — verify ALSA/PipeWire output works**

**Step 3: Commit**
```bash
git commit -m "feat: audio engine with ack/done tones + WAV playback"
```

---

### Task 23: Voice overlay

**Files:**
- Create: `clawd-dashboard/src/widgets/voice_overlay.rs`

**Step 1: Voice state machine**

```rust
pub enum VoiceOverlayState {
    Hidden,
    Listening { start_time: f64 },
    Processing { transcript: String },
    Response { transcript: String, response: String, dismiss_at: f64 },
    Toast { message: String, dismiss_at: f64 },
    Info { data: String, dismiss_at: f64 },
}
```

**Step 2: Render states**

- Listening: pulsing concentric rings (animated radius + opacity)
- Processing: transcript text + bouncing dots
- Response: transcript + response in scrollable box
- Toast: pill at bottom with message

**Step 3: Wire to SSE voice events**

- `activated` → play ack tone, enter Listening
- `command` → enter Processing with transcript
- `response` → enter Response, highlight panels
- `speak` → play WAV audio
- `navigate` → swipe to panel, flash glow
- `toast` → show pill
- `no_speech` / `error` → show briefly, dismiss

**Step 4: Panel glow animation**

When voice response references panels, pulse glow (box-shadow equivalent via slightly larger quad behind panel with accent color + animated opacity).

**Step 5: Commit**
```bash
git commit -m "feat: voice overlay with state machine + animations"
```

---

## Phase 6: Integration + Polish

### Task 24: Animation system

**Files:**
- Create: `clawd-dashboard/src/anim.rs`

**Step 1: Tween/spring primitives**

```rust
pub struct Tween {
    from: f32,
    to: f32,
    duration: f64,
    elapsed: f64,
    easing: Easing,
}

pub enum Easing { Linear, EaseOut, EaseInOut, Spring { damping: f32, stiffness: f32 } }
```

**Step 2: Apply to swipe transitions, overlay fade, panel glow, keyboard slide**

**Step 3: Commit**
```bash
git commit -m "feat: animation system with tween + spring easing"
```

---

### Task 25: Configuration + deployment

**Files:**
- Create: `clawd-dashboard/src/config.rs`
- Create: `clawd-dashboard/clawd-dashboard.service`

**Step 1: Config from env vars**

```rust
pub struct Config {
    pub clawdbot_url: String,     // default http://localhost:3000
    pub dashboard_token: String,
    pub fullscreen: bool,         // default true
    pub width: u32,               // default 1024
    pub height: u32,              // default 600
}
```

**Step 2: systemd service**

```ini
[Unit]
Description=Clawd Dashboard (Native)
After=clawdbot.service
Wants=clawdbot.service

[Service]
Type=simple
User=pi
Environment=WAYLAND_DISPLAY=wayland-0
Environment=XDG_RUNTIME_DIR=/run/user/1000
Environment=DASHBOARD_TOKEN=VhPJmjOLM0A_t2idQrtfa3cHpSr_hBh0fgNxMr2TwUM
ExecStart=/home/pi/clawd-dashboard
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

**Step 3: Replace Chromium autostart**

Update `~/.config/labwc/autostart` to launch native binary instead of Chromium.

**Step 4: Commit**
```bash
git commit -m "feat: config, systemd service, deployment"
```

---

### Task 26: Desktop mode + final integration testing

**Step 1: Desktop mode button — POST /api/desktop-mode, then exit app**

**Step 2: End-to-end test on Pi**

- Launch binary, verify all 7 panels render with live data
- Swipe left/right column panels
- Touch todo checkbox — verify completion
- Type in chat + send — verify response appears
- Trigger voice command — verify ack tone + overlay
- Verify SSE updates arrive in real-time
- Verify TTS WAV playback works
- Check memory usage (target: <50MB RSS)

**Step 3: Remove Chromium kiosk config, enable dashboard service**

```bash
sudo systemctl enable clawd-dashboard
sudo systemctl start clawd-dashboard
```

**Step 4: Final commit**
```bash
git commit -m "feat: clawd-dashboard v1.0 — native Pi dashboard"
```

---

## File Tree (Final)

```
clawd-dashboard/
  Cargo.toml
  .cargo/config.toml
  clawd-dashboard.service
  assets/
    fonts/
      NotoSans-Regular.ttf
      NotoSans-Bold.ttf
      NotoSans-SemiBold.ttf
      NotoColorEmoji-Regular.ttf
  src/
    main.rs           # winit event loop, orchestration
    gpu.rs            # wgpu init, surface management
    renderer.rs       # quad batch renderer
    text.rs           # cosmic-text + glyph atlas
    layout.rs         # flexbox-lite solver
    widget.rs         # Widget trait
    theme.rs          # colors, sizes, radii
    draw.rs           # DrawCmd buffer
    scroll.rs         # scrollable container
    swipe_track.rs    # horizontal panel switcher
    input.rs          # touch routing
    state.rs          # AppState + watch channel
    models.rs         # API data types (serde)
    api.rs            # reqwest HTTP client
    sse.rs            # SSE listener + parser
    audio.rs          # rodio tones + WAV
    anim.rs           # tween/spring animations
    config.rs         # env var config
    shaders/
      quad.wgsl       # rounded rect shader
      text.wgsl       # glyph atlas shader
    widgets/
      mod.rs
      header.rs
      todos.rs
      henry.rs
      calendar.rs
      email.rs
      sidegig.rs
      soul.rs
      admin.rs
      keyboard.rs
      chatbar.rs
      voice_overlay.rs
```

## Dependency Summary

| Crate | Purpose | Size Impact |
|-------|---------|-------------|
| wgpu | GPU rendering (Vulkan) | ~2MB |
| winit | Window + touch events | ~200KB |
| cosmic-text | Text shaping + font loading | ~500KB |
| tokio | Async runtime | ~400KB |
| reqwest | HTTP client | ~500KB |
| rodio | Audio playback | ~200KB |
| serde + serde_json | JSON parsing | ~200KB |
| bytemuck | Safe casting for GPU buffers | tiny |
| pollster | Block on async (init only) | tiny |
| log + env_logger | Logging | tiny |
| base64 | Decode TTS audio | tiny |

**Estimated binary size (release, stripped):** ~5-8MB
**Estimated RSS:** 20-40MB (vs 200-400MB for Chromium)
**Startup time:** <1s (vs 10s+ for Chromium)
