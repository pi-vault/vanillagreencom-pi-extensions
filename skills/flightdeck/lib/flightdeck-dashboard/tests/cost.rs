mod common;

use flightdeck_dashboard::cost::claude::parse_claude_jsonl;
use flightdeck_dashboard::cost::pricing::{parse_pricing, PricingTable};
use flightdeck_dashboard::cost::{CostAggregator, CostError, CostMetrics, CostSource};
use flightdeck_dashboard::fixtures;
use flightdeck_dashboard::state::snapshot::{DashboardSnapshot, TrackedSession};

#[test]
fn parse_claude_jsonl_accumulates_models_and_cache_tokens() {
    let pricing = PricingTable::load();
    let transcript = r#"
{"type":"user","message":{"role":"user"}}
{"type":"assistant","timestamp":"2026-05-15T10:00:00Z","message":{"model":"claude-opus-4-20250514","usage":{"input_tokens":1000000,"output_tokens":10000,"cache_creation_input_tokens":200000,"cache_read_input_tokens":500000}}}
{"type":"assistant","timestamp":"2026-05-15T10:01:00Z","message":{"model":"claude-sonnet-4-20250514","usage":{"input_tokens":500000,"output_tokens":20000,"cache_creation_input_tokens":0,"cache_read_input_tokens":100000}}}
{"type":"assistant","timestamp":"2026-05-15T10:02:00Z","message":{"model":"unknown-free","usage":{"input_tokens":999,"output_tokens":888,"cache_creation_input_tokens":777,"cache_read_input_tokens":666}}}
{"type":"assistant","timestamp":"2026-05-15T10:03:00Z","message":{"model":"claude-3-5-haiku-20241022","usage":{"input_tokens":100000,"output_tokens":100000,"cache_creation_input_tokens":100000,"cache_read_input_tokens":100000}}}
{"type":"assistant","timestamp":"2026-05-15T10:04:00Z","message":{"model":"claude-sonnet-4-20250514","usage":{"input_tokens":1,"output_tokens":2,"cache_creation_input_tokens":3,"cache_read_input_tokens":4}}}
"#;
    let metrics = parse_claude_jsonl(transcript, &pricing).expect("transcript parses");

    assert_eq!(metrics.turns, 5);
    assert_eq!(metrics.input_tokens, 1_601_000);
    assert_eq!(metrics.output_tokens, 130_890);
    assert_eq!(metrics.cache_creation_tokens, 300_780);
    assert_eq!(metrics.cache_read_tokens, 700_670);
    assert_eq!(
        metrics.last_model.as_deref(),
        Some("claude-sonnet-4-20250514")
    );
    assert!((metrics.cost_usd - 22.668_045_45).abs() < 0.000_001);
}

#[test]
fn pricing_matches_known_model_rates() {
    let table = parse_pricing(
        r#"
[[models]]
name = "test-model"
input_per_m = 2.00
output_per_m = 10.00
cache_creation_per_m = 4.00
cache_read_per_m = 0.50
"#,
        String::from("test"),
    )
    .expect("pricing parses");
    let metrics = CostMetrics {
        input_tokens: 1_000_000,
        output_tokens: 250_000,
        cache_creation_tokens: 500_000,
        cache_read_tokens: 2_000_000,
        ..CostMetrics::default()
    };

    assert_eq!(table.cost_for(Some("test-model"), &metrics), 7.5);
    assert_eq!(table.cost_for(Some("missing-model"), &metrics), 0.0);
}

#[test]
fn aggregator_sums_grand_and_harness_totals() {
    let now = common::fixed_now();
    let snapshot = fixtures::load_demo_snapshot("mixed", now).expect("fixture loads");
    let mut aggregator = CostAggregator::with_sources(
        vec![Box::new(FakeCostSource { fail: false })],
        String::from("test pricing"),
    );

    let totals = aggregator.poll_snapshot(&snapshot, now);

    assert_eq!(totals.grand.input_tokens, 300);
    assert_eq!(totals.grand.output_tokens, 60);
    assert_eq!(totals.grand.turns, 6);
    assert_eq!(totals.by_harness["pi"].sessions, 1);
    assert_eq!(totals.by_harness["codex"].metrics.input_tokens, 100);
    assert_eq!(totals.by_harness["opencode"].metrics.input_tokens, 100);
}

#[test]
fn missing_source_keeps_ui_dashable_metrics() {
    let now = common::fixed_now();
    let mut fixture = fixtures::load_demo_snapshot("mixed", now).expect("fixture loads");
    let session = fixture.sessions.remove(0);
    let mut snapshot = DashboardSnapshot::empty_for_session("s", "state.json".into(), now);
    snapshot.sessions = vec![session];
    let mut aggregator = CostAggregator::with_sources(
        vec![Box::new(FakeCostSource { fail: true })],
        String::from("test pricing"),
    );

    let totals = aggregator.poll_snapshot(&snapshot, now);
    let metrics = totals
        .by_entry
        .values()
        .next()
        .expect("entry metrics recorded");

    assert_eq!(totals.grand.turns, 0);
    assert!(metrics
        .source_error
        .as_deref()
        .is_some_and(|err| err == "offline"));
    assert_eq!(totals.unhealthy_sources, 1);
}

struct FakeCostSource {
    fail: bool,
}

impl CostSource for FakeCostSource {
    fn name(&self) -> &'static str {
        "fake"
    }

    fn supports(&self, _entry: &TrackedSession) -> bool {
        true
    }

    fn poll(&mut self, _entry: &TrackedSession) -> Result<CostMetrics, CostError> {
        if self.fail {
            return Err(CostError::Unavailable(String::from("offline")));
        }
        Ok(CostMetrics {
            input_tokens: 100,
            output_tokens: 20,
            turns: 2,
            cost_usd: 0.01,
            ..CostMetrics::default()
        })
    }
}
