//! The engine's whole presence on the player's machine: one icon by the clock.
//!
//! Everything is set from Tonecraft, in the browser — the interface, the
//! buffer, the headphone level. The icon only says whether a page is
//! connected, opens Tonecraft, and quits. No window, no settings of its own:
//! the player should feel they are using a browser tab and nothing else.
//!
//! The UI event loop owns the main thread (AppKit and GTK insist); the
//! WebSocket control loop runs on its own thread, and neither ever touches
//! the audio thread except through the atomics and rings in `audio.rs`.

use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tao::event::{Event, StartCause};
use tao::event_loop::{ControlFlow, EventLoopBuilder, EventLoopProxy};
use tray_icon::menu::{CheckMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tray_icon::{Icon, MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};

use crate::{autostart, browser, log, server};

enum UiEvent {
    Tray(TrayIconEvent),
    Menu(MenuEvent),
    Connected(bool),
    Exit,
}

fn tooltip(connected: bool) -> String {
    if connected {
        "Tonecraft Engine — connected to Tonecraft".into()
    } else {
        "Tonecraft Engine — waiting for Tonecraft".into()
    }
}

/// The icon, drawn rather than shipped: a ring with a centre point, the
/// Tonecraft celadon over a thin dark outline so it holds on light and dark
/// taskbars alike. macOS gets it as a monochrome template, as menu bar icons
/// are expected to be.
fn icon() -> Option<Icon> {
    const N: u32 = 32;
    let template = cfg!(target_os = "macos");
    let celadon = [0x8F, 0xB9, 0xA8];
    let edge = [0x1A, 0x1D, 0x1C];
    let mut rgba = Vec::with_capacity((N * N * 4) as usize);
    let c = (N as f32 - 1.0) / 2.0;
    // Coverage of a band between two radii, anti-aliased over one pixel.
    let band = |d: f32, inner: f32, outer: f32| ((outer - d + 0.5).clamp(0.0, 1.0)) * ((d - inner + 0.5).clamp(0.0, 1.0));
    for y in 0..N {
        for x in 0..N {
            let d = ((x as f32 - c).powi(2) + (y as f32 - c).powi(2)).sqrt();
            let mark = band(d, 8.0, 13.0).max(band(d, -1.0, 3.5));
            let outline = band(d, 7.0, 14.5).max(band(d, -1.0, 4.5));
            let (rgb, a) = if template {
                ([0, 0, 0], mark)
            } else {
                let mut rgb = [0u8; 3];
                for i in 0..3 {
                    rgb[i] = (celadon[i] as f32 * mark + edge[i] as f32 * (1.0 - mark)) as u8;
                }
                (rgb, outline.max(mark) * if mark > 0.0 { 1.0 } else { 0.55 })
            };
            rgba.extend_from_slice(&[rgb[0], rgb[1], rgb[2], (a * 255.0) as u8]);
        }
    }
    Icon::from_rgba(rgba, N, N).ok()
}

/// Sends to the event loop from callbacks that must be `Sync`.
fn sender(proxy: &EventLoopProxy<UiEvent>) -> impl Fn(UiEvent) + Send + Sync + 'static {
    let proxy = Mutex::new(proxy.clone());
    move |event| {
        if let Ok(p) = proxy.lock() {
            let _ = p.send_event(event);
        }
    }
}

pub fn run(listener: TcpListener, origins: Vec<String>) -> ! {
    #[allow(unused_mut)]
    let mut event_loop = EventLoopBuilder::<UiEvent>::with_user_event().build();
    #[cfg(target_os = "macos")]
    {
        // A menu bar icon, not an application: no Dock tile, no app menu.
        use tao::platform::macos::{ActivationPolicy, EventLoopExtMacOS};
        event_loop.set_activation_policy(ActivationPolicy::Accessory);
    }
    let proxy = event_loop.create_proxy();
    let send = Arc::new(sender(&proxy));
    {
        let send = send.clone();
        TrayIconEvent::set_event_handler(Some(move |e| send(UiEvent::Tray(e))));
    }
    {
        let send = send.clone();
        MenuEvent::set_event_handler(Some(move |e| send(UiEvent::Menu(e))));
    }

    let quit = Arc::new(AtomicBool::new(false));
    {
        let send = send.clone();
        let quit = quit.clone();
        std::thread::Builder::new()
            .name("control".into())
            .spawn(move || {
                let status = send.clone();
                let hooks = server::Hooks {
                    on_connected: Box::new(move |c| status(UiEvent::Connected(c))),
                    quit,
                };
                if let Err(server::RunError::Other(e)) = server::serve(listener, origins, Some(hooks)) {
                    log::write(&format!("fatal: {e}"));
                }
                send(UiEvent::Exit);
            })
            .expect("the control thread could not start");
    }

    let open = MenuItem::new("Open Tonecraft", true, None);
    let start = CheckMenuItem::new("Start with this computer", true, autostart::enabled(), None);
    let leave = MenuItem::new("Quit Tonecraft Engine", true, None);
    let menu = Menu::new();
    for item in [
        &open as &dyn tray_icon::menu::IsMenuItem,
        &start,
        &PredefinedMenuItem::separator(),
        &leave,
    ] {
        if let Err(e) = menu.append(item) {
            log::write(&format!("menu: {e}"));
        }
    }
    let (open_id, start_id, leave_id) = (open.id().clone(), start.id().clone(), leave.id().clone());

    let mut menu = Some(menu);
    let mut tray: Option<TrayIcon> = None;
    event_loop.run(move |event, _, flow| {
        *flow = ControlFlow::Wait;
        match event {
            // Made once the loop runs: GTK and AppKit want the icon created on
            // a live UI thread. It starts minimised — there is nothing else.
            Event::NewEvents(StartCause::Init) => {
                let Some(menu) = menu.take() else { return };
                let mut builder = TrayIconBuilder::new()
                    .with_menu(Box::new(menu))
                    .with_tooltip(tooltip(false))
                    .with_icon_as_template(cfg!(target_os = "macos"))
                    // On Windows a left click opens Tonecraft and the menu is
                    // on the right; elsewhere the menu is what a click shows.
                    .with_menu_on_left_click(!cfg!(windows));
                if let Some(icon) = icon() {
                    builder = builder.with_icon(icon);
                }
                match builder.build() {
                    Ok(t) => tray = Some(t),
                    Err(e) => log::write(&format!("no tray icon: {e}")),
                }
            }
            Event::UserEvent(UiEvent::Tray(TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            })) if cfg!(windows) => browser::open(browser::PAGE),
            Event::UserEvent(UiEvent::Menu(e)) => {
                if e.id == open_id {
                    browser::open(browser::PAGE);
                } else if e.id == start_id {
                    if let Err(err) = autostart::set(!autostart::enabled()) {
                        log::write(&format!("autostart: {err}"));
                    }
                    // What the system says, not what the click assumed.
                    start.set_checked(autostart::enabled());
                } else if e.id == leave_id {
                    // The control thread stops the streams, then asks us to exit.
                    quit.store(true, Ordering::Relaxed);
                }
            }
            Event::UserEvent(UiEvent::Connected(c)) => {
                if let Some(t) = &tray {
                    let _ = t.set_tooltip(Some(tooltip(c)));
                }
            }
            Event::UserEvent(UiEvent::Exit) => {
                tray = None;
                *flow = ControlFlow::Exit;
            }
            _ => {}
        }
    })
}
