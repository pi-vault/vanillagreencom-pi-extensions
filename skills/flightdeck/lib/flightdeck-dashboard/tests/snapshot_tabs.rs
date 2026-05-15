use chrono::{DateTime, TimeZone, Utc};
use flightdeck_dashboard::app::model::{ModalState, Model, MotionLevel, Tab};
use flightdeck_dashboard::app::view;
use flightdeck_dashboard::fixtures;
use ratatui::backend::TestBackend;
use ratatui::Terminal;

fn fixed_now() -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 5, 15, 10, 10, 0)
        .single()
        .expect("fixed timestamp is valid")
}

fn model_for_tab(tab: Tab) -> Model {
    let snapshot = fixtures::load_demo_snapshot("mixed", fixed_now()).expect("fixture loads");
    let mut model = Model::new(snapshot, "mixed", MotionLevel::Off, fixed_now);
    model.current_tab = tab;
    model
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
fn mixed_overview_tab() {
    insta::assert_snapshot!("tab_overview", render_model(&model_for_tab(Tab::Overview)));
}

#[test]
fn mixed_live_feed_tab() {
    insta::assert_snapshot!("tab_live_feed", render_model(&model_for_tab(Tab::LiveFeed)));
}

#[test]
fn mixed_conversations_tab() {
    insta::assert_snapshot!(
        "tab_conversations",
        render_model(&model_for_tab(Tab::Conversations))
    );
}

#[test]
fn mixed_merges_tab() {
    insta::assert_snapshot!("tab_merges", render_model(&model_for_tab(Tab::Merges)));
}

#[test]
fn mixed_decisions_tab() {
    insta::assert_snapshot!(
        "tab_decisions",
        render_model(&model_for_tab(Tab::Decisions))
    );
}

#[test]
fn mixed_daemon_tab() {
    insta::assert_snapshot!("tab_daemon", render_model(&model_for_tab(Tab::Daemon)));
}

#[test]
fn help_overlay() {
    let mut model = model_for_tab(Tab::Overview);
    model.show_help = true;
    model.modal = ModalState::Help;
    insta::assert_snapshot!("help_overlay", render_model(&model));
}
