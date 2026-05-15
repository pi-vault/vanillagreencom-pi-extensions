use std::collections::HashMap;

use chrono::{DateTime, Utc};
use thiserror::Error;

use crate::state::snapshot::TrackedSession;

pub mod aggregator;
pub mod claude;
pub mod codex;
pub mod opencode;
pub mod pi;
pub mod pricing;

pub use aggregator::CostAggregator;
pub use pricing::PricingTable;

#[derive(Debug, Clone, Default, PartialEq)]
pub struct CostMetrics {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_creation_tokens: u64,
    pub cache_read_tokens: u64,
    pub cost_usd: f64,
    pub turns: u64,
    pub last_model: Option<String>,
    pub last_updated: Option<DateTime<Utc>>,
    pub source_error: Option<String>,
}

impl CostMetrics {
    pub fn add_assign(&mut self, other: &Self) {
        self.input_tokens = self.input_tokens.saturating_add(other.input_tokens);
        self.output_tokens = self.output_tokens.saturating_add(other.output_tokens);
        self.cache_creation_tokens = self
            .cache_creation_tokens
            .saturating_add(other.cache_creation_tokens);
        self.cache_read_tokens = self
            .cache_read_tokens
            .saturating_add(other.cache_read_tokens);
        self.cost_usd += other.cost_usd;
        self.turns = self.turns.saturating_add(other.turns);
        self.last_updated = newest(self.last_updated, other.last_updated);
    }

    #[must_use]
    pub fn with_error(mut self, error: impl Into<String>) -> Self {
        self.source_error = Some(error.into());
        self
    }

    #[must_use]
    pub fn has_usage(&self) -> bool {
        self.turns > 0
            || self.input_tokens > 0
            || self.output_tokens > 0
            || self.cache_creation_tokens > 0
            || self.cache_read_tokens > 0
            || self.cost_usd > 0.0
    }
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct HarnessTotal {
    pub sessions: usize,
    pub metrics: CostMetrics,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct SessionTotals {
    pub by_entry: HashMap<String, CostMetrics>,
    pub grand: CostMetrics,
    pub by_harness: HashMap<String, HarnessTotal>,
    pub pricing_source: String,
    pub last_polled: Option<DateTime<Utc>>,
    pub unhealthy_sources: usize,
}

pub trait CostSource: Send + 'static {
    fn name(&self) -> &'static str;
    fn supports(&self, entry: &TrackedSession) -> bool;
    fn poll(&mut self, entry: &TrackedSession) -> Result<CostMetrics, CostError>;
}

#[derive(Debug, Error)]
pub enum CostError {
    #[error("{0}")]
    Unavailable(String),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("parse: {0}")]
    Parse(String),
}

fn newest(left: Option<DateTime<Utc>>, right: Option<DateTime<Utc>>) -> Option<DateTime<Utc>> {
    match (left, right) {
        (Some(left), Some(right)) => Some(left.max(right)),
        (Some(value), None) | (None, Some(value)) => Some(value),
        (None, None) => None,
    }
}

#[must_use]
pub fn format_cost(cost: f64) -> String {
    if cost <= 0.0 {
        String::from("$0.00")
    } else if cost < 0.01 {
        String::from("<$0.01")
    } else {
        format!("${cost:.2}")
    }
}

#[must_use]
pub fn format_tokens(value: u64) -> String {
    if value >= 1_000_000 {
        format!("{:.1}M", value as f64 / 1_000_000.0)
    } else if value >= 1_000 {
        format!("{:.1}K", value as f64 / 1_000.0)
    } else {
        value.to_string()
    }
}

#[must_use]
pub fn format_compact(metrics: &CostMetrics) -> String {
    if metrics.source_error.is_some() || !metrics.has_usage() {
        return String::from("—");
    }
    format!("{} · {}T", format_cost(metrics.cost_usd), metrics.turns)
}

#[must_use]
pub fn format_summary(metrics: &CostMetrics) -> String {
    format!(
        "{} · {} turns · in {} / out {}",
        format_cost(metrics.cost_usd),
        metrics.turns,
        format_tokens(metrics.input_tokens),
        format_tokens(metrics.output_tokens)
    )
}
