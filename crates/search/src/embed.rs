//! On-device text embeddings: model2vec static models (potion-base-8M by
//! default), shipped inside the app and verified against pinned hashes.
//!
//! Model2vec embeds by looking up one vector per token and averaging, so a
//! sentence costs microseconds on a laptop CPU and no network. The model is
//! ~30 MB, bundled as a Tauri resource (`apps/desktop/src-tauri/resources/
//! search-model/`, see `docs/search.md`); nothing is ever downloaded.

use model2vec_rs::model::StaticModel;
use sha1::Digest as _;
use std::fs;
use std::path::Path;

type Result<T> = std::result::Result<T, String>;

/// Turns texts into vectors. Implementations must be deterministic: the
/// index stores vectors and compares them with fresh query vectors.
pub trait Embedder: Send + Sync {
    /// Names the model and its revision. A different id re-embeds the index.
    fn id(&self) -> &str;
    fn embed(&self, texts: &[String]) -> Vec<Vec<f32>>;
}

/// A loaded model2vec model.
pub struct Model2Vec {
    id: String,
    model: StaticModel,
}

impl Model2Vec {
    /// Loads a model folder as it is (see [`ModelSpec::load`] to verify it).
    pub fn load(dir: &Path, id: &str) -> Result<Self> {
        let read = |name: &str| {
            fs::read(dir.join(name)).map_err(|_| format!("embedding model is missing {name}"))
        };
        Self::from_bytes(
            id,
            &read("tokenizer.json")?,
            &read("model.safetensors")?,
            &read("config.json")?,
        )
    }

    pub fn from_bytes(id: &str, tokenizer: &[u8], model: &[u8], config: &[u8]) -> Result<Self> {
        let model = StaticModel::from_bytes(tokenizer, model, config, Some(true))
            .map_err(|e| format!("could not load the embedding model: {e}"))?;
        Ok(Model2Vec {
            id: id.into(),
            model,
        })
    }
}

impl Embedder for Model2Vec {
    fn id(&self) -> &str {
        &self.id
    }

    fn embed(&self, texts: &[String]) -> Vec<Vec<f32>> {
        self.model.encode_with_args(texts, Some(512), 256)
    }
}

/// A model from the Hugging Face Hub, pinned to one revision and verified
/// file by file, so a damaged or swapped file is refused rather than loaded.
/// `repo` and `revision` say where the bundled copy came from.
pub struct ModelSpec {
    pub name: &'static str,
    pub repo: &'static str,
    pub revision: &'static str,
    pub files: &'static [ModelFile],
}

pub struct ModelFile {
    pub name: &'static str,
    pub size: u64,
    pub check: Check,
}

pub enum Check {
    /// Git's blob id: sha1 of `blob <size>\0<bytes>` (small files on the Hub).
    GitBlob(&'static str),
    /// sha256 of the bytes (LFS files on the Hub).
    Sha256(&'static str),
}

/// minishlab/potion-base-8M (MIT): 256 dimensions, 29,528 tokens.
pub const POTION_BASE_8M: ModelSpec = ModelSpec {
    name: "potion-base-8M",
    repo: "minishlab/potion-base-8M",
    revision: "bf8b056651a2c21b8d2565580b8569da283cab23",
    files: &[
        ModelFile {
            name: "config.json",
            size: 202,
            check: Check::GitBlob("7df26884a1aaaefbd7a30b37c32a25477cfb4c0e"),
        },
        ModelFile {
            name: "tokenizer.json",
            size: 683_666,
            check: Check::GitBlob("3e511f68ccf95c33b9ffd214a94c6d25bdb3034f"),
        },
        ModelFile {
            name: "model.safetensors",
            size: 30_236_760,
            check: Check::Sha256(
                "f65d0f325faadc1e121c319e2faa41170d3fa07d8c89abd48ca5358d9a223de2",
            ),
        },
    ],
};

impl ModelSpec {
    /// The id stored beside vectors: the name and a short revision.
    pub fn id(&self) -> String {
        format!("{}@{}", self.name, &self.revision[..12])
    }

    /// True when every file in `dir` is present and matches its pinned hash.
    pub fn verified(&self, dir: &Path) -> bool {
        self.check(dir).is_ok()
    }

    fn check(&self, dir: &Path) -> Result<()> {
        for file in self.files {
            let bytes = fs::read(dir.join(file.name))
                .map_err(|_| format!("the embedding model is missing {}", file.name))?;
            if !file.matches(&bytes) {
                return Err(format!("{} failed verification", file.name));
            }
        }
        Ok(())
    }

    /// Loads the model from `dir` (the app's bundled copy), refusing it if
    /// any file is missing or doesn't match its pinned hash.
    pub fn load(&self, dir: &Path) -> Result<Model2Vec> {
        self.check(dir)?;
        Model2Vec::load(dir, &self.id())
    }
}

impl ModelFile {
    fn matches(&self, bytes: &[u8]) -> bool {
        if bytes.len() as u64 != self.size {
            return false;
        }
        match self.check {
            Check::GitBlob(expected) => {
                let mut hash = sha1::Sha1::new();
                hash.update(format!("blob {}\0", bytes.len()));
                hash.update(bytes);
                hex(&hash.finalize()) == expected
            }
            Check::Sha256(expected) => hex(&sha2::Sha256::digest(bytes)) == expected,
        }
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// A tiny model2vec model for tests: a word-level tokenizer and a one-hot
/// table where words that mean the same thing share a dimension. It runs the
/// real model2vec code path with no download.
#[doc(hidden)]
pub fn fixture(groups: &[&[&str]]) -> Model2Vec {
    let mut vocab = serde_json::Map::new();
    vocab.insert("[UNK]".into(), 0.into());
    let mut rows: Vec<usize> = vec![usize::MAX];
    for (dim, words) in groups.iter().enumerate() {
        for word in *words {
            vocab.insert((*word).into(), rows.len().into());
            rows.push(dim);
        }
    }
    let dims = groups.len().max(1);
    let tokenizer = serde_json::json!({
        "version": "1.0", "truncation": null, "padding": null, "added_tokens": [],
        "normalizer": { "type": "Lowercase" },
        "pre_tokenizer": { "type": "Whitespace" },
        "post_processor": null, "decoder": null,
        "model": { "type": "WordLevel", "vocab": vocab, "unk_token": "[UNK]" }
    });
    let mut data = Vec::with_capacity(rows.len() * dims * 4);
    for row in &rows {
        for dim in 0..dims {
            data.extend_from_slice(&(if *row == dim { 1.0f32 } else { 0.0 }).to_le_bytes());
        }
    }
    let header = serde_json::json!({
        "embeddings": { "dtype": "F32", "shape": [rows.len(), dims], "data_offsets": [0, data.len()] }
    })
    .to_string();
    let mut safetensors = (header.len() as u64).to_le_bytes().to_vec();
    safetensors.extend_from_slice(header.as_bytes());
    safetensors.extend_from_slice(&data);
    Model2Vec::from_bytes(
        "fixture",
        tokenizer.to_string().as_bytes(),
        &safetensors,
        br#"{"normalize": true}"#,
    )
    .unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixture_model_embeds_synonyms_together() {
        let model = fixture(&[&["sleep", "rest"], &["kiln", "pottery"]]);
        let v = model.embed(&[
            "Sleep".into(),
            "rest rest".into(),
            "pottery".into(),
            "zebra".into(),
        ]);
        assert_eq!(v[0], v[1]);
        assert_eq!(v[0], vec![1.0, 0.0]);
        assert_eq!(v[2], vec![0.0, 1.0]);
        assert_eq!(v[3], vec![0.0, 0.0], "unknown words embed to nothing");
    }

    #[test]
    fn files_are_checked_by_size_and_hash() {
        let blob = ModelFile {
            name: "x",
            size: 5,
            check: Check::GitBlob("b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0"),
        };
        assert!(blob.matches(b"hello"));
        assert!(!blob.matches(b"hellp"));
        let sha = ModelFile {
            name: "y",
            size: 5,
            check: Check::Sha256(
                "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
            ),
        };
        assert!(sha.matches(b"hello") && !sha.matches(b"hello!"));
        assert_eq!(POTION_BASE_8M.id(), "potion-base-8M@bf8b056651a2");
    }

    #[test]
    fn a_missing_or_damaged_model_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let missing = POTION_BASE_8M.load(dir.path()).err().unwrap();
        assert_eq!(missing, "the embedding model is missing config.json");
        std::fs::write(dir.path().join("config.json"), "{}").unwrap();
        let damaged = POTION_BASE_8M.load(dir.path()).err().unwrap();
        assert_eq!(damaged, "config.json failed verification");
        assert!(!POTION_BASE_8M.verified(dir.path()));
    }
}
