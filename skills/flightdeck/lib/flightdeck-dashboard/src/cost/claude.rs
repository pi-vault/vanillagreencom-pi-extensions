use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use serde::Deserialize;

use crate::state::snapshot::TrackedSession;

use super::pricing::{path_label, PricingTable};
use super::{CostError, CostMetrics, CostSource};

#[derive(Debug, Clone)]
pub struct ClaudeSource {
    pricing: PricingTable,
    offsets: HashMap<String, u64>,
    totals: HashMap<String, CostMetrics>,
    partials: HashMap<String, String>,
}

impl ClaudeSource {
    #[must_use]
    pub fn new(pricing: PricingTable) -> Self {
        Self {
            pricing,
            offsets: HashMap::new(),
            totals: HashMap::new(),
            partials: HashMap::new(),
        }
    }

    #[must_use]
    pub fn pricing(&self) -> &PricingTable {
        &self.pricing
    }
}

impl CostSource for ClaudeSource {
    fn name(&self) -> &'static str {
        "claude"
    }

    fn supports(&self, entry: &TrackedSession) -> bool {
        entry.adapter.cc_transcript.is_some()
            || entry
                .harness
                .as_deref()
                .is_some_and(|harness| harness == "claude")
    }

    fn poll(&mut self, entry: &TrackedSession) -> Result<CostMetrics, CostError> {
        let Some(path) = entry.adapter.cc_transcript.as_deref() else {
            return Err(CostError::Unavailable(String::from(
                "claude transcript path missing",
            )));
        };
        let path = PathBuf::from(path);
        let mut file = File::open(&path).map_err(|error| {
            CostError::Unavailable(format!("{}: {error}", path_label(path.as_path())))
        })?;
        let len = file.metadata()?.len();
        let offset = self.offsets.entry(entry.id.clone()).or_default();
        if len < *offset {
            *offset = 0;
            self.totals.remove(&entry.id);
            self.partials.remove(&entry.id);
        }
        file.seek(SeekFrom::Start(*offset))?;
        let mut chunk = String::new();
        file.read_to_string(&mut chunk)?;
        *offset = len;

        let total = self.totals.entry(entry.id.clone()).or_default();
        if chunk.is_empty() {
            return Ok(total.clone());
        }
        let partial = self.partials.entry(entry.id.clone()).or_default();
        parse_claude_chunk(&chunk, &self.pricing, total, partial)?;
        Ok(total.clone())
    }
}

#[derive(Debug, Deserialize)]
struct ClaudeEvent {
    #[serde(rename = "type")]
    event_type: Option<String>,
    message: Option<ClaudeMessage>,
    timestamp: Option<DateTime<Utc>>,
    ts: Option<DateTime<Utc>>,
}

#[derive(Debug, Deserialize)]
struct ClaudeMessage {
    model: Option<String>,
    usage: Option<ClaudeUsage>,
}

#[derive(Debug, Default, Deserialize)]
struct ClaudeUsage {
    #[serde(default)]
    input_tokens: u64,
    #[serde(default)]
    output_tokens: u64,
    #[serde(default)]
    cache_creation_input_tokens: u64,
    #[serde(default)]
    cache_read_input_tokens: u64,
}

pub fn parse_claude_jsonl(text: &str, pricing: &PricingTable) -> Result<CostMetrics, CostError> {
    let mut total = CostMetrics::default();
    let mut partial = String::new();
    parse_claude_chunk(text, pricing, &mut total, &mut partial)?;
    if !partial.trim().is_empty() {
        parse_claude_line(&partial, pricing, &mut total)?;
    }
    Ok(total)
}

fn parse_claude_chunk(
    chunk: &str,
    pricing: &PricingTable,
    total: &mut CostMetrics,
    partial: &mut String,
) -> Result<(), CostError> {
    partial.push_str(chunk);
    if partial.is_empty() {
        return Ok(());
    }
    let complete_len = partial
        .rfind('\n')
        .map(|index| index.saturating_add(1))
        .unwrap_or(0);
    if complete_len == 0 {
        return Ok(());
    }
    let complete = partial[..complete_len].to_owned();
    let rest = partial[complete_len..].to_owned();
    partial.clear();
    partial.push_str(&rest);
    for line in complete.lines().filter(|line| !line.trim().is_empty()) {
        parse_claude_line(line, pricing, total)?;
    }
    Ok(())
}

fn parse_claude_line(
    line: &str,
    pricing: &PricingTable,
    total: &mut CostMetrics,
) -> Result<(), CostError> {
    let event: ClaudeEvent = serde_json::from_str(line)?;
    if event.event_type.as_deref() != Some("assistant") {
        return Ok(());
    }
    let Some(message) = event.message else {
        return Ok(());
    };
    let Some(usage) = message.usage else {
        return Ok(());
    };
    let mut turn = CostMetrics {
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        cache_creation_tokens: usage.cache_creation_input_tokens,
        cache_read_tokens: usage.cache_read_input_tokens,
        turns: 1,
        last_model: message.model.clone(),
        last_updated: event.timestamp.or(event.ts),
        ..CostMetrics::default()
    };
    turn.cost_usd = pricing.cost_for(message.model.as_deref(), &turn);
    total.add_assign(&turn);
    if let Some(model) = message.model {
        total.last_model = Some(model);
    }
    Ok(())
}

#[must_use]
pub fn transcript_supports_file(path: &Path) -> bool {
    path.is_file()
}
