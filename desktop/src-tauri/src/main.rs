// Release builds are a bundled .app, not a console program.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    wisp_desktop::run()
}
