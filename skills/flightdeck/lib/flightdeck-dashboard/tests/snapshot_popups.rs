mod common;

use flightdeck_dashboard::app::model::{ModalState, Tab};
use flightdeck_dashboard::app::motion::MotionLevel;
use flightdeck_dashboard::state::snapshot::{ActivitySource, Event, EventImportance};

#[test]
fn popup_theme_picker() {
    let mut model = common::model_for_fixture("mixed", MotionLevel::Off);
    model.modal = ModalState::ThemePicker;
    insta::assert_snapshot!("popup_theme_picker", common::render_model(&model));
}

#[test]
fn popup_session_detail() {
    let mut model = common::model_for_fixture("mixed", MotionLevel::Off);
    model.modal = ModalState::SessionDetail;
    insta::assert_snapshot!("popup_session_detail", common::render_model(&model));
}

#[test]
fn popup_decision_detail() {
    let mut model = common::model_for_fixture("decisions", MotionLevel::Off);
    model.current_tab = Tab::Decisions;
    model.modal = ModalState::DecisionDetail;
    insta::assert_snapshot!("popup_decision_detail", common::render_model(&model));
}

#[test]
fn popup_event_detail() {
    let mut model = common::model_for_tab(Tab::LiveFeed);
    model.push_event(Event::new(
        common::fixed_now(),
        ActivitySource::Prompt,
        EventImportance::Important,
        "prompt detected: merge-now with long detail text",
    ));
    model.modal = ModalState::EventDetail;
    insta::assert_snapshot!("popup_event_detail", common::render_model(&model));
}

#[test]
fn popup_filter_input() {
    let mut model = common::model_for_fixture("mixed", MotionLevel::Off);
    model.feed_filter.begin_edit();
    model.feed_filter.input = "^HT-".to_owned();
    model.ui.filter_open = true;
    model.modal = ModalState::FilterInput;
    insta::assert_snapshot!("popup_filter_input", common::render_model(&model));
}

#[test]
fn popup_help_with_legend() {
    let mut model = common::model_for_fixture("mixed", MotionLevel::Off);
    model.modal = ModalState::Help;
    model.show_help = true;
    let rendered = common::render_model(&model);
    assert!(rendered.contains("Legend"));
    assert!(rendered.contains("Kind badges"));
    insta::assert_snapshot!("popup_help_with_legend", rendered);
}
