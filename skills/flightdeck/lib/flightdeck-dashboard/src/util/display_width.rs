use std::borrow::Cow;

use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

/// Terminal display width in cells. CJK ideographs and most emoji occupy
/// two cells, ASCII one, zero-width joiners zero.
#[must_use]
pub fn display_width(value: &str) -> usize {
    UnicodeWidthStr::width(value)
}

/// Truncate `value` so its display width fits within `max` cells. When
/// truncation occurs the trailing visible cell becomes `…`. Wide chars are
/// never split mid-grapheme: a 2-cell character is either included whole or
/// dropped before the ellipsis.
#[must_use]
pub fn truncate_to_width(value: &str, max: usize) -> Cow<'_, str> {
    if max == 0 {
        return Cow::Borrowed("");
    }
    if display_width(value) <= max {
        return Cow::Borrowed(value);
    }
    if max == 1 {
        return Cow::Owned(String::from("…"));
    }
    let budget = max - 1;
    let mut out = String::new();
    let mut used = 0usize;
    for ch in value.chars() {
        let w = UnicodeWidthChar::width(ch).unwrap_or(0);
        if used + w > budget {
            break;
        }
        out.push(ch);
        used += w;
    }
    out.push('…');
    Cow::Owned(out)
}

/// Pad `value` on the right with ASCII spaces until its display width hits
/// `target` cells. If `value` is already that wide or wider, returns it
/// unchanged.
#[must_use]
pub fn pad_end_to_width(value: &str, target: usize) -> Cow<'_, str> {
    let current = display_width(value);
    if current >= target {
        return Cow::Borrowed(value);
    }
    let mut out = String::from(value);
    out.extend(std::iter::repeat(' ').take(target - current));
    Cow::Owned(out)
}

/// Truncate to `max` cells, then append `…` to signal more content. The
/// returned string is up to `max + 1` cells wide. Use this when the caller
/// treats the cap as an advisory soft limit (the column can stretch by one
/// to show the ellipsis); use [`truncate_to_width`] when the cap is a hard
/// budget that must include the ellipsis.
#[must_use]
pub fn truncate_overflow_to_width(value: &str, max: usize) -> Cow<'_, str> {
    if display_width(value) <= max {
        return Cow::Borrowed(value);
    }
    let mut out = String::new();
    let mut used = 0usize;
    for ch in value.chars() {
        let w = UnicodeWidthChar::width(ch).unwrap_or(0);
        if used + w > max {
            break;
        }
        out.push(ch);
        used += w;
    }
    out.push('…');
    Cow::Owned(out)
}

/// Like [`truncate_to_width`] but keeps the trailing run that fits, with a
/// leading `…` indicating truncation from the start.
#[must_use]
pub fn truncate_start_to_width(value: &str, max: usize) -> Cow<'_, str> {
    if max == 0 {
        return Cow::Borrowed("");
    }
    if display_width(value) <= max {
        return Cow::Borrowed(value);
    }
    if max == 1 {
        return Cow::Owned(String::from("…"));
    }
    let budget = max - 1;
    let mut tail: Vec<char> = Vec::new();
    let mut used = 0usize;
    for ch in value.chars().rev() {
        let w = UnicodeWidthChar::width(ch).unwrap_or(0);
        if used + w > budget {
            break;
        }
        tail.push(ch);
        used += w;
    }
    let mut out = String::from("…");
    out.extend(tail.iter().rev());
    Cow::Owned(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_width_counts_cells_not_chars() {
        assert_eq!(display_width("abc"), 3);
        // Rocket emoji is two cells in most terminals.
        assert_eq!(display_width("🚀"), 2);
        // CJK ideograph is two cells.
        assert_eq!(display_width("测"), 2);
        assert_eq!(display_width("🚀 ship"), 7);
    }

    #[test]
    fn truncate_to_width_respects_two_cell_chars() {
        assert_eq!(truncate_to_width("abcdef", 10), "abcdef");
        assert_eq!(truncate_to_width("abcdef", 4), "abc…");
        // 🚀 (2) + " " (1) + ship it (7) = 10 cells.
        // With max=6 the budget is 5; "🚀" fits (2), " " fits (3), "s" (4), "h" (5), no room for "i" before ellipsis.
        assert_eq!(truncate_to_width("🚀 ship it", 6), "🚀 sh…");
        // Wide char gets dropped whole instead of split when one cell remains.
        // Budget = 2 (max=3 minus ellipsis). "🚀" (2 cells) fits exactly.
        assert_eq!(truncate_to_width("🚀ship", 3), "🚀…");
        // Budget = 1 (max=2 minus ellipsis). "🚀" doesn't fit (2 cells); fall back to ellipsis only.
        assert_eq!(truncate_to_width("🚀ship", 2), "…");
    }

    #[test]
    fn truncate_to_width_edge_cases() {
        assert_eq!(truncate_to_width("anything", 0), "");
        assert_eq!(truncate_to_width("anything", 1), "…");
        assert_eq!(truncate_to_width("", 5), "");
    }

    #[test]
    fn pad_end_to_width_uses_cells_not_chars() {
        assert_eq!(pad_end_to_width("abc", 5), "abc  ");
        // "测试" is 4 cells; padding to 6 adds 2 spaces.
        assert_eq!(pad_end_to_width("测试", 6), "测试  ");
        // Already wider — unchanged.
        assert_eq!(pad_end_to_width("测试试", 5), "测试试");
    }

    #[test]
    fn truncate_overflow_matches_legacy_take_then_append() {
        // Legacy `truncate(value, 6)` on ASCII took 6 chars + appended … (=7 cells).
        assert_eq!(truncate_overflow_to_width("abcdefgh", 6), "abcdef…");
        // Wide chars: "测" is 2 cells; budget 4 fits 测测 (4 cells) + ….
        assert_eq!(truncate_overflow_to_width("测测测测测", 4), "测测…");
        // Single wide char at the cap doesn't split mid-grapheme.
        assert_eq!(truncate_overflow_to_width("🚀🚀🚀", 5), "🚀🚀…");
    }

    #[test]
    fn truncate_start_to_width_keeps_trailing_run() {
        assert_eq!(truncate_start_to_width("abcdef", 10), "abcdef");
        assert_eq!(truncate_start_to_width("abcdef", 4), "…def");
        // "测试 done" = 2+2+1+4 = 9 cells. Budget=4 (max=5 minus ellipsis).
        // From the right: "e"(1),"n"(2),"o"(3),"d"(4) — " " would be 5, stop.
        assert_eq!(truncate_start_to_width("测试 done", 5), "…done");
    }
}
