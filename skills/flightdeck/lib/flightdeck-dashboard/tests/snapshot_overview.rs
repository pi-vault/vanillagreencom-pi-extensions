use chrono::{DateTime, TimeZone, Utc};
use flightdeck_dashboard::app::model::{Model, MotionLevel, Tab};
use flightdeck_dashboard::app::view;
use flightdeck_dashboard::fixtures;
use ratatui::backend::TestBackend;
use ratatui::Terminal;

fn fixed_now() -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 5, 15, 10, 10, 0)
        .single()
        .expect("fixed timestamp is valid")
}

fn render_fixture(name: &str) -> String {
    let snapshot = fixtures::load_demo_snapshot(name, fixed_now()).expect("fixture loads");
    let model = Model::new(snapshot, name, MotionLevel::Off, fixed_now);
    render_model(&model)
}

fn render_model(model: &Model) -> String {
    let backend = TestBackend::new(200, 60);
    let mut terminal = Terminal::new(backend).expect("test backend creates terminal");
    terminal
        .draw(|frame| view::render(frame, model))
        .expect("render succeeds");
    format!("{}", terminal.backend())
}

#[test]
fn empty_fixture_overview() {
    insta::assert_snapshot!("overview_empty", render_fixture("empty"));
}

#[test]
fn one_adhoc_fixture_overview() {
    insta::assert_snapshot!("overview_one_adhoc", render_fixture("one-adhoc"));
}

#[test]
fn one_issue_fixture_overview() {
    insta::assert_snapshot!("overview_one_issue", render_fixture("one-issue"));
}

#[test]
fn mixed_fixture_overview() {
    insta::assert_snapshot!("overview_mixed", render_fixture("mixed"));
}

#[test]
fn terminated_fixture_overview() {
    insta::assert_snapshot!("overview_terminated", render_fixture("terminated"));
}

#[test]
fn paused_fixture_overview() {
    insta::assert_snapshot!("overview_paused", render_fixture("paused"));
}

#[test]
fn motion_effects_overview_start_and_settled() {
    let snapshot = fixtures::load_demo_snapshot("mixed", fixed_now()).expect("fixture loads");
    let mut model = Model::new(snapshot, "mixed", MotionLevel::Full, fixed_now);
    model.current_tab = Tab::Overview;
    insta::assert_snapshot!("overview_motion_t0", render_model(&model));
    model.animate_frame = 8;
    model.prune_effects();
    insta::assert_snapshot!("overview_motion_settled", render_model(&model));
}
