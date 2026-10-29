//! The clip format needs a flat map, not a general YAML interpreter. Keeping
//! this small also means a file can never ask us to load another file or tag.

use crate::Result;

#[derive(Clone, Debug, PartialEq)]
pub(super) enum Value {
    Scalar(String),
    List(Vec<String>),
}

pub(super) struct Frontmatter<'a> {
    pub fields: Vec<(String, Value)>,
    pub body: &'a str,
    // Keep untouched properties verbatim: booleans, numbers and comments are
    // the writer's data too, even though our getters only need strings/lists.
    original: Vec<(Option<String>, &'a str)>,
    changed: Vec<String>,
}

impl<'a> Frontmatter<'a> {
    pub fn empty() -> Self {
        Self {
            fields: Vec::new(),
            body: "",
            original: Vec::new(),
            changed: Vec::new(),
        }
    }

    pub fn parse(text: &'a str) -> Result<Self> {
        let mut lines = text.split_inclusive('\n');
        let first = lines.next().ok_or("missing clip frontmatter")?;
        if first.trim_end_matches(['\r', '\n']) != "---" {
            return Err("missing clip frontmatter".into());
        }
        let mut offset = first.len();
        let mut fields: Vec<(String, Value)> = Vec::new();
        let mut original = Vec::new();
        for raw in lines {
            offset += raw.len();
            let line = raw.trim_end_matches(['\r', '\n']);
            if line == "---" {
                return Ok(Self {
                    fields,
                    body: &text[offset..],
                    original,
                    changed: Vec::new(),
                });
            }
            if line.trim().is_empty() || line.trim_start().starts_with('#') {
                original.push((None, raw));
                continue;
            }
            if line.starts_with(char::is_whitespace) {
                let item = line
                    .trim()
                    .strip_prefix("- ")
                    .ok_or("clip frontmatter must be flat")?;
                match fields.last_mut() {
                    Some((key, Value::List(items))) => {
                        items.push(scalar(item)?);
                        original.push((Some(key.clone()), raw));
                    }
                    _ => return Err("clip frontmatter must be flat".into()),
                }
                continue;
            }
            let (key, value) = line.split_once(':').ok_or("invalid clip frontmatter")?;
            let key = key.trim();
            if key.is_empty()
                || !key
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
            {
                return Err("invalid clip field name".into());
            }
            if fields.iter().any(|(k, _)| k == key) {
                return Err("duplicate clip field".into());
            }
            let value = value.trim();
            let value = if value.is_empty() {
                Value::List(Vec::new())
            } else if value.starts_with('[') {
                Value::List(list(value)?)
            } else {
                Value::Scalar(scalar(value)?)
            };
            fields.push((key.into(), value));
            original.push((Some(key.into()), raw));
        }
        Err("unclosed clip frontmatter".into())
    }

    pub fn scalar(&self, key: &str) -> Option<String> {
        match self.fields.iter().find(|(k, _)| k == key) {
            Some((_, Value::Scalar(value))) if !value.is_empty() => Some(value.clone()),
            _ => None,
        }
    }

    pub fn list(&self, key: &str) -> Vec<String> {
        match self.fields.iter().find(|(k, _)| k == key) {
            Some((_, Value::List(items))) => items.clone(),
            _ => Vec::new(),
        }
    }

    pub fn set(&mut self, key: &str, value: Option<Value>) {
        if !self.changed.iter().any(|k| k == key) {
            self.changed.push(key.into());
        }
        if let Some(index) = self.fields.iter().position(|(k, _)| k == key) {
            if let Some(value) = value {
                self.fields[index].1 = value;
            } else {
                self.fields.remove(index);
            }
        } else if let Some(value) = value {
            self.fields.push((key.into(), value));
        }
    }

    pub fn render(&self, body: &str) -> String {
        let mut text = String::from("---\n");
        let mut rendered = Vec::new();
        for (key, raw) in &self.original {
            let Some(key) = key else {
                text.push_str(raw);
                continue;
            };
            if !self.changed.contains(key) {
                text.push_str(raw);
            } else if !rendered.contains(key) {
                if let Some((_, value)) = self.fields.iter().find(|(k, _)| k == key) {
                    text.push_str(&field(key, value));
                }
            }
            if !rendered.contains(key) {
                rendered.push(key.clone());
            }
        }
        for (key, value) in &self.fields {
            if !rendered.contains(key) {
                text.push_str(&field(key, value));
            }
        }
        text.push_str("---\n");
        text.push_str(body);
        text
    }
}

fn field(key: &str, value: &Value) -> String {
    let value = match value {
        Value::Scalar(value) => quote(value),
        Value::List(items) => format!(
            "[{}]",
            items
                .iter()
                .map(|s| quote(s))
                .collect::<Vec<_>>()
                .join(", ")
        ),
    };
    format!("{key}: {value}\n")
}

fn quote(value: &str) -> String {
    // JSON strings are also YAML strings, including escaped newlines and quotes.
    serde_json::to_string(value).expect("a string is serializable")
}

fn scalar(value: &str) -> Result<String> {
    let value = value.trim();
    if value.starts_with('"') {
        let end = quoted_end(value, '"')?;
        let tail = value[end..].trim();
        if !tail.is_empty() && !tail.starts_with('#') {
            return Err("invalid quoted clip field".into());
        }
        return serde_json::from_str(&value[..end]).map_err(|_| "invalid quoted clip field".into());
    }
    if value.starts_with('\'') {
        let end = quoted_end(value, '\'')?;
        let tail = value[end..].trim();
        if !tail.is_empty() && !tail.starts_with('#') {
            return Err("invalid quoted clip field".into());
        }
        return Ok(value[1..end - 1].replace("''", "'"));
    }
    Ok(value
        .split_once(" #")
        .map_or(value, |(v, _)| v)
        .trim()
        .to_string())
}

fn quoted_end(value: &str, quote: char) -> Result<usize> {
    let mut chars = value.char_indices().skip(1).peekable();
    while let Some((index, c)) = chars.next() {
        if quote == '"' && c == '\\' {
            chars.next();
        } else if c == quote {
            if quote == '\'' && chars.peek().is_some_and(|(_, c)| *c == '\'') {
                chars.next();
            } else {
                return Ok(index + 1);
            }
        }
    }
    Err("unclosed quoted clip field".into())
}

fn list(value: &str) -> Result<Vec<String>> {
    let mut rest = value
        .strip_prefix('[')
        .ok_or("invalid clip list")?
        .trim_start();
    let mut items = Vec::new();
    loop {
        if let Some(tail) = rest.strip_prefix(']') {
            if !tail.trim().is_empty() && !tail.trim().starts_with('#') {
                return Err("invalid clip list".into());
            }
            return Ok(items);
        }
        let end = if rest.starts_with(['"', '\'']) {
            quoted_end(rest, rest.chars().next().unwrap())?
        } else {
            rest.find([',', ']']).ok_or("unclosed clip list")?
        };
        if end == 0 {
            return Err("empty clip list item".into());
        }
        items.push(scalar(&rest[..end])?);
        rest = rest[end..].trim_start();
        if let Some(tail) = rest.strip_prefix(',') {
            rest = tail.trim_start();
        } else if !rest.starts_with(']') {
            return Err("invalid clip list".into());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_inline_and_obsidian_block_lists() {
        let inline = Frontmatter::parse("---\ntitle: \"Quotes: \\\"yes\\\"\"\ntags: [sleep, 'reader''s life', \"a, b\"] # comment\n---\n\nBody").unwrap();
        assert_eq!(inline.scalar("title").as_deref(), Some("Quotes: \"yes\""));
        assert_eq!(inline.list("tags"), ["sleep", "reader's life", "a, b"]);
        assert_eq!(inline.body, "\nBody");
        let block =
            Frontmatter::parse("---\r\ntags:\r\n  - sleep\r\n  - \"a, b\"\r\n---\r\n\r\nBody")
                .unwrap();
        assert_eq!(block.list("tags"), ["sleep", "a, b"]);
        assert_eq!(block.body, "\r\nBody");
    }

    #[test]
    fn round_trips_scalars_without_injecting_fields() {
        let mut fm = Frontmatter::parse("---\ntags: []\n---\n").unwrap();
        let value = "a \\\"quote\\\"\nkind: video\n---\nbody";
        fm.set("title", Some(Value::Scalar(value.into())));
        let rendered = fm.render("\nBody");
        let parsed = Frontmatter::parse(&rendered).unwrap();
        assert_eq!(parsed.scalar("title").as_deref(), Some(value));
        assert_eq!(parsed.body, "\nBody");
    }

    #[test]
    fn untouched_properties_keep_their_types_comments_and_spelling() {
        let header = "# My properties\nempty:\nflag: true # important\ncount: 5\ndate-created: 2026-10-29\ntags:\n  - Writing\n";
        let text = format!("---\n{header}---\n\nBody");
        let mut fm = Frontmatter::parse(&text).unwrap();
        fm.set("title", Some(Value::Scalar("A title".into())));
        let rendered = fm.render(fm.body);
        assert!(rendered.starts_with(&format!("---\n{header}title:")));
        let mut fm = Frontmatter::parse(&rendered).unwrap();
        fm.set("tags", Some(Value::List(vec!["new".into()])));
        let rendered = fm.render(fm.body);
        assert!(rendered.contains("flag: true # important\ncount: 5\ndate-created: 2026-10-29\n"));
        assert!(!rendered.contains("  - Writing"));
        assert!(rendered.contains("tags: [\"new\"]\n"));
    }

    #[test]
    fn refuses_nested_or_incomplete_frontmatter() {
        for text in [
            "Body",
            "---\nkind: note",
            "---\ntitle: \"unclosed\n---",
            "---\ntags: [unclosed\n---",
            "---\na:\n  nested: value\n---",
            "---\na: x\na: y\n---",
        ] {
            assert!(Frontmatter::parse(text).is_err(), "{text}");
        }
    }
}
