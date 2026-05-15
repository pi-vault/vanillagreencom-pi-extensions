use std::collections::HashMap;
use std::path::Path;

use super::{CostError, CostMetrics};

const BUNDLED_PRICING: &str = include_str!("pricing.toml");
const PRICING_ENV: &str = "FLIGHTDECK_DASHBOARD_PRICING_FILE";
const PRICE_SCALE: f64 = 1_000_000.0;

#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct ModelRates {
    pub input_per_m: f64,
    pub output_per_m: f64,
    pub cache_creation_per_m: f64,
    pub cache_read_per_m: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PricingTable {
    rates: HashMap<String, ModelRates>,
    pub source_label: String,
}

impl PricingTable {
    #[must_use]
    pub fn load() -> Self {
        if let Ok(path) = std::env::var(PRICING_ENV) {
            let trimmed = path.trim();
            if !trimmed.is_empty() {
                match std::fs::read_to_string(trimmed)
                    .map_err(CostError::Io)
                    .and_then(|text| parse_pricing(&text, trimmed.to_owned()))
                {
                    Ok(table) => return table,
                    Err(error) => {
                        eprintln!(
                            "flightdeck-dashboard: warning: pricing file '{}' invalid: {}; using bundled pricing",
                            trimmed, error
                        );
                    }
                }
            }
        }
        parse_pricing(BUNDLED_PRICING, String::from("bundled @ 2026-05-15"))
            .expect("bundled pricing table parses")
    }

    #[must_use]
    pub fn cost_for(&self, model: Option<&str>, usage: &CostMetrics) -> f64 {
        let Some(model) = model else {
            return 0.0;
        };
        let Some(rates) = self.rates_for(model) else {
            return 0.0;
        };
        ((usage.input_tokens as f64) / PRICE_SCALE) * rates.input_per_m
            + ((usage.output_tokens as f64) / PRICE_SCALE) * rates.output_per_m
            + ((usage.cache_creation_tokens as f64) / PRICE_SCALE) * rates.cache_creation_per_m
            + ((usage.cache_read_tokens as f64) / PRICE_SCALE) * rates.cache_read_per_m
    }

    #[must_use]
    pub fn rates_for(&self, model: &str) -> Option<ModelRates> {
        let key = normalize_model(model);
        self.rates.get(&key).copied().or_else(|| {
            self.rates
                .iter()
                .find_map(|(known, rates)| key.contains(known).then_some(*rates))
        })
    }
}

pub fn parse_pricing(text: &str, source_label: String) -> Result<PricingTable, CostError> {
    let mut rates = HashMap::new();
    let mut current_name: Option<String> = None;
    let mut current = ModelRates::default();
    let mut in_model = false;

    for line in text.lines() {
        let line = line.split('#').next().unwrap_or_default().trim();
        if line.is_empty() {
            continue;
        }
        if line == "[[models]]" {
            flush_model(&mut rates, &mut current_name, &mut current, in_model)?;
            in_model = true;
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            return Err(CostError::Parse(format!("bad pricing line: {line}")));
        };
        let key = key.trim();
        let value = value.trim().trim_matches('"');
        match key {
            "name" => current_name = Some(normalize_model(value)),
            "input_per_m" => current.input_per_m = parse_rate(value, key)?,
            "output_per_m" => current.output_per_m = parse_rate(value, key)?,
            "cache_creation_per_m" => current.cache_creation_per_m = parse_rate(value, key)?,
            "cache_read_per_m" => current.cache_read_per_m = parse_rate(value, key)?,
            _ => return Err(CostError::Parse(format!("unknown pricing key: {key}"))),
        }
    }
    flush_model(&mut rates, &mut current_name, &mut current, in_model)?;
    if rates.is_empty() {
        return Err(CostError::Parse(String::from("no models in pricing file")));
    }
    Ok(PricingTable {
        rates,
        source_label,
    })
}

fn flush_model(
    rates: &mut HashMap<String, ModelRates>,
    current_name: &mut Option<String>,
    current: &mut ModelRates,
    in_model: bool,
) -> Result<(), CostError> {
    if !in_model {
        return Ok(());
    }
    let Some(name) = current_name.take() else {
        return Err(CostError::Parse(String::from("model entry missing name")));
    };
    rates.insert(name, *current);
    *current = ModelRates::default();
    Ok(())
}

fn parse_rate(value: &str, key: &str) -> Result<f64, CostError> {
    value
        .parse::<f64>()
        .map_err(|error| CostError::Parse(format!("{key}: {error}")))
}

#[must_use]
pub fn normalize_model(model: &str) -> String {
    let model = model
        .trim()
        .trim_start_matches("openai/")
        .trim_start_matches("anthropic/");
    model.to_ascii_lowercase().replace('_', "-")
}

#[must_use]
pub fn path_label(path: &Path) -> String {
    path.display().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_pricing_parses() {
        let table = PricingTable::load();
        assert!(table.rates_for("claude-opus-4-20250514").is_some());
        assert!(table.rates_for("openai/gpt-5.5").is_some());
    }
}
