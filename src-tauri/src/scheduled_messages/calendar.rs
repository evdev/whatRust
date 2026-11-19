use chrono::{Datelike, Days, LocalResult, Months, NaiveDate, NaiveDateTime, TimeZone};
use chrono_tz::{GapInfo, Tz};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Unit {
    Day,
    Week,
    Month,
    Year,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Repeat {
    pub unit: Unit,
    pub interval: u32,
    pub end_date: Option<String>,
    pub max_sends: Option<u32>,
}

pub struct Calendar<'a> {
    anchor: NaiveDateTime,
    zone: Tz,
    repeat: Option<&'a Repeat>,
    end: Option<NaiveDate>,
}

impl<'a> Calendar<'a> {
    pub fn new(
        local_at: &str,
        time_zone: &str,
        repeat: Option<&'a Repeat>,
    ) -> Result<Self, String> {
        let anchor = NaiveDateTime::parse_from_str(local_at, "%Y-%m-%dT%H:%M")
            .map_err(|_| "invalid_date")?;
        if local_at.len() != 16 || !(1970..=9999).contains(&anchor.year()) {
            return Err("invalid_date".into());
        }
        let zone: Tz = time_zone.parse().map_err(|_| "invalid_timezone")?;
        let mut end = None;
        if let Some(rule) = repeat {
            if rule.interval == 0
                || rule.max_sends == Some(0)
                || (rule.end_date.is_some() && rule.max_sends.is_some())
            {
                return Err("invalid_repeat".into());
            }
            if let Some(input) = &rule.end_date {
                let date =
                    NaiveDate::parse_from_str(input, "%Y-%m-%d").map_err(|_| "invalid_end_date")?;
                if input.len() != 10 || date < anchor.date() || date.year() > 9999 {
                    return Err("invalid_end_date".into());
                }
                end = Some(date);
            }
        }
        Ok(Self {
            anchor,
            zone,
            repeat,
            end,
        })
    }

    pub fn due(&self, index: u32) -> Option<i64> {
        let date = self.anchor.date();
        let day = if index == 0 {
            date
        } else {
            let rule = self.repeat?;
            let step = rule.interval.checked_mul(index)?;
            match rule.unit {
                Unit::Day => date.checked_add_days(Days::new(u64::from(step)))?,
                Unit::Week => date.checked_add_days(Days::new(u64::from(step) * 7))?,
                Unit::Month => date.checked_add_months(Months::new(step))?,
                Unit::Year => date.checked_add_months(Months::new(step.checked_mul(12)?))?,
            }
        };
        if day.year() > 9999 || self.end.is_some_and(|end| day > end) {
            return None;
        }

        let local = day.and_time(self.anchor.time());
        let instant = match self.zone.from_local_datetime(&local) {
            LocalResult::Single(instant) => instant,
            LocalResult::Ambiguous(left, right) => left.min(right),
            LocalResult::None => {
                let gap = GapInfo::new(&local, &self.zone)?;
                let (begin, _) = gap.begin?;
                let end = gap.end?;
                end.checked_add_signed(local - begin)?
            }
        };
        Some(instant.timestamp_millis())
    }

    /// A long outage should cost logarithmic time even with a daily schedule.
    pub fn latest_due(&self, from: u32, now_ms: i64) -> Option<u32> {
        let is_due = |index| self.due(index).is_some_and(|due| due <= now_ms);
        if !is_due(from) {
            return None;
        }
        let mut low = from;
        let mut step = 1u32;
        let mut high = from.saturating_add(step);
        while is_due(high) {
            low = high;
            step = step.saturating_mul(2);
            high = from.saturating_add(step);
        }
        while high - low > 1 {
            let middle = low + (high - low) / 2;
            if is_due(middle) {
                low = middle;
            } else {
                high = middle;
            }
        }
        Some(low)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(unit: Unit) -> Repeat {
        Repeat {
            unit,
            interval: 1,
            end_date: None,
            max_sends: None,
        }
    }

    fn utc(stamp: &str) -> i64 {
        chrono::DateTime::parse_from_rfc3339(stamp)
            .unwrap()
            .timestamp_millis()
    }

    #[test]
    fn advances_from_the_anchor_through_short_months_and_common_years() {
        let monthly = rule(Unit::Month);
        let calendar = Calendar::new("2028-01-31T09:00", "UTC", Some(&monthly)).unwrap();
        assert_eq!(calendar.due(1), Some(utc("2028-02-29T09:00:00Z")));
        assert_eq!(calendar.due(2), Some(utc("2028-03-31T09:00:00Z")));

        let annual = rule(Unit::Year);
        let calendar = Calendar::new("2028-02-29T09:00", "UTC", Some(&annual)).unwrap();
        assert_eq!(calendar.due(1), Some(utc("2029-02-28T09:00:00Z")));
        assert_eq!(calendar.due(4), Some(utc("2032-02-29T09:00:00Z")));
    }

    #[test]
    fn resolves_spring_gap_and_fall_fold_in_the_original_zone() {
        let weekly = rule(Unit::Week);
        let calendar = Calendar::new("2026-03-01T02:30", "America/Denver", Some(&weekly)).unwrap();
        assert_eq!(calendar.due(0), Some(utc("2026-03-01T09:30:00Z")));
        assert_eq!(calendar.due(1), Some(utc("2026-03-08T09:30:00Z")));
        assert_eq!(calendar.due(2), Some(utc("2026-03-15T08:30:00Z")));
        let calendar = Calendar::new("2026-11-01T01:30", "America/Denver", None).unwrap();
        assert_eq!(calendar.due(0), Some(utc("2026-11-01T07:30:00Z")));
    }

    #[test]
    fn includes_end_date_and_finds_latest_custom_occurrence() {
        let repeat = Repeat {
            unit: Unit::Year,
            interval: 2,
            end_date: Some("2034-02-28".into()),
            max_sends: None,
        };
        let calendar = Calendar::new("2028-02-29T18:00", "UTC", Some(&repeat)).unwrap();
        assert_eq!(calendar.due(3), Some(utc("2034-02-28T18:00:00Z")));
        assert_eq!(calendar.due(4), None);
        assert_eq!(calendar.latest_due(1, utc("2050-01-01T00:00:00Z")), Some(3));
        assert_eq!(calendar.latest_due(4, utc("2050-01-01T00:00:00Z")), None);
    }
}
