//! The app's texts. The crew sends them in the user's language when it starts (`run --desktop`); the English catalog
//! is built in for the moment before that, or when the crew can't start at all.
use std::collections::HashMap;

use serde_json::{Map, Value};

const EN: &str = include_str!("../../../../packages/i18n/locales/en.json");
const PREFIX: &str = "desktop.";

#[derive(Clone, Debug)]
pub struct Strings(HashMap<String, String>);

impl Default for Strings {
    fn default() -> Self {
        let all: HashMap<String, String> = serde_json::from_str(EN).unwrap_or_default();
        Strings(
            all.into_iter()
                .filter_map(|(k, v)| k.strip_prefix(PREFIX).map(|k| (k.to_string(), v)))
                .collect(),
        )
    }
}

impl Strings {
    /// Take the texts the crew sent; a key it left out keeps its English text.
    pub fn merge(&mut self, from: &Map<String, Value>) {
        for (key, value) in from {
            if let Some(text) = value.as_str() {
                self.0.insert(key.clone(), text.to_string());
            }
        }
    }

    pub fn get(&self, key: &str) -> String {
        self.fill(key, &[])
    }

    /// The text for `key` with each `{name}` replaced.
    pub fn fill(&self, key: &str, vars: &[(&str, &str)]) -> String {
        let mut text = self.0.get(key).cloned().unwrap_or_else(|| key.to_string());
        for (name, value) in vars {
            text = text.replace(&format!("{{{name}}}"), value);
        }
        text
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn english_is_built_in_and_placeholders_fill() {
        let s = Strings::default();
        assert_eq!(s.get("quit"), "Quit Crewreview");
        assert_eq!(s.fill("inbox", &[("count", "3")]), "Inbox (3)");
        assert_eq!(s.get("no-such-key"), "no-such-key");
    }

    #[test]
    fn the_crews_language_replaces_english() {
        let mut s = Strings::default();
        let sent: Value = serde_json::json!({ "quit": "Sair do Crewreview" });
        s.merge(sent.as_object().unwrap());
        assert_eq!(s.get("quit"), "Sair do Crewreview");
        assert_eq!(s.get("open"), "Open dashboard");
    }
}
